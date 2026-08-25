"""Shared dependencies: settings, client providers, ref resolution, state cache.

Everything here exists to keep routers free of three concerns: where the v2
client comes from (real or mock), how a ``{ref}`` path parameter becomes a
routable target, and how raw cloud state becomes the spec's normalised shape
without hammering the rate limit.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol, cast

import anyio.to_thread
import click
from fastapi import Request

from govee_cli import ledger
from govee_cli.config import DeviceConfig, GoveeConfig, load_config, resolve_device_ref
from govee_cli.exceptions import DeviceNotConfigured
from govee_cli.http_v2 import DIYScene, Scene, V2Device
from govee_cli.transport import BLE, CLOUD_V1, CLOUD_V2, ModelSpec, get_spec, resolve_target

from .errors import bad_request, conflict, not_found

if TYPE_CHECKING:
    from .mock import MockV2

STATE_CACHE_TTL = 2.5  # >= 2s per spec; absorbs 10s UI polls plus manual refresh bursts
WRITE_ECHO_TTL = 8.0  # how long a successful write outranks a lagging cloud read

# Same address shapes the config module accepts for device references.
_MAC_PATTERN = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")
_HTTP_ID_PATTERN = re.compile(r"^([0-9A-Fa-f]{2}:){7}[0-9A-Fa-f]{2}$")


class V2Client(Protocol):
    """The slice of ``GoveeHTTPv2`` the sidecar uses; MockV2 implements it too."""

    def get_devices(self) -> list[V2Device]: ...

    def get_device(self, sku: str, device_id: str) -> V2Device | None: ...

    def get_state(self, sku: str, device_id: str) -> dict[str, Any]: ...

    def turn_on(self, sku: str, device_id: str) -> None: ...

    def turn_off(self, sku: str, device_id: str) -> None: ...

    def set_brightness(self, sku: str, device_id: str, value: int) -> None: ...

    def set_color(self, sku: str, device_id: str, r: int, g: int, b: int) -> None: ...

    def set_color_temp(self, sku: str, device_id: str, kelvin: int) -> None: ...

    def set_segment_color(self, sku: str, device_id: str, segments: list[int],
                          r: int, g: int, b: int) -> None: ...

    def set_segment_brightness(self, sku: str, device_id: str, segments: list[int],
                               brightness: int) -> None: ...

    def set_scene(self, sku: str, device_id: str, scene: Scene) -> None: ...

    def set_diy_scene(self, sku: str, device_id: str, value: int) -> None: ...

    def set_snapshot(self, sku: str, device_id: str, value: int) -> None: ...

    def set_music_mode(self, sku: str, device_id: str, mode: int, sensitivity: int,
                       auto_color: bool | None = None,
                       rgb: int | None = None) -> None: ...

    def set_toggle(self, sku: str, device_id: str, instance: str, on: bool) -> None: ...

    def get_scenes(self, sku: str, device_id: str,
                   *, use_cache: bool = True) -> list[Scene]: ...

    def get_diy_scenes(self, sku: str, device_id: str) -> list[DIYScene]: ...

    def find_scene(self, sku: str, device_id: str, name: str) -> Scene | None: ...

    def find_diy_scene(self, sku: str, device_id: str, name: str) -> DIYScene | None: ...


@dataclass(frozen=True)
class Settings:
    """Sidecar configuration, read from the environment once at app creation."""

    mock: bool
    scheduler_enabled: bool
    port: int

    @classmethod
    def from_env(cls) -> "Settings":
        mock = os.environ.get("GOVEE_WEBUI_MOCK") == "1"
        # Default on, but never in mock mode: the embedded scheduler would fire
        # real commands at real devices while someone thinks they are demoing.
        scheduler_enabled = (
            os.environ.get("GOVEE_WEBUI_SCHEDULER", "1") != "0" and not mock
        )
        port = int(os.environ.get("GOVEE_WEBUI_PORT", "6057"))
        return cls(mock=mock, scheduler_enabled=scheduler_enabled, port=port)


class TTLCache:
    """Minimal thread-safe TTL cache for device state reads.

    The cloud allows ~2 req/s sustained; a UI polling several devices would blow
    through that on its own. Entries expire after :data:`STATE_CACHE_TTL` seconds
    and are invalidated on mutations so the UI sees its own writes immediately.

    A generation counter guards against a stale-read race: a fetch that started
    before an invalidation must not repopulate pre-mutation data when it
    completes, so ``set`` drops entries fetched under an older generation.
    """

    def __init__(self, ttl: float = STATE_CACHE_TTL) -> None:
        self._ttl = ttl
        self._entries: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()
        self._generation = 0

    def get(self, key: str) -> Any | None:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or now - entry[0] > self._ttl:
                return None
            return entry[1]

    def set(self, key: str, value: Any, *, generation: int | None = None) -> None:
        with self._lock:
            if generation is not None and generation != self._generation:
                # A fetch that overlapped an invalidation: its data predates
                # the mutation, so it must not land.
                return
            self._entries[key] = (time.monotonic(), value)

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)
            self._generation += 1

    def current_generation(self) -> int:
        with self._lock:
            return self._generation


class WriteEcho:
    """Remembers what this sidecar successfully commanded, per device.

    The Govee cloud's state read lags several seconds behind its write
    endpoint: a ``PUT /power`` returns 200 but the following ``GET /state``
    can still report the old value. Without compensation the UI flips back
    to stale state right after every mutation — toggle five times quickly
    and the console disagrees with the room.

    Writes are recorded as ``{field: (value, monotonic)}`` and overlaid onto
    normalised state for :data:`WRITE_ECHO_TTL` seconds. A field stops
    overriding as soon as a fresh read *confirms* the commanded value (the
    cloud caught up) or when the TTL lapses (trust the device again — this
    also bounds how long a silently-ignored command can mislead the UI).
    Thread-safe: writes land from worker threads, reads from the event loop.
    """

    def __init__(self, ttl: float = WRITE_ECHO_TTL) -> None:
        self._ttl = ttl
        self._entries: dict[str, dict[str, tuple[Any, float]]] = {}
        self._lock = threading.Lock()

    def record(self, device_id: str, fields: dict[str, Any]) -> None:
        """Record commanded values. ``None`` is a legitimate commanded value
        (setting color clears color_temp_k on the hardware) and overlays as one."""
        now = time.monotonic()
        with self._lock:
            entry = self._entries.setdefault(device_id, {})
            for field, value in fields.items():
                entry[field] = (value, now)

    def overlay(self, device_id: str, state: dict[str, Any]) -> dict[str, Any]:
        """Return ``state`` with unexpired, unconfirmed echoes applied."""
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(device_id)
            if not entry:
                return state
            confirmed: list[str] = []
            overlaid = dict(state)
            for field, (value, at) in entry.items():
                if now - at >= self._ttl:
                    confirmed.append(field)
                    continue
                if field in overlaid and overlaid[field] == value:
                    confirmed.append(field)  # cloud caught up — stand down
                    continue
                overlaid[field] = value
            for field in confirmed:
                entry.pop(field, None)
            if not entry:
                self._entries.pop(device_id, None)
            return overlaid


@dataclass(frozen=True)
class Resolved:
    """A device reference resolved far enough to route a command."""

    device_id: str
    model: str | None
    transport: str
    config: GoveeConfig
    device_cfg: DeviceConfig | None

    @property
    def spec(self) -> ModelSpec | None:
        return get_spec(self.model)

    @property
    def label(self) -> str:
        if self.device_cfg and self.device_cfg.name:
            return self.device_cfg.name
        return self.device_id

    @property
    def name(self) -> str:
        return self.label

    @property
    def sku(self) -> str:
        """The model name guaranteed non-None, for v2 calls that require it."""
        if not self.model:
            raise conflict(
                f"Device '{self.device_id}' has no model recorded. "
                f"Run `govee-cli scan-http` to refresh the registry."
            )
        return self.model


def resolve_ref(cfg: GoveeConfig, ref: str | None) -> Resolved:
    """Resolve a device name or id, mapping failures to 404/409.

    Mirrors ``_common.resolve()`` but raises API errors instead of ClickException,
    keeping the library's own message text. An unregistered ref that looks like a
    MAC or cloud id falls back to BLE basic control, exactly as the CLI does.
    """
    ref = ref or cfg.default_mac
    if not ref:
        raise bad_request(
            "No device specified. Use --device or set a default with `govee-cli config`."
        )
    try:
        mac, device_cfg = resolve_device_ref(cfg, ref)
    except DeviceNotConfigured as e:
        if _MAC_PATTERN.match(ref) or _HTTP_ID_PATTERN.match(ref):
            # Same fallback as resolve_target(): an ad-hoc address is still
            # drivable over BLE even though the registry has never seen it.
            return Resolved(
                device_id=ref.upper(), model=None, transport=BLE, config=cfg,
                device_cfg=None,
            )
        raise not_found(str(e)) from e
    try:
        device_id, model, transport = resolve_target(cfg, ref)
    except click.ClickException as e:
        # resolve_target's only failure is a cloud model registered under a
        # 6-octet BLE MAC — a routing misconfiguration, not a missing device.
        raise conflict(e.format_message()) from e
    return Resolved(
        device_id=device_id, model=model, transport=transport, config=cfg,
        device_cfg=device_cfg,
    )


def get_settings(request: Request) -> Settings:
    return cast(Settings, request.app.state.settings)


def get_config() -> GoveeConfig:
    """Load the config. Blocking disk IO — call via ``anyio.to_thread``."""
    return load_config()


def get_client(request: Request) -> V2Client:
    """Return the v2 client for this app: MockV2 in mock mode, else the real one.

    Constructing the real client reads config.json from disk; call sites that
    run on the event loop must reach this through :func:`run_blocking` (the
    routers do). Direct calls are only safe from worker threads.
    """
    if request.app.state.settings.mock:
        mock: MockV2 = request.app.state.mock_client
        return mock
    client: V2Client | None = request.app.state.v2_client
    if client is None:
        from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

        try:
            client = GoveeHTTPv2()
        except GoveeV2Error as e:
            raise bad_request(str(e)) from e
        request.app.state.v2_client = client
    return client


async def get_client_async(request: Request) -> V2Client:
    """Event-loop-safe variant: builds the real client on a worker thread."""
    if request.app.state.settings.mock:
        return get_client(request)
    client: V2Client | None = request.app.state.v2_client
    if client is None:
        return cast(V2Client, await run_blocking(_build_and_store_client, request))
    return client


def _build_and_store_client(request: Request) -> V2Client:
    # Double-checked after the blocking construct: a concurrent request may
    # have stored one while this thread was reading config.
    existing: V2Client | None = request.app.state.v2_client
    if existing is not None:
        return existing
    return get_client(request)


def get_state_cache(request: Request) -> TTLCache:
    return cast(TTLCache, request.app.state.state_cache)


def get_write_echo(request: Request) -> WriteEcho:
    return cast(WriteEcho, request.app.state.write_echo)


def record_write(request: Request, target: Resolved, fields: dict[str, Any]) -> None:
    """Remember commanded values so lagging cloud reads can't undo them."""
    get_write_echo(request).record(target.device_id, fields)


