"""Tests for the schedule-truth backend (WEBUI_V3_SPEC.md §6): crontab discovery,
confidence-tiered next-fire, the sidecar routes, and scheduler-runner health.

Pure-function tests cover ``external_schedule.py`` directly with
``subprocess.run`` monkeypatched — no real crontab or wake-ramp binary is ever
invoked. Route tests run the sidecar in ``GOVEE_WEBUI_MOCK=1`` mode (same
pattern as ``tests/test_webui_api.py``) with the same monkeypatching, since
mock mode only fakes the device client, not the OS-level crontab/wake-ramp
shells this module owns.
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from govee_cli.schedule.scheduler import ScheduleRule  # noqa: E402
from webui.api import external_schedule  # noqa: E402
from webui.api.errors import ApiError  # noqa: E402
from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.routers import schedules as schedules_router  # noqa: E402
from webui.api.scheduler_runner import SchedulerRunner  # noqa: E402

REAL_WAKE_RAMP_LINE = (
    "30 6 * * * /home/chumby/.local/bin/wake-ramp run "
    ">> /home/chumby/logs/wake-ramp.log 2>&1"
)

# The six-category "unrelated jobs" mix named in the task brief, matching the
# real host's crontab shape (quartz-build, candle-warmer x4, morning-briefing,
# evening-healthcheck, homeio-backup) so the filter is exercised against
# something realistic, not a toy fixture.
UNRELATED_LINES = [
    "# Quartz vault build",
    "*/5 * * * * flock -n /tmp/quartz-build.lock -c 'npx quartz build' "
    ">> /home/chumby/logs/quartz-build.log 2>&1",
    "",
    "# Candle warmer — Kasa plug schedule",
    "0 5 * * * /home/chumby/.local/bin/candle-warmer on "
    ">> /home/chumby/logs/candle-warmer.log 2>&1",
    "0 11 * * * /home/chumby/.local/bin/candle-warmer off "
    ">> /home/chumby/logs/candle-warmer.log 2>&1",
    "0 15 * * * /home/chumby/.local/bin/candle-warmer on "
    ">> /home/chumby/logs/candle-warmer.log 2>&1",
    "0 21 * * * /home/chumby/.local/bin/candle-warmer off "
    ">> /home/chumby/logs/candle-warmer.log 2>&1",
    "3 8 * * * /home/chumby/.local/bin/morning-briefing "
    ">> /home/chumby/logs/morning-briefing.log 2>&1",
    "11 20 * * * /home/chumby/.local/bin/evening-healthcheck "
    ">> /home/chumby/logs/evening-healthcheck.log 2>&1",
    "30 3 * * * /home/chumby/projects/homelab/services/homeio/scheduled-backup.sh "
    ">> /home/chumby/logs/homeio-backup.log 2>&1",
]

FULL_CRONTAB = "\n".join([REAL_WAKE_RAMP_LINE, *UNRELATED_LINES]) + "\n"

WAKE_RAMP_STATUS_JSON = (
    '{"armed_date": null, "weekdays_always": true, "cron_installed": true, '
    '"today_will_run": true, "ramp": {"min_pct": 1, "max_pct": 50, "kelvin": 2000, '
    '"steps": 16, "start": "06:30", "end": "07:00", "devices": ["Light Bars"]}}'
)


def _completed(returncode: int = 0, stdout: str = "", stderr: str = "") -> Any:
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def _fake_run(
    *,
    crontab_stdout: str = "",
    crontab_returncode: int = 0,
    crontab_stderr: str = "",
    crontab_raises: Exception | None = None,
    wake_ramp_stdout: str = WAKE_RAMP_STATUS_JSON,
    wake_ramp_returncode: int = 0,
    wake_ramp_stderr: str = "",
    wake_ramp_raises: Exception | None = None,
) -> Any:
    def fake(cmd: list[str], **kwargs: Any) -> Any:
        if cmd[0] == external_schedule.CRONTAB_BIN:
            if crontab_raises is not None:
                raise crontab_raises
            return _completed(crontab_returncode, crontab_stdout, crontab_stderr)
        if cmd[0] == external_schedule.WAKE_RAMP_BIN:
            if wake_ramp_raises is not None:
                raise wake_ramp_raises
            return _completed(wake_ramp_returncode, wake_ramp_stdout, wake_ramp_stderr)
        raise AssertionError(f"unexpected subprocess call: {cmd}")

    return fake


# --------------------------------------------------------------- parse_line


def test_parse_line_skips_blank_and_comment() -> None:
    assert external_schedule.parse_line("") is None
    assert external_schedule.parse_line("   ") is None
    assert external_schedule.parse_line("# a comment") is None


def test_parse_line_skips_env_assignment() -> None:
    # No whitespace inside "MAILTO=root" -> fewer than 6 fields once split.
    assert external_schedule.parse_line("MAILTO=root") is None


def test_parse_line_splits_cron_and_command() -> None:
    parsed = external_schedule.parse_line(REAL_WAKE_RAMP_LINE)
    assert parsed is not None
    assert parsed.cron_expr == "30 6 * * *"
    assert parsed.command.startswith("/home/chumby/.local/bin/wake-ramp run")


# ----------------------------------------------------------- is_govee_relevant


def test_is_govee_relevant_wake_ramp() -> None:
    assert external_schedule.is_govee_relevant("/home/chumby/.local/bin/wake-ramp run")


def test_is_govee_relevant_govee_cli() -> None:
    assert external_schedule.is_govee_relevant("govee-cli power on --device 'Light Bars'")


def test_is_govee_relevant_false_for_unrelated() -> None:
    assert not external_schedule.is_govee_relevant("/home/chumby/.local/bin/candle-warmer on")


@pytest.fixture(autouse=True)
def _no_host_crontab_fallbacks(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """Point the two fallback routes at paths that do not exist.

    ``read_crontab`` falls through ``crontab -l`` -> the spool file -> a cached
    snapshot, so a test that mocks only ``subprocess.run`` would quietly read
    THIS machine's real crontab snapshot and report "readable" where it meant to
    assert a failure. Tests that want a fallback exercised opt back in by
    setting these paths themselves.
    """
    monkeypatch.setattr(external_schedule, "SPOOL_PATH", tmp_path / "nonexistent-spool")
    monkeypatch.setattr(
        external_schedule, "SNAPSHOT_PATH", tmp_path / "nonexistent-snapshot"
    )


# -------------------------------------------------------------------- classify


def test_classify_wake_ramp_by_path() -> None:
    parsed = external_schedule.parse_line(REAL_WAKE_RAMP_LINE)
    assert parsed is not None
    assert external_schedule.classify(parsed) == "wake-ramp"


def test_classify_generic_govee_cli_is_cron() -> None:
    parsed = external_schedule.parse_line(
        "0 9 * * * govee-cli scene apply Sunrise --device 'Light Bars'"
    )
    assert parsed is not None
    assert external_schedule.classify(parsed) == "cron"


# ------------------------------------------------------------------ read_crontab


def test_read_crontab_readable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(crontab_stdout=FULL_CRONTAB)
    )
    result = external_schedule.read_crontab()
    assert result.readable is True
    assert result.error is None
    assert len(result.raw_lines) == len(FULL_CRONTAB.splitlines())


def test_read_crontab_legitimately_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_returncode=1, crontab_stderr="no crontab for chumby"),
    )
    result = external_schedule.read_crontab()
    assert result.readable is True
    assert result.error is None
    assert result.raw_lines == []


def test_read_crontab_permission_denied_is_unreadable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_returncode=1, crontab_stderr="permission denied"),
    )
    result = external_schedule.read_crontab()
    assert result.readable is False
    assert result.error  # non-empty
    assert result.raw_lines == []


def test_read_crontab_binary_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_raises=FileNotFoundError()),
    )
    result = external_schedule.read_crontab()
    assert result.readable is False
    assert "not found" in (result.error or "")


def test_read_crontab_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_raises=subprocess.TimeoutExpired(cmd="crontab", timeout=3)),
    )
    result = external_schedule.read_crontab()
    assert result.readable is False
    assert "timed out" in (result.error or "")


# --------------------------------------------------------------- wake_ramp_status


def test_wake_ramp_status_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(external_schedule.subprocess, "run", _fake_run())
    status = external_schedule.wake_ramp_status()
    assert status is not None
    assert status["cron_installed"] is True
    assert status["ramp"]["devices"] == ["Light Bars"]


def test_wake_ramp_status_nonzero_exit_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(wake_ramp_returncode=1)
    )
    assert external_schedule.wake_ramp_status() is None


def test_wake_ramp_status_bad_json_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(wake_ramp_stdout="not json")
    )
    assert external_schedule.wake_ramp_status() is None


def test_wake_ramp_status_missing_binary_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(wake_ramp_raises=FileNotFoundError())
    )
    assert external_schedule.wake_ramp_status() is None


# ---------------------------------------------------------- next_fire_for_wake_ramp


def test_next_fire_for_wake_ramp_weekday_morning_before_start() -> None:
    status = {"armed_date": None, "ramp": {"start": "06:30", "end": "07:00"}}
    now = datetime.datetime(2026, 8, 25, 5, 0, tzinfo=datetime.timezone.utc)  # a Tuesday
    fire, confidence = external_schedule.next_fire_for_wake_ramp(status, now)
    assert confidence == "exact"
    assert fire == "2026-08-25T06:30:00+00:00"


def test_next_fire_for_wake_ramp_weekday_after_start_rolls_to_next_day() -> None:
    status = {"armed_date": None, "ramp": {"start": "06:30", "end": "07:00"}}
    now = datetime.datetime(2026, 8, 25, 8, 0, tzinfo=datetime.timezone.utc)  # past today's window
    fire, confidence = external_schedule.next_fire_for_wake_ramp(status, now)
    assert confidence == "exact"
    assert fire == "2026-08-26T06:30:00+00:00"


def test_next_fire_for_wake_ramp_weekend_unarmed_skips_to_monday() -> None:
    # 2026-08-29 is a Saturday.
    status = {"armed_date": None, "ramp": {"start": "06:30", "end": "07:00"}}
    now = datetime.datetime(2026, 8, 29, 5, 0, tzinfo=datetime.timezone.utc)
    fire, confidence = external_schedule.next_fire_for_wake_ramp(status, now)
    assert confidence == "exact"
    assert fire == "2026-08-31T06:30:00+00:00"  # Monday


def test_next_fire_for_wake_ramp_weekend_armed_fires_that_day() -> None:
    status = {"armed_date": "2026-08-29", "ramp": {"start": "06:30", "end": "07:00"}}
    now = datetime.datetime(2026, 8, 29, 5, 0, tzinfo=datetime.timezone.utc)
    fire, confidence = external_schedule.next_fire_for_wake_ramp(status, now)
    assert confidence == "exact"
    assert fire == "2026-08-29T06:30:00+00:00"


# -------------------------------------------------------------- next_fire_for_cron


def test_next_fire_for_cron_valid_is_estimated() -> None:
    now = datetime.datetime(2026, 8, 25, 5, 0)
    fire, confidence = external_schedule.next_fire_for_cron("0 9 * * *", now)
    assert confidence == "estimated"
    assert fire is not None


def test_next_fire_for_cron_malformed_is_unknown() -> None:
    now = datetime.datetime(2026, 8, 25, 5, 0)
    fire, confidence = external_schedule.next_fire_for_cron("99 6 * * *", now)
    assert fire is None
    assert confidence == "unknown"


# --------------------------------------------------------------- today_occurrences


def test_today_occurrences_caps_pathological_expression() -> None:
    now = datetime.datetime(2026, 8, 25, 12, 0)
    occurrences, truncated = external_schedule.today_occurrences("* * * * *", now, cap=20)
    assert len(occurrences) == 20
    assert truncated is True


def test_today_occurrences_malformed_returns_empty_untruncated() -> None:
    now = datetime.datetime(2026, 8, 25, 12, 0)
    occurrences, truncated = external_schedule.today_occurrences("99 6 * * *", now)
    assert occurrences == []
    assert truncated is False


# ------------------------------------------------------------ build_external_schedule


def test_build_external_schedule_filters_to_exactly_one_wake_ramp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(crontab_stdout=FULL_CRONTAB)
    )
    now = datetime.datetime(2026, 8, 25, 5, 0, tzinfo=datetime.timezone.utc)
    result = external_schedule.build_external_schedule(now)
    assert result["crontab"]["readable"] is True
    entries = result["entries"]
    wake_ramp_entries = [e for e in entries if e["kind"] == "wake-ramp"]
    cron_entries = [e for e in entries if e["kind"] == "cron"]
    assert len(wake_ramp_entries) == 1
    assert len(cron_entries) == 0
    assert wake_ramp_entries[0]["id"] == "wake-ramp"
    assert wake_ramp_entries[0]["next_fire_confidence"] == "exact"
    assert wake_ramp_entries[0]["device_hint"] == "Light Bars"
    assert wake_ramp_entries[0]["duration_minutes"] == 30


def test_build_external_schedule_unreadable_crontab_is_not_empty_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unreadable crontab must never present as a genuinely empty one (§6.6)."""
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_returncode=1, crontab_stderr="sandboxed: permission denied"),
    )
    result = external_schedule.build_external_schedule()
    assert result["crontab"]["readable"] is False
    assert result["crontab"]["error"]  # non-empty — never silently omitted
    assert result["entries"] == []


