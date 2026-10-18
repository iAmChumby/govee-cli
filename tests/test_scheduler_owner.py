"""Scheduler ownership (issue #2): one lock across processes, heartbeat
freshness, stale versus running, and the state-file helpers."""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time

import pytest

from govee_cli.schedule import owner, scheduler
from govee_cli.schedule.owner import (
    OwnerRecord,
    SchedulerLock,
    describe_holder,
    previous_last_cycle,
    read_owner,
)
from govee_cli.schedule.scheduler import RuleState, ScheduleRule

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
UTC = dt.timezone.utc

HOLDER = """
import sys, time, pathlib
from govee_cli.schedule import owner
owner.OWNER_PATH = pathlib.Path(sys.argv[1])
owner.OWNER_LOCK_PATH = pathlib.Path(sys.argv[2])
lock = owner.SchedulerLock("daemon", 10.0)
import os
print(("held " if lock.try_acquire() else "refused ") + str(os.getpid()), flush=True)
time.sleep(120)
"""


@pytest.fixture(autouse=True)
def owner_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path) -> pathlib.Path:
    monkeypatch.setattr(owner, "OWNER_PATH", tmp_path / "scheduler-owner.json")
    monkeypatch.setattr(owner, "OWNER_LOCK_PATH", tmp_path / "scheduler-owner.json.lock")
    return tmp_path


def now() -> dt.datetime:
    return dt.datetime.now(UTC)


def write_record(pid: int, last_cycle: dt.datetime | None, poll: float = 20.0,
                 started: dt.datetime | None = None, host: str | None = None) -> None:
    started = started or now() - dt.timedelta(hours=1)
    rec = OwnerRecord(
        kind="sidecar", dry_run=False, pid=pid, host=host or socket.gethostname(),
        started_at=started.isoformat(),
        last_cycle_at=last_cycle.isoformat() if last_cycle else None, poll_seconds=poll)
    owner.OWNER_PATH.write_text(json.dumps(rec.__dict__), encoding="utf-8")


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


# --- read_owner ---------------------------------------------------------------


def test_no_file_reads_nobody() -> None:
    view = read_owner(now())
    assert view.state == "nobody" and view.record is None and view.stale_since is None
    assert previous_last_cycle() is None


def test_corrupt_file_reads_unknown_with_detail() -> None:
    owner.OWNER_PATH.write_text("{not json", encoding="utf-8")
    view = read_owner(now())
    assert view.state == "unknown" and view.detail and "corrupt" in view.detail
    owner.OWNER_PATH.write_text('{"kind": "sidecar"}', encoding="utf-8")
    assert read_owner(now()).state == "unknown"


def test_fresh_heartbeat_with_live_pid_is_running() -> None:
    write_record(os.getpid(), now() - dt.timedelta(seconds=10), poll=20.0)
    view = read_owner(now())
    assert view.state == "running" and view.stale_since is None and view.detail is None


def test_old_heartbeat_with_live_pid_is_stale_never_running() -> None:
    beat = now() - dt.timedelta(seconds=61)  # > 3 x 20s
    write_record(os.getpid(), beat, poll=20.0)
    view = read_owner(now())
    assert view.state == "stale"
    assert view.stale_since == beat
    assert view.detail is not None and view.detail.startswith("no heartbeat for ")


def test_heartbeat_at_exactly_three_polls_is_still_running() -> None:
    at = dt.datetime(2026, 10, 18, 12, 0, tzinfo=UTC)
    write_record(os.getpid(), at - dt.timedelta(seconds=60), poll=20.0)
    assert read_owner(at).state == "running"
    assert read_owner(at + dt.timedelta(seconds=1)).state == "stale"


def test_fresh_heartbeat_with_dead_pid_is_stale() -> None:
    pid = dead_pid()
    beat = now() - dt.timedelta(seconds=1)
    write_record(pid, beat, poll=20.0)
    view = read_owner(now())
    assert view.state == "stale" and view.stale_since == beat
    assert view.detail == f"pid {pid} is not running"


def test_never_heartbeat_falls_back_to_started_at() -> None:
    started = now() - dt.timedelta(minutes=10)
    write_record(os.getpid(), None, poll=20.0, started=started)
    view = read_owner(now())
    assert view.state == "stale" and view.stale_since == started
    assert previous_last_cycle() == started


def test_record_from_another_host_is_unknown() -> None:
    write_record(os.getpid(), now(), host="some-other-box")
    view = read_owner(now())
    assert view.state == "unknown" and view.detail and "some-other-box" in view.detail


def test_describe_holder_names_kind_pid_host_and_local_time() -> None:
    started = dt.datetime(2026, 10, 18, 17, 40, tzinfo=UTC)
    write_record(os.getpid(), now(), started=started)
    view = read_owner(now())
    expected_hm = started.astimezone().strftime("%H:%M")
    assert describe_holder(view) == (
        f"schedule owned by sidecar pid {os.getpid()} on {socket.gethostname()} "
        f"since {expected_hm}")


# --- SchedulerLock ------------------------------------------------------------


