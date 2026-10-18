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
import pathlib
from dataclasses import dataclass
from typing import Literal

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


class SchedulerLock:
    """Held by whichever scheduler owns the schedule.

    ``try_acquire`` never blocks. On success it writes a fresh record; the
    owner calls ``heartbeat`` every cycle and ``release`` on shutdown.
    """

    def __init__(self, kind: OwnerKind, poll_seconds: float, dry_run: bool = False) -> None:
        self.kind = kind
        self.poll_seconds = poll_seconds
        self.dry_run = dry_run

    @property
    def held(self) -> bool:
        raise NotImplementedError

    def try_acquire(self) -> bool:
        raise NotImplementedError

    def heartbeat(self, now: dt.datetime) -> None:
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


def read_owner(now: dt.datetime) -> OwnerView:
    raise NotImplementedError


def previous_last_cycle() -> dt.datetime | None:
    """The ``last_cycle_at`` left by the previous owner, read BEFORE a new owner
    overwrites the record (feeds engine.detect_missed)."""
    raise NotImplementedError


def describe_holder(view: OwnerView) -> str:
    """One line naming the owner for a refused daemon:
    ``schedule owned by sidecar pid 1234 on pop-os since 13:40``."""
    raise NotImplementedError
