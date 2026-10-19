"""The one room-scene executor (issue #2), shared by the sidecar, the CLI and the scheduler.

SPINE — signatures and shapes fixed by the main agent; the body is built by the
room area, lifted out of ``webui/api/routers/rooms.py``. Synchronous on purpose:
``govee-cli daemon`` and ``govee-cli room apply`` are synchronous, and the
sidecar calls it through ``run_blocking`` and invalidates its own state caches
afterwards from the returned refs.

Rules it must keep (CLAUDE.md + grill G5/G6/G8):
- ``target.device_cfg is None`` -> that device is skipped with
  ``device not registered``; never resolved to an ad-hoc BLE address.
- Ledger is written only after ALL of a device's steps succeed; a ledger
  failure never fails the step. Any failed step clears that device's ledger
  entry and adds the note ``ledger cleared: partial apply``.
- A DIY step sends the stored ``diy_value`` only after verifying it in the
  device's DIY list (live or disk-cached); otherwise it errors without sending.
- Every request goes through ``GoveeHTTPv2._request`` (metered); no new hooks.
- Nothing here imports from ``webui/``: the CLI and the daemon use this module.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

import structlog

from govee_cli import ledger, room_scenes
from govee_cli.room_scenes import RestoreStep

if TYPE_CHECKING:
    from govee_cli.config import DeviceConfig, GoveeConfig
    from govee_cli.http import GoveeHTTP
    from govee_cli.http_v2 import GoveeHTTPv2
    from govee_cli.ledger import Source
    from govee_cli.room_scenes import CapturedDevice, RoomScene

logger = structlog.get_logger(__name__)

_BASIC_KINDS = frozenset({"power", "color", "temp", "brightness"})
DIY_CACHE_NAME = "diy-list-cache.json"


@dataclass
class DeviceResult:
    ref: str  # the device's display label when registered, else its id
    device_id: str
    ok: bool  # True for a full success AND for a skipped device
    skipped_reason: str | None = None
    error: str | None = None
    # Human-readable extras: "DIY 'old' is now named 'new'",
    # "verified against list cached 13:40", "ledger cleared: partial apply".
    notes: list[str] = field(default_factory=list)


@dataclass
class SceneResult:
    name: str
    ok: bool  # every non-skipped device succeeded
    results: list[DeviceResult]


@dataclass
class RestoreClients:
    """Clients the executor may use. ``v1`` is built per call if None and needed."""

    v2: GoveeHTTPv2 | None
    v1: GoveeHTTP | None = None
    # False in the sidecar's mock mode: mock fakes only the HTTP clients, so a
    # BLE step there would be a real GATT write. Such steps error instead.
    allow_ble: bool = True


class _StepError(Exception):
    """A step failed before anything was sent for it (bad payload, DIY gone,
    list unverifiable). The device's remaining steps may still run."""


def restore_scene(name: str, scene: RoomScene, *, cfg: GoveeConfig,
                  clients: RestoreClients, source: Source) -> SceneResult:
    """Replay ``scene`` one device at a time; one failure never aborts the rest."""
    steps_by_device: dict[str, list[RestoreStep]] = {}
    for device_id, group in itertools.groupby(
        room_scenes.plan_restore(scene), key=lambda s: s.device_id
    ):
        steps_by_device.setdefault(device_id, []).extend(group)

    results = []
    for device in scene.devices:
        try:
            result = _restore_device(
                cfg, clients, device, steps_by_device.get(device.device_id, []), source
            )
        except Exception as e:  # last-resort isolation: never abort the scene
            result = DeviceResult(
                ref=device.device_id, device_id=device.device_id, ok=False,
                error=_message(e),
            )
        results.append(result)
    return SceneResult(name=name, ok=all(r.ok for r in results), results=results)


def _message(e: BaseException) -> str:
    return str(getattr(e, "message", e)) or e.__class__.__name__


def _rate_limit_message(e: Exception, client: Any) -> str:
    retries = getattr(client, "max_retries", None)
    tail = f" after {retries} attempts" if retries else ""
    return f"Govee cloud rate limit (HTTP 429): gave up{tail}. {e}"


