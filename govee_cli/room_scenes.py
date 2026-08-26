"""Room scenes — capture and restore several devices' modes as one named group.

A room scene is a different thing from a `groups` entry in config.json: a group
broadcasts one command string to several devices (`govee-cli power on --group
bedroom`), while a room scene restores several devices to several *different*
modes at once (lamp on DIY "sleep", bars on a firmware scene, dresser off). They
share nothing structurally, which is why this is a new file rather than a field
on `GoveeConfig` — see WEBUI_V3_SPEC.md §10, task T19.

Storage: `~/.config/govee-cli/room-scenes.json`, sibling to `config.json` and
`active-mode.json`, keyed by scene name. Concurrency and the never-raise contract
are identical to `ledger.py` — flock-guarded read-modify-write, atomic
`os.replace`, and every public write/read function swallows its own failures
(logged at WARNING) rather than raising, because a room-scene bookkeeping error
must never look like a light command failed.

`plan_restore()` is the one function in this module that touches no disk and
makes no client call. That purity is deliberate: it is what lets the mode-dispatch
table below (the honesty-critical part of this task) be tested without hardware,
a mock client, or even a filesystem. The device that actually issues the client
calls `plan_restore()` describes lives in the sidecar route that calls this
module (T22), not here.
"""

from __future__ import annotations

import json
import os
import pathlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Optional

import structlog

from govee_cli import filelock
from govee_cli.ledger import Mode

logger = structlog.get_logger(__name__)

ROOM_SCENES_VERSION = 1

# Module-level, overridable exactly as ledger.LEDGER_PATH is — a test or the
# sidecar's mock install() repoints these at a temp dir.
ROOM_SCENES_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "room-scenes.json"
ROOM_SCENES_LOCK_PATH = ROOM_SCENES_PATH.with_suffix(".json.lock")


@dataclass(frozen=True)
class CapturedDevice:
    """One device's state as captured into a room scene.

    `power`/`brightness`/`color`/`color_temp_k` come from live device state at
    capture time. `mode`/`label`/`payload` are copied verbatim from
    `ledger.read_one()` — this module never guesses a mode, it only ever
    transcribes what the ledger already recorded (or "unknown" when there was
    no entry, per the ledger's own contract).
    """

    device_id: str
    model: str
    power: bool
    brightness: int
    color: Optional[list[int]]
    color_temp_k: Optional[int]
    mode: Mode
    label: Optional[str]
    payload: Optional[dict]


@dataclass(frozen=True)
class RoomScene:
    """A named capture of several devices, ready to be replayed by plan_restore()."""

    created_at: str  # ISO-8601 UTC
    devices: list[CapturedDevice]


@dataclass(frozen=True)
class RestoreStep:
    """One action to take (or explicitly not take) while restoring a device.

    `kind` mirrors the captured `mode` for scene/diy/music/snapshot/segments/
    effect/unknown, and is "power"/"color"/"temp"/"brightness" for the
    basic-mode pieces — see the dispatch table in plan_restore()'s docstring.
    `skipped_reason` is None for every step that should actually be executed;
    when it is set, `args` is empty and the caller must not issue any client
    call for this step.
    """

    device_id: str
    model: str
    kind: str
    args: dict
    skipped_reason: Optional[str]


def _empty_document() -> dict:
    return {"version": ROOM_SCENES_VERSION, "scenes": {}}


def _read_document() -> dict:
    """Read and parse the room-scenes file. Any failure to do so means 'no
    scenes saved yet' — a missing file and a corrupt file are indistinguishable
    from an empty store, which is the only sane fallback for a store nothing
    downstream can repair automatically."""
    try:
        with open(ROOM_SCENES_PATH) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _empty_document()

    if not isinstance(raw, dict) or not isinstance(raw.get("scenes"), dict):
        return _empty_document()
    return raw


def _captured_device_from_dict(raw: dict) -> Optional[CapturedDevice]:
    try:
        return CapturedDevice(
            device_id=raw["device_id"],
            model=raw["model"],
            power=raw["power"],
            brightness=raw["brightness"],
            color=raw.get("color"),
            color_temp_k=raw.get("color_temp_k"),
            mode=raw["mode"],
            label=raw.get("label"),
            payload=raw.get("payload"),
        )
    except (KeyError, TypeError):
        return None


def _room_scene_from_dict(raw: dict) -> Optional[RoomScene]:
    try:
        raw_devices = raw["devices"]
        if not isinstance(raw_devices, list):
            return None
        devices = []
        for raw_device in raw_devices:
            device = (
                _captured_device_from_dict(raw_device)
                if isinstance(raw_device, dict)
                else None
            )
            if device is None:
                return None
            devices.append(device)
        return RoomScene(created_at=raw["created_at"], devices=devices)
    except (KeyError, TypeError):
        return None


def save_scene(name: str, devices: list[CapturedDevice]) -> None:
    """Best-effort write of a room scene, replacing any existing scene of the
    same name. Never raises — see module docstring."""
    try:
        _save_scene_unsafe(name, devices)
    except Exception:
        logger.warning("room_scenes.save_scene.failed", name=name)


