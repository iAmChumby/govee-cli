"""The one place that decides when schedule rules fire (issue #2).

SPINE — signatures and shapes fixed by the main agent; bodies built by the core
area. Both ``govee-cli daemon`` and the sidecar's ``SchedulerRunner`` call
``due_rules``; nothing else in the codebase compares a rule's time to a clock.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from govee_cli.schedule.scheduler import RuleState, ScheduleRule
from govee_cli.schedule.timespec import (
    Location,
    TimeSpec,
    TimeSpecError,
    _zone,
    canonical,
    event_time_on,
    fire_time_on,
    parse_time,
)

DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

NO_LOCATION_NEXT = "no location: no next run"
NOT_TODAY = "not scheduled today"
_SCAN_DAYS = 8


@dataclass(frozen=True)
class RuleStatus:
    """Everything the CLI and console show about one rule, computed server-side.

    All datetimes are aware, in the Location's zone, floored to the minute.
    """

    rule_id: str
    canonical_time: str | None  # None when the stored time no longer parses
    next_run: dt.datetime | None
    next_run_reason: str | None  # set iff next_run is None ("paused", "no location", ...)
    today_fire: dt.datetime | None  # today's computed minute, past or future (G3)
    today_reason: str | None  # set iff today_fire is None ("not scheduled today", ...)
    target_problem: str | None  # "room scene 'X' missing: rule will not fire"


def minute_key(when: dt.datetime) -> str:
    """The UTC ISO spelling used for ``RuleState.last_fired_minute``/``missed_minute``.

    UTC, not wall clock, so the repeated hour of a DST fall-back is two different
    keys and a rule cannot double-fire (or be suppressed) across it.
    """
    return when.astimezone(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()


def rule_days(rule: ScheduleRule) -> set[str]:
    """``rule.days`` normalised to DAY_KEYS (stored files mix ``Mon`` and ``mon``)."""
    out: set[str] = set()
    for day in rule.days:
        key = str(day).strip().lower()[:3]
        if key in DAY_KEYS:
            out.add(key)
    return out


def _local(now: dt.datetime, loc: Location) -> dt.datetime:
    tz = _zone(loc)
    if tz is None:
        return now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    if now.tzinfo is None:
        return now.replace(tzinfo=tz)
    return now.astimezone(tz)


def _floor(value: dt.datetime) -> dt.datetime:
    return value.replace(second=0, microsecond=0)


def _fires(spec: TimeSpec, days: set[str], loc: Location, first: dt.date,
           last: dt.date) -> list[dt.datetime]:
    """Every fire whose OWN local date is in [first, last] and whose weekday is
    in ``days``, ascending. Candidates are generated from ``first-1 .. last+1``
    because a sun offset can carry a fire across midnight in either direction."""
    found: dict[dt.datetime, dt.datetime] = {}
    day = first - dt.timedelta(days=1)
    while day <= last + dt.timedelta(days=1):
        fire, _ = fire_time_on(spec, day, loc)
        if fire is not None and first <= fire.date() <= last:
            if DAY_KEYS[fire.weekday()] in days:
                found[fire.astimezone(dt.timezone.utc)] = fire
        day += dt.timedelta(days=1)
    return [found[k] for k in sorted(found)]


def _day_fire(spec: TimeSpec, days: set[str], loc: Location,
              day: dt.date) -> tuple[dt.datetime | None, str | None]:
    """The fire that lands on local ``day``, or ``(None, why)``."""
    if spec.kind != "clock" and not loc.has_coordinates:
        return None, "no location"
    fires = _fires(spec, days, loc, day, day)
    if fires:
        return fires[0], None
    if DAY_KEYS[day.weekday()] not in days:
        return None, NOT_TODAY
    _, reason = fire_time_on(spec, day, loc)
    return None, reason or NOT_TODAY


def rule_status(rule: ScheduleRule, now: dt.datetime, loc: Location,
                scene_names: set[str]) -> RuleStatus:
    """Next run (scanning today..today+8), today's fire, and any target problem."""
    target_problem = None
    if rule.room_scene is not None and rule.room_scene not in scene_names:
        target_problem = f"room scene '{rule.room_scene}' missing: rule will not fire"

    try:
        spec = parse_time(rule.time)
    except TimeSpecError as exc:
        reason = f"invalid time: {exc}"
        return RuleStatus(rule.id, None, None, reason, None, reason, target_problem)

    canon = canonical(spec)
    days = rule_days(rule)
    local_now = _local(now, loc)
    today = local_now.date()

    today_fire, today_reason = _day_fire(spec, days, loc, today)

    next_run: dt.datetime | None = None
    next_reason: str | None = None
    if not rule.enabled:
        next_reason = "paused"
    elif spec.kind != "clock" and not loc.has_coordinates:
        next_reason = NO_LOCATION_NEXT
    elif target_problem is not None:
        next_reason = target_problem
    elif not days:
        next_reason = "no days selected"
    else:
        for fire in _fires(spec, days, loc, today, today + dt.timedelta(days=_SCAN_DAYS)):
            # UTC instants: two datetimes sharing one tzinfo compare by wall
            # clock and would ignore the fold inside a DST overlap.
            if fire.astimezone(dt.timezone.utc) > local_now.astimezone(dt.timezone.utc):
                next_run = fire
                break
        if next_run is None:
            next_reason = f"no run in the next {_SCAN_DAYS} days"
    return RuleStatus(rule.id, canon, next_run, next_reason, today_fire,
                      today_reason, target_problem)


