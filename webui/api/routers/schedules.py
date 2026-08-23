"""Schedule CRUD over the library's schedule store.

Rules live in the same ``schedule.json`` the CLI daemon reads, so a rule created
here fires for a CLI-run daemon too (run one scheduler, not both).
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Request

from govee_cli.config import resolve_device_ref
from govee_cli.schedule.scheduler import (
    ScheduleRule,
    add_rule,
    list_rules,
    remove_rule,
    set_rule_enabled,
)

from ..deps import get_config, run_blocking
from ..errors import not_found
from ..schemas import ScheduleCreateRequest, SchedulePatchRequest

router = APIRouter()


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
