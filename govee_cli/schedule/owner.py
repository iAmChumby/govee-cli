"""Who owns the schedule: one lock, one heartbeat (issue #2).

SPINE — signatures and shapes fixed by the main agent; bodies built by the core
area.

The lock (``OWNER_LOCK_PATH``) is held for the life of a scheduler process
through a non-blocking exclusive lock; the OS releases it when the process
dies, so a crashed owner never blocks a successor. The heartbeat file
(``OWNER_PATH``) is evidence only: a reader reports ``running`` only if the
recorded pid is alive on this host AND ``now - last_cycle_at <= 3 x
poll_seconds``. Otherwise ``stale`` (with ``stale_since``), or ``nobody``
when there is no file. An unreadable file is ``unknown``, never "fine".
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import socket
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any, Literal

import structlog

from govee_cli import filelock

logger = structlog.get_logger(__name__)

OWNER_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "scheduler-owner.json"
OWNER_LOCK_PATH = OWNER_PATH.with_suffix(".json.lock")

STALE_FACTOR = 3

OwnerKind = Literal["sidecar", "daemon"]
OwnerState = Literal["running", "stale", "nobody", "unknown"]


@dataclass
class OwnerRecord:
    kind: OwnerKind
    dry_run: bool  # True in mock mode: computes and records "would fire", sends nothing
    pid: int
    host: str
    started_at: str  # ISO-8601 UTC
    last_cycle_at: str | None  # ISO-8601 UTC
    poll_seconds: float


@dataclass(frozen=True)
class OwnerView:
    state: OwnerState
    record: OwnerRecord | None
    stale_since: dt.datetime | None  # set iff state == "stale" (the last_cycle_at)
    detail: str | None  # e.g. "pid 4211 is not running"


def _utc_iso(when: dt.datetime) -> str:
    return when.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat()


def _parse_iso(text: str | None) -> dt.datetime | None:
    if not text:
        return None
    try:
        value = dt.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value


def _pid_alive(pid: int) -> bool:
    """Is ``pid`` a running process on this host? Never signals the process."""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined,unused-ignore]
        handle = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            # 5 = ACCESS_DENIED: the process exists but is not ours to query.
            return bool(kernel32.GetLastError() == 5)
        try:
            code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return bool(code.value == 259)  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _record_from_json(raw: Any) -> OwnerRecord:
    if not isinstance(raw, dict):
        raise ValueError("owner file is not a JSON object")
    return OwnerRecord(
        kind=raw["kind"],
        dry_run=bool(raw.get("dry_run", False)),
        pid=int(raw["pid"]),
        host=str(raw["host"]),
        started_at=str(raw["started_at"]),
        last_cycle_at=raw.get("last_cycle_at"),
        poll_seconds=float(raw["poll_seconds"]),
    )


def _write_record(record: OwnerRecord) -> None:
    path = OWNER_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(asdict(record), f, indent=2)
    last: OSError | None = None
    for _ in range(5):  # Windows refuses a replace while a reader has it open
        try:
            os.replace(tmp, path)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.02)
    assert last is not None
    raise last


class SchedulerLock:
    """Held by whichever scheduler owns the schedule.

    ``try_acquire`` never blocks. On success it writes a fresh record; the
    owner calls ``heartbeat`` every cycle and ``release`` on shutdown.

    The lock is the OS-level advisory lock on ``OWNER_LOCK_PATH``, held through
    an open fd for the life of the owner. Acquire and release must happen on
    the same thread (the in-process mutex in ``filelock`` is an RLock).
    """

    def __init__(self, kind: OwnerKind, poll_seconds: float, dry_run: bool = False) -> None:
        self.kind = kind
        self.poll_seconds = poll_seconds
        self.dry_run = dry_run
        self._fd: int | None = None
        self._key = ""
        self._record: OwnerRecord | None = None

    @property
    def held(self) -> bool:
        return self._fd is not None

    def try_acquire(self) -> bool:
        if self._fd is not None:
            return True
        lock_path = OWNER_LOCK_PATH
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        key = str(lock_path)
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            got = filelock.try_lock_exclusive(fd, key)
        except BaseException:
            os.close(fd)
            raise
        if not got:
            os.close(fd)
            return False
        self._fd, self._key = fd, key
        self._record = OwnerRecord(
            kind=self.kind,
            dry_run=self.dry_run,
            pid=os.getpid(),
            host=socket.gethostname(),
            started_at=_utc_iso(dt.datetime.now(dt.timezone.utc)),
            last_cycle_at=None,
            poll_seconds=self.poll_seconds,
        )
        try:
            _write_record(self._record)
        except OSError as exc:
            logger.warning("owner_record_write_failed", error=str(exc))
        return True

    def heartbeat(self, now: dt.datetime) -> None:
        if self._fd is None or self._record is None:
            return
        self._record.last_cycle_at = _utc_iso(now)
        try:
            _write_record(self._record)
        except OSError as exc:
            logger.warning("owner_heartbeat_failed", error=str(exc))

    def release(self) -> None:
        if self._fd is None:
            return
        fd, key, record = self._fd, self._key, self._record
        self._fd, self._record = None, None
        try:
            # Remove the record BEFORE unlocking so a successor's fresh record
            # is never deleted by us; only delete a record that is still ours.
            try:
                current = _record_from_json(json.loads(OWNER_PATH.read_text(encoding="utf-8")))
                if record is None or (current.pid == record.pid and current.host == record.host):
                    OWNER_PATH.unlink()
            except (OSError, ValueError, KeyError, TypeError):
                pass
        finally:
            filelock.unlock(fd, key)
            os.close(fd)


def _read_record() -> tuple[OwnerRecord | None, str | None]:
    """(record, error). ``(None, None)`` means no file."""
    try:
        text = OWNER_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        return None, f"owner file unreadable: {exc}"
    try:
        return _record_from_json(json.loads(text)), None
    except (ValueError, KeyError, TypeError) as exc:
        return None, f"owner file corrupt: {exc!r}"


def read_owner(now: dt.datetime) -> OwnerView:
    record, error = _read_record()
    if error is not None:
        return OwnerView("unknown", None, None, error)
    if record is None:
        return OwnerView("nobody", None, None, None)

    last = _parse_iso(record.last_cycle_at) or _parse_iso(record.started_at)
    if last is None:
        return OwnerView("unknown", record, None, "owner file has no readable timestamp")

    if record.host != socket.gethostname():
        return OwnerView(
            "unknown", record, None,
            f"record written on host {record.host}; pid {record.pid} cannot be checked here",
        )

    if not _pid_alive(record.pid):
        return OwnerView("stale", record, last, f"pid {record.pid} is not running")

    age = (now - last).total_seconds()
    if age > STALE_FACTOR * record.poll_seconds:
        return OwnerView("stale", record, last, f"no heartbeat for {int(age)}s")
    return OwnerView("running", record, None, None)


def previous_last_cycle() -> dt.datetime | None:
    """The ``last_cycle_at`` left by the previous owner, read BEFORE a new owner
    overwrites the record (feeds engine.detect_missed)."""
    record, _ = _read_record()
    if record is None:
        return None
    return _parse_iso(record.last_cycle_at) or _parse_iso(record.started_at)


def describe_holder(view: OwnerView) -> str:
    """One line naming the owner for a refused daemon:
    ``schedule owned by sidecar pid 1234 on pop-os since 13:40``."""
    record = view.record
    if record is None:
        return "schedule owner unknown" if view.state == "unknown" else "schedule has no owner"
    since = _parse_iso(record.started_at)
    when = f" since {since.astimezone():%H:%M}" if since else ""
    return f"schedule owned by {record.kind} pid {record.pid} on {record.host}{when}"
