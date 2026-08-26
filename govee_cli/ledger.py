"""The active-mode ledger — a durable local record of what we last commanded.

The Govee cloud API is structurally blind to scene/DIY/music/segment/effect state:
`/device/state` reports the four basic fields (power, brightness, colorRgb,
colorTemperatureK) reliably, but always reads back an empty string for
`lightScene`/`diyScene`/`musicMode`/`segmentedColorRgb`/`snapshot` regardless of what
the device is actually doing. No polling frequency or heuristic recovers this — it is
a permanent property of the API, not a bug. This module is the only durable memory of
"what we told the device to do," so the web console and CLI can honestly show "DIY:
sleep, assumed, 5s ago" instead of silently rendering stale/wrong basic-mode state.

Storage: one JSON file, `~/.config/govee-cli/active-mode.json`, sibling to
`config.json`/`schedule.json`, keyed by the device's cloud id (not ref/alias — a device
can have many aliases, but the ledger has exactly one entry per physical device).

Concurrency: an exclusive, blocking advisory lock via `filelock.lock_exclusive`
(`fcntl.flock` on POSIX — writes are microseconds, so a brief
wait beats a skipped write) around a read-modify-write, then an atomic `os.replace` so a
concurrent reader always sees a fully-old or fully-new file, never a torn write. Reads
take no lock at all — atomicity of `os.replace` makes that safe.

Never-raise contract: `record_mode` runs *after* the underlying device command has
already succeeded. The user turning on a lamp cares about the lamp, not about our
bookkeeping — a ledger write failure (read-only filesystem, corrupt JSON, whatever) is
logged at WARNING and swallowed, never allowed to look like the command itself failed.
"""

from __future__ import annotations

import json
import os
import pathlib
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Literal, Optional

import structlog

from govee_cli import filelock

logger = structlog.get_logger(__name__)

Mode = Literal[
    "off", "basic", "scene", "diy", "music", "snapshot", "segments", "effect", "unknown"
]
Source = Literal["cli", "webui", "schedule", "group"]

LEDGER_VERSION = 1

# Module-level, overridable the same way config._CONFIG_PATH is — mock.py's install()
# repoints these at a seeded temp dir so demo/test traffic never touches the real file.
LEDGER_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "active-mode.json"
LEDGER_LOCK_PATH = LEDGER_PATH.with_suffix(".json.lock")


@dataclass(frozen=True)
class ActiveModeEntry:
    """One device's last-commanded mode. See module docstring for why this exists."""

    mode: Mode
    label: Optional[str]
    payload: Optional[dict]
    source: Source
    set_at: str  # ISO-8601 UTC, e.g. datetime.now(timezone.utc).isoformat()


def _empty_document() -> dict:
    return {"version": LEDGER_VERSION, "devices": {}}


def _read_document() -> dict:
    """Read and parse the ledger file. Any failure to do so means 'empty ledger' —
    a missing file and a corrupt file are indistinguishable from 'no entries yet',
    which is the correct behavior: both mean mode=unknown to every caller."""
    try:
        with open(LEDGER_PATH) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _empty_document()

    if not isinstance(raw, dict) or not isinstance(raw.get("devices"), dict):
        return _empty_document()
    return raw


def _entry_from_dict(raw: dict) -> Optional[ActiveModeEntry]:
    try:
        return ActiveModeEntry(
            mode=raw["mode"],
            label=raw.get("label"),
            payload=raw.get("payload"),
            source=raw["source"],
            set_at=raw["set_at"],
        )
    except (KeyError, TypeError):
        return None


def record_mode(
    device_id: str,
    mode: Mode,
    label: Optional[str],
    payload: Optional[dict],
    source: Source,
) -> None:
    """Best-effort write of a device's new active mode.

    Must be called AFTER the underlying device command has already succeeded — never
    before. Every failure mode (lock contention timeout aside, since the flock is
    blocking; read-only parent dir; corrupt existing file; disk full on write) is
    caught, logged at WARNING, and swallowed. This function must never raise: the
    caller already got their light command through, and a bookkeeping failure must
    never look like that command failed.
    """
    try:
        _record_mode_unsafe(device_id, mode, label, payload, source)
    except Exception:
        logger.warning(
            "ledger.record_mode.failed",
            device_id=device_id,
            mode=mode,
            source=source,
        )


def _record_mode_unsafe(
    device_id: str,
    mode: Mode,
    label: Optional[str],
    payload: Optional[dict],
    source: Source,
) -> None:
    entry = ActiveModeEntry(
        mode=mode,
        label=label,
        payload=payload,
        source=source,
        set_at=datetime.now(timezone.utc).isoformat(),
    )

    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)

    lock_fd = os.open(LEDGER_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        filelock.lock_exclusive(lock_fd)  # blocking — writes are microseconds

        data = _read_document()
        data["devices"][device_id] = asdict(entry)

        tmp_path = LEDGER_PATH.with_suffix(".json.tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, LEDGER_PATH)  # atomic on ext4: never a torn read
    finally:
        filelock.unlock(lock_fd)
        os.close(lock_fd)


def read_all() -> dict[str, ActiveModeEntry]:
    """Return every device's ledger entry. No lock taken — safe because os.replace
    guarantees any concurrent reader sees a fully-old or fully-new file.

    A missing file, an empty file, or a corrupt-JSON file all produce {} rather than
    raising — 'no ledger entry' is indistinguishable from 'ledger doesn't exist yet',
    which is correct: both mean mode=unknown to every caller.
    """
    try:
        data = _read_document()
        result: dict[str, ActiveModeEntry] = {}
        for device_id, raw in data.get("devices", {}).items():
            entry = _entry_from_dict(raw) if isinstance(raw, dict) else None
            if entry is not None:
                result[device_id] = entry
        return result
    except Exception:
        logger.warning("ledger.read_all.failed")
        return {}


def read_one(device_id: str) -> Optional[ActiveModeEntry]:
    """Return the ledger entry for one device, or None if it has never been recorded."""
    return read_all().get(device_id)


def clear_mode(device_id: str) -> None:
    """Remove a device's ledger entry entirely (not set to mode='unknown' — an absent
    key IS unknown, per read_all's contract). This is the manual "this doesn't look
    right" reset (DELETE /active-mode) — power-off writes mode='off', it does not clear.
    """
    try:
        _clear_mode_unsafe(device_id)
    except Exception:
        logger.warning("ledger.clear_mode.failed", device_id=device_id)


def _clear_mode_unsafe(device_id: str) -> None:
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)

    lock_fd = os.open(LEDGER_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        filelock.lock_exclusive(lock_fd)

        data = _read_document()
        if device_id in data.get("devices", {}):
            del data["devices"][device_id]

            tmp_path = LEDGER_PATH.with_suffix(".json.tmp")
            with open(tmp_path, "w") as f:
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, LEDGER_PATH)
    finally:
        filelock.unlock(lock_fd)
        os.close(lock_fd)