def apply_echo(request: Request, target: Resolved, state: dict[str, Any]) -> dict[str, Any]:
    """Overlay recent commanded values onto a normalised state dict."""
    return get_write_echo(request).overlay(target.device_id, state)


# Modes the cloud API can never confirm mid-playback (scene/segment/music
# instances always read back ""), so their confidence never rises above
# "assumed" — see §3.4/§3.6 rule 3.
_UNVERIFIABLE_MODES = frozenset(
    {"scene", "diy", "music", "snapshot", "segments", "effect"}
)


def _unknown_active() -> dict[str, Any]:
    return {
        "mode": "unknown",
        "label": None,
        "confidence": "unknown",
        "source": None,
        "set_at": None,
        "age_seconds": None,
    }


def _age_seconds(set_at: Any) -> int | None:
    """Seconds since ``set_at``, or None if it can't be parsed.

    A malformed timestamp must not blow up the whole merge — it just means
    the age can't be shown, same honesty rule as everything else here.
    ``set_at`` is typed ``str`` on :class:`ledger.ActiveModeEntry`, but that
    dataclass is built from on-disk JSON with no runtime type check on this
    field (``_entry_from_dict`` only guards against missing keys) — a
    corrupted or hand-edited ledger file can hand this a ``null`` or a
    number, which raises ``TypeError`` rather than ``ValueError``.
    """
    try:
        set_dt = datetime.fromisoformat(set_at)
    except (ValueError, TypeError):
        return None
    if set_dt.tzinfo is None:
        set_dt = set_dt.replace(tzinfo=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - set_dt).total_seconds()))