def test_acquire_writes_record_heartbeat_updates_release_clears() -> None:
    lock = SchedulerLock("daemon", 15.0, dry_run=True)
    assert not lock.held and lock.try_acquire() and lock.held
    view = read_owner(now())
    assert view.state == "running"
    assert view.record is not None
    rec = view.record
    assert (rec.kind, rec.pid, rec.poll_seconds) == ("daemon", os.getpid(), 15.0)
    assert view.record.dry_run is True and view.record.last_cycle_at is None
    beat = dt.datetime(2026, 10, 18, 12, 0, 30, 123456, tzinfo=UTC)
    lock.heartbeat(beat)
    assert previous_last_cycle() == beat.replace(microsecond=0)
    lock.release()
    assert not lock.held
    assert read_owner(now()).state == "nobody"  # clean release leaves no record
    lock.release()  # idempotent


def test_same_process_second_lock_is_refused_until_release() -> None:
    first, second = SchedulerLock("sidecar", 20.0), SchedulerLock("daemon", 20.0)
    assert first.try_acquire()
    assert not second.try_acquire()
    assert read_owner(now()).record is not None and read_owner(now()).record.kind == "sidecar"
    first.release()
    assert second.try_acquire()
    second.release()


def test_stale_record_never_blocks_acquire() -> None:
    write_record(dead_pid(), now() - dt.timedelta(hours=2))
    lock = SchedulerLock("daemon", 10.0)
    assert lock.try_acquire()
    lock.release()


def _start_holder() -> tuple[subprocess.Popen[str], int]:
    proc = subprocess.Popen(
        [sys.executable, "-c", HOLDER, str(owner.OWNER_PATH), str(owner.OWNER_LOCK_PATH)],
        cwd=REPO_ROOT, stdout=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    line = proc.stdout.readline().split()
    assert line[:1] == ["held"], line
    # On Windows the venv python.exe is a launcher, so Popen.pid is not the
    # process that holds the lock; the holder reports its own pid.
    return proc, int(line[1])


def test_lock_excludes_another_process_and_survives_kill() -> None:
    holder, holder_pid = _start_holder()
    try:
        mine = SchedulerLock("sidecar", 20.0)
        assert mine.try_acquire() is False  # held by the other process
        assert read_owner(now()).record is not None
        assert read_owner(now()).record.pid == holder_pid  # type: ignore[union-attr]
        assert read_owner(now()).state == "running"
    finally:
        # SIGKILL where it exists (kill -9: no cleanup code runs); on Windows
        # os.kill with SIGTERM is TerminateProcess, equally abrupt.
        os.kill(holder_pid, getattr(signal, "SIGKILL", signal.SIGTERM))
        holder.wait()
    # The record is still on disk but the pid is gone: stale, and the lock is free.
    view = read_owner(now())
    assert view.state == "stale" and view.detail == f"pid {holder_pid} is not running"
    deadline = time.monotonic() + 5
    got = False
    while time.monotonic() < deadline and not got:
        got = mine.try_acquire()
        time.sleep(0.05)
    assert got, "lock was not released after the holder process died"
    mine.release()


# --- scheduler.py state + rules ----------------------------------------------


@pytest.fixture
def sched_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path) -> pathlib.Path:
    monkeypatch.setattr(scheduler, "SCHEDULE_DIR", tmp_path)
    monkeypatch.setattr(scheduler, "SCHEDULE_FILE", tmp_path / "schedule.json")
    monkeypatch.setattr(scheduler, "SCHEDULE_STATE_PATH", tmp_path / "schedule-state.json")
    return tmp_path


def test_state_roundtrip_missing_and_corrupt(sched_paths: pathlib.Path) -> None:
    assert scheduler.read_state() == {}
    state = {"a": RuleState(last_fired_minute="2026-10-19T10:30:00+00:00", last_result="ok",
                            last_at="2026-10-19T10:30:02+00:00"),
             "b": RuleState(missed_minute="2026-10-19T10:30:00+00:00", last_result="missed")}
    scheduler.write_state(state)
    assert scheduler.read_state() == state
    assert (sched_paths / "schedule-state.json.lock").exists()
    assert not (sched_paths / "schedule-state.json.tmp").exists()
    (sched_paths / "schedule-state.json").write_text("{oops", encoding="utf-8")
    with pytest.raises(ValueError):
        scheduler.read_state()
    (sched_paths / "schedule-state.json").write_text("[1]", encoding="utf-8")
    with pytest.raises(ValueError):
        scheduler.read_state()


def test_get_and_update_rule_atomic_save(sched_paths: pathlib.Path) -> None:
    rule = ScheduleRule(id="x1", name="Wake", time="06:30", days=["Mon"], command="power on")
    scheduler.add_rule(rule)
    assert scheduler.get_rule("x1") == rule
    assert scheduler.get_rule("nope") is None
    edited = ScheduleRule(id="x1", name="Dusk", time="sunset-1h", days=["Mon", "Tue"],
                          command="", room_scene="Movie")
    assert scheduler.update_rule(edited) is True
    assert scheduler.get_rule("x1") == edited
    assert scheduler.update_rule(ScheduleRule(id="zz", name="", time="06:30", days=[],
                                              command="")) is False
    assert len(scheduler.list_rules()) == 1
    assert not (sched_paths / "schedule.json.tmp").exists()
    assert (sched_paths / "schedule.json.lock").exists()
