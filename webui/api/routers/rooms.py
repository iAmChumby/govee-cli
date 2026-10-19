"""Room-scene routes: capture, author, list, delete, and restore several devices at once.

A room scene is not a group broadcast (``groups.py``'s ``POST /groups/{name}/run``):
it restores several devices to several *different* modes in one call, so each
device gets its own restore plan instead of one shared command string. See
``govee_cli/room_scenes.py`` for storage and the pure ``plan_restore()`` table.

This router keeps no send logic. Replaying a scene is
``govee_cli.room_restore.restore_scene`` (shared with ``govee-cli room apply`` and
the scheduler), which also owns the ledger write-through: it records each
device's mode only after all of that device's steps succeeded, and clears it on a
partial apply. The router only builds the clients, and afterwards drops the state
cache and echoes the commanded basics so the next read reports intent.
"""

from __future__ import annotations

import functools
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Request

from govee_cli import ledger, room_restore, room_scenes
from govee_cli.config import GoveeConfig, resolve_device_ref
from govee_cli.exceptions import DeviceNotConfigured
from govee_cli.room_scenes import CapturedDevice, RoomScene
from govee_cli.transport import get_spec

from ..deps import (
    apply_echo,
    get_client_async,
    get_config,
    get_state_cache,
    normalize_state,
    overlay_active_mode,
    read_state,
    record_write,
    resolve_ref,
    run_blocking,
)
from ..errors import ApiError, conflict, not_found
from ..schemas import (
    AuthoredDeviceIn,
    RoomSceneAuthorRequest,
    RoomSceneCaptureRequest,
    RoomSceneRestoreRequest,
    RoomSceneUpdateRequest,
)
from .devices import _echo_fields

router = APIRouter()


@router.get("/rooms")
async def list_rooms() -> dict[str, Any]:
    scenes = await run_blocking(room_scenes.list_scenes)
    return {"scenes": [_scene_summary(name, scene) for name, scene in sorted(scenes.items())]}


@router.post("/rooms")
async def capture_room(request: Request, body: RoomSceneCaptureRequest) -> dict[str, Any]:
    """Capture every registered device's live state plus its ledger-recorded mode.

    Basic fields (power/brightness/color/color_temp_k) come from the same
    read_state -> apply_echo -> normalize_state -> overlay_active_mode chain the
    device routes use, so a device offline or unreadable right now still gets an
    entry (empty state, per list_devices' own "one offline device must not blank
    the grid" rule) rather than being dropped from the capture.

    mode/label/payload are NOT taken from that chain's "active" block — they are
    read straight from ledger.read_one(), copied verbatim, per room_scenes.py's
    CapturedDevice contract. overlay_active_mode's rules can *override* a stale
    ledger entry for display purposes (e.g. power=False always wins); a room
    scene must not inherit that override, or a restore would replay a mode the
    ledger never actually confirmed.

    An unreadable device is captured as ``unknown`` regardless of what the
    ledger last recorded. ``normalize_state`` returns ``power: None`` exactly
    when it could not confirm a reading (an empty ``raw`` dict — a caught
    exception here, or the BLE path's own "nothing to fetch" branch), and its
    own docstring is explicit that fabricating ``power: false`` there "would
    misreport an unreachable device as switched off". Pairing a stale ledger
    mode (say "diy") with a *fabricated* ``power=False, brightness=0`` reading
    would be worse than that single fabrication: `plan_restore()` would emit a
    real "power on, replay diy, set brightness 0" for a device whose actual
    brightness we never saw — a confident-looking all-zero state issued back
    to the device as a real command. So readability gates whether the ledger
    entry is even consulted; an unreadable device only ever captures `unknown`.
    """
    cfg = await run_blocking(get_config)
    captured: list[CapturedDevice] = []
    unknown_refs: list[str] = []

    for mac, _dev_cfg in sorted(cfg.devices.items()):
        target = resolve_ref(cfg, mac)
        try:
            raw = await read_state(request, target)
            state = apply_echo(request, target, normalize_state(target, raw))
            state = overlay_active_mode(target, state)
        except Exception:
            state = {}

        # See the docstring above: state["power"] is None only when the chain
        # above could not confirm a reading, never a real "off".
        readable = state.get("power") is not None
        entry = ledger.read_one(target.device_id) if readable else None
        mode = entry.mode if entry is not None else "unknown"
        label = entry.label if entry is not None else None
        payload = entry.payload if entry is not None else None
        # A colour or colour temperature read from /device/state is only
        # trustworthy when the ledger says this device is in basic mode: state
        # always reports a stale colorTemperatureK (and often a stale colorRgb)
        # for a lamp running a DIY/scene/music/segment/effect. Promoting that
        # stale value into a stored white/colour row is exactly the bug the
        # ledger exists to prevent, one level earlier. For any other mode the
        # basic fields are dropped (None) so plan_restore() never replays a
        # guessed colour.
        if mode == "basic":
            color_rgb = (state.get("color") or {}).get("rgb")
            color_temp_k = state.get("color_temp_k")
        else:
            color_rgb = None
            color_temp_k = None

        captured.append(CapturedDevice(
            device_id=target.device_id,
            model=target.model or "",
            power=bool(state.get("power")),
            brightness=int(state.get("brightness") or 0),
            color=color_rgb,
            color_temp_k=color_temp_k,
            mode=mode,
            label=label,
            payload=payload,
        ))
        if mode == "unknown":
            unknown_refs.append(target.label)

    await run_blocking(room_scenes.save_scene, body.name, captured)
    scene = await run_blocking(room_scenes.read_scene, body.name)
    summary = _scene_summary(body.name, scene) if scene else {
        "name": body.name, "created_at": None, "device_count": len(captured),
        "unknown_count": len(unknown_refs), "source": "captured", "note": None,
        "devices": [asdict(d) for d in captured],
    }
    return {**summary, "unknown": unknown_refs}