def _entry_active(entry: ledger.ActiveModeEntry, confidence: str) -> dict[str, Any]:
    return {
        "mode": entry.mode,
        "label": entry.label,
        "confidence": confidence,
        "source": entry.source,
        "set_at": entry.set_at,
        "age_seconds": _age_seconds(entry.set_at),
    }


def _basic_confidence(payload: dict[str, Any] | None, state: dict[str, Any]) -> str:
    """Compare the ledger's recorded basic-mode payload to live state.

    Brightness-only writes never touch the ledger (§3.5), so ``payload`` only
    ever carries a ``color_rgb`` or ``color_temp_k`` key when it was written by
    an explicit color/temp command — that's the one field the comparison
    checks. ``payload=None`` (a bare power-on) has nothing to diverge from, so
    there is nothing to disprove: confirmed by default.
    """
    if not payload:
        return "confirmed"
    if "color_rgb" in payload:
        live_rgb = (state.get("color") or {}).get("rgb")
        return "confirmed" if live_rgb == list(payload["color_rgb"]) else "external"
    if "color_temp_k" in payload:
        return "confirmed" if state.get("color_temp_k") == payload["color_temp_k"] else "external"
    return "confirmed"


def overlay_active_mode(target: Resolved, state: dict[str, Any]) -> dict[str, Any]:
    """Merge the ledger's recorded intent onto normalised state (§3.6).

    Must run *after* :func:`apply_echo` — comparing against the echo-applied
    state (not a raw cloud read) means our own just-issued, not-yet-cloud-
    confirmed write compares correctly against the ledger entry it wrote in
    the same request, instead of misreporting "external" purely because the
    cloud hasn't caught up yet.

    Five rules, in order, mirroring §3.6 exactly:

    1. ``online is False`` -> unknown, unconditionally.
    2. ``power is False`` -> off/confirmed, unconditionally — power is the one
       field the cloud always proves outright, so it overrides even a ledger
       that disagrees.
    3. ``power is True`` and the ledger's mode is one of the cloud-unverifiable
       modes (scene/diy/music/snapshot/segments/effect) -> that entry
       verbatim, confidence always "assumed" (never upgraded — see §3.4).
    4. ``power is True`` and the ledger's mode is "basic" (or absent) ->
       compare live brightness/color/temp to the ledger's payload: match is
       "confirmed", divergence is "external" (the phone-app-changed-it case).
    5. No ledger entry at all, or a ledger entry contradicted by live state
       (mode="off" while the device is live and on, or an explicit "unknown"
       write) -> unknown. Never defaults to "basic" — that would itself be an
       unverifiable claim about a device never ledger-recorded.
    """
    online = state.get("online")
    power = state.get("power")

    if online is False:
        active = _unknown_active()
    elif power is False:
        entry = ledger.read_one(target.device_id)
        if entry is not None and entry.mode == "off":
            active = _entry_active(entry, "confirmed")
        else:
            active = {**_unknown_active(), "mode": "off", "confidence": "confirmed"}
    elif power is not True:
        # Power itself couldn't be read (e.g. BLE with no state support) —
        # nothing downstream can be claimed with any confidence either.
        active = _unknown_active()
    else:
        entry = ledger.read_one(target.device_id)
        if entry is None or entry.mode in ("unknown", "off"):
            # No entry, an explicit "unknown" write, or a stale "off" entry
            # that live power now contradicts (rule 2's override runs both
            # directions: the one thing cloud state proves outright wins).
            active = _unknown_active()
        elif entry.mode in _UNVERIFIABLE_MODES:
            active = _entry_active(entry, "assumed")
        else:  # "basic"
            active = _entry_active(entry, _basic_confidence(entry.payload, state))

    return {**state, "active": active}


