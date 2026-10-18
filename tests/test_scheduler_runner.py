"""Shared scheduler firing path, cycle, ownership and runner (issue #2).

engine/owner/room_restore bodies belong to other areas, so every collaborator is
a monkeypatched fake here. Nothing builds a real client or touches a device.
"""

from __future__ import annotations

import datetime as dt
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from click.testing import CliRunner

from govee_cli.commands import daemon as daemon_mod
from govee_cli.schedule.scheduler import RuleState, ScheduleRule
from govee_cli.schedule.timespec import Location
from webui.api import scheduler_runner as runner_mod
from webui.api.scheduler_runner import SchedulerRunner

TZ = ZoneInfo("America/New_York")
NOW = dt.datetime(2026, 10, 19, 6, 30, 5, tzinfo=TZ)
LOC = Location(None, None, "America/New_York", "config")


class FakeLock:
    def __init__(self, acquirable: bool = True) -> None:
        self.acquirable = acquirable
        self.held = False
        self.beats: list[dt.datetime] = []
        self.acquire_calls = 0
        self.released = False

    def try_acquire(self) -> bool:
        self.acquire_calls += 1
        self.held = self.acquirable
        return self.acquirable

    def heartbeat(self, now: dt.datetime) -> None:
        self.beats.append(now)

    def release(self) -> None:
        self.released = True
        self.held = False


def rule(rid: str, **kw: object) -> ScheduleRule:
    base = dict(id=rid, name=rid, time="06:30", days=["Mon"], command="power on",
                device="Lamp")
    base.update(kw)
    return ScheduleRule(**base)  # type: ignore[arg-type]


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    w = SimpleNamespace(rules=[], state={}, written=[], due=[], events=[])
    monkeypatch.setattr(daemon_mod, "_now_in_zone", lambda: (NOW, LOC))
    monkeypatch.setattr(daemon_mod, "list_rules", lambda: list(w.rules))
    monkeypatch.setattr(daemon_mod, "read_state", lambda: dict(w.state))
    monkeypatch.setattr(daemon_mod, "write_state", lambda s: w.written.append(dict(s)))
    monkeypatch.setattr(
        daemon_mod.engine, "due_rules",
        lambda rules, now, loc, state: [(r, NOW.replace(second=0)) for r in w.due],
        raising=False,
    )
    return w


def test_cycle_records_state_and_survives_a_failing_rule(world: SimpleNamespace) -> None:
    a, b = rule("a"), rule("b")
    world.rules, world.due = [a, b], [a, b]
    lock = FakeLock()

    def fire(r: ScheduleRule, *, dry_run: bool):
        if r.id == "a":
            return "error", "boom"
        return "ok", "fine"

    assert daemon_mod.run_cycle(lock, dry_run=False, fire=fire) == 2  # type: ignore[arg-type]
    state = world.written[-1]
    assert state["a"].last_result == "error" and state["a"].last_detail == "boom"
    assert state["b"].last_result == "ok"
    # fire minute stored as the UTC instant (06:30 EDT = 10:30Z)
    assert state["b"].last_fired_minute == "2026-10-19T10:30:00+00:00"
    assert lock.beats == [NOW]


