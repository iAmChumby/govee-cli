"""Feature routes over cloud v2: scenes, DIY, snapshots, music, toggles, segments.

Every endpoint gates on the model's ModelSpec first and answers with the CLI's
own error wording, so an unsupported feature reads identically whether it came
from the terminal or the console. Device-level rejections surface verbatim as
409s — the dreamViewToggle lesson: advertise nothing you cannot guarantee.
"""

from __future__ import annotations

import asyncio
import functools
from typing import Any

from fastapi import APIRouter, Query, Request

from govee_cli import ledger
from govee_cli.commands._common import parse_segments
from govee_cli.devices import SUPPORTED_DEVICES
from govee_cli.http_v2 import CAP_TOGGLE
from govee_cli.transport import CLOUD_V2

from ..deps import (
    Resolved,
    get_client_async,
    get_config,
    invalidate_state,
    read_state,
    require_v2_feature,
    resolve_ref,
    run_blocking,
)
from ..errors import bad_request, conflict, not_found
from ..schemas import (
    DiyApplyRequest,
    MusicApplyRequest,
    SceneApplyRequest,
    SegmentsRequest,
    SnapshotApplyRequest,
    ToggleApplyRequest,
)

router = APIRouter()


def _slug(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


async def _target(request: Request, ref: str) -> Resolved:
    cfg = await run_blocking(get_config)
    return resolve_ref(cfg, ref)


# ---------------------------------------------------------------------- scenes


@router.get("/devices/{ref}/scenes")
async def list_scenes(request: Request, ref: str) -> dict[str, Any]:
    """The firmware scene library, served through the client's disk cache."""
    target = await _target(request, ref)
    require_v2_feature(target, "Scenes", bool(target.spec and target.spec.cloud_scenes))
    client = await get_client_async(request)
    cached = await run_blocking(_scenes_served_from_cache, request, target)
    scenes = await run_blocking(client.get_scenes, target.sku, target.device_id)
    return {
        "scenes": [
            {"name": s.name, "param_id": s.param_id, "scene_id": s.scene_id}
            for s in scenes
        ],
        "cached": cached,
    }


def _scenes_served_from_cache(request: Request, target: Resolved) -> bool:
    if request.app.state.settings.mock:
        return target.device_id.upper() in request.app.state.mock_client.scene_cache
    from govee_cli.http_v2 import _read_scene_cache

    return _read_scene_cache(target.device_id, "lightScene") is not None


@router.put("/devices/{ref}/scenes")
async def apply_scene(
    request: Request, ref: str, body: SceneApplyRequest,
    refresh: bool = Query(False, alias="refresh"),
) -> dict[str, Any]:
    """Activate a firmware scene by name. ``?refresh=1`` bypasses the disk cache."""
    target = await _target(request, ref)
    require_v2_feature(target, "Scenes", bool(target.spec and target.spec.cloud_scenes))
    client = await get_client_async(request)

    scene = None
    if refresh:
        options = await run_blocking(functools.partial(
            client.get_scenes, target.sku, target.device_id, use_cache=False
        ))
        wanted = _slug(body.name)
        scene = next((s for s in options if _slug(s.name) == wanted), None)
    else:
        scene = await run_blocking(client.find_scene, target.sku, target.device_id,
                                   body.name)
    if scene is None:
        raise not_found(f"Unknown scene '{body.name}' for {target.model}")

    await run_blocking(client.set_scene, target.sku, target.device_id, scene)
    invalidate_state(request, target)
    # Same mode-selection rule as the CLI's scene.py (§3.3): the resolved scene
    # name is the label — never the raw scene_id, which means nothing to a
    # human reading the console.
    ledger.record_mode(
        target.device_id, "scene", scene.name,
        {"scene_id": scene.scene_id, "param_id": scene.param_id}, source="webui",
    )
    return {"applied": {"name": scene.name, "param_id": scene.param_id,
                        "scene_id": scene.scene_id}}


# ------------------------------------------------------------------------- diy


@router.get("/devices/{ref}/diy")
async def list_diy(request: Request, ref: str) -> dict[str, Any]:
    target = await _target(request, ref)
    require_v2_feature(target, "DIY scenes", bool(target.spec and target.spec.cloud_diy))
    client = await get_client_async(request)
    scenes = await run_blocking(client.get_diy_scenes, target.sku, target.device_id)
    return {"scenes": [{"name": s.name, "value": s.value} for s in scenes]}


@router.put("/devices/{ref}/diy")
async def apply_diy(request: Request, ref: str, body: DiyApplyRequest) -> dict[str, Any]:
    target = await _target(request, ref)
    require_v2_feature(target, "DIY scenes", bool(target.spec and target.spec.cloud_diy))
    client = await get_client_async(request)
    diy = await run_blocking(client.find_diy_scene, target.sku, target.device_id,
                             body.name)
    if diy is None:
        raise not_found(f"Unknown DIY scene '{body.name}' for {target.model}")
    await run_blocking(client.set_diy_scene, target.sku, target.device_id, diy.value)
    invalidate_state(request, target)
    # Same mode-selection rule as the CLI's diy.py (§3.3).
    ledger.record_mode(
        target.device_id, "diy", diy.name, {"diy_value": diy.value}, source="webui",
    )
    return {"applied": {"name": diy.name, "value": diy.value}}


# ------------------------------------------------------------------- snapshots


@router.get("/devices/{ref}/snapshots")
async def list_snapshots(request: Request, ref: str) -> dict[str, Any]:
    """Snapshots saved in the Govee app, read from the device description."""
    target = await _target(request, ref)
    require_v2_feature(target, "Snapshots", True)
    client = await get_client_async(request)
    options = await run_blocking(_snapshot_options, client, target)
    return {"snapshots": [{"name": name, "value": value} for name, value in options]}


class _SnapshotTarget:
    """Adapter so the CLI's ``_snapshot_options`` works against a Resolved."""

    def __init__(self, target: Resolved) -> None:
        self.cloud_model = target.sku
        self.device_id = target.device_id


def _snapshot_options(client: Any, target: Resolved) -> list[tuple[str, int]]:
    from typing import cast

    from govee_cli.commands._common import Target
    from govee_cli.commands.snapshot import _snapshot_options as cli_options

    adapter = _SnapshotTarget(target)
    return cli_options(client, cast(Target, adapter))


@router.put("/devices/{ref}/snapshots")
async def apply_snapshot(request: Request, ref: str,
                         body: SnapshotApplyRequest) -> dict[str, Any]:
    target = await _target(request, ref)
    require_v2_feature(target, "Snapshots", True)
    client = await get_client_async(request)
    options = await run_blocking(_snapshot_options, client, target)

    value: int | None = next(
        (v for name, v in options if name.lower() == body.name_or_id.lower()), None
    )
    if value is None:
        if body.name_or_id.isdigit():
            # A raw numeric id is accepted even when listing is empty — same
            # fallback the CLI offers, since Govee has no snapshot list endpoint.
            value = int(body.name_or_id)
        else:
            available = ", ".join(name for name, _ in options) or "(none saved)"
            raise not_found(f"Unknown snapshot '{body.name_or_id}'. Available: {available}")

    await run_blocking(client.set_snapshot, target.sku, target.device_id, value)
    invalidate_state(request, target)
    # Same mode-selection rule as the CLI's snapshot.py (§3.3): prefer the
    # resolved option name over the raw id, but a bare numeric id with no
    # matching advertised option still gets a readable label.
    resolved_label = next(
        (opt_name for opt_name, opt_value in options if opt_value == value),
        f"snapshot #{value}",
    )
    ledger.record_mode(
        target.device_id, "snapshot", resolved_label,
        {"snapshot_value": value}, source="webui",
    )
    return {"applied": {"name_or_id": body.name_or_id, "value": value}}


# ----------------------------------------------------------------------- music


def _music_modes(target: Resolved) -> dict[str, int]:
    handler = SUPPORTED_DEVICES.get((target.model or "").upper())
    return dict(getattr(handler, "MUSIC_MODES", {}) or {})


@router.get("/devices/{ref}/music")
async def list_music(request: Request, ref: str) -> dict[str, Any]:
    """Per-model music modes. The integers are model-specific by design."""
    target = await _target(request, ref)
    modes = _music_modes(target)
    supported = bool(modes) and bool(target.spec and target.spec.cloud_music)
    return {"modes": [{"key": k, "value": v} for k, v in modes.items()],
            "supported": supported}


@router.put("/devices/{ref}/music")
async def apply_music(request: Request, ref: str,
                      body: MusicApplyRequest) -> dict[str, Any]:
    target = await _target(request, ref)
    modes = _music_modes(target)
    if not modes or not (target.spec and target.spec.cloud_music):
        raise conflict(
            f"{target.model or 'This model'} has no firmware music mode "
            f"('{target.label}'). The device rejects musicMode with "
            f"\"devices not support this instance\"."
        )
    if target.transport != CLOUD_V2:
        raise conflict(
            f"Music mode for {target.model} needs the cloud v2 transport, but "
            f"'{target.label}' resolves to {target.transport}."
        )

    key = body.mode.lower()
    if key not in modes:
        raise bad_request(
            f"Unknown music mode '{body.mode}' for {target.model}. "
            f"Available: {', '.join(modes)}."
        )

    rgb: int | None = None
    auto_color = body.auto_color
    if body.hex:
        r, g, b = _rgb_from_hex(body.hex)
        rgb = (r << 16) | (g << 8) | b
        # A fixed colour implies device-chosen colour is off, matching the CLI;
        # an explicit auto_color still wins.
        if auto_color is None:
            auto_color = False

    client = await get_client_async(request)
    await run_blocking(
        client.set_music_mode, target.sku, target.device_id, modes[key],
        body.sensitivity, auto_color, rgb,
    )
    invalidate_state(request, target)
    # Same mode-selection rule as the CLI's music.py (§3.3): `key` is already
    # the per-model mode NAME ("rhythm", "energic", ...), never the raw int
    # sent over the wire — the same integer means a different mode on a
    # different model, so writing modes[key] as the label would silently
    # mislabel the console on whichever model doesn't share that mapping.
    ledger.record_mode(
        target.device_id, "music", key,
        {"music_mode": modes[key], "sensitivity": body.sensitivity}, source="webui",
    )
    return {"applied": {"mode": key, "sensitivity": body.sensitivity}}


def _rgb_from_hex(hex_color: str) -> tuple[int, int, int]:
    from govee_cli.commands._common import parse_hex

    try:
        return parse_hex(hex_color)
    except Exception as e:
        raise bad_request(str(getattr(e, "message", e))) from e


# --------------------------------------------------------------------- toggles


@router.get("/devices/{ref}/toggles")
async def list_toggles(request: Request, ref: str) -> dict[str, Any]:
    """Verified toggles from the ModelSpec plus advertised-but-unproven ones."""
    target = await _target(request, ref)
    require_v2_feature(target, "Toggles", True)
    verified = list(target.spec.toggles) if target.spec else []

    advertised: list[str] = []
    client = await get_client_async(request)
    device = await run_blocking(client.get_device, target.sku, target.device_id)
    if device is not None:
        advertised = [
            c.instance for c in device.capabilities
            if c.type == CAP_TOGGLE and c.instance not in verified
        ]

    toggles = [{"instance": t, "verified": True} for t in verified]
    toggles += [{"instance": t, "verified": False} for t in advertised]
    return {"toggles": toggles}


@router.put("/devices/{ref}/toggles")
async def apply_toggle(request: Request, ref: str,
                       body: ToggleApplyRequest) -> dict[str, Any]:
    target = await _target(request, ref)
    require_v2_feature(target, "Toggles", True)
    known = list(target.spec.toggles) if target.spec else []
    # Advertised-but-unverified instances are accepted too: the device rejecting
    # one is a real answer (the H6056's dreamViewToggle), never a client error.
    client = await get_client_async(request)
    device = await run_blocking(client.get_device, target.sku, target.device_id)
    if device is not None:
        known += [
            c.instance for c in device.capabilities
            if c.type == CAP_TOGGLE and c.instance not in known
        ]
    wanted = body.instance.lower().removesuffix("toggle")
    instance = next(
        (t for t in known if t.lower() in (body.instance.lower(), f"{wanted}toggle")),
        None,
    )
    if instance is None:
        raise bad_request(
            f"Unknown toggle '{body.instance}' for {target.model}. "
            f"Available: {', '.join(known) or '(none)'}"
        )
    # An advertised-but-unverified toggle reaches the hardware anyway; its
    # rejection comes back as a 409 with the device's own words.
    await run_blocking(client.set_toggle, target.sku, target.device_id, instance, body.on)
    invalidate_state(request, target)
    return {"applied": {"instance": instance, "on": body.on}}


# -------------------------------------------------------------------- segments


@router.post("/devices/{ref}/segments")
async def apply_segments(request: Request, ref: str,
                         body: SegmentsRequest) -> dict[str, Any]:
    """Paint segments and/or set their brightness, over cloud or BLE like the CLI."""
    target = await _target(request, ref)
    spec = target.spec
    on_cloud = target.transport == CLOUD_V2 and bool(spec and spec.cloud_segments)

    if spec:
        segment_count = spec.segment_count if on_cloud else spec.ble_segment_count
        if not segment_count:
            raise conflict(
                f"{spec.model} has no addressable segments — use "
                f"`govee-cli color` / `govee-cli brightness` instead."
            )
    else:
        segment_count = 16

    segments = _parse_segment_selector(body.segments, segment_count)
    rgb = _rgb_from_hex(body.hex) if body.hex else None
    if rgb is None and body.brightness is None:
        raise bad_request("Give a color, brightness, or both.")

    if on_cloud:
        if body.brightness is not None and not (spec and spec.cloud_segment_brightness):
            raise conflict(
                f"{spec.model if spec else 'This model'} does not support "
                f"per-segment brightness. Use `govee-cli brightness` to set the "
                f"whole device."
            )
        client = await get_client_async(request)
        if rgb is not None:
            await run_blocking(client.set_segment_color, target.sku, target.device_id,
                               segments, *rgb)
        if body.brightness is not None:
            await run_blocking(client.set_segment_brightness, target.sku,
                               target.device_id, segments, body.brightness)
    else:
        if body.brightness is not None:
            raise conflict(
                "Per-segment brightness is not available over BLE for this device."
            )
        if rgb is None:
            raise bad_request("A color is required for BLE segment control.")
        await run_blocking(_ble_paint_segments, target, segments, rgb)

    invalidate_state(request, target)
    # Same mode-selection rule as the CLI's segments.py (§3.3): one ledger
    # entry for the whole invocation even though color and brightness are two
    # separate client calls above on the cloud path. The CLI's BLE branch also
    # records (source="cli") — its per-segment loop just has no brightness
    # concept, so `body.brightness` is already guaranteed None there (the
    # conflict raised above if it wasn't) — so this one call correctly covers
    # both paths.
    ledger.record_mode(
        target.device_id, "segments", None,
        {"segments": segments, "rgb": list(rgb) if rgb else None,
         "brightness": body.brightness},
        source="webui",
    )
    state = await read_state(request, target)
    return {
        "applied": {
            "segments": segments,
            "hex": body.hex,
            "brightness": body.brightness,
        },
        "state": state,
    }


def _parse_segment_selector(selector: str | list[int], count: int) -> list[int]:
    if isinstance(selector, str):
        return parse_segments(selector, count)
    if not selector:
        raise bad_request("No segments selected.")
    bad = [s for s in selector if not 0 <= s < count]
    if bad:
        raise bad_request(f"Segment(s) {bad} out of range. Valid range is 0-{count - 1}.")
    seen: set[int] = set()
    unique: list[int] = []
    for segment in selector:
        if segment not in seen:
            seen.add(segment)
            unique.append(segment)
    return unique


def _ble_paint_segments(target: Resolved, segments: list[int],
                        rgb: tuple[int, int, int]) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_segment
    from govee_cli.commands._common import Target

    r, g, b = rgb
    ble_target = Target(target.device_id, target.model, target.transport, target.config)
    adapter = target.config.default_adapter or "hci0"

    async def paint() -> None:
        async with GoveeBLE(ble_target.ble_mac, adapter=adapter) as client:
            for seg in segments:
                await client.send(encode_segment(seg, r, g, b))

    asyncio.run(paint())