@router.post("/rooms/authored", status_code=201)
async def create_authored_room(body: RoomSceneAuthorRequest) -> dict[str, Any]:
    """Create a hand-authored scene (per-device power, brightness, colour / white K / DIY)."""
    cfg = await run_blocking(get_config)
    devices = _authored_to_captured(cfg, body.devices)
    try:
        scene = await run_blocking(room_scenes.save_authored_scene, body.name, devices)
    except room_scenes.SceneExistsError:
        raise conflict(f"Room scene '{body.name}' already exists.") from None
    return _scene_summary(body.name, scene)


@router.put("/rooms/{name}")
async def update_authored_room(name: str, body: RoomSceneUpdateRequest) -> dict[str, Any]:
    """Replace an authored scene's devices. Captured scenes are never edited."""
    existing = await run_blocking(room_scenes.read_scene, name)
    if existing is None:
        raise not_found(f"Room scene '{name}' not found.")
    if existing.source != "authored":
        raise conflict("Captured scenes cannot be edited.")
    cfg = await run_blocking(get_config)
    devices = _authored_to_captured(cfg, body.devices)
    try:
        scene = await run_blocking(room_scenes.replace_authored_scene, name, devices)
    except room_scenes.CapturedSceneError:
        raise conflict("Captured scenes cannot be edited.") from None
    if scene is None:
        raise not_found(f"Room scene '{name}' not found.")
    return _scene_summary(name, scene)


@router.get("/rooms/{name}/references")
async def room_references(name: str) -> dict[str, Any]:
    """Names of the schedule rules that fire this scene (the UI asks before deleting)."""
    from govee_cli.schedule.scheduler import list_rules

    rules = await run_blocking(list_rules)
    return {"name": name, "rules": [r.name for r in rules if r.room_scene == name]}


@router.delete("/rooms/{name}", status_code=204)
async def delete_room(name: str) -> None:
    deleted = await run_blocking(room_scenes.delete_scene, name)
    if not deleted:
        raise not_found(f"Room scene '{name}' not found.")


@router.post("/rooms/{name}/restore")
async def restore_room(
    request: Request, name: str,
    _body: RoomSceneRestoreRequest | None = None,
) -> dict[str, Any]:
    """Replay a room scene through the shared executor.

    ``_body`` is unread; the schema exists so restore options can be added later
    without a breaking change. A failing or skipped device never aborts the rest.
    """
    scene = await run_blocking(room_scenes.read_scene, name)
    if scene is None:
        raise not_found(f"Room scene '{name}' not found.")

    cfg = await run_blocking(get_config)
    try:
        v2: Any = await get_client_async(request)
    except Exception:
        v2 = None  # no API key: devices that need the cloud report it themselves
    # Mock mode fakes only the HTTP clients; a BLE step there would be a real write.
    clients = room_restore.RestoreClients(
        v2=v2, allow_ble=not request.app.state.settings.mock
    )
    result = await run_blocking(functools.partial(
        room_restore.restore_scene, name, scene, cfg=cfg, clients=clients, source="webui",
    ))

    _refresh_after_restore(request, cfg, scene, result)
    return {
        "name": result.name,
        "ok": result.ok,
        "results": [_result_out(r) for r in result.results],
    }