async def run_blocking(func: Any, *args: Any) -> Any:
    """Run a blocking library call on a worker thread.

    Every requests-based client call goes through here so the event loop never
    blocks, per the spec's sidecar requirements.
    """
    return await anyio.to_thread.run_sync(func, *args)


async def read_state(request: Request, target: Resolved) -> dict[str, Any]:
    """Read device state through the TTL cache, off the event loop."""
    if target.transport == BLE:
        # No BLE state read exists in the library (parse_state is unverified), so
        # there is nothing to fetch — report an empty state the normaliser maps
        # to unknowns rather than fabricated values.
        return {}
    cache = get_state_cache(request)
    cached = cache.get(target.device_id)
    if cached is not None:
        return dict(cached)
    client = get_client(request)
    generation = cache.current_generation()
    raw = await run_blocking(client.get_state, target.sku, target.device_id)
    cache.set(target.device_id, raw, generation=generation)
    return dict(raw)


def invalidate_state(request: Request, target: Resolved) -> None:
    get_state_cache(request).invalidate(target.device_id)


def capabilities_block(spec: ModelSpec | None) -> dict[str, Any]:
    """The capabilities object exactly as WEBUI_SPEC.md §4 defines it."""
    if spec is None:
        return {
            "segments": False, "segment_brightness": False, "scenes": False,
            "diy": False, "music": False, "toggles": [], "temp_min": 2700,
            "temp_max": 9000, "segment_count_cloud": 0, "segment_count_ble": 0,
            "prefer_ble_effects": False, "matrix_rows": 0, "matrix_cols": 0,
            "matrix_wrap_col": False,
        }
    return {
        "segments": spec.cloud_segments,
        "segment_brightness": spec.cloud_segment_brightness,
        "scenes": spec.cloud_scenes,
        "diy": spec.cloud_diy,
        "music": spec.cloud_music,
        "toggles": list(spec.toggles),
        "temp_min": spec.temp_min,
        "temp_max": spec.temp_max,
        "segment_count_cloud": spec.segment_count,
        "segment_count_ble": spec.ble_segment_count,
        "prefer_ble_effects": spec.prefer_ble_effects,
        "matrix_rows": spec.matrix_rows,
        "matrix_cols": spec.matrix_cols,
        "matrix_wrap_col": spec.matrix_wrap_col,
    }


