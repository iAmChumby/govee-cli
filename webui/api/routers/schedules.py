"""Schedule CRUD over the library's schedule store, plus the external truth panel.

Rules live in the same ``schedule.json`` the CLI daemon reads, so a rule created
here fires for a CLI-run daemon too (run one scheduler, not both).

Every datetime on the wire is ISO-8601 carrying the schedule zone's offset,
floored to the minute. Instants stored in the state and owner files are UTC and
are converted here, never in the UI.

The ``/schedules/external`` routes below are a different thing entirely: they
read automation this store has never heard of — a plain crontab line, per
WEBUI_V3_SPEC.md §6. See ``external_schedule.py`` for the discovery pipeline.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Request

from govee_cli import room_scenes
from govee_cli.commands.schedule import stamp_baseline, starts_new_baseline
from govee_cli.config import load_config, resolve_device_ref
from govee_cli.schedule import engine, owner, scheduler, timespec
from govee_cli.schedule.scheduler import RuleState, ScheduleRule

from .. import external_schedule
from ..deps import TTLCache, get_config, run_blocking
from ..errors import ApiError, not_found
from ..schemas import (
    ScheduleLastFireOut,
    ScheduleListOut,
    ScheduleLocationOut,
    SchedulePatchRequest,
    SchedulePreviewOut,
    SchedulePreviewRequest,
    SchedulerOwnerOut,
    ScheduleRuleOut,
    ScheduleWriteRequest,
)

router = APIRouter()

# A separate cache instance from the device-state one (that TTL is 2.5s,
# tuned for 10s UI polling; this endpoint shells out up to twice per call and
# the spec asks for a coarser 30-60s window — §6.2). Module-level and shared
# across requests within one worker process, matching how ``app.state``
# caches are used elsewhere, without needing a slot on ``app.state`` itself.
_EXTERNAL_CACHE_TTL = 30.0
_EXTERNAL_CACHE_KEY = "external_schedule"
_external_cache = TTLCache(ttl=_EXTERNAL_CACHE_TTL)

# Results that prove the scheduler actually acted ("last fire").
_FIRED_RESULTS = ("ok", "error", "would_fire")
_WIRE_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


# ------------------------------------------------------------- wire helpers


@dataclass(frozen=True)
class _Clock:
    """The schedule zone, resolved once per request."""

    loc: timespec.Location
    zone: ZoneInfo
    now: dt.datetime  # aware, in ``zone``, floored to the minute


def _floor(value: dt.datetime) -> dt.datetime:
    return value.replace(second=0, microsecond=0)


def _clock() -> _Clock:
    loc = timespec.resolve_location(load_config())
    zone = ZoneInfo(loc.timezone)
    return _Clock(loc=loc, zone=zone, now=_floor(dt.datetime.now(zone)))


def _aware(value: dt.datetime) -> dt.datetime:
    """Naive datetimes from the owner/state layers are UTC by contract."""
    if value.tzinfo is None:
        return value.replace(tzinfo=dt.timezone.utc)
    return value


def _wire(value: dt.datetime | None, zone: ZoneInfo) -> str | None:
    if value is None:
        return None
    return _floor(_aware(value).astimezone(zone)).isoformat()


def _wire_instant(text: str | None, zone: ZoneInfo) -> str | None:
    """A UTC ISO instant from the state or owner file, rendered in the schedule zone."""
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return _wire(parsed, zone)


def _location_out(loc: timespec.Location) -> ScheduleLocationOut:
    return ScheduleLocationOut(
        latitude=loc.latitude,
        longitude=loc.longitude,
        timezone=loc.timezone,
        timezone_source=loc.timezone_source,
    )


def _wire_days(rule: ScheduleRule) -> list[str]:
    """Days as ``Mon``..``Sun`` in week order, whatever case the file stored."""
    normalised = engine.rule_days(rule)
    return [day for day in _WIRE_DAYS if day.lower() in normalised]


def _read_state_safely() -> tuple[dict[str, RuleState], bool]:
    """``(state, readable)``. An unreadable file is reported, never read as "nothing happened"."""
    try:
        return scheduler.read_state(), True
    except Exception:
        return {}, False


def _rule_out(
    rule: ScheduleRule,
    clock: _Clock,
    status: engine.RuleStatus,
    state: dict[str, RuleState],
) -> ScheduleRuleOut:
    last = state.get(rule.id)
    zone = clock.zone
    return ScheduleRuleOut(
        id=rule.id,
        name=rule.name,
        time=status.canonical_time or rule.time,
        days=_wire_days(rule),
        command=rule.command,
        enabled=rule.enabled,
        device=rule.device,
        room_scene=rule.room_scene,
        next_run=_wire(status.next_run, zone),
        next_run_reason=status.next_run_reason,
        today_fire=_wire(status.today_fire, zone),
        today_reason=status.today_reason,
        target_problem=status.target_problem,
        last_result=last.last_result if last else None,
        last_detail=last.last_detail if last else None,
        last_at=_wire_instant(last.last_at, zone) if last else None,
        missed_minute=_wire_instant(last.missed_minute, zone) if last else None,
    )


def _single_out(rule: ScheduleRule) -> ScheduleRuleOut:
    """One rule as the API returns it after a write."""
    clock = _clock()
    scene_names = set(room_scenes.list_scenes())
    status = engine.rule_status(rule, clock.now, clock.loc, scene_names)
    state, readable = _read_state_safely()
    return _rule_out(rule, clock, status, state if readable else {})


def _last_fire(
    rules: dict[str, ScheduleRule], state: dict[str, RuleState], zone: ZoneInfo
) -> ScheduleLastFireOut | None:
    """The newest state entry that records a real attempt to fire."""
    newest: tuple[dt.datetime, str, RuleState] | None = None
    for rule_id, entry in state.items():
        if entry.last_result not in _FIRED_RESULTS or not entry.last_at:
            continue
        try:
            at = _aware(dt.datetime.fromisoformat(entry.last_at))
        except ValueError:
            continue
        if newest is None or at > newest[0]:
            newest = (at, rule_id, entry)
    if newest is None:
        return None
    at, rule_id, entry = newest
    rule = rules.get(rule_id)
    # A rule deleted since it fired keeps its history under the name it had
    # when it fired; only a fire recorded before names were kept falls back to the id.
    name = rule.name if rule else (
        f"{entry.rule_name} (rule deleted)" if entry.rule_name else f"deleted rule {rule_id}"
    )
    return ScheduleLastFireOut(
        rule_id=rule_id,
        rule_name=name,
        at=_floor(at.astimezone(zone)).isoformat(),
        result=entry.last_result or "",
    )


def _owner_out(view: owner.OwnerView, zone: ZoneInfo, this_process: str) -> SchedulerOwnerOut:
    rec = view.record
    return SchedulerOwnerOut(
        state=view.state,
        kind=rec.kind if rec else None,
        dry_run=rec.dry_run if rec else False,
        pid=rec.pid if rec else None,
        host=rec.host if rec else None,
        started_at=_wire_instant(rec.started_at, zone) if rec else None,
        last_cycle_at=_wire_instant(rec.last_cycle_at, zone) if rec else None,
        poll_seconds=rec.poll_seconds if rec else None,
        stale_since=_wire(view.stale_since, zone),
        detail=view.detail,
        last_cycle_age_seconds=_age_seconds(rec.last_cycle_at or rec.started_at) if rec else None,
        this_process=cast(Any, this_process),
    )


def _age_seconds(iso: str | None) -> int | None:
    """Whole seconds since ``iso`` (a UTC instant from the owner record), unfloored."""
    if not iso:
        return None
    try:
        then = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if then.tzinfo is None:
        then = then.replace(tzinfo=dt.timezone.utc)
    return max(0, int((dt.datetime.now(dt.timezone.utc) - then).total_seconds()))


def _build_list(lock_status: Any) -> ScheduleListOut:
    """Blocking: everything ``GET /schedules`` reports, from one clock reading."""
    clock = _clock()
    rules = scheduler.list_rules()
    rules_by_id = {r.id: r for r in rules}
    scene_names = set(room_scenes.list_scenes())
    state, readable = _read_state_safely()
    visible_state = state if readable else {}

    schedules = [
        _rule_out(
            rule,
            clock,
            engine.rule_status(rule, clock.now, clock.loc, scene_names),
            visible_state,
        )
        for rule in rules
    ]
    view = owner.read_owner(clock.now)
    this_process = "disabled" if lock_status is None else lock_status()

    return ScheduleListOut(
        schedules=schedules,
        owner=_owner_out(view, clock.zone, this_process),
        location=_location_out(clock.loc),
        now=clock.now.isoformat(),
        last_fire=_last_fire(rules_by_id, visible_state, clock.zone) if readable else None,
        state_readable=readable,
    )


# ------------------------------------------------------------- write helpers


def _check_targets(body: ScheduleWriteRequest) -> None:
    """A device or room scene must exist when the rule is saved, not at 07:00 on a Tuesday."""
    if body.device:
        try:
            resolve_device_ref(get_config(), body.device)
        except Exception as e:
            raise not_found(
                f"Device '{body.device}' not found: {e}. Run `govee-cli scan-http`."
            ) from e
    if body.room_scene is not None and body.room_scene.strip():
        if body.room_scene not in room_scenes.list_scenes():
            raise not_found(f"Room scene '{body.room_scene}' not found.")


def _rule_from_body(rule_id: str, body: ScheduleWriteRequest) -> ScheduleRule:
    """Build the stored rule. The schema has already enforced exactly one target."""
    has_scene = bool(body.room_scene and body.room_scene.strip())
    return ScheduleRule(
        id=rule_id,
        name=body.name,
        time=body.time,  # canonical: the schema normalised it
        days=list(body.days),
        command="" if has_scene else body.command,
        enabled=body.enabled,
        device=None if has_scene else body.device,
        room_scene=body.room_scene if has_scene else None,
    )


# ------------------------------------------------------------------- routes


@router.get("/schedules", response_model=ScheduleListOut)
async def list_schedules(request: Request) -> ScheduleListOut:
    runner = request.app.state.scheduler_runner
    lock_status = runner.lock_status if runner is not None else None
    return cast(ScheduleListOut, await run_blocking(_build_list, lock_status))


@router.post("/schedules/preview", response_model=SchedulePreviewOut)
async def preview_schedule(body: SchedulePreviewRequest) -> SchedulePreviewOut:
    """Resolve a time and days for the rule dialog. A grammar error is a 200 with ``error`` set."""

    def compute() -> SchedulePreviewOut:
        clock = _clock()
        days = [d.strip().title()[:3] for d in body.days]
        result = engine.preview(body.time, days, clock.now, clock.loc)
        return SchedulePreviewOut(
            canonical_time=result.canonical_time,
            error=result.error,
            event_time=_wire(result.event_time, clock.zone),
            today_fire=_wire(result.today_fire, clock.zone),
            next_run=_wire(result.next_run, clock.zone),
            reason=result.reason,
            location=_location_out(clock.loc),
        )

    return cast(SchedulePreviewOut, await run_blocking(compute))


@router.post("/schedules", response_model=ScheduleRuleOut)
async def create_schedule(body: ScheduleWriteRequest) -> ScheduleRuleOut:
    """Create a rule with a fresh id, validated exactly as the CLI validates it."""
    await run_blocking(_check_targets, body)
    rule = _rule_from_body(str(uuid.uuid4())[:8], body)
    await run_blocking(scheduler.add_rule, rule)
    await run_blocking(stamp_baseline, rule.id)
    return cast(ScheduleRuleOut, await run_blocking(_single_out, rule))


@router.put("/schedules/{rule_id}", response_model=ScheduleRuleOut)
async def update_schedule(rule_id: str, body: ScheduleWriteRequest) -> ScheduleRuleOut:
    """Replace a rule's name, time, days, target and enabled flag under POST's validation."""

    def apply() -> ScheduleRule:
        before = scheduler.get_rule(rule_id)
        if before is None:
            raise not_found(f"No schedule rule with id '{rule_id}'.")
        _check_targets(body)
        rule = _rule_from_body(rule_id, body)
        if not scheduler.update_rule(rule):
            raise not_found(f"No schedule rule with id '{rule_id}'.")
        if starts_new_baseline(before, rule):
            stamp_baseline(rule_id)
        return rule

    rule = await run_blocking(apply)
    return cast(ScheduleRuleOut, await run_blocking(_single_out, rule))


@router.patch("/schedules/{rule_id}", response_model=ScheduleRuleOut)
async def patch_schedule(rule_id: str, body: SchedulePatchRequest) -> ScheduleRuleOut:
    before = await run_blocking(scheduler.get_rule, rule_id)
    updated = await run_blocking(scheduler.set_rule_enabled, rule_id, body.enabled)
    if not updated:
        raise not_found(f"No schedule rule with id '{rule_id}'.")
    if body.enabled and before is not None and not before.enabled:
        await run_blocking(stamp_baseline, rule_id)
    rule = await run_blocking(scheduler.get_rule, rule_id)
    if rule is None:
        raise ApiError(404, "not_found", f"No schedule rule with id '{rule_id}'.")
    return cast(ScheduleRuleOut, await run_blocking(_single_out, rule))


@router.delete("/schedules/{rule_id}")
async def delete_schedule(rule_id: str) -> dict[str, Any]:
    removed = await run_blocking(scheduler.remove_rule, rule_id)
    if not removed:
        raise not_found(f"No schedule rule with id '{rule_id}'.")
    return {"deleted": rule_id}


# ------------------------------------------------------------- external truth


@router.get("/schedules/external")
async def get_external_schedules() -> dict[str, Any]:
    """Crontab-discovered automation the native rule store can't see (§6.2)."""
    cached = _external_cache.get(_EXTERNAL_CACHE_KEY)
    if cached is not None:
        return cast(dict[str, Any], cached)
    result = await run_blocking(external_schedule.build_external_schedule)
    _external_cache.set(_EXTERNAL_CACHE_KEY, result)
    return cast(dict[str, Any], result)


@router.post("/schedules/external/wake-ramp/arm")
async def arm_wake_ramp_route() -> dict[str, Any]:
    """Shell out to ``wake-ramp arm`` and return the freshly re-read entry.

    Scoped to this one script by exact path — there is no generic "arm any
    cron line" affordance, since the sidecar has no writable relationship to
    a crontab entry it doesn't own.
    """
    entry = await run_blocking(external_schedule.arm_wake_ramp)
    _external_cache.invalidate(_EXTERNAL_CACHE_KEY)
    return cast(dict[str, Any], entry)


@router.post("/schedules/external/wake-ramp/disarm")
async def disarm_wake_ramp_route() -> dict[str, Any]:
    entry = await run_blocking(external_schedule.disarm_wake_ramp)
    _external_cache.invalidate(_EXTERNAL_CACHE_KEY)
    return cast(dict[str, Any], entry)