def _restore_device(cfg: GoveeConfig, clients: RestoreClients, device: CapturedDevice,
                    steps: list[RestoreStep], source: Source) -> DeviceResult:
    from click import ClickException

    from govee_cli.config import resolve_device_ref
    from govee_cli.exceptions import DeviceNotConfigured
    from govee_cli.transport import resolve_target

    device_id = device.device_id
    # A stored id is never resolved to an ad-hoc BLE address: that fallback is
    # for a MAC a human just typed, not one written by a past capture/author.
    try:
        _mac, device_cfg = resolve_device_ref(cfg, device_id)
    except DeviceNotConfigured:
        return DeviceResult(device_id, device_id, True, skipped_reason="device not registered")
    except Exception as e:
        return DeviceResult(device_id, device_id, False, error=_message(e))
    if device_cfg is None:
        return DeviceResult(device_id, device_id, True, skipped_reason="device not registered")

    label = device_cfg.name or device_id
    if len(steps) == 1 and steps[0].skipped_reason is not None:
        return DeviceResult(label, device_id, True, skipped_reason=steps[0].skipped_reason)

    try:
        cloud_id, model, transport = resolve_target(cfg, device_id)
    except ClickException as e:
        return DeviceResult(label, device_id, False, error=e.format_message())

    ctx = _Ctx(cfg, clients, device_id=cloud_id, model=model or "", transport=transport,
               device_cfg=device_cfg, label=label)
    notes: list[str] = []
    errors: list[str] = []
    for step in steps:
        try:
            _execute_step(ctx, step, notes)
        except _StepError as e:
            errors.append(str(e))  # nothing sent for this step; carry on
        except Exception as e:
            errors.append(_step_failure_text(e, clients))
            # Stop only when more requests would fail the same way: a 429, or a
            # connection/transport failure (network, timeout, BLE connect). An
            # API-level rejection (e.g. GoveeV2Error 400 on the DIY or colour
            # step) leaves the device's other steps to run (G5).
            if _is_transport_failure(e):
                break

    if errors:
        _clear_ledger(device_id)
        notes.append("ledger cleared: partial apply")
        return DeviceResult(label, device_id, False, error="; ".join(errors), notes=notes)

    try:
        ledger.record_mode(device_id, device.mode, device.label, device.payload,
                           source=source)
    except Exception:
        logger.warning("room_restore.ledger.failed", device_id=device_id)
    return DeviceResult(label, device_id, True, notes=notes)


def _is_transport_failure(e: Exception) -> bool:
    import requests

    from govee_cli.exceptions import GoveeError
    from govee_cli.http_v2 import GoveeV2Error, GoveeV2RateLimited

    if isinstance(e, (GoveeV2RateLimited, GoveeError, requests.RequestException,
                      ConnectionError, TimeoutError, OSError)):
        return True
    # GoveeV2Client raises this plain GoveeV2Error when every attempt failed at
    # the network level.
    return isinstance(e, GoveeV2Error) and str(e).startswith("Govee cloud unreachable")


def _step_failure_text(e: Exception, clients: RestoreClients) -> str:
    from govee_cli.http_v2 import GoveeV2RateLimited

    if isinstance(e, GoveeV2RateLimited):
        return _rate_limit_message(e, clients.v2)
    return _message(e)


def _clear_ledger(device_id: str) -> None:
    try:
        ledger.clear_mode(device_id)
    except Exception:
        logger.warning("room_restore.ledger_clear.failed", device_id=device_id)


@dataclass
class _Ctx:
    cfg: GoveeConfig
    clients: RestoreClients
    device_id: str
    model: str
    transport: str
    device_cfg: DeviceConfig
    label: str

    def v2(self) -> GoveeHTTPv2:
        if self.clients.v2 is None:
            raise RuntimeError("the Govee cloud v2 client is unavailable (is GOVEE_API_KEY set?)")
        return self.clients.v2


def _execute_step(ctx: _Ctx, step: RestoreStep, notes: list[str]) -> None:
    from govee_cli.transport import CLOUD_V2

    if step.kind in _BASIC_KINDS:
        _apply_basic(ctx, _basic_command_string(step))
        return

    # scene/diy/music/snapshot/segments are cloud-v2-only features.
    if ctx.transport != CLOUD_V2:
        raise _StepError(
            f"Restoring a {step.kind} needs the cloud v2 transport, but "
            f"'{ctx.label}' resolves to {ctx.transport}."
        )
    client = ctx.v2()
    payload = step.args.get("payload") or {}
    sku, did = ctx.model, ctx.device_id

    if step.kind == "scene":
        from govee_cli.http_v2 import Scene

        label = step.args.get("label")
        if label is None or "scene_id" not in payload or "param_id" not in payload:
            raise _StepError("Captured scene is missing its id — cannot restore.")
        client.set_scene(sku, did, Scene(name=label, param_id=payload["param_id"],
                                         scene_id=payload["scene_id"]))
    elif step.kind == "diy":
        if "diy_value" not in payload:
            raise _StepError("Captured DIY scene is missing its value — cannot restore.")
        value = _verify_diy(ctx, client, step.args.get("label"), payload["diy_value"], notes)
        client.set_diy_scene(sku, did, value)
    elif step.kind == "music":
        if "music_mode" not in payload:
            raise _StepError("Captured music mode is missing its value — cannot restore.")
        client.set_music_mode(sku, did, payload["music_mode"],
                              payload.get("sensitivity", 60))
    elif step.kind == "snapshot":
        if "snapshot_value" not in payload:
            raise _StepError("Captured snapshot is missing its value — cannot restore.")
        client.set_snapshot(sku, did, payload["snapshot_value"])
    elif step.kind == "segments":
        segments = payload.get("segments")
        if not segments:
            raise _StepError("Captured segments have no segment list — cannot restore.")
        rgb = payload.get("rgb")
        brightness = payload.get("brightness")
        if rgb is not None:
            r, g, b = rgb
            client.set_segment_color(sku, did, segments, r, g, b)
        if brightness is not None:
            client.set_segment_brightness(sku, did, segments, brightness)
    else:
        raise _StepError(f"Unrecognised restore step kind: {step.kind!r}")


