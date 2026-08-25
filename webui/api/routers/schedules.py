"""Schedule CRUD over the library's schedule store, plus the external truth panel.

Rules live in the same ``schedule.json`` the CLI daemon reads, so a rule created
here fires for a CLI-run daemon too (run one scheduler, not both).

The ``/schedules/external`` routes below are a different thing entirely: they
read automation this store has never heard of — a plain crontab line, per
WEBUI_V3_SPEC.md §6. See ``external_schedule.py`` for the discovery pipeline.
"""

from __future__ import annotations

import uuid
from typing import Any, cast

from fastapi import APIRouter, Request

from govee_cli.config import resolve_device_ref
from govee_cli.schedule.scheduler import (
    ScheduleRule,
    add_rule,
    list_rules,
    remove_rule,
    set_rule_enabled,
)

from .. import external_schedule
from ..deps import TTLCache, get_config, run_blocking
from ..errors import not_found
from ..schemas import ScheduleCreateRequest, SchedulePatchRequest

router = APIRouter()

# A separate cache instance from the device-state one (that TTL is 2.5s,
# tuned for 10s UI polling; this endpoint shells out up to twice per call and
# the spec asks for a coarser 30-60s window — §6.2). Module-level and shared
# across requests within one worker process, matching how ``app.state``
# caches are used elsewhere, without needing a slot on ``app.state`` itself.
_EXTERNAL_CACHE_TTL = 30.0
_EXTERNAL_CACHE_KEY = "external_schedule"
_external_cache = TTLCache(ttl=_EXTERNAL_CACHE_TTL)


def _rule_out(rule: ScheduleRule) -> dict[str, Any]:
    return {
        "id": rule.id,
        "name": rule.name,
        "time": rule.time,
        "days": rule.days,
        "command": rule.command,
        "enabled": rule.enabled,
        "device": rule.device,
    }


@router.get("/schedules")
async def list_schedules() -> dict[str, Any]:
    rules = await run_blocking(list_rules)
    return {"schedules": [_rule_out(r) for r in rules]}


@router.post("/schedules")
async def create_schedule(request: Request, body: ScheduleCreateRequest) -> dict[str, Any]:
    """Create a rule. A device ref is validated now — never fail at 07:00 on a Tuesday."""
    if body.device:
        cfg = await run_blocking(get_config)
        try:
            resolve_device_ref(cfg, body.device)
        except Exception as e:
            raise not_found(
                f"Device '{body.device}' not found: {e}. Run `govee-cli scan-http`."
            ) from e

    rule = ScheduleRule(
        id=str(uuid.uuid4())[:8],
        name=body.name,
        time=body.time,
        days=body.days,
        command=body.command,
        enabled=True,
        device=body.device,
    )
    await run_blocking(add_rule, rule)
    return _rule_out(rule)


@router.patch("/schedules/{rule_id}")
async def patch_schedule(rule_id: str, body: SchedulePatchRequest) -> dict[str, Any]:
    updated = await run_blocking(set_rule_enabled, rule_id, body.enabled)
    if not updated:
        raise not_found(f"No schedule rule with id '{rule_id}'.")
    rules = await run_blocking(list_rules)
    rule = next(r for r in rules if r.id == rule_id)
    return _rule_out(rule)


@router.delete("/schedules/{rule_id}")
async def delete_schedule(rule_id: str) -> dict[str, Any]:
    removed = await run_blocking(remove_rule, rule_id)
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
