"""The request meter — measured counts of outbound Govee API traffic, nothing invented.

Why this exists (WEBUI_V3_SPEC.md §10.1-10.2): four registered devices means four
upstream `read_state()` calls per poll, and there is no batch endpoint that changes
that. Whether 24 req/min matters is unknown, because Govee v2 publishes no rate limit
and returns no rate-limit headers. This module replaces that guess with a number:
requests today, requests in the last minute, requests in the last hour, and whether a
429 has actually been seen. It never renders a percentage against a limit we made up —
the one exception is `request_budget_per_day` in config, which is opt-in and, when
set, is explicitly the *user's* number, not ours (see `budget_per_day` in the meter
route this module feeds).

v1 and v2 are metered separately and are never summed into one figure — they are
different APIs with (as far as we know) different quotas, verified live per the spec's
addendum. Every retry counts as its own request: `_request`'s retry loop issues a
fresh `requests.request` per attempt, and each attempt calls `record()` once.

Storage: one JSON file, `~/.config/govee-cli/request-meter.json`, sibling to
`config.json`/`active-mode.json`. Concurrency and the never-raise contract mirror
`ledger.py` exactly: an exclusive, blocking advisory lock (`filelock.lock_exclusive`,
which is `fcntl.flock` on POSIX) around a read-modify-write,
a `.tmp` sibling + `os.replace` for an atomic swap (no `fsync` — see the flush
itself for why this file diverges from the ledger there), and every
failure caught, logged at WARNING, and swallowed — a meter write must never turn a
successful device command into an error.

Buffering is the one thing `ledger.py` doesn't need and this module does:
`playback.py`'s cloud loop calls `record()` once per changed-colour group per frame,
so a lock-and-write per call would slow down the exact loop the meter is supposed to
be measuring. `record()` instead accumulates counts in a module-level dict under a
plain `threading.Lock` and only touches disk when a time or count threshold is
crossed, merging into the on-disk totals by *addition* so the CLI, the sidecar and the
scheduler daemon — three independent processes, per §10.3 — all writing concurrently
sum correctly instead of clobbering each other.
"""

from __future__ import annotations

import atexit
import json
import os
import pathlib
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

import structlog

from govee_cli import filelock

logger = structlog.get_logger(__name__)

Api = Literal["v1", "v2"]

METER_VERSION = 1

# Module-level, overridable the same way ledger.LEDGER_PATH is — mock.py's install()
# repoints these at a seeded temp dir so a verification run never inflates the real
# counts the running console displays.
METER_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "request-meter.json"
METER_LOCK_PATH = METER_PATH.with_suffix(".json.lock")

FLUSH_INTERVAL = 2.0  # seconds, wall-clock via time.monotonic()
FLUSH_MAX = 20  # buffered record() calls

_DAY_RETENTION = 30
_MINUTE_RETENTION = 180  # 3h at minute resolution

_buffer_lock = threading.Lock()
# day -> {"v2": n, "v1": n, "rate_limited": n, "errors": n}
_buffer_days: dict[str, dict[str, int]] = {}
# minute ("%Y-%m-%dT%H:%M") -> {"v2": n, "v1": n}
_buffer_minutes: dict[str, dict[str, int]] = {}
_buffered = 0
# 0.0 so the first record() in a short-lived process (a one-shot CLI command) flushes
# immediately rather than waiting out FLUSH_INTERVAL against a process that is about
# to exit anyway.
_last_flush = 0.0


@dataclass(frozen=True)
class MeterSnapshot:
    """A read of measured traffic. See module docstring — never a percentage of an
    invented limit; `budget_per_day` (if the caller wants one) lives in config and is
    applied by the reader, not stored here."""

    day: str
    v2_today: int
    v1_today: int
    rate_limited_today: int
    errors_today: int
    v2_last_minute: int
    v2_last_hour: int
    minutes: list[tuple[str, int]]  # last 60 v2-count buckets, oldest first, zero-filled


