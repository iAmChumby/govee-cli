"""Room-scene routes: capture, list, delete, and restore several devices at once.

A room scene is not a group broadcast (``groups.py``'s ``POST /groups/{name}/run``):
it restores several devices to several *different* modes in one call — lamp on
DIY "sleep", bars on a firmware scene, dresser off — so each device gets its own
restore plan instead of one shared command string. See ``govee_cli/room_scenes.py``
(T19) for the storage layer and the pure ``plan_restore()`` dispatch table this
router executes.

The mandatory trap this router exists to avoid: ``groups.py`` deliberately skips
ledger writes for scene/diy/music broadcasts (its own docstring explains why —
a different ``source`` per member would need duplicating the mapping, which it
does). A room-scene restore has no such excuse: if it merely replayed each
device's captured state through the normal command routes without writing the
ledger itself, every restored device would read back ``active.mode == "unknown"``
the instant the request returned, which is exactly the bug the whole ledger
module exists to prevent. So ``_restore_device`` below writes
``ledger.record_mode`` once per device, after that device's steps have all
succeeded, using the very same mode/label/payload the scene captured — those
values are already ledger-shaped (``room_scenes.CapturedDevice`` copies them
verbatim from ``ledger.read_one()`` at capture time), so replaying them back is
not a guess, it is exactly what the ledger recorded the last time this was real.
"""

from __future__ import annotations

import itertools
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Request

from govee_cli import ledger, room_scenes
from govee_cli.commands.group import _apply_http_command, _apply_v2_command
from govee_cli.config import GoveeConfig
from govee_cli.http import GoveeHTTP
from govee_cli.http_v2 import Scene
from govee_cli.room_scenes import CapturedDevice, RestoreStep, RoomScene
from govee_cli.transport import CLOUD_V1, CLOUD_V2

from ..deps import (
    Resolved,
    apply_echo,
    get_client_async,
    get_config,
    invalidate_state,
    normalize_state,
    overlay_active_mode,
    read_state,
    record_write,
    resolve_ref,
    run_blocking,
)
from ..errors import conflict, not_found
from ..schemas import RoomSceneCaptureRequest, RoomSceneRestoreRequest
from .devices import _apply_ble_command, _echo_fields

router = APIRouter()

