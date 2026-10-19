"""Schedule and config behaviour for issue #2: API routes and CLI commands.

The core area fills the spine bodies (timespec, engine, owner, and the rule
get/update and read_state helpers) in parallel, so these tests replace those
functions with small fakes. The routes and commands are what is under test.
Every path is redirected to tmp_path (config, schedule rules, schedule state,
owner record) and room scenes are faked. Nothing touches ~/.config/govee-cli,
and no test sends a command to a device.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import os
import re
from collections.abc import Callable
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from click.testing import CliRunner
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from govee_cli import room_scenes  # noqa: E402
from govee_cli.commands.config_cmd import command as config_group  # noqa: E402
from govee_cli.commands.schedule import schedule as schedule_group  # noqa: E402
from govee_cli.config import GoveeConfig  # noqa: E402
from govee_cli.schedule import engine, owner, scheduler, timespec  # noqa: E402
from govee_cli.schedule.scheduler import RuleState, ScheduleRule  # noqa: E402
from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

ZONE = "America/New_York"
# Fixed next run every enabled clock rule reports, so the CLI text is stable.
NEXT = dt.datetime(2026, 10, 18, 17, 10, tzinfo=ZoneInfo(ZONE))
DEVICE_ID = "50:CE:E8:6E:80:C6:50:3F"
DEVICE_NAME = "Shelf Lamp"
SCENES = ("Evening", "Sleep Mode")
NOBODY = owner.OwnerView(state="nobody", record=None, stale_since=None, detail=None)


# ------------------------------------------------------------------ fakes


def fake_resolve_location(cfg: GoveeConfig) -> timespec.Location:
    return timespec.Location(
        latitude=cfg.latitude,
        longitude=cfg.longitude,
        timezone=cfg.timezone or ZONE,
        timezone_source="config" if cfg.timezone else "host",
    )


_CLOCK = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_SUN = re.compile(r"^(sunrise|sunset)([+-]\d+[hm](\d+m)?)?$")


def fake_normalise_time(text: str) -> str:
    t = text.strip().lower()
    if _CLOCK.match(t) or _SUN.match(t):
        return t
    raise timespec.TimeSpecError(f"Bad time '{text}'. Use HH:MM, sunrise or sunset.")


def fake_rule_days(rule: ScheduleRule) -> set[str]:
    return {d.lower()[:3] for d in rule.days}


def fake_rule_status(
    rule: ScheduleRule, now: dt.datetime, loc: timespec.Location, scene_names: set[str]
) -> engine.RuleStatus:
    problem = None
    if rule.room_scene and rule.room_scene not in scene_names:
        problem = f"room scene '{rule.room_scene}' missing: rule will not fire"
    next_run: dt.datetime | None = NEXT
    reason: str | None = None
    if not rule.enabled:
        next_run, reason = None, "paused"
    elif rule.time.startswith("sun") and not loc.has_coordinates:
        next_run, reason = None, "no location: no next run"
    return engine.RuleStatus(
        rule_id=rule.id,
        canonical_time=rule.time,
        next_run=next_run,
        next_run_reason=reason,
        today_fire=None,
        today_reason="not scheduled today",
        target_problem=problem,
    )


def fake_preview(time_text: str, days: list[str], now: dt.datetime,
                 loc: timespec.Location) -> engine.Preview:
    try:
        canonical = fake_normalise_time(time_text)
    except timespec.TimeSpecError as e:
        return engine.Preview(canonical_time=None, error=str(e), event_time=None,
                              today_fire=None, next_run=None, reason=None)
    return engine.Preview(canonical_time=canonical, error=None, event_time=None,
                          today_fire=None, next_run=NEXT, reason=None)


def fake_get_rule(rule_id: str) -> ScheduleRule | None:
    return next((r for r in scheduler.list_rules() if r.id == rule_id), None)


def fake_update_rule(rule: ScheduleRule) -> bool:
    rules = scheduler.list_rules()
    for i, existing in enumerate(rules):
        if existing.id == rule.id:
            rules[i] = rule
            scheduler._save_rules(rules)
            return True
    return False


# Store behind the read_state/write_state fakes, so baseline stamps are observable.
STATE: dict[str, RuleState] = {}
_BASELINE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+00:00$")


def fake_read_state() -> dict[str, RuleState]:
    return {k: dataclasses.replace(v) for k, v in STATE.items()}


def fake_write_state(state: dict[str, RuleState]) -> None:
    STATE.clear()
    STATE.update(state)


def _baseline(rule_id: str) -> str | None:
    entry = STATE.get(rule_id)
    return entry.baseline_at if entry else None


def _owner_running_sidecar(now: dt.datetime) -> owner.OwnerView:
    cycle = (now - dt.timedelta(seconds=12)).astimezone(dt.timezone.utc)
    return owner.OwnerView(
        state="running",
        record=owner.OwnerRecord(
            kind="sidecar", dry_run=False, pid=4211, host="pop-os",
            started_at="2026-10-18T13:00:00+00:00",
            last_cycle_at=cycle.isoformat(), poll_seconds=20.0,
        ),
        stale_since=None,
        detail=None,
    )


# --------------------------------------------------------------- fixtures


@pytest.fixture(scope="module")
def app():
    application = create_app()
    yield application
    uninstall_mock()


@pytest.fixture(autouse=True)
def isolated(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """Redirect every file this area writes, and fake the unbuilt spine bodies."""
    config_file = tmp_path / "config.json"
    config_file.write_text(json.dumps({
        "version": 2,
        "default_mac": DEVICE_ID,
        "groups": {},
        "devices": {DEVICE_ID: {"model": "H6022", "name": DEVICE_NAME}},
    }))
    monkeypatch.setattr("govee_cli.config._CONFIG_PATH", config_file)
    monkeypatch.setattr(scheduler, "SCHEDULE_DIR", tmp_path)
    monkeypatch.setattr(scheduler, "SCHEDULE_FILE", tmp_path / "schedule.json")
    monkeypatch.setattr(scheduler, "SCHEDULE_STATE_PATH", tmp_path / "schedule-state.json")
    monkeypatch.setattr(owner, "OWNER_PATH", tmp_path / "scheduler-owner.json")
    monkeypatch.setattr(owner, "OWNER_LOCK_PATH", tmp_path / "scheduler-owner.json.lock")

    monkeypatch.setattr(timespec, "resolve_location", fake_resolve_location)
    monkeypatch.setattr(timespec, "normalise_time", fake_normalise_time)
    monkeypatch.setattr(engine, "rule_days", fake_rule_days)
    monkeypatch.setattr(engine, "rule_status", fake_rule_status)
    monkeypatch.setattr(engine, "preview", fake_preview)
    monkeypatch.setattr(owner, "read_owner", lambda now: NOBODY)
    STATE.clear()
    monkeypatch.setattr(scheduler, "read_state", fake_read_state)
    monkeypatch.setattr(scheduler, "write_state", fake_write_state)
    monkeypatch.setattr(scheduler, "get_rule", fake_get_rule)
    monkeypatch.setattr(scheduler, "update_rule", fake_update_rule)
    monkeypatch.setattr(room_scenes, "list_scenes", lambda: dict.fromkeys(SCENES))


@pytest.fixture
def client(app) -> TestClient:
    # No lifespan: the embedded scheduler stays off, as it is in these tests.
    return TestClient(app)


def _rule_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": "Morning",
        "time": "06:30",
        "days": ["Mon", "Wed"],
        "command": "power on",
        "device": DEVICE_NAME,
        "enabled": True,
    }
    body.update(overrides)
    return body


def _error_message(resp) -> str:
    return resp.json()["error"]["message"]


def _seed_rule(**overrides: Any) -> ScheduleRule:
    rule = ScheduleRule(
        id=overrides.pop("id", "abc12345"),
        name=overrides.pop("name", "Morning"),
        time=overrides.pop("time", "06:30"),
        days=overrides.pop("days", ["Mon"]),
        command=overrides.pop("command", "power on"),
        device=overrides.pop("device", DEVICE_NAME),
        room_scene=overrides.pop("room_scene", None),
    )
    scheduler.add_rule(rule)
    return rule


# ------------------------------------------------------------ schedule API


def test_post_command_rule_returns_canonical_rule_and_next_run(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json=_rule_body(days=["mon", "wed"]))
    assert resp.status_code == 200, resp.text
    rule = resp.json()
    assert len(rule["id"]) == 8
    assert rule["time"] == "06:30"
    assert rule["days"] == ["Mon", "Wed"]
    assert rule["device"] == DEVICE_NAME
    assert rule["room_scene"] is None
    assert rule["next_run"] == "2026-10-18T17:10:00-04:00"
    stored = scheduler.get_rule(rule["id"])
    assert stored is not None and stored.command == "power on"


def test_post_room_scene_rule_stores_no_device(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json={
        "name": "Wind down", "time": "sunset-1h15m", "days": ["Sat"],
        "command": "", "room_scene": "Evening",
    })
    assert resp.status_code == 200, resp.text
    rule = resp.json()
    assert rule["room_scene"] == "Evening"
    assert rule["device"] is None
    assert rule["time"] == "sunset-1h15m"
    stored = scheduler.get_rule(rule["id"])
    assert stored is not None
    assert stored.command == "" and stored.device is None and stored.room_scene == "Evening"


def test_post_rejects_a_rule_with_no_target(client: TestClient) -> None:
    body = _rule_body()
    body.pop("command")
    body.pop("device")
    resp = client.post("/api/v1/schedules", json=body)
    assert resp.status_code == 400, resp.text
    assert "exactly one target" in resp.text


def test_post_rejects_command_and_room_scene_together(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json=_rule_body(room_scene="Evening"))
    assert resp.status_code == 400, resp.text
    assert "exactly one target" in resp.text


def test_post_rejects_device_on_a_room_scene_rule(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json={
        "name": "X", "time": "06:30", "days": ["Mon"], "command": "",
        "room_scene": "Evening", "device": DEVICE_NAME,
    })
    assert resp.status_code == 400, resp.text
    assert "drop 'device'" in resp.text


def test_post_unknown_device_is_404(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json=_rule_body(device="Nowhere"))
    assert resp.status_code == 404
    assert "Device 'Nowhere' not found" in _error_message(resp)


def test_post_unknown_room_scene_is_404(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json={
        "name": "X", "time": "06:30", "days": ["Mon"], "command": "", "room_scene": "Nope",
    })
    assert resp.status_code == 404
    assert _error_message(resp) == "Room scene 'Nope' not found."


def test_put_replaces_fields_under_post_validation(client: TestClient) -> None:
    created = client.post("/api/v1/schedules", json=_rule_body()).json()
    rule_id = created["id"]

    resp = client.put(f"/api/v1/schedules/{rule_id}", json={
        "name": "Late", "time": "sunrise+30m", "days": ["Sat"],
        "command": "", "room_scene": "Sleep Mode", "enabled": False,
    })
    assert resp.status_code == 200, resp.text
    rule = resp.json()
    assert rule["id"] == rule_id
    assert rule["name"] == "Late"
    assert rule["time"] == "sunrise+30m"
    assert rule["days"] == ["Sat"]
    assert rule["room_scene"] == "Sleep Mode"
    assert rule["device"] is None
    assert rule["enabled"] is False
    assert rule["next_run"] is None and rule["next_run_reason"] == "paused"

    stored = scheduler.get_rule(rule_id)
    assert stored is not None and stored.room_scene == "Sleep Mode" and stored.command == ""


def test_put_missing_id_is_404(client: TestClient) -> None:
    resp = client.put("/api/v1/schedules/zzzzzzzz", json=_rule_body())
    assert resp.status_code == 404
    assert _error_message(resp) == "No schedule rule with id 'zzzzzzzz'."


def test_put_enforces_exactly_one_target(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    resp = client.put(f"/api/v1/schedules/{rule_id}", json=_rule_body(room_scene="Evening"))
    assert resp.status_code == 400
    assert "exactly one target" in resp.text


def test_put_unknown_room_scene_is_404(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    resp = client.put(f"/api/v1/schedules/{rule_id}", json={
        "name": "X", "time": "06:30", "days": ["Mon"], "command": "", "room_scene": "Nope",
    })
    assert resp.status_code == 404
    assert _error_message(resp) == "Room scene 'Nope' not found."


def test_patch_returns_full_rule_shape(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    resp = client.patch(f"/api/v1/schedules/{rule_id}", json={"enabled": False})
    assert resp.status_code == 200
    rule = resp.json()
    assert rule["enabled"] is False
    assert rule["next_run_reason"] == "paused"
    assert {"today_fire", "today_reason", "target_problem", "last_result"} <= set(rule)


def test_list_reports_owner_last_fire_and_zone_wall_clock(
    client: TestClient, app, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_rule(id="abc12345", name="Morning")
    state = {
        "abc12345": RuleState(last_result="ok", last_at="2026-10-18T21:10:00+00:00"),
        "older000": RuleState(last_result="error", last_detail="boom",
                              last_at="2026-10-17T10:00:00+00:00"),
    }
    monkeypatch.setattr(scheduler, "read_state", lambda: state)
    monkeypatch.setattr(owner, "read_owner", _owner_running_sidecar)

    class _Runner:
        def lock_status(self) -> str:
            return "waiting"

    monkeypatch.setattr(app.state, "scheduler_runner", _Runner())

    body = client.get("/api/v1/schedules").json()
    assert body["state_readable"] is True
    assert body["last_fire"] == {
        "rule_id": "abc12345", "rule_name": "Morning",
        "at": "2026-10-18T17:10:00-04:00", "result": "ok",
    }
    assert body["owner"]["state"] == "running"
    assert body["owner"]["kind"] == "sidecar"
    assert body["owner"]["this_process"] == "waiting"
    assert body["owner"]["last_cycle_at"][-6:] == "-04:00"
    assert body["location"]["timezone_source"] == "host"
    assert body["now"][17:19] == "00"
    assert body["schedules"][0]["last_at"] == "2026-10-18T17:10:00-04:00"


def test_list_unreadable_state_is_reported_not_hidden(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed_rule(id="abc12345")

    def unreadable() -> dict[str, RuleState]:
        raise OSError("disk gone")

    monkeypatch.setattr(scheduler, "read_state", unreadable)
    body = client.get("/api/v1/schedules").json()
    assert body["state_readable"] is False
    assert body["last_fire"] is None
    assert body["schedules"][0]["last_result"] is None


def test_list_owner_disabled_without_runner(client: TestClient) -> None:
    body = client.get("/api/v1/schedules").json()
    assert body["owner"]["this_process"] == "disabled"
    assert body["owner"]["state"] == "nobody"


def test_sun_rule_has_no_next_run_until_location_is_set(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules", json={
        "name": "Dusk", "time": "sunset", "days": ["Mon"], "command": "power on",
    })
    rule = resp.json()
    assert rule["next_run"] is None
    assert rule["next_run_reason"] == "no location: no next run"

    client.patch("/api/v1/config", json={"latitude": 40.7128, "longitude": -74.006})
    listed = client.get("/api/v1/schedules").json()["schedules"][0]
    assert listed["next_run"] == "2026-10-18T17:10:00-04:00"


def test_preview_grammar_error_is_200(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules/preview", json={"time": "sunset+x", "days": ["Mon"]})
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] and body["canonical_time"] is None
    assert body["location"]["timezone"] == ZONE


def test_preview_valid_time_resolves(client: TestClient) -> None:
    resp = client.post("/api/v1/schedules/preview",
                       json={"time": "sunset-1h15m", "days": ["Mon"]})
    body = resp.json()
    assert body["error"] is None
    assert body["canonical_time"] == "sunset-1h15m"
    assert body["next_run"] == "2026-10-18T17:10:00-04:00"


# ------------------------------------------------------------- config API


def test_location_needs_latitude_and_longitude_together(client: TestClient) -> None:
    resp = client.patch("/api/v1/config", json={"latitude": 40.7})
    assert resp.status_code == 422
    assert _error_message(resp) == "Set latitude and longitude together."


def test_location_range_is_enforced(client: TestClient) -> None:
    resp = client.patch("/api/v1/config", json={"latitude": 95, "longitude": 0})
    assert resp.status_code == 400


def test_unknown_timezone_is_rejected(client: TestClient) -> None:
    resp = client.patch("/api/v1/config", json={"timezone": "Mars/Olympus"})
    assert resp.status_code == 400
    assert "Unknown timezone" in resp.text


def test_location_set_then_read_back(client: TestClient) -> None:
    resp = client.patch("/api/v1/config", json={
        "latitude": 40.7128, "longitude": -74.006, "timezone": ZONE,
    })
    assert resp.status_code == 200, resp.text
    body = client.get("/api/v1/config").json()
    assert body["latitude"] == 40.7128
    assert body["longitude"] == -74.006
    assert body["timezone"] == ZONE
    assert body["timezone_effective"] == ZONE
    assert body["timezone_source"] == "config"


def test_unset_timezone_reads_as_host(client: TestClient) -> None:
    body = client.get("/api/v1/config").json()
    assert body["latitude"] is None and body["longitude"] is None
    assert body["timezone"] is None
    assert body["timezone_source"] == "host"


def test_clear_location_removes_all_three(client: TestClient) -> None:
    client.patch("/api/v1/config", json={"latitude": 1.0, "longitude": 2.0, "timezone": ZONE})
    resp = client.patch("/api/v1/config", json={"clear_location": True})
    assert resp.status_code == 200
    body = resp.json()
    assert body["latitude"] is None and body["longitude"] is None and body["timezone"] is None


def test_clear_location_refuses_to_combine_with_coordinates(client: TestClient) -> None:
    resp = client.patch("/api/v1/config",
                        json={"clear_location": True, "latitude": 1.0, "longitude": 2.0})
    assert resp.status_code == 422


# ----------------------------------------------------------------- CLI


def _invoke(args: list[str]):
    return CliRunner().invoke(schedule_group, args)


def _config_on_disk(tmp_path) -> dict[str, Any]:
    return json.loads((tmp_path / "config.json").read_text())


def test_cli_add_room_scene_rule_prints_canonical_time(tmp_path) -> None:
    result = _invoke(["add", "--name", "Wind down", "--time", "sunset-1h15m",
                      "--days", "mon,wed", "--room-scene", "Evening"])
    assert result.exit_code == 0, result.output
    assert "sunset-1h15m" in result.output
    assert "room scene 'Evening'" in result.output
    rule = scheduler.list_rules()[0]
    assert rule.room_scene == "Evening" and rule.command == "" and rule.device is None
    assert rule.days == ["Mon", "Wed"]


def test_cli_add_requires_exactly_one_target(tmp_path) -> None:
    both = _invoke(["add", "--name", "X", "--time", "06:30", "--days", "Mon",
                    "--command", "power on", "--room-scene", "Evening"])
    assert both.exit_code == 1
    assert "not both" in both.output

    neither = _invoke(["add", "--name", "X", "--time", "06:30", "--days", "Mon"])
    assert neither.exit_code == 1
    assert "needs a target" in neither.output
    assert scheduler.list_rules() == []


def test_cli_add_rejects_a_bad_time(tmp_path) -> None:
    result = _invoke(["add", "--name", "X", "--time", "25:00", "--days", "Mon",
                      "--command", "power on"])
    assert result.exit_code == 1
    assert "Bad time" in result.output


def test_cli_add_unknown_room_scene(tmp_path) -> None:
    result = _invoke(["add", "--name", "X", "--time", "06:30", "--days", "Mon",
                      "--room-scene", "Nope"])
    assert result.exit_code == 1
    assert "Room scene 'Nope' not found." in result.output


def test_cli_multiword_command_is_kept_whole(tmp_path) -> None:
    result = _invoke(["add", "--name", "Sleep", "--time", "22:00", "--days", "Mon",
                      "--command", "diy Sleep Mode"])
    assert result.exit_code == 0, result.output
    assert scheduler.list_rules()[0].command == "diy Sleep Mode"


def test_cli_edit_switches_target_and_clears_the_other(tmp_path) -> None:
    rule = _seed_rule(id="abc12345", room_scene="Evening", command="", device=None)

    result = _invoke(["edit", rule.id, "--command", "power on"])
    assert result.exit_code == 0, result.output
    switched = scheduler.get_rule(rule.id)
    assert switched is not None
    assert switched.room_scene is None and switched.command == "power on"

    result = _invoke(["edit", rule.id, "--room-scene", "Sleep Mode"])
    assert result.exit_code == 0, result.output
    back = scheduler.get_rule(rule.id)
    assert back is not None
    assert back.room_scene == "Sleep Mode" and back.command == "" and back.device is None


def test_cli_edit_changes_only_what_is_passed(tmp_path) -> None:
    _seed_rule(id="abc12345", name="Morning", time="06:30", days=["Mon"])
    result = _invoke(["edit", "abc12345", "--time", "07:15", "--days", "sat,Sun",
                      "--disable", "--name", "Wake"])
    assert result.exit_code == 0, result.output
    rule = scheduler.get_rule("abc12345")
    assert rule is not None
    assert (rule.name, rule.time, rule.days, rule.enabled) == (
        "Wake", "07:15", ["Sat", "Sun"], False)
    assert rule.command == "power on" and rule.device == DEVICE_NAME


def test_cli_edit_rejects_both_targets_nothing_and_unknown(tmp_path) -> None:
    _seed_rule(id="abc12345")
    both = _invoke(["edit", "abc12345", "--room-scene", "Evening", "--command", "power on"])
    assert both.exit_code == 1
    assert "cannot be combined" in both.output

    nothing = _invoke(["edit", "abc12345"])
    assert nothing.exit_code == 1
    assert "Nothing to change" in nothing.output

    missing = _invoke(["edit", "nope0000", "--name", "x"])
    assert missing.exit_code == 1
    assert "Schedule nope0000 not found" in missing.output


def test_cli_enable_and_disable(tmp_path) -> None:
    _seed_rule(id="abc12345")
    assert _invoke(["disable", "abc12345"]).exit_code == 0
    assert scheduler.get_rule("abc12345").enabled is False  # type: ignore[union-attr]
    assert _invoke(["enable", "abc12345"]).exit_code == 0
    assert scheduler.get_rule("abc12345").enabled is True  # type: ignore[union-attr]


def test_cli_list_header_and_next_run_lines(tmp_path) -> None:
    _seed_rule(id="clock001", name="Morning", time="06:30", days=["Mon"])
    _seed_rule(id="scene001", name="Wind down", time="sunset-1h15m", days=["Sun"],
               command="", device=None, room_scene="Gone")
    _seed_rule(id="dusk0001", name="Dusk", time="sunset", days=["Mon"])

    result = _invoke(["list"])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert lines[0] == (
        "location: not set · timezone: host: America/New_York · owner: nobody"
    )
    assert "[✓] clock001  06:30  Mon  → Shelf Lamp: power on  next: Sun 18 Oct 17:10" in lines[1]
    assert "room scene 'Gone'" in result.output
    assert "problem: room scene 'Gone' missing: rule will not fire" in result.output
    assert "next: no location: no next run" in result.output
    # HH:MM only: no seconds anywhere in the listing.
    assert not re.search(r"\d\d:\d\d:\d\d", result.output)


def test_cli_list_disabled_rule_shows_paused(tmp_path) -> None:
    _seed_rule(id="off00001", time="06:30", days=["Mon"])
    scheduler.set_rule_enabled("off00001", False)
    result = _invoke(["list"])
    assert "[✗] off00001" in result.output
    assert "next: paused" in result.output


@pytest.mark.parametrize("view_builder, expected", [
    (lambda now: _owner_running_sidecar(now), "web console sidecar (running, last cycle 12s ago)"),
    (lambda now: owner.OwnerView(
        state="running",
        record=owner.OwnerRecord(kind="daemon", dry_run=False, pid=9001, host="pop-os",
                                 started_at="2026-10-18T13:00:00+00:00",
                                 last_cycle_at=None, poll_seconds=20.0),
        stale_since=None, detail=None),
     "govee-cli daemon pid 9001 (running)"),
    (lambda now: owner.OwnerView(
        state="stale", record=None,
        stale_since=dt.datetime(2026, 10, 18, 21, 3, tzinfo=dt.timezone.utc),
        detail="pid 4211 is not running"),
     "nobody (stale since 17:03)"),
])
def test_cli_list_owner_words(tmp_path, monkeypatch: pytest.MonkeyPatch,
                              view_builder: Callable[[dt.datetime], owner.OwnerView],
                              expected: str) -> None:
    monkeypatch.setattr(owner, "read_owner", view_builder)
    result = _invoke(["list"])
    assert f"owner: {expected}" in result.output.splitlines()[0]


def test_cli_list_shows_location_and_missed_and_last_error(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_file = tmp_path / "config.json"
    raw = json.loads(config_file.read_text())
    raw.update({"latitude": 40.7128, "longitude": -74.006})
    config_file.write_text(json.dumps(raw))
    _seed_rule(id="abc12345", name="Morning", time="06:30", days=["Mon"])
    monkeypatch.setattr(scheduler, "read_state", lambda: {
        "abc12345": RuleState(last_result="error", last_detail="device offline",
                              last_at="2026-10-18T21:10:00+00:00",
                              missed_minute="2026-10-18T21:05:00+00:00"),
    })
    result = _invoke(["list"])
    header = result.output.splitlines()[0]
    assert header.startswith("location: 40.7128, -74.0060 · timezone: host: America/New_York")
    assert "missed 17:05" in result.output
    assert "last: error device offline" in result.output


def test_cli_list_unreadable_state_says_unknown(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    _seed_rule(id="abc12345", time="06:30", days=["Mon"])

    def unreadable() -> dict[str, RuleState]:
        raise OSError("disk gone")

    monkeypatch.setattr(scheduler, "read_state", unreadable)
    result = _invoke(["list"])
    assert "last: unknown" in result.output


def test_config_location_set_show_and_clear(tmp_path) -> None:
    runner = CliRunner()

    set_result = runner.invoke(config_group, [
        "location", "40.7128", "-74.0060", "--timezone", ZONE,
    ])
    assert set_result.exit_code == 0, set_result.output
    saved = _config_on_disk(tmp_path)
    assert saved["latitude"] == 40.7128 and saved["longitude"] == -74.006
    assert saved["timezone"] == ZONE
    assert "location: 40.7128, -74.0060" in set_result.output
    assert "timezone: America/New_York" in set_result.output

    show = runner.invoke(config_group, ["location"])
    assert show.exit_code == 0
    assert "location: 40.7128, -74.0060" in show.output

    cleared = runner.invoke(config_group, ["location", "--clear"])
    assert cleared.exit_code == 0
    saved = _config_on_disk(tmp_path)
    assert "latitude" not in saved and "timezone" not in saved

    unset = runner.invoke(config_group, ["location"])
    assert "location: not set" in unset.output
    assert "timezone: host: America/New_York" in unset.output


def test_config_location_validates_input(tmp_path) -> None:
    runner = CliRunner()
    out_of_range = runner.invoke(config_group, ["location", "95", "0"])
    assert out_of_range.exit_code == 1
    assert "out of range" in out_of_range.output

    bad_zone = runner.invoke(config_group, ["location", "40", "-74",
                                            "--timezone", "Mars/Olympus"])
    assert bad_zone.exit_code == 1
    assert "Unknown timezone 'Mars/Olympus'" in bad_zone.output

    half = runner.invoke(config_group, ["location", "40"])
    assert half.exit_code == 1
    assert "Give both LATITUDE and LONGITUDE" in half.output

    clash = runner.invoke(config_group, ["location", "--clear", "--timezone", "UTC"])
    assert clash.exit_code == 1


def test_config_flags_still_show_the_config(tmp_path) -> None:
    result = CliRunner().invoke(config_group, ["--show"])
    assert result.exit_code == 0
    assert json.loads(result.output)["default_mac"] == DEVICE_ID


# ------------------------------------------------- baseline (missed-fire anchor)
# A rule's state gets baseline_at (now, UTC, minute precision) when the rule is
# created, goes disabled -> enabled, or its time or days change. Other state
# fields are kept, and an unreadable state file never fails the save.


def test_api_create_stamps_baseline(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    stamped = _baseline(rule_id)
    assert stamped is not None and _BASELINE.match(stamped), stamped


def test_api_patch_enable_stamps_only_on_disabled_to_enabled(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    client.patch(f"/api/v1/schedules/{rule_id}", json={"enabled": False})
    STATE.clear()
    client.patch(f"/api/v1/schedules/{rule_id}", json={"enabled": True})
    assert _BASELINE.match(_baseline(rule_id) or "")

    STATE.clear()
    client.patch(f"/api/v1/schedules/{rule_id}", json={"enabled": True})
    assert _baseline(rule_id) is None


def test_api_put_stamps_on_time_days_or_enable_change_only(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    url = f"/api/v1/schedules/{rule_id}"

    STATE.clear()
    client.put(url, json=_rule_body(name="Renamed"))
    assert _baseline(rule_id) is None, "a rename must not restart the baseline"

    client.put(url, json=_rule_body(time="07:00"))
    assert _BASELINE.match(_baseline(rule_id) or ""), "time change should stamp"

    STATE.clear()
    client.put(url, json=_rule_body(days=["Tue"]))
    assert _BASELINE.match(_baseline(rule_id) or ""), "days change should stamp"

    client.patch(url, json={"enabled": False})
    STATE.clear()
    client.put(url, json=_rule_body(days=["Tue"], enabled=True))
    assert _BASELINE.match(_baseline(rule_id) or ""), "PUT re-enable should stamp"


def test_api_put_keeps_other_state_fields(client: TestClient) -> None:
    rule_id = client.post("/api/v1/schedules", json=_rule_body()).json()["id"]
    STATE[rule_id] = RuleState(last_result="ok", last_at="2026-10-18T21:10:00+00:00")
    client.put(f"/api/v1/schedules/{rule_id}", json=_rule_body(time="07:00"))
    entry = STATE[rule_id]
    assert entry.last_result == "ok" and entry.last_at == "2026-10-18T21:10:00+00:00"
    assert _BASELINE.match(entry.baseline_at or "")


def test_api_save_succeeds_when_state_is_unreadable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def corrupt() -> dict[str, RuleState]:
        raise ValueError("schedule-state.json is not JSON")

    monkeypatch.setattr(scheduler, "read_state", corrupt)
    resp = client.post("/api/v1/schedules", json=_rule_body())
    assert resp.status_code == 200, resp.text
    assert scheduler.get_rule(resp.json()["id"]) is not None


def test_cli_add_stamps_baseline(tmp_path) -> None:
    result = _invoke(["add", "--name", "X", "--time", "06:30", "--days", "Mon",
                      "--command", "power on"])
    assert result.exit_code == 0, result.output
    assert _BASELINE.match(_baseline(scheduler.list_rules()[0].id) or "")


def test_cli_enable_stamps_only_on_disabled_to_enabled(tmp_path) -> None:
    _seed_rule(id="abc12345")
    scheduler.set_rule_enabled("abc12345", False)
    STATE.clear()
    assert _invoke(["enable", "abc12345"]).exit_code == 0
    assert _BASELINE.match(_baseline("abc12345") or "")

    STATE.clear()
    assert _invoke(["enable", "abc12345"]).exit_code == 0
    assert _baseline("abc12345") is None


def test_cli_disable_does_not_stamp(tmp_path) -> None:
    _seed_rule(id="abc12345")
    STATE.clear()
    assert _invoke(["disable", "abc12345"]).exit_code == 0
    assert _baseline("abc12345") is None


def test_cli_edit_stamps_on_enable_time_or_days_only(tmp_path) -> None:
    _seed_rule(id="abc12345", time="06:30", days=["Mon"])
    scheduler.set_rule_enabled("abc12345", False)

    STATE.clear()
    assert _invoke(["edit", "abc12345", "--name", "Renamed"]).exit_code == 0
    assert _baseline("abc12345") is None, "a rename must not restart the baseline"

    assert _invoke(["edit", "abc12345", "--time", "07:00"]).exit_code == 0
    assert _BASELINE.match(_baseline("abc12345") or "")

    STATE.clear()
    assert _invoke(["edit", "abc12345", "--days", "Tue"]).exit_code == 0
    assert _BASELINE.match(_baseline("abc12345") or "")

    STATE.clear()
    assert _invoke(["edit", "abc12345", "--enable"]).exit_code == 0
    assert _BASELINE.match(_baseline("abc12345") or "")


def test_cli_add_succeeds_when_state_is_unreadable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def corrupt() -> dict[str, RuleState]:
        raise ValueError("schedule-state.json is not JSON")

    monkeypatch.setattr(scheduler, "read_state", corrupt)
    result = _invoke(["add", "--name", "X", "--time", "06:30", "--days", "Mon",
                      "--command", "power on"])
    assert result.exit_code == 0, result.output
    assert len(scheduler.list_rules()) == 1


def test_schedules_location_block_carries_the_city_name(client: TestClient) -> None:
    from govee_cli.config import load_config, save_config

    assert client.get("/api/v1/schedules").json()["location"]["name"] is None
    cfg = load_config()
    cfg.latitude, cfg.longitude = 43.1548, -77.6156
    cfg.location_name = "Rochester, New York, United States"
    save_config(cfg)
    loc = client.get("/api/v1/schedules").json()["location"]
    assert loc["name"] == "Rochester, New York, United States"