def _empty_document() -> dict:
    return {"version": METER_VERSION, "days": {}, "minutes": {}}


def _read_document() -> dict:
    """Read and parse the meter file. Any failure to do so means 'no traffic
    recorded yet' — a missing file, an empty file and a corrupt file are all
    indistinguishable from a fresh meter, which is the correct fallback."""
    try:
        with open(METER_PATH) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return _empty_document()

    if (
        not isinstance(raw, dict)
        or not isinstance(raw.get("days"), dict)
        or not isinstance(raw.get("minutes"), dict)
    ):
        return _empty_document()
    return raw


def record(
    api: Api, *, status: int | None, rate_limited: bool = False, error: bool = False
) -> None:
    """Record one outbound request attempt. Never raises, safe to call from any
    thread — this must be true even under lock contention or a full disk, because
    the caller (http_v2.py's retry loop) has already made the real network call and
    a bookkeeping failure must never look like that call failed.

    `status` is the raw HTTP status of this attempt, kept for context in the
    WARNING log on failure; it is not itself part of the persisted document —
    `rate_limited`/`error` are what the caller has already classified it as.
    """
    try:
        _record_unsafe(api, rate_limited=rate_limited, error=error)
    except Exception:
        logger.warning("request_meter.record.failed", api=api, status=status)


def _record_unsafe(api: Api, *, rate_limited: bool, error: bool) -> None:
    global _buffered

    now = datetime.now().astimezone()  # local time — the user reads this against
    # their own day, per §10's document-shape note.
    day = now.strftime("%Y-%m-%d")
    minute = now.strftime("%Y-%m-%dT%H:%M")

    should_flush: bool
    with _buffer_lock:
        day_bucket = _buffer_days.setdefault(
            day, {"v2": 0, "v1": 0, "rate_limited": 0, "errors": 0}
        )
        day_bucket[api] += 1
        if rate_limited:
            day_bucket["rate_limited"] += 1
        if error:
            day_bucket["errors"] += 1

        minute_bucket = _buffer_minutes.setdefault(minute, {"v2": 0, "v1": 0})
        minute_bucket[api] += 1

        _buffered += 1
        should_flush = (
            time.monotonic() - _last_flush >= FLUSH_INTERVAL or _buffered >= FLUSH_MAX
        )

    if should_flush:
        _flush()


def _flush() -> None:
    """Drain the in-memory buffer to disk. Never raises — registered as an atexit
    hook (below) so a one-shot CLI process doesn't lose its last sub-FLUSH_INTERVAL
    batch, and atexit hooks that raise print an ugly traceback on interpreter
    shutdown for no benefit to anyone."""
    global _buffer_days, _buffer_minutes, _buffered, _last_flush

    with _buffer_lock:
        days_delta = _buffer_days
        minutes_delta = _buffer_minutes
        _buffer_days = {}
        _buffer_minutes = {}
        _buffered = 0
        _last_flush = time.monotonic()

    if not days_delta and not minutes_delta:
        return

    try:
        _flush_to_disk(days_delta, minutes_delta)
    except Exception:
        logger.warning("request_meter.flush.failed")