def test_cycle_survives_a_raising_fire_and_corrupt_state(
    world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    a = rule("a")
    world.rules, world.due = [a], [a]

    def bad_state() -> dict[str, RuleState]:
        raise ValueError("corrupt")

    monkeypatch.setattr(daemon_mod, "read_state", bad_state)

    def fire(r: ScheduleRule, *, dry_run: bool):
        raise RuntimeError("kaboom")

    assert daemon_mod.run_cycle(FakeLock(), dry_run=False, fire=fire) == 1  # type: ignore[arg-type]
    assert world.written[-1]["a"].last_detail == "kaboom"


def test_dry_run_builds_no_client(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(*a: object, **k: object) -> None:
        raise AssertionError("a client was built in dry run")

    monkeypatch.setattr("govee_cli.http_v2.GoveeHTTPv2", explode)
    monkeypatch.setattr(daemon_mod, "_fire_room_scene", explode)
    monkeypatch.setattr(daemon_mod.SchedulerDaemon, "_execute_rule_detail", explode)
    assert daemon_mod.fire_rule(rule("a"), dry_run=True) == (
        "would_fire", "dry run: nothing sent")
    assert daemon_mod.fire_rule(rule("r", room_scene="Movie", command=""),
                                dry_run=True)[0] == "would_fire"


def test_room_scene_missing_sends_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("govee_cli.room_scenes.read_scene", lambda n: None)
    result = daemon_mod.fire_rule(rule("r", room_scene="Ghost", command=""), dry_run=False)
    assert result == ("error", "room scene 'Ghost' missing: rule will not fire")


def _fake_restore(monkeypatch: pytest.MonkeyPatch, results: list) -> None:
    monkeypatch.setattr("govee_cli.room_scenes.read_scene", lambda n: object())
    monkeypatch.setattr("govee_cli.http_v2.GoveeHTTPv2", lambda *a, **k: object())
    monkeypatch.setattr("govee_cli.config.load_config", lambda: object())
    monkeypatch.setattr(
        "govee_cli.room_restore.restore_scene",
        lambda name, scene, **k: SimpleNamespace(
            ok=all(r.ok for r in results), results=results),
    )


def test_room_scene_ok_and_partial_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    ok = SimpleNamespace(ref="Lamp", ok=True, skipped_reason=None, error=None)
    skipped = SimpleNamespace(ref="Gone", ok=True, skipped_reason="not registered", error=None)
    bad = SimpleNamespace(ref="Bulb", ok=False, skipped_reason=None, error="429 after 3 retries")
    r = rule("r", room_scene="Movie", command="")

    _fake_restore(monkeypatch, [ok, skipped])
    assert daemon_mod.fire_rule(r, dry_run=False)[0] == "ok"

    _fake_restore(monkeypatch, [ok, skipped, bad])
    result, detail = daemon_mod.fire_rule(r, dry_run=False)
    assert result == "error"
    assert detail == "1 of 2 devices failed: Bulb: 429 after 3 retries"


def test_ownership_reads_previous_cycle_before_acquire_and_records_missed(
    world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = FakeLock()
    prev = NOW - dt.timedelta(hours=2)

    def previous() -> dt.datetime:
        world.events.append(("previous", lock.acquire_calls))
        return prev

    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", previous)
    seen = {}

    def missed(rules, now, loc, state, previous_last_cycle):
        seen["prev"] = previous_last_cycle
        return {"a": NOW - dt.timedelta(minutes=30)}

    monkeypatch.setattr(daemon_mod.engine, "detect_missed", missed, raising=False)
    world.rules = [rule("a")]
    assert daemon_mod.acquire_and_record_missed(lock, NOW, LOC) is True
    assert world.events == [("previous", 0)]  # read before try_acquire
    assert seen["prev"] == prev
    st = world.written[-1]["a"]
    assert st.last_result == "missed"
    assert st.missed_minute == "2026-10-19T10:00:00+00:00"


def test_refused_lock_records_nothing(world: SimpleNamespace,
                                      monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", lambda: None)
    assert daemon_mod.acquire_and_record_missed(FakeLock(False), NOW, LOC) is False
    assert world.written == []


def test_daemon_exits_1_naming_owner(world: SimpleNamespace,
                                     monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", lambda: None)
    monkeypatch.setattr(daemon_mod, "SchedulerLock", lambda *a, **k: FakeLock(False))
    monkeypatch.setattr(daemon_mod.owner, "read_owner", lambda now: "VIEW")
    monkeypatch.setattr(
        daemon_mod.owner, "describe_holder",
        lambda v: f"schedule owned by sidecar pid 4211 on pop-os since 13:40 [{v}]")
    res = CliRunner().invoke(daemon_mod.command, ["--once"])
    assert res.exit_code == 1
    assert "sidecar pid 4211" in res.output


def test_daemon_once_runs_one_cycle_and_releases(
    world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = FakeLock()
    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", lambda: None)
    monkeypatch.setattr(daemon_mod.engine, "detect_missed", lambda *a: {}, raising=False)
    monkeypatch.setattr(daemon_mod, "SchedulerLock", lambda *a, **k: lock)
    res = CliRunner().invoke(daemon_mod.command, ["--once"])
    assert res.exit_code == 0, res.output
    assert lock.beats == [NOW] and lock.released


# ---- sidecar runner -------------------------------------------------------


def test_runner_waits_without_stealing_then_takes_over(
    world: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", lambda: None)
    monkeypatch.setattr(daemon_mod.engine, "detect_missed", lambda *a: {}, raising=False)
    r = SchedulerRunner()
    r._lock = lock = FakeLock(False)  # type: ignore[assignment]
    assert r.lock_status() == "waiting"
    r.cycle()
    r.cycle()
    assert lock.acquire_calls == 2 and lock.beats == []  # retries every cycle, no firing
    lock.acquirable = True
    r.cycle()
    assert r.lock_status() == "owner" and lock.beats == [NOW]


@pytest.mark.parametrize("pinned,expected", [
    ("nobody", "disabled"), ("stale", "disabled"),
    ("waiting", "waiting"), ("daemon", "waiting"),
])
def test_mock_owner_never_acquires(pinned: str, expected: str) -> None:
    r = SchedulerRunner(dry_run=True, mock_owner=pinned)
    r._lock = lock = FakeLock()  # type: ignore[assignment]
    r.cycle()
    assert lock.acquire_calls == 0
    assert r.lock_status() == expected


def test_mock_owner_ignored_outside_dry_run() -> None:
    assert SchedulerRunner(dry_run=False, mock_owner="nobody")._mock_owner is None


def test_runner_dry_run_records_would_fire(world: SimpleNamespace,
                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(daemon_mod.owner, "previous_last_cycle", lambda: None)
    monkeypatch.setattr(daemon_mod.engine, "detect_missed", lambda *a: {}, raising=False)
    monkeypatch.setattr("govee_cli.http_v2.GoveeHTTPv2",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("client")))
    a = rule("a")
    world.rules, world.due = [a], [a]
    r = SchedulerRunner(dry_run=True)
    r._lock = FakeLock()  # type: ignore[assignment]
    assert r.cycle() == 1
    assert world.written[-1]["a"].last_result == "would_fire"
    assert r.snapshot()["last_fire"]["ok"] is True


def test_zone_iso_floors_and_converts() -> None:
    out = runner_mod._zone_iso("2026-10-19T10:30:42+00:00", TZ)
    assert out == "2026-10-19T06:30:00-04:00"
