"""Time grammar and sun maths (issue #2): the parser, canonical spelling,
astral-backed event times, polar days and DST edges."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest

from govee_cli.schedule.timespec import (
    Location,
    TimeSpecError,
    canonical,
    event_time_on,
    fire_time_on,
    host_timezone,
    normalise_time,
    parse_time,
    resolve_location,
)

NYC = Location(40.7128, -74.0060, "America/New_York", "config")
OSLO = Location(59.9139, 10.7522, "Europe/Oslo", "config")
TROMSO = Location(69.65, 18.96, "Europe/Oslo", "config")
NO_COORDS = Location(None, None, "America/New_York", "host")


@pytest.mark.parametrize("text, expected", [
    ("sunset-1h", "sunset-1h"),
    ("sunrise+30m", "sunrise+30m"),
    ("sunset-1h15m", "sunset-1h15m"),
    ("sunset", "sunset"),
    ("06:30", "06:30"),
    ("6:30", "06:30"),
    ("sunset+0m", "sunset"),
    ("Sunset-90M", "sunset-1h30m"),
    ("sunset-2h0m", "sunset-2h"),
    ("sunset-75m", "sunset-1h15m"),
    ("  SUNRISE + 6h ", "sunrise+6h"),
    ("sunset-360m", "sunset-6h"),
    ("sunset+1m", "sunset+1m"),
])
def test_parse_and_canonical(text: str, expected: str) -> None:
    assert normalise_time(text) == expected
    # Canonical is a fixed point.
    assert normalise_time(expected) == expected


@pytest.mark.parametrize("text, fragment", [
    ("sunset+7h", "too large"),
    ("sunset-361m", "too large"),
    ("25:00", "not a valid time of day"),
    ("12:60", "not a valid time of day"),
    ("noon", "not a valid time"),
    ("sunset-1x", "invalid offset"),
    ("sunset+", "invalid offset"),
    ("", "empty"),
])
def test_rejects_with_readable_message(text: str, fragment: str) -> None:
    with pytest.raises(TimeSpecError) as err:
        parse_time(text)
    assert fragment in str(err.value)


def test_parsed_fields() -> None:
    spec = parse_time("sunset-1h30m")
    assert (spec.kind, spec.offset_minutes) == ("sunset", -90)
    clock = parse_time("07:05")
    assert (clock.kind, clock.hour, clock.minute) == ("clock", 7, 5)
    assert canonical(clock) == "07:05"


def test_resolve_location_labels_source(monkeypatch: pytest.MonkeyPatch) -> None:
    from govee_cli.config import GoveeConfig

    monkeypatch.setenv("TZ", "Europe/Oslo")
    host = resolve_location(GoveeConfig())
    assert (host.timezone, host.timezone_source) == ("Europe/Oslo", "host")
    assert not host.has_coordinates
    cfg = resolve_location(GoveeConfig(latitude=1.0, longitude=2.0, timezone="Asia/Tokyo"))
    assert (cfg.timezone, cfg.timezone_source) == ("Asia/Tokyo", "config")
    assert cfg.has_coordinates


def test_host_timezone_prefers_valid_tz_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TZ", "America/Chicago")
    assert host_timezone() == "America/Chicago"
    monkeypatch.setenv("TZ", "Not/AZone")
    # An invalid TZ is ignored, never returned.
    assert host_timezone() != "Not/AZone"


def test_nyc_sunset_minus_one_hour_is_floored() -> None:
    day = dt.date(2026, 10, 18)
    event, _ = event_time_on("sunset", day, NYC)
    assert event is not None
    assert (event.hour, event.minute, event.second) == (18, 10, 0)  # astral 18:10:52, floored
    fire, reason = fire_time_on(parse_time("sunset-1h"), day, NYC)
    assert reason is None and fire is not None
    assert fire == dt.datetime(2026, 10, 18, 17, 10, tzinfo=ZoneInfo("America/New_York"))
    assert fire.second == 0 and fire.utcoffset() == dt.timedelta(hours=-4)


def test_no_coordinates_has_no_sun_time() -> None:
    assert event_time_on("sunset", dt.date(2026, 10, 18), NO_COORDS) == (None, "no location")
    fire, reason = fire_time_on(parse_time("sunset-1h"), dt.date(2026, 10, 18), NO_COORDS)
    assert fire is None and reason == "no location"
    # A clock rule never needs coordinates.
    fire, _ = fire_time_on(parse_time("06:30"), dt.date(2026, 10, 18), NO_COORDS)
    assert fire is not None and (fire.hour, fire.minute) == (6, 30)


def test_polar_day_has_no_sunset_and_does_not_raise() -> None:
    day = dt.date(2026, 6, 21)
    assert event_time_on("sunset", day, TROMSO) == (
        None, "no sunset on 2026-06-21 at this location")
    assert fire_time_on(parse_time("sunset-1h"), day, TROMSO) == (
        None, "no sunset on 2026-06-21 at this location")
    sunrise = event_time_on("sunrise", day, TROMSO)
    assert sunrise == (None, "no sunrise on 2026-06-21 at this location")


def test_dst_gap_clock_time_does_not_exist() -> None:
    fire, reason = fire_time_on(parse_time("02:30"), dt.date(2027, 3, 14), NYC)
    assert fire is None
    assert reason == "02:30 does not exist on 2027-03-14 (DST)"
    # The day before and after are ordinary.
    for day in (dt.date(2027, 3, 13), dt.date(2027, 3, 15)):
        assert fire_time_on(parse_time("02:30"), day, NYC)[0] is not None


def test_dst_overlap_clock_time_is_first_occurrence() -> None:
    fire, reason = fire_time_on(parse_time("01:30"), dt.date(2026, 11, 1), NYC)
    assert reason is None and fire is not None
    assert fire.utcoffset() == dt.timedelta(hours=-4)  # EDT, the first 01:30
    assert fire.fold == 0


def test_sun_offset_is_elapsed_time_across_a_transition() -> None:
    # 2026-11-01 sunset in New York is ~16:50 EST (UTC-5), after the 02:00 change.
    fire, _ = fire_time_on(parse_time("sunset"), dt.date(2026, 11, 1), NYC)
    assert fire is not None and fire.utcoffset() == dt.timedelta(hours=-5)
    # sunrise+6h on 2026-11-01 (sunrise ~06:30 EST, already past the change): still -05:00
    fire, _ = fire_time_on(parse_time("sunrise+6h"), dt.date(2026, 11, 1), NYC)
    assert fire is not None and fire.utcoffset() == dt.timedelta(hours=-5)
    # sunset the day before is EDT.
    fire, _ = fire_time_on(parse_time("sunset"), dt.date(2026, 10, 31), NYC)
    assert fire is not None and fire.utcoffset() == dt.timedelta(hours=-4)


def test_sun_offset_can_cross_midnight() -> None:
    day = dt.date(2026, 6, 22)  # Monday; Oslo sunset ~22:xx
    late, _ = fire_time_on(parse_time("sunset+3h"), day, OSLO)
    assert late is not None and late.date() == dt.date(2026, 6, 23)  # lands on Tuesday
    early, _ = fire_time_on(parse_time("sunrise-6h"), day, OSLO)
    assert early is not None and early.date() == dt.date(2026, 6, 21)  # lands on Sunday