def _flush_to_disk(
    days_delta: dict[str, dict[str, int]], minutes_delta: dict[str, dict[str, int]]
) -> None:
    METER_PATH.parent.mkdir(parents=True, exist_ok=True)

    lock_fd = os.open(METER_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        # blocking — writes are microseconds
        filelock.lock_exclusive(lock_fd, str(METER_LOCK_PATH))

        data = _read_document()

        days = data["days"]
        for day, delta in days_delta.items():
            existing = days.setdefault(day, {"v2": 0, "v1": 0, "rate_limited": 0, "errors": 0})
            for key, amount in delta.items():
                existing[key] = existing.get(key, 0) + amount  # add, never overwrite —
                # this is what makes concurrent writers from separate processes sum
                # correctly instead of last-writer-wins.

        minutes = data["minutes"]
        for minute, delta in minutes_delta.items():
            existing = minutes.setdefault(minute, {"v2": 0, "v1": 0})
            for key, amount in delta.items():
                existing[key] = existing.get(key, 0) + amount

        _prune_retention(data)

        # Deliberately no os.fsync() here, and this is the one place this module
        # departs from ledger.py's algorithm. os.replace() is what buys atomicity
        # — a reader sees the old file or the new one, never a torn one — and that
        # property is preserved. fsync buys something different: durability across
        # a power cut, at a measured p50 of 124ms and a max of 535ms on this host's
        # disk.
        #
        # That price is wrong for this file. record() sits on playback.py's cloud
        # loop, which has a 500ms frame budget at CLOUD_MAX_FPS, so a flush landing
        # inside a frame could eat the whole budget and visibly stall an effect. And
        # what fsync would protect is at most the last couple of seconds of request
        # counts — a statistic, not a record anything depends on. The ledger fsyncs
        # because losing its last write means the console lies about what a light is
        # doing; losing two seconds of a traffic tally means the tally is off by two
        # seconds. Never trade a visible stall for that.
        tmp_path = METER_PATH.with_suffix(".json.tmp")
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
        os.replace(tmp_path, METER_PATH)  # atomic on ext4: never a torn read
    finally:
        filelock.unlock(lock_fd, str(METER_LOCK_PATH))
        os.close(lock_fd)


def _prune_retention(data: dict) -> None:
    """Keys are ISO date/minute strings, so lexicographic sort is chronological
    sort — no need to parse them back into datetimes just to find the newest N."""
    days = data["days"]
    if len(days) > _DAY_RETENTION:
        keep = sorted(days)[-_DAY_RETENTION:]
        data["days"] = {k: days[k] for k in keep}

    minutes = data["minutes"]
    if len(minutes) > _MINUTE_RETENTION:
        keep = sorted(minutes)[-_MINUTE_RETENTION:]
        data["minutes"] = {k: minutes[k] for k in keep}


atexit.register(_flush)


def snapshot() -> MeterSnapshot:
    """Flush the buffer, then read. Flushing first means a caller that just recorded
    a request sees it reflected immediately — the buffer is a write-latency
    optimisation, not a source of staleness for readers."""
    _flush()
    data = _read_document()

    now = datetime.now().astimezone()
    day = now.strftime("%Y-%m-%d")
    today = data.get("days", {}).get(day, {})

    minutes_data = data.get("minutes", {})
    current_minute = now.replace(second=0, microsecond=0)
    # Zero-filled for gaps: a sparkline with holes in it would misreport a quiet
    # period (nothing recorded that minute) as missing data (nothing measured).
    minutes: list[tuple[str, int]] = []
    for offset in range(59, -1, -1):
        key = (current_minute - timedelta(minutes=offset)).strftime("%Y-%m-%dT%H:%M")
        minutes.append((key, minutes_data.get(key, {}).get("v2", 0)))

    v2_last_minute = minutes[-1][1] if minutes else 0
    v2_last_hour = sum(count for _, count in minutes)

    return MeterSnapshot(
        day=day,
        v2_today=today.get("v2", 0),
        v1_today=today.get("v1", 0),
        rate_limited_today=today.get("rate_limited", 0),
        errors_today=today.get("errors", 0),
        v2_last_minute=v2_last_minute,
        v2_last_hour=v2_last_hour,
        minutes=minutes,
    )


def reset() -> None:
    """Clear the buffer and the on-disk file. For tests only."""
    global _buffer_days, _buffer_minutes, _buffered, _last_flush
    with _buffer_lock:
        _buffer_days = {}
        _buffer_minutes = {}
        _buffered = 0
        _last_flush = 0.0

    try:
        METER_PATH.unlink(missing_ok=True)
    except OSError:
        pass