def _save_scene_unsafe(name: str, devices: list[CapturedDevice]) -> None:
    scene = RoomScene(created_at=datetime.now(timezone.utc).isoformat(), devices=devices)

    ROOM_SCENES_PATH.parent.mkdir(parents=True, exist_ok=True)

    lock_fd = os.open(ROOM_SCENES_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        # blocking — writes are microseconds
        filelock.lock_exclusive(lock_fd, str(ROOM_SCENES_LOCK_PATH))

        data = _read_document()
        data["scenes"][name] = {
            "created_at": scene.created_at,
            "devices": [asdict(d) for d in scene.devices],
        }

        tmp_path = ROOM_SCENES_PATH.with_suffix(".json.tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, ROOM_SCENES_PATH)  # atomic on ext4: never a torn read
    finally:
        filelock.unlock(lock_fd, str(ROOM_SCENES_LOCK_PATH))
        os.close(lock_fd)


def list_scenes() -> dict[str, RoomScene]:
    """Return every saved room scene, keyed by name. No lock taken — safe
    because os.replace guarantees a concurrent reader sees a fully-old or
    fully-new file. A missing, empty, or corrupt-JSON file all yield {}."""
    try:
        data = _read_document()
        result: dict[str, RoomScene] = {}
        for name, raw in data.get("scenes", {}).items():
            scene = _room_scene_from_dict(raw) if isinstance(raw, dict) else None
            if scene is not None:
                result[name] = scene
        return result
    except Exception:
        logger.warning("room_scenes.list_scenes.failed")
        return {}


def read_scene(name: str) -> Optional[RoomScene]:
    """Return one saved room scene by name, or None if it does not exist."""
    return list_scenes().get(name)


def delete_scene(name: str) -> bool:
    """Best-effort delete of a room scene by name. Returns True if a scene of
    that name existed and was removed, False if there was nothing to delete
    (including when the delete itself failed — never raises)."""
    try:
        return _delete_scene_unsafe(name)
    except Exception:
        logger.warning("room_scenes.delete_scene.failed", name=name)
        return False


def _delete_scene_unsafe(name: str) -> bool:
    ROOM_SCENES_PATH.parent.mkdir(parents=True, exist_ok=True)

    lock_fd = os.open(ROOM_SCENES_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        filelock.lock_exclusive(lock_fd, str(ROOM_SCENES_LOCK_PATH))

        data = _read_document()
        if name not in data.get("scenes", {}):
            return False
        del data["scenes"][name]

        tmp_path = ROOM_SCENES_PATH.with_suffix(".json.tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, ROOM_SCENES_PATH)
        return True
    finally:
        filelock.unlock(lock_fd, str(ROOM_SCENES_LOCK_PATH))
        os.close(lock_fd)


def plan_restore(scene: RoomScene) -> list[RestoreStep]:
    """Turn a captured RoomScene into an ordered list of steps to execute.

    Pure — no I/O, no client calls. That is what makes the dispatch table below
    testable without a device: given a RoomScene value, the output is entirely
    determined by it.

    Per device, in order: power first, then the mode-specific step(s), then
    brightness last (a scene/DIY/segments write resets brightness on these
    models, so setting it before the mode step would just have it clobbered).

    Dispatch on captured `mode`:
      off              power off, nothing else
      basic            power on, then colour OR temp (never both — captured
                       mutually exclusively, same as the device itself), then
                       brightness
      scene/diy/music/
      snapshot         power on, apply by label (kind mirrors the mode name,
                       args carries label + the captured payload needed to
                       reissue the command), then brightness
      segments         power on, replay the captured per-segment payload, then
                       brightness
      effect           skipped — effects are live playback, not a device state,
                       so there is nothing durable to restore *to*
      unknown          skipped — the ledger had no entry for this device when
                       the scene was captured, so restoring it would mean
                       inventing a mode. That is exactly the bug the ledger
                       exists to prevent, one abstraction up: an `unknown`
                       captured device stays `unknown`, and the caller is told
                       why so a real client call is never made on a guess.
    """
    steps: list[RestoreStep] = []
    for device in scene.devices:
        steps.extend(_plan_device(device))
    return steps


def _plan_device(device: CapturedDevice) -> list[RestoreStep]:
    device_id, model = device.device_id, device.model

    if device.mode == "off":
        return [RestoreStep(device_id, model, "power", {"on": False}, None)]

    if device.mode == "effect":
        return [
            RestoreStep(
                device_id, model, "effect", {},
                skipped_reason="effects are live playback, not a device state",
            )
        ]

    if device.mode == "unknown":
        return [
            RestoreStep(
                device_id, model, "unknown", {},
                skipped_reason="mode was unknown when this room scene was captured",
            )
        ]

    steps = [RestoreStep(device_id, model, "power", {"on": True}, None)]

    if device.mode == "basic":
        if device.color is not None:
            steps.append(RestoreStep(device_id, model, "color", {"rgb": device.color}, None))
        elif device.color_temp_k is not None:
            steps.append(
                RestoreStep(device_id, model, "temp", {"kelvin": device.color_temp_k}, None)
            )
    elif device.mode in ("scene", "diy", "music", "snapshot"):
        steps.append(
            RestoreStep(
                device_id, model, device.mode,
                {"label": device.label, "payload": device.payload}, None,
            )
        )
    elif device.mode == "segments":
        steps.append(
            RestoreStep(device_id, model, "segments", {"payload": device.payload}, None)
        )

    steps.append(
        RestoreStep(device_id, model, "brightness", {"value": device.brightness}, None)
    )
    return steps