def test_build_external_schedule_malformed_cron_line_is_unknown_not_a_crash(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    crontab = (
        "99 6 * * * govee-cli scene apply Sunrise --device 'Light Bars' "
        ">> /home/chumby/logs/govee-scene.log 2>&1\n"
    )
    monkeypatch.setattr(external_schedule.subprocess, "run", _fake_run(crontab_stdout=crontab))
    result = external_schedule.build_external_schedule()
    assert result["crontab"]["readable"] is True
    assert len(result["entries"]) == 1
    entry = result["entries"][0]
    assert entry["kind"] == "cron"
    assert entry["next_fire"] is None
    assert entry["next_fire_confidence"] == "unknown"
    assert entry["parse_error"]


def test_build_external_schedule_irrelevant_jobs_produce_no_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_stdout="\n".join(UNRELATED_LINES) + "\n"),
    )
    result = external_schedule.build_external_schedule()
    assert result["crontab"]["readable"] is True
    assert result["entries"] == []


def test_build_external_schedule_wake_ramp_status_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The crontab line exists but the script itself can't be asked — still no crash, no guess."""
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_stdout=REAL_WAKE_RAMP_LINE + "\n", wake_ramp_returncode=1),
    )
    result = external_schedule.build_external_schedule()
    entry = result["entries"][0]
    assert entry["next_fire"] is None
    assert entry["next_fire_confidence"] == "unknown"
    assert entry["parse_error"]