def _parse_instant(text: str | None) -> dt.datetime | None:
    if not text:
        return None
    try:
        value = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value


def due_rules(rules: list[ScheduleRule], now: dt.datetime, loc: Location,
              state: dict[str, RuleState]) -> list[tuple[ScheduleRule, dt.datetime]]:
    """Enabled rules whose fire minute equals ``now``'s minute and that have not
    already fired for that minute (``state[id].last_fired_minute``, a UTC ISO
    instant, so a DST-repeated hour cannot double-fire). Returns (rule, fire_minute)."""
    local_now = _local(now, loc)
    now_minute = _floor(local_now.astimezone(dt.timezone.utc))
    today = local_now.date()
    due: list[tuple[ScheduleRule, dt.datetime]] = []
    for rule in rules:
        if not rule.enabled:
            continue
        try:
            spec = parse_time(rule.time)
        except TimeSpecError:
            continue
        days = rule_days(rule)
        if not days:
            continue
        for fire in _fires(spec, days, loc, today - dt.timedelta(days=1),
                           today + dt.timedelta(days=1)):
            if fire.astimezone(dt.timezone.utc) != now_minute:
                continue
            fired = _parse_instant(state[rule.id].last_fired_minute) if rule.id in state else None
            if fired is not None and fired.astimezone(dt.timezone.utc) == (
                fire.astimezone(dt.timezone.utc)
            ):
                break
            due.append((rule, fire))
            break
    return due


def detect_missed(rules: list[ScheduleRule], now: dt.datetime, loc: Location,
                  state: dict[str, RuleState],
                  previous_last_cycle: dt.datetime | None) -> dict[str, dt.datetime]:
    """Run once when a scheduler takes ownership.

    For each enabled rule, its most recent scheduled minute before ``now``
    counts as missed iff it is after the rule's ``last_fired_minute`` (or, when
    the rule never fired, after ``previous_last_cycle``). A rule never fired
    with no previous owner record is never reported missed. Returns
    ``{rule_id: missed_minute}``.
    """
    local_now = _local(now, loc)
    now_minute = _floor(local_now.astimezone(dt.timezone.utc))
    today = local_now.date()
    missed: dict[str, dt.datetime] = {}
    for rule in rules:
        if not rule.enabled:
            continue
        try:
            spec = parse_time(rule.time)
        except TimeSpecError:
            continue
        days = rule_days(rule)
        if not days:
            continue
        past = [
            f for f in _fires(spec, days, loc, today - dt.timedelta(days=_SCAN_DAYS),
                              today + dt.timedelta(days=1))
            if f.astimezone(dt.timezone.utc) < now_minute
        ]
        if not past:
            continue
        latest = past[-1]
        fired = _parse_instant(state[rule.id].last_fired_minute) if rule.id in state else None
        if fired is not None:
            baseline = fired
        elif previous_last_cycle is not None:
            baseline = previous_last_cycle
        else:
            continue
        if latest.astimezone(dt.timezone.utc) > baseline.astimezone(dt.timezone.utc):
            missed[rule.id] = latest
    return missed


@dataclass(frozen=True)
class Preview:
    """``POST /schedules/preview`` result for the rule dialog's resolved line."""

    canonical_time: str | None
    error: str | None  # grammar error message
    event_time: dt.datetime | None  # today's raw sunrise/sunset, sun rules only
    today_fire: dt.datetime | None
    next_run: dt.datetime | None
    reason: str | None


def preview(time_text: str, days: list[str], now: dt.datetime, loc: Location) -> Preview:
    """Resolve ``time_text`` for the dialog. ``reason`` explains whatever is
    missing: the next-run reason when there is no next run, otherwise today's
    reason when today has no fire (e.g. "not scheduled today")."""
    try:
        spec = parse_time(time_text)
    except TimeSpecError as exc:
        return Preview(None, str(exc), None, None, None, None)

    canon = canonical(spec)
    rule = ScheduleRule(id="preview", name="", time=canon, days=days, command="")
    status = rule_status(rule, now, loc, set())

    event_time = None
    if spec.kind != "clock":
        today = _local(now, loc).date()
        event_time, _ = event_time_on(spec.kind, today, loc)  # type: ignore[arg-type]

    reason = status.next_run_reason if status.next_run is None else status.today_reason
    return Preview(canon, None, event_time, status.today_fire, status.next_run, reason)