# Steps whose kind maps directly onto the CLI-style "verb arg" command strings
# _apply_v2_command/_apply_http_command already know how to route per transport
# — same dispatch _basic_control (devices.py) and _apply_to_member (groups.py)
# use, so a restored power/color/temp/brightness step produces the identical
# request a manual control would.
_BASIC_KINDS = frozenset({"power", "color", "temp", "brightness"})


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
        color_rgb = (state.get("color") or {}).get("rgb")

        captured.append(CapturedDevice(
            device_id=target.device_id,
            model=target.model or "",
            power=bool(state.get("power")),
            brightness=int(state.get("brightness") or 0),
            color=color_rgb,
            color_temp_k=state.get("color_temp_k"),
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
        "unknown_count": len(unknown_refs), "devices": [asdict(d) for d in captured],
    }
    return {**summary, "unknown": unknown_refs}


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
    """Replay a captured room scene, one device at a time.

    ``_body`` defaults to ``None`` (no caller is forced to send an empty JSON
    object) rather than a mutable-default model instance (ruff B008), and is
    unread — the schema exists so restore options can be added later without
    a breaking change (see its own docstring), not because anything on it
    matters yet.

    A failing or skipped device must not abort the rest — each device gets its
    own try/except and its own entry in ``results``, mirroring the group
    broadcast route's per-member error isolation (``groups.py``'s
    ``run_group_command``).
    """
    scene = await run_blocking(room_scenes.read_scene, name)
    if scene is None:
        raise not_found(f"Room scene '{name}' not found.")

    cfg = await run_blocking(get_config)
    steps_by_device = _group_steps_by_device(room_scenes.plan_restore(scene))

    results: list[dict[str, Any]] = []
    for device in scene.devices:
        result = await _restore_device(
            request, cfg, device, steps_by_device.get(device.device_id, [])
        )
        results.append(result)

    return {"name": name, "ok": all(r["ok"] for r in results), "results": results}


def _group_steps_by_device(steps: list[RestoreStep]) -> dict[str, list[RestoreStep]]:
    grouped: dict[str, list[RestoreStep]] = {}
    for device_id, group in itertools.groupby(steps, key=lambda s: s.device_id):
        grouped.setdefault(device_id, []).extend(group)
    return grouped


async def _restore_device(request: Request, cfg: GoveeConfig, device: CapturedDevice,
                          steps: list[RestoreStep]) -> dict[str, Any]:
    # resolve_ref itself can raise (a device that used to be registered and is
    # now misconfigured hits resolve_target's ClickException/conflict path) —
    # that must not abort every other device in the scene either, so it goes
    # through the same isolation as a step failure below rather than being
    # called ahead of the try.
    try:
        target = resolve_ref(cfg, device.device_id)
    except Exception as e:
        message = str(getattr(e, "message", e)) or e.__class__.__name__
        return {"ref": device.device_id, "ok": False, "error": message}

    # A captured device_id that resolve_ref can no longer find in the live
    # registry falls back to its "ad-hoc address, still drivable over BLE"
    # branch (device_cfg=None) — deliberate for a MAC a human just typed at
    # the CLI, but a room scene's device_id was written by a *past* capture,
    # not typed just now. Replaying it against "whatever answers that BLE
    # address today" would send a real command based on a stale, unverified
    # reference — precisely the kind of confident-looking guess the ledger's
    # whole honesty rule exists to forbid, and a hard-rule violation waiting
    # to happen the moment a captured device is renamed or deregistered. Fail
    # this device instead of guessing.
    if target.device_cfg is None:
        return {
            "ref": device.device_id, "ok": False,
            "error": "device is no longer registered — refusing to guess a BLE address",
        }

    # plan_restore() emits exactly one step, already marked, for a device whose
    # captured mode was effect/unknown — nothing to execute, and reporting it
    # as a plain failure would bury the actual reason under a generic error.
    if len(steps) == 1 and steps[0].skipped_reason is not None:
        return {"ref": target.label, "ok": True, "skipped_reason": steps[0].skipped_reason}

    try:
        for step in steps:
            await _execute_step(request, target, step)
        # The trap this task exists to close: without this write, every
        # restored device reads back mode=unknown the instant this request
        # returns, because none of the command routes below know they were
        # called from a room-scene restore rather than a manual control.
        ledger.record_mode(
            device.device_id, device.mode, device.label, device.payload,
            source="webui",
        )
        invalidate_state(request, target)
        return {"ref": target.label, "ok": True}
    except Exception as e:
        message = str(getattr(e, "message", e)) or e.__class__.__name__
        return {"ref": target.label, "ok": False, "error": message}


async def _execute_step(request: Request, target: Resolved, step: RestoreStep) -> None:
    if step.kind in _BASIC_KINDS:
        await _apply_basic_step(request, target, step)
        return

    # scene/diy/music/snapshot/segments are cloud-v2-only features (per
    # CLAUDE.md's per-model transport table) — a captured device that has
    # since lost its v2 registration fails honestly here rather than silently
    # doing nothing.
    if target.transport != CLOUD_V2:
        raise conflict(
            f"Restoring a {step.kind} needs the cloud v2 transport, but "
            f"'{target.label}' resolves to {target.transport}."
        )
    client = await get_client_async(request)
    payload = step.args.get("payload") or {}

    if step.kind == "scene":
        label = step.args.get("label")
        if label is None or "scene_id" not in payload or "param_id" not in payload:
            raise ValueError("Captured scene is missing its id — cannot restore.")
        scene = Scene(name=label, param_id=payload["param_id"],
                      scene_id=payload["scene_id"])
        await run_blocking(client.set_scene, target.sku, target.device_id, scene)
    elif step.kind == "diy":
        if "diy_value" not in payload:
            raise ValueError("Captured DIY scene is missing its value — cannot restore.")
        await run_blocking(client.set_diy_scene, target.sku, target.device_id,
                           payload["diy_value"])
    elif step.kind == "music":
        if "music_mode" not in payload:
            raise ValueError("Captured music mode is missing its value — cannot restore.")
        await run_blocking(client.set_music_mode, target.sku, target.device_id,
                           payload["music_mode"], payload.get("sensitivity", 60))
    elif step.kind == "snapshot":
        if "snapshot_value" not in payload:
            raise ValueError("Captured snapshot is missing its value — cannot restore.")
        await run_blocking(client.set_snapshot, target.sku, target.device_id,
                           payload["snapshot_value"])
    elif step.kind == "segments":
        segments = payload.get("segments")
        if not segments:
            raise ValueError("Captured segments have no segment list — cannot restore.")
        rgb = payload.get("rgb")
        brightness = payload.get("brightness")
        if rgb is not None:
            r, g, b = rgb
            await run_blocking(client.set_segment_color, target.sku, target.device_id,
                               segments, r, g, b)
        if brightness is not None:
            await run_blocking(client.set_segment_brightness, target.sku,
                               target.device_id, segments, brightness)
    else:
        raise ValueError(f"Unrecognised restore step kind: {step.kind!r}")


async def _apply_basic_step(request: Request, target: Resolved, step: RestoreStep) -> None:
    cmd = _basic_command_string(step)
    if target.transport == CLOUD_V2:
        client = await get_client_async(request)
        await run_blocking(_apply_v2_command, client, target.device_id, target.sku, cmd)
    elif target.transport == CLOUD_V1:
        await run_blocking(_apply_v1_command, target, cmd)
    else:
        await run_blocking(_apply_ble_command, target, cmd)
    verb, arg = cmd.split(None, 1)
    record_write(request, target, _echo_fields(verb, arg))


def _basic_command_string(step: RestoreStep) -> str:
    if step.kind == "power":
        return "power on" if step.args["on"] else "power off"
    if step.kind == "color":
        r, g, b = step.args["rgb"]
        return f"color {r:02X}{g:02X}{b:02X}"
    if step.kind == "temp":
        return f"temp {step.args['kelvin']}"
    return f"brightness {step.args['value']}"


def _apply_v1_command(target: Resolved, cmd: str) -> None:
    _apply_http_command(GoveeHTTP(), target.device_id, target.sku, cmd)


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
        "devices": [asdict(d) for d in scene.devices],
    }