# -------------------------------------------------------------- arm/disarm (pure)


def test_arm_wake_ramp_reads_fresh_status(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []

    def fake(cmd: list[str], **kwargs: Any) -> Any:
        calls.append(cmd)
        if cmd[0] == external_schedule.WAKE_RAMP_BIN and cmd[1] == "arm":
            return _completed(0, "", "")
        if cmd[0] == external_schedule.CRONTAB_BIN:
            return _completed(0, REAL_WAKE_RAMP_LINE + "\n", "")
        if cmd[0] == external_schedule.WAKE_RAMP_BIN and cmd[1] == "status":
            return _completed(0, WAKE_RAMP_STATUS_JSON, "")
        raise AssertionError(cmd)

    monkeypatch.setattr(external_schedule.subprocess, "run", fake)
    entry = external_schedule.arm_wake_ramp()
    assert entry["id"] == "wake-ramp"
    assert [external_schedule.WAKE_RAMP_BIN, "arm"] in calls


def test_arm_wake_ramp_failure_raises_api_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(wake_ramp_returncode=1, wake_ramp_stderr="flag dir not writable"),
    )
    with pytest.raises(ApiError):
        external_schedule.arm_wake_ramp()


# ------------------------------------------------------------------------ routes


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


@pytest.fixture(autouse=True)
def _clear_external_cache() -> Any:
    # The module-level TTL cache in routers/schedules.py outlives any one
    # test — without clearing it, an earlier test's monkeypatched subprocess
    # result would still be served to a later test within the cache window.
    schedules_router._external_cache.invalidate(schedules_router._EXTERNAL_CACHE_KEY)
    yield
    schedules_router._external_cache.invalidate(schedules_router._EXTERNAL_CACHE_KEY)