def normalize_state(target: Resolved, raw: dict[str, Any]) -> dict[str, Any]:
    """Convert raw transport state into the spec's normalised shape.

    Only power/brightness/colorRgb/colorTemperatureK/online are reliable reads;
    scene/segment/music instances come back as "" and are ignored. An empty raw
    dict (the BLE path) maps to unknowns — fabricating ``power: false`` would
    misreport an unreachable device as switched off.
    """
    if not raw:
        return {
            "ref": target.name,
            "id": target.device_id,
            "model": target.model,
            "name": target.name,
            "transport": target.transport,
            "online": None,
            "power": None,
            "brightness": None,
            "color": None,
            "color_temp_k": None,
            "capabilities": capabilities_block(target.spec),
        }

    color: dict[str, Any] | None = None
    temp_k: int | None = None

    if target.transport == CLOUD_V1:
        power = str(raw.get("powerState", "")).lower() == "on"
        brightness = _as_int(raw.get("brightness"))
        rgb_dict = raw.get("color") if isinstance(raw.get("color"), dict) else {}
        if rgb_dict:
            r, g, b = (int(rgb_dict.get(k, 0) or 0) for k in ("r", "g", "b"))
            color = _color_out((r << 16) | (g << 8) | b)
        temp_k = _as_int(raw.get("colorTem"))
        online: bool | None = None
    else:
        power = bool(raw.get("powerSwitch"))
        brightness = _as_int(raw.get("brightness"))
        color = _color_out(_as_int(raw.get("colorRgb")))
        temp_k = _as_int(raw.get("colorTemperatureK"))
        online_raw = raw.get("online")
        online = bool(online_raw) if online_raw is not None else None

    return {
        "ref": target.name,
        "id": target.device_id,
        "model": target.model,
        "name": target.name,
        "transport": target.transport,
        "online": online,
        "power": power,
        "brightness": brightness,
        "color": color,
        "color_temp_k": temp_k,
        "capabilities": capabilities_block(target.spec),
    }


def _as_int(value: Any) -> int | None:
    """int-or-None for cloud values that arrive as ints, "" or 0 placeholders."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        as_int = int(value)
        return as_int if as_int > 0 else None
    return None


def _color_out(rgb_int: int | None) -> dict[str, Any] | None:
    if not rgb_int:
        return None
    r, g, b = (rgb_int >> 16) & 0xFF, (rgb_int >> 8) & 0xFF, rgb_int & 0xFF
    return {"hex": f"#{r:02X}{g:02X}{b:02X}", "rgb": [r, g, b]}


def require_v2_feature(target: Resolved, feature: str, supported: bool) -> None:
    """409 when a model cannot carry a feature, with the CLI's own wording."""
    if target.transport != CLOUD_V2:
        raise conflict(
            f"{feature} over the cloud requires a v2-capable model. "
            f"'{target.label}' is model '{target.model or 'unknown'}' "
            f"(transport: {target.transport})."
        )
    if not supported:
        raise conflict(
            f"{feature} is not available on {target.model}. "
            f"The device rejects it with \"devices not support this instance\"."
        )


__all__ = [
    "BLE",
    "CLOUD_V1",
    "CLOUD_V2",
    "Resolved",
    "Settings",
    "TTLCache",
    "V2Client",
    "WriteEcho",
    "apply_echo",
    "capabilities_block",
    "get_client",
    "get_config",
    "get_settings",
    "get_state_cache",
    "get_write_echo",
    "invalidate_state",
    "normalize_state",
    "overlay_active_mode",
    "read_state",
    "record_write",
    "require_v2_feature",
    "resolve_ref",
    "run_blocking",
]