def _result_out(r: room_restore.DeviceResult) -> dict[str, Any]:
    out: dict[str, Any] = {"ref": r.ref, "ok": r.ok}
    if r.error is not None:
        out["error"] = r.error
    if r.skipped_reason is not None:
        out["skipped_reason"] = r.skipped_reason
    if r.notes:
        out["notes"] = r.notes
    return out


def _refresh_after_restore(request: Request, cfg: GoveeConfig, scene: RoomScene,
                           result: room_restore.SceneResult) -> None:
    """Drop cached reads and echo the commanded basics so the next state read
    reports intent while the cloud's read lags behind its write endpoint."""
    steps = room_scenes.plan_restore(scene)
    cache = get_state_cache(request)
    for r in result.results:
        cache.invalidate(r.device_id)
        if not r.ok or r.skipped_reason is not None:
            continue
        try:
            target = resolve_ref(cfg, r.device_id)
        except Exception:
            continue
        if target.device_cfg is None:
            continue
        for step in steps:
            if step.device_id != r.device_id or step.skipped_reason is not None:
                continue
            if step.kind in ("power", "color", "temp", "brightness"):
                verb, arg = room_restore._basic_command_string(step).split(None, 1)
                record_write(request, target, _echo_fields(verb, arg))


def _unprocessable(message: str) -> ApiError:
    return ApiError(422, "unprocessable", message)


def _authored_to_captured(cfg: GoveeConfig, rows: list[AuthoredDeviceIn]) -> list[CapturedDevice]:
    """Validate hand-authored rows against the registry and model specs (422)."""
    out: list[CapturedDevice] = []
    seen: set[str] = set()
    for row in rows:
        try:
            mac, device_cfg = resolve_device_ref(cfg, row.device_id)
        except DeviceNotConfigured:
            raise _unprocessable(f"{row.device_id}: device is not registered.") from None
        if mac in seen:
            raise _unprocessable(f"{row.device_id}: listed more than once.")
        seen.add(mac)
        model = device_cfg.model
        spec = get_spec(model)
        label = device_cfg.name or mac
        if row.power and row.mode == "white":
            if spec is None:
                raise _unprocessable(
                    f"{label}: model '{model}' is unknown, cannot check the white range."
                )
            kelvin = row.color_temp_k or 0
            if not spec.temp_min <= kelvin <= spec.temp_max:
                raise _unprocessable(
                    f"{label}: white must be {spec.temp_min}-{spec.temp_max}K for {model}, "
                    f"got {kelvin}K."
                )
        if row.power and row.mode == "diy" and not (spec and spec.cloud_diy):
            raise _unprocessable(f"{label}: {model} cannot store DIY scenes.")
        data = row.model_dump()
        data["device_id"] = mac
        try:
            out.append(room_scenes.captured_from_authored(data, model))
        except ValueError as e:
            raise _unprocessable(str(e)) from None
    return out


def _scene_summary(name: str, scene: RoomScene) -> dict[str, Any]:
    """One scene as the API reports it — summary counts plus the full capture.

    The captured devices ride along rather than sitting behind a detail route
    because reading them costs nothing upstream: room scenes live in a local
    JSON file, so serving four devices per scene is one file read either way,
    and a per-scene detail route would have turned a page of N cards into N
    extra requests for data we already had in hand.

    It also removes a caveat the UI would otherwise have to live with. Each
    card tints itself from the palette of what it actually captured, and with
    summaries alone that colour would only be available for a scene captured in
    the current session — every scene from a previous one would sit honestly
    grey until recaptured. Sending the devices means the card can always tell
    the truth in colour instead of only sometimes.
    """
    unknown_count = sum(1 for d in scene.devices if d.mode == "unknown")
    return {
        "name": name,
        "created_at": scene.created_at,
        "device_count": len(scene.devices),
        "unknown_count": unknown_count,
        "source": scene.source,
        "note": scene.note,
        "devices": [asdict(d) for d in scene.devices],
    }
