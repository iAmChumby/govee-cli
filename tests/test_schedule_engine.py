"""Schedule engine (issue #2): next run, today's fire, due-once polling across
DST, missed detection, previews."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

from govee_cli.schedule.engine import (
    detect_missed,
    due_rules,
    minute_key,
    preview,
    rule_days,
    rule_status,
)
from govee_cli.schedule.scheduler import RuleState, ScheduleRule
from govee_cli.schedule.timespec import Location

NY = ZoneInfo("America/New_York")
OSLO_TZ = ZoneInfo("Europe/Oslo")
NYC = Location(40.7128, -74.0060, "America/New_York", "config")
OSLO = Location(59.9139, 10.7522, "Europe/Oslo", "config")
TROMSO = Location(69.65, 18.96, "Europe/Oslo", "config")
NO_COORDS = Location(None, None, "America/New_York", "host")
ALL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def rule(time: str, days: list[str] | None = None, *, id: str = "r1", enabled: bool = True,
         room_scene: str | None = None) -> ScheduleRule:
    return ScheduleRule(id=id, name=id, time=time, days=days or ALL, command="power on",
                        enabled=enabled, room_scene=room_scene)


def ny(y: int, mo: int, d: int, h: int = 0, mi: int = 0, s: int = 0) -> dt.datetime:
    return dt.datetime(y, mo, d, h, mi, s, tzinfo=NY)


def test_rule_days_accepts_mixed_spellings() -> None:
    r = rule("06:30", ["Mon", "tue", "WEDNESDAY", "bogus"])
    assert rule_days(r) == {"mon", "tue", "wed"}


def test_next_run_for_sunset_minus_one_hour() -> None:
    status = rule_status(rule("sunset-1h"), ny(2026, 10, 18, 12), NYC, set())
    assert status.next_run == ny(2026, 10, 18, 17, 10)
    assert status.next_run_reason is None
    assert status.today_fire == ny(2026, 10, 18, 17, 10)
    assert status.canonical_time == "sunset-1h"


def test_next_run_after_todays_fire_is_tomorrow() -> None:
    status = rule_status(rule("sunset-1h"), ny(2026, 10, 18, 18), NYC, set())
    assert status.next_run is not None and status.next_run.date() == dt.date(2026, 10, 19)
    assert status.today_fire == ny(2026, 10, 18, 17, 10)  # past fire still reported


def test_stored_noncanonical_time_is_canonicalised() -> None:
    assert rule_status(rule("sunset-75m"), ny(2026, 10, 18, 12), NYC,
                       set()).canonical_time == "sunset-1h15m"


def test_paused_and_today_fire_still_computed() -> None:
    status = rule_status(rule("06:30", enabled=False), ny(2026, 10, 18, 12), NYC, set())
    assert status.next_run is None and status.next_run_reason == "paused"
    assert status.today_fire == ny(2026, 10, 18, 6, 30)


def test_not_scheduled_today() -> None:
    # 2026-10-18 is a Sunday.
    status = rule_status(rule("06:30", ["Mon"]), ny(2026, 10, 18, 12), NYC, set())
    assert status.today_fire is None and status.today_reason == "not scheduled today"
    assert status.next_run == ny(2026, 10, 19, 6, 30)


def test_invalid_time_is_reported_not_raised() -> None:
    status = rule_status(rule("noon"), ny(2026, 10, 18, 12), NYC, set())
    assert status.canonical_time is None and status.next_run is None
    assert status.next_run_reason is not None
    assert status.next_run_reason.startswith("invalid time: ")


def test_sun_rule_without_location() -> None:
    status = rule_status(rule("sunset"), ny(2026, 10, 18, 12), NO_COORDS, set())
    assert status.next_run is None
    assert status.next_run_reason == "no location: no next run"
    assert status.today_fire is None and status.today_reason == "no location"
    # clock rules are unaffected
    assert rule_status(rule("06:30"), ny(2026, 10, 18, 12), NO_COORDS,
                       set()).next_run == ny(2026, 10, 19, 6, 30)


def test_missing_room_scene_blocks_next_run() -> None:
    r = rule("06:30", room_scene="Movie")
    status = rule_status(r, ny(2026, 10, 18, 12), NYC, {"Other"})
    expected = "room scene 'Movie' missing: rule will not fire"
    assert status.target_problem == expected
    assert status.next_run is None and status.next_run_reason == expected
    ok = rule_status(r, ny(2026, 10, 18, 12), NYC, {"Movie"})
    assert ok.target_problem is None and ok.next_run is not None


def test_polar_day_reason_and_no_exception() -> None:
    now = dt.datetime(2026, 6, 21, 12, tzinfo=OSLO_TZ)
    status = rule_status(rule("sunset"), now, TROMSO, set())
    assert status.today_fire is None
    assert status.today_reason == "no sunset on 2026-06-21 at this location"


def test_days_filter_uses_fires_own_local_date_across_midnight() -> None:
    # Oslo 2026-06-22 (Mon) sunset ~22:xx; +3h lands Tuesday ~01:xx.
    mon_only = rule("sunset+3h", ["Mon"])
    tue_only = rule("sunset+3h", ["Tue"])
    now = dt.datetime(2026, 6, 22, 12, tzinfo=OSLO_TZ)  # Monday noon
    # The Monday-evening sunset fires on Tuesday, so a Monday-only rule skips it.
    nxt = rule_status(mon_only, now, OSLO, set()).next_run
    # Next Monday-dated fire is Sunday 28th's sunset carried to Monday 29th 01:xx.
    assert nxt is not None and nxt.date() == dt.date(2026, 6, 29) and nxt.hour < 6
    tue = rule_status(tue_only, now, OSLO, set())
    assert tue.next_run is not None and tue.next_run.date() == dt.date(2026, 6, 23)
    assert tue.next_run.hour < 6
    # Tuesday's today_fire is the fire carried over from Monday's sunset.
    tue_now = dt.datetime(2026, 6, 23, 12, tzinfo=OSLO_TZ)
    assert rule_status(tue_only, tue_now, OSLO, set()).today_fire is not None
    assert rule_status(mon_only, tue_now, OSLO, set()).today_fire is None


def test_sunrise_minus_6h_crosses_midnight_backwards() -> None:
    # Oslo sunrise ~03:5x, minus 6h = ~21:5x the previous evening.
    sun_only = rule("sunrise-6h", ["Sun"])
    now = dt.datetime(2026, 6, 20, 12, tzinfo=OSLO_TZ)  # Saturday
    status = rule_status(sun_only, now, OSLO, set())
    # Monday sunrise-6h lands Sunday evening; Sunday sunrise-6h lands Saturday evening.
    assert status.next_run is not None
    assert status.next_run.weekday() == 6  # Sunday
    assert status.next_run.hour >= 20


def test_dst_gap_next_run_skips_the_missing_day_and_today_says_why() -> None:
    now = ny(2027, 3, 14, 0, 5)
    status = rule_status(rule("02:30"), now, NYC, set())
    assert status.today_fire is None
    assert status.today_reason == "02:30 does not exist on 2027-03-14 (DST)"
    assert status.next_run == ny(2027, 3, 15, 2, 30)


def test_sun_next_run_across_transition_carries_new_offset() -> None:
    status = rule_status(rule("sunset"), ny(2026, 10, 31, 20), NYC, set())
    assert status.next_run is not None
    assert status.next_run.date() == dt.date(2026, 11, 1)
    assert status.next_run.utcoffset() == dt.timedelta(hours=-5)


def test_due_matches_only_the_scheduled_minute() -> None:
    r = rule("06:30")
    assert due_rules([r], ny(2026, 10, 19, 6, 30, 0), NYC, {}) == [(r, ny(2026, 10, 19, 6, 30))]
    assert due_rules([r], ny(2026, 10, 19, 6, 30, 59), NYC, {})  # same minute, still due
    assert due_rules([r], ny(2026, 10, 19, 6, 29, 59), NYC, {}) == []
    assert due_rules([r], ny(2026, 10, 19, 6, 31, 0), NYC, {}) == []
    assert due_rules([rule("06:30", enabled=False)], ny(2026, 10, 19, 6, 30), NYC, {}) == []
    assert due_rules([rule("06:30", ["Tue"])], ny(2026, 10, 19, 6, 30), NYC, {}) == []  # Monday


def test_rule_fires_once_per_minute_across_polls_and_reloads() -> None:
    r = rule("06:30")
    state: dict[str, RuleState] = {}
    fired = []
    start = ny(2026, 10, 19, 6, 29, 40)
    for i in range(0, 7):  # polls every 20s from 06:29:40 to 06:31:40
        now = start + dt.timedelta(seconds=20 * i)
        for due_rule, minute in due_rules([r], now, NYC, state):
            fired.append(minute)
            state[due_rule.id] = RuleState(last_fired_minute=minute_key(minute))
    assert fired == [ny(2026, 10, 19, 6, 30)]
    # A restarted scheduler that reloaded the state file sees the same thing.
    reloaded = {k: RuleState(**vars(v)) for k, v in state.items()}
    assert due_rules([r], ny(2026, 10, 19, 6, 30, 40), NYC, reloaded) == []
    assert state["r1"].last_fired_minute == "2026-10-19T10:30:00+00:00"


def test_dst_overlap_0130_fires_exactly_once() -> None:
    r = rule("01:30")
    state: dict[str, RuleState] = {}
    fired = []
    utc = dt.timezone.utc
    t = dt.datetime(2026, 11, 1, 4, 50, tzinfo=utc)  # 00:50 EDT
    end = dt.datetime(2026, 11, 1, 7, 10, tzinfo=utc)  # 02:10 EST
    while t < end:
        for due_rule, minute in due_rules([r], t, NYC, state):
            fired.append(minute.astimezone(utc))
            state[due_rule.id] = RuleState(last_fired_minute=minute_key(minute))
        t += dt.timedelta(seconds=20)
    assert fired == [dt.datetime(2026, 11, 1, 5, 30, tzinfo=utc)]  # the first 01:30 (EDT)


def test_dst_gap_0230_never_fires() -> None:
    r = rule("02:30")
    utc = dt.timezone.utc
    t = dt.datetime(2027, 3, 14, 5, 50, tzinfo=utc)  # 00:50 EST
    end = dt.datetime(2027, 3, 14, 8, 10, tzinfo=utc)  # 04:10 EDT
    hits = 0
    while t < end:
        hits += len(due_rules([r], t, NYC, {}))
        t += dt.timedelta(seconds=20)
    assert hits == 0


def test_sun_rule_due_at_its_minute() -> None:
    r = rule("sunset-1h")
    assert [m for _, m in due_rules([r], ny(2026, 10, 18, 17, 10, 30), NYC, {})] == [
        ny(2026, 10, 18, 17, 10)]
    assert due_rules([r], ny(2026, 10, 18, 17, 11), NYC, {}) == []


# --- detect_missed ----------------------------------------------------------


def utc_dt(*args: int) -> dt.datetime:
    return dt.datetime(*args, tzinfo=dt.timezone.utc)  # type: ignore[arg-type]


def test_missed_after_last_fired_minute() -> None:
    r = rule("06:30")
    now = ny(2026, 10, 19, 9, 0)  # Monday 09:00; 06:30 today has passed
    state = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 18, 6, 30)))}
    missed = detect_missed([r], now, NYC, state, utc_dt(2026, 10, 19, 5, 0))
    assert missed == {"r1": ny(2026, 10, 19, 6, 30)}


def test_not_missed_when_already_fired() -> None:
    r = rule("06:30")
    now = ny(2026, 10, 19, 9, 0)
    state = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 19, 6, 30)))}
    assert detect_missed([r], now, NYC, state, None) == {}


def test_never_fired_uses_previous_last_cycle() -> None:
    r = rule("06:30")
    now = ny(2026, 10, 19, 9, 0)
    # Previous owner stopped before the fire -> missed.
    assert detect_missed([r], now, NYC, {}, ny(2026, 10, 19, 6, 0)) == {
        "r1": ny(2026, 10, 19, 6, 30)}
    # Previous owner was alive past the fire minute (it would have fired) -> nothing.
    assert detect_missed([r], now, NYC, {}, ny(2026, 10, 19, 8, 0)) == {}


def test_never_fired_and_no_previous_owner_is_nothing() -> None:
    assert detect_missed([rule("06:30")], ny(2026, 10, 19, 9, 0), NYC, {}, None) == {}


def test_missed_ignores_disabled_and_uses_most_recent_scheduled_minute() -> None:
    now = ny(2026, 10, 21, 9, 0)  # Wednesday
    old = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 15, 6, 30)))}
    missed = detect_missed([rule("06:30")], now, NYC, old, None)
    assert missed == {"r1": ny(2026, 10, 21, 6, 30)}  # only the latest, not a backlog
    assert detect_missed([rule("06:30", enabled=False)], now, NYC, old, None) == {}
    # Weekday-only rule evaluated Saturday: most recent scheduled minute is Friday.
    sat = ny(2026, 10, 24, 9, 0)
    wk = rule("06:30", ["Mon", "Tue", "Wed", "Thu", "Fri"])
    assert detect_missed([wk], sat, NYC, old, None) == {"r1": ny(2026, 10, 23, 6, 30)}


def test_fire_minute_equal_to_now_is_not_missed() -> None:
    # due_rules owns the current minute.
    now = ny(2026, 10, 19, 6, 30, 20)
    state = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 18, 6, 30)))}
    assert detect_missed([rule("06:30")], now, NYC, state, None) == {}


def test_reenabled_after_its_minute_is_not_missed() -> None:
    now = ny(2026, 10, 21, 9, 0)  # Wednesday; 06:30 passed while the rule was disabled
    state = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 19, 6, 30)),
                             baseline_at=minute_key(ny(2026, 10, 21, 8, 0)))}
    assert detect_missed([rule("06:30")], now, NYC, state, None) == {}
    # Re-enabled BEFORE the minute: still missed.
    early = {"r1": RuleState(last_fired_minute=minute_key(ny(2026, 10, 19, 6, 30)),
                             baseline_at=minute_key(ny(2026, 10, 21, 6, 0)))}
    assert detect_missed([rule("06:30")], now, NYC, early, None) == {
        "r1": ny(2026, 10, 21, 6, 30)}


def test_created_after_its_minute_is_not_missed() -> None:
    now = ny(2026, 10, 21, 9, 0)
    state = {"r1": RuleState(baseline_at=minute_key(ny(2026, 10, 21, 8, 30)))}
    # Even with a previous owner who stopped long before the minute.
    assert detect_missed([rule("06:30")], now, NYC, state, ny(2026, 10, 21, 5, 0)) == {}
    # A minute exactly at the baseline is not missed either.
    at = {"r1": RuleState(baseline_at=minute_key(ny(2026, 10, 21, 6, 30)))}
    assert detect_missed([rule("06:30")], now, NYC, at, None) == {}


# --- preview ----------------------------------------------------------------


def test_preview_sun_rule() -> None:
    p = preview("Sunset-60M", ["Sun", "Mon"], ny(2026, 10, 18, 12), NYC)
    assert p.error is None and p.canonical_time == "sunset-1h"
    assert p.event_time is not None and (p.event_time.hour, p.event_time.minute) == (18, 10)
    assert p.today_fire == ny(2026, 10, 18, 17, 10)
    assert p.next_run == ny(2026, 10, 18, 17, 10)
    assert p.reason is None


def test_preview_grammar_error_and_no_location() -> None:
    bad = preview("sunset+9h", ALL, ny(2026, 10, 18, 12), NYC)
    assert bad.error is not None and "too large" in bad.error
    assert bad.canonical_time is None and bad.next_run is None
    nowhere = preview("sunset", ALL, ny(2026, 10, 18, 12), NO_COORDS)
    assert nowhere.canonical_time == "sunset" and nowhere.next_run is None
    assert nowhere.event_time is None and nowhere.reason == "no location: no next run"