def test_route_get_external_schedule(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(crontab_stdout=FULL_CRONTAB)
    )
    resp = client.get("/api/v1/schedules/external")
    assert resp.status_code == 200
    body = resp.json()
    assert body["crontab"]["readable"] is True
    entries = body["entries"]
    assert len([e for e in entries if e["kind"] == "wake-ramp"]) == 1
    assert len([e for e in entries if e["kind"] == "cron"]) == 0


def test_route_get_external_schedule_unreadable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(crontab_returncode=1, crontab_stderr="permission denied"),
    )
    resp = client.get("/api/v1/schedules/external")
    assert resp.status_code == 200
    body = resp.json()
    assert body["crontab"]["readable"] is False
    assert body["crontab"]["error"]
    assert body["entries"] == []


def test_route_get_external_schedule_is_cached(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    def fake(cmd: list[str], **kwargs: Any) -> Any:
        calls["n"] += 1
        if cmd[0] == external_schedule.CRONTAB_BIN:
            return _completed(0, REAL_WAKE_RAMP_LINE + "\n", "")
        return _completed(0, WAKE_RAMP_STATUS_JSON, "")

    monkeypatch.setattr(external_schedule.subprocess, "run", fake)
    first = client.get("/api/v1/schedules/external")
    second = client.get("/api/v1/schedules/external")
    assert first.status_code == second.status_code == 200
    # crontab + wake-ramp-status = 2 subprocess calls for the first request;
    # the second must be served from cache, not re-invoking either shell.
    assert calls["n"] == 2


def test_route_arm_and_disarm_wake_ramp(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = {"armed": False}

    def fake(cmd: list[str], **kwargs: Any) -> Any:
        if cmd[0] == external_schedule.WAKE_RAMP_BIN and cmd[1] == "arm":
            state["armed"] = True
            return _completed(0, "", "")
        if cmd[0] == external_schedule.WAKE_RAMP_BIN and cmd[1] == "disarm":
            state["armed"] = False
            return _completed(0, "", "")
        if cmd[0] == external_schedule.CRONTAB_BIN:
            return _completed(0, REAL_WAKE_RAMP_LINE + "\n", "")
        if cmd[0] == external_schedule.WAKE_RAMP_BIN and cmd[1] == "status":
            status = json.loads(WAKE_RAMP_STATUS_JSON)
            status["armed_date"] = "2026-08-29" if state["armed"] else None
            return _completed(0, json.dumps(status), "")
        raise AssertionError(cmd)

    monkeypatch.setattr(external_schedule.subprocess, "run", fake)

    armed = client.post("/api/v1/schedules/external/wake-ramp/arm")
    assert armed.status_code == 200
    assert armed.json()["wake_ramp_status"]["armed_date"] == "2026-08-29"

    disarmed = client.post("/api/v1/schedules/external/wake-ramp/disarm")
    assert disarmed.status_code == 200
    assert disarmed.json()["wake_ramp_status"]["armed_date"] is None


def test_route_arm_wake_ramp_failure_is_bad_gateway(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        external_schedule.subprocess,
        "run",
        _fake_run(wake_ramp_returncode=1, wake_ramp_stderr="flag dir not writable"),
    )
    resp = client.post("/api/v1/schedules/external/wake-ramp/arm")
    assert resp.status_code == 502


def test_native_schedules_route_unaffected(client: TestClient) -> None:
    """The pre-existing native-rule CRUD routes are untouched by this change."""
    resp = client.get("/api/v1/schedules")
    assert resp.status_code == 200
    assert "schedules" in resp.json()


# --------------------------------------------------------------- scheduler_runner


def test_scheduler_runner_snapshot_initial_state() -> None:
    runner = SchedulerRunner(poll_seconds=1.0)
    snap = runner.snapshot()
    assert snap == {
        "alive": False,
        "poll_seconds": 1.0,
        "last_cycle_at": None,
        "last_fire": None,
    }


def test_fire_due_sets_last_cycle_at_even_with_nothing_due(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = SchedulerRunner()
    monkeypatch.setattr("webui.api.scheduler_runner.list_rules", lambda: [])
    fired = runner.fire_due()
    assert fired == 0
    snap = runner.snapshot()
    assert snap["last_cycle_at"] is not None
    # Must be a real, parseable ISO-8601 UTC timestamp.
    datetime.datetime.fromisoformat(snap["last_cycle_at"])


def test_run_rule_records_success(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = SchedulerRunner()

    async def fake_execute(rule: ScheduleRule) -> bool:
        return True

    monkeypatch.setattr(runner, "_execute", fake_execute)
    rule = ScheduleRule(
        id="r1", name="Morning", time="06:30", days=["Mon"], command="power on"
    )
    runner._run_rule(rule)
    snap = runner.snapshot()
    assert snap["last_fire"] == {
        "rule_id": "r1", "name": "Morning", "at": snap["last_fire"]["at"], "ok": True
    }
    assert "error" not in snap["last_fire"]


def test_run_rule_records_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    runner = SchedulerRunner()

    async def fake_execute(rule: ScheduleRule) -> bool:
        raise RuntimeError("boom")

    monkeypatch.setattr(runner, "_execute", fake_execute)
    rule = ScheduleRule(
        id="r2", name="Evening", time="20:00", days=["Mon"], command="power off"
    )
    runner._run_rule(rule)
    snap = runner.snapshot()
    assert snap["last_fire"]["rule_id"] == "r2"
    assert snap["last_fire"]["ok"] is False
    assert snap["last_fire"]["error"] == "boom"


def test_run_rule_records_failure_when_device_refuses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rule the device did not obey must not read as a successful fire.

    ``_execute_rule`` handles every failure it can reach internally and reports
    the outcome as a bool rather than raising, so a runner that only watched for
    exceptions would record ``ok=True`` for a rule that silently did nothing —
    which is precisely what the health readout is there to catch.
    """
    runner = SchedulerRunner()

    async def fake_execute(rule: ScheduleRule) -> bool:
        return False

    monkeypatch.setattr(runner, "_execute", fake_execute)
    runner._run_rule(ScheduleRule(id="r9", name="dud", time="07:00", days=["mon"],
                                  command="power on", device="Nope"))

    snap = runner.snapshot()
    assert snap["last_fire"]["ok"] is False
    assert snap["last_fire"]["error"]


# ------------------------------------------------------- read_crontab fallbacks


def _denied_run():
    """A crontab -l that fails the way the sandboxed sidecar sees it."""
    return _fake_run(crontab_returncode=1, crontab_stderr="crontabs/chumby/: fopen: Permission denied")


def test_spool_file_answers_when_the_command_cannot(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    spool = tmp_path / "chumby"
    spool.write_text(REAL_WAKE_RAMP_LINE + "\n")
    monkeypatch.setattr(external_schedule.subprocess, "run", _denied_run())
    monkeypatch.setattr(external_schedule, "SPOOL_PATH", spool)

    result = external_schedule.read_crontab()
    assert result.readable is True
    assert result.source == "spool"
    assert result.stale_seconds is None
    assert result.raw_lines == [REAL_WAKE_RAMP_LINE]


def test_snapshot_answers_last_and_reports_its_age(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    snapshot = tmp_path / "crontab.snapshot"
    snapshot.write_text(REAL_WAKE_RAMP_LINE + "\n")
    monkeypatch.setattr(external_schedule.subprocess, "run", _denied_run())
    monkeypatch.setattr(external_schedule, "SNAPSHOT_PATH", snapshot)

    result = external_schedule.read_crontab()
    assert result.readable is True
    assert result.source == "snapshot"
    # A cached answer must never be indistinguishable from a live one.
    assert result.stale_seconds is not None
    assert result.stale_seconds >= 0


def test_live_command_wins_over_both_fallbacks(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    stale = tmp_path / "crontab.snapshot"
    stale.write_text("0 0 * * * govee-cli power off --device Stale\n")
    monkeypatch.setattr(
        external_schedule.subprocess, "run", _fake_run(crontab_stdout=FULL_CRONTAB)
    )
    monkeypatch.setattr(external_schedule, "SNAPSHOT_PATH", stale)

    result = external_schedule.read_crontab()
    assert result.source == "crontab"
    assert "Stale" not in "\n".join(result.raw_lines)


def test_all_routes_failing_reports_the_fix_not_just_eacces(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(external_schedule.subprocess, "run", _denied_run())
    result = external_schedule.read_crontab()

    assert result.readable is False
    assert result.source == "none"
    assert result.raw_lines == []
    # The point of the message is that someone can act on it.
    assert "Permission denied" in (result.error or "")
    assert "govee-crontab-snapshot" in (result.error or "")


def test_cron_installed_trusts_our_own_read_over_the_script(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """wake-ramp's own crontab check fails under the same sandbox we work around.

    When the script reports cron_installed:false but we are holding the parsed
    crontab line that schedules it, our evidence is strictly better.
    """
    parsed = external_schedule.parse_line(REAL_WAKE_RAMP_LINE)
    assert parsed is not None
    status = {
        "armed_date": None,
        "weekdays_always": True,
        "cron_installed": False,
        "today_will_run": True,
        "ramp": {"start": "06:30", "end": "07:00", "devices": ["Light Bars"]},
    }
    entry = external_schedule._build_wake_ramp_entry(
        parsed, status, datetime.datetime(2026, 8, 25, 2, 0).astimezone()
    )
    assert entry["wake_ramp_status"]["cron_installed"] is True