# ------------------------------------------------------------------ DIY (G5)


def _slug(text: object) -> str:
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def _diy_cache_path() -> Any:
    # Next to room-scenes.json, resolved at call time, so every test or mock
    # that repoints ROOM_SCENES_PATH repoints this too.
    return room_scenes.ROOM_SCENES_PATH.with_name(DIY_CACHE_NAME)


def _read_diy_cache(device_id: str) -> tuple[list[dict], datetime] | None:
    try:
        with open(_diy_cache_path()) as f:
            doc = json.load(f)
        entry = doc[device_id.upper()]
        scenes = [
            {"name": str(x["name"]), "value": int(x["value"])} for x in entry["scenes"]
        ]
        return scenes, datetime.fromisoformat(entry["fetched_at"])
    except Exception:
        return None


def _write_diy_cache(device_id: str, scenes: list[dict]) -> None:
    try:
        path = _diy_cache_path()
        try:
            with open(path) as f:
                doc = json.load(f)
            if not isinstance(doc, dict):
                doc = {}
        except (OSError, ValueError):
            doc = {}
        doc[device_id.upper()] = {
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "scenes": scenes,
        }
        tmp = path.with_suffix(".tmp")
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w") as f:
            json.dump(doc, f)
        os.replace(tmp, path)
    except Exception:
        logger.warning("room_restore.diy_cache.write_failed", device_id=device_id)


def _verify_diy(ctx: _Ctx, client: GoveeHTTPv2, name: str | None, value: int,
                notes: list[str]) -> int:
    """Return the value to send, after checking it against the device's DIY list."""
    from govee_cli.http_v2 import GoveeV2Error, GoveeV2RateLimited

    wanted = name or f"#{value}"
    cached_at: datetime | None = None
    try:
        live = client.get_diy_scenes(ctx.model, ctx.device_id)
        if not live:
            # An empty list is not authoritative: the API also returns [] when
            # the capability is missing from the response. Never cache it.
            raise GoveeV2Error("the DIY list came back empty")
        scenes = [{"name": s.name, "value": s.value} for s in live]
        _write_diy_cache(ctx.device_id, scenes)
    except GoveeV2Error as e:
        reason = (
            _rate_limit_message(e, client) if isinstance(e, GoveeV2RateLimited) else str(e)
        )
        cached = _read_diy_cache(ctx.device_id)
        if cached is None:
            raise _StepError(
                f"could not verify DIY scene '{wanted}' on {ctx.label}: list unavailable "
                f"({reason})"
            ) from e
        scenes, cached_at = cached

    if cached_at is not None:
        stamp = cached_at.astimezone().strftime("%H:%M")
        notes.append(f"verified against list cached {stamp}")

    match = next((s for s in scenes if s["value"] == value), None)
    if match is None:
        raise _StepError(f"DIY scene '{wanted}' no longer exists on {ctx.label}")
    if name and _slug(match["name"]) != _slug(name):
        notes.append(f"DIY '{name}' is now named '{match['name']}'")
    return value


# ------------------------------------------------------------------ basic steps


def _basic_command_string(step: RestoreStep) -> str:
    if step.kind == "power":
        return "power on" if step.args["on"] else "power off"
    if step.kind == "color":
        r, g, b = step.args["rgb"]
        return f"color {r:02X}{g:02X}{b:02X}"
    if step.kind == "temp":
        return f"temp {step.args['kelvin']}"
    return f"brightness {step.args['value']}"


def _apply_basic(ctx: _Ctx, cmd: str) -> None:
    from govee_cli.transport import CLOUD_V1, CLOUD_V2

    if ctx.transport == CLOUD_V2:
        from govee_cli.commands.group import _apply_v2_command

        _apply_v2_command(ctx.v2(), ctx.device_id, ctx.model, cmd)
    elif ctx.transport == CLOUD_V1:
        from govee_cli.commands.group import _apply_http_command

        v1 = ctx.clients.v1
        if v1 is None:
            from govee_cli.http import GoveeHTTP

            v1 = ctx.clients.v1 = GoveeHTTP()
        _apply_http_command(v1, ctx.device_id, ctx.model, cmd)
    else:
        _apply_ble(ctx, cmd)


def _apply_ble(ctx: _Ctx, cmd: str) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.commands._common import Target
    from govee_cli.commands.group import _parse_inline_command

    if not ctx.clients.allow_ble:
        raise _StepError("BLE is disabled in mock mode: nothing sent")
    parsed = _parse_inline_command(cmd, device_model=ctx.model or None)
    if parsed is None:
        raise _StepError(f"Unknown command: {cmd}")
    target = Target(ctx.device_id, ctx.model or None, ctx.transport, ctx.cfg)
    adapter = ctx.cfg.default_adapter or "hci0"
    timeout = ctx.cfg.default_timeout

    async def execute() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter, timeout=timeout) as cl:
            await cl.execute(parsed)

    asyncio.run(execute())
