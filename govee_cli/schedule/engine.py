"""The one place that decides when schedule rules fire (issue #2).

SPINE — signatures and shapes fixed by the main agent; bodies built by the core
area. Both ``govee-cli daemon`` and the sidecar's ``SchedulerRunner`` call
``due_rules``; nothing else in the codebase compares a rule's time to a clock.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from govee_cli.schedule.scheduler import RuleState, ScheduleRule
from govee_cli.schedule.timespec import Location

DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


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


def rule_days(rule: ScheduleRule) -> set[str]:
    """``rule.days`` normalised to DAY_KEYS (stored files mix ``Mon`` and ``mon``)."""
    raise NotImplementedError


def rule_status(rule: ScheduleRule, now: dt.datetime, loc: Location,
                scene_names: set[str]) -> RuleStatus:
    """Next run (scanning today..today+8), today's fire, and any target problem."""
    raise NotImplementedError


def due_rules(rules: list[ScheduleRule], now: dt.datetime, loc: Location,
              state: dict[str, RuleState]) -> list[tuple[ScheduleRule, dt.datetime]]:
    """Enabled rules whose fire minute equals ``now``'s minute and that have not
    already fired for that minute (``state[id].last_fired_minute``, a UTC ISO
    instant, so a DST-repeated hour cannot double-fire). Returns (rule, fire_minute)."""
    raise NotImplementedError


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
    raise NotImplementedError


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
    raise NotImplementedError
