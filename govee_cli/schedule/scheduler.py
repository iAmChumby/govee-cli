"""Local scheduling engine for Govee CLI.

Schedules are stored in ~/.config/govee-cli/schedule.json
No cloud dependency — all local using APScheduler.
"""

import json
import logging
import pathlib
from dataclasses import dataclass, field
from datetime import datetime, time

import structlog

logger = structlog.get_logger(__name__)

SCHEDULE_DIR = pathlib.Path.home() / ".config" / "govee-cli"
SCHEDULE_FILE = SCHEDULE_DIR / "schedule.json"


@dataclass
class ScheduleRule:
    """A single scheduled rule."""

    id: str
    name: str
    time: str  # HH:MM in 24h format
    days: list[str]  # Mon, Tue, Wed, Thu, Fri, Sat, Sun
    command: str  # e.g. "power on", "color FF5500"
    enabled: bool = True


def _load_rules() -> list[ScheduleRule]:
    """Load schedule rules from disk."""
    if not SCHEDULE_FILE.exists():
        return []

    with open(SCHEDULE_FILE) as f:
        raw = json.load(f)

    return [ScheduleRule(**r) for r in raw]


def _save_rules(rules: list[ScheduleRule]) -> None:
    """Save schedule rules to disk."""
    SCHEDULE_DIR.mkdir(parents=True, exist_ok=True)

    with open(SCHEDULE_FILE, "w") as f:
        json.dump([vars(r) for r in rules], f, indent=2)


def list_rules() -> list[ScheduleRule]:
    """Return all schedule rules."""
    return _load_rules()


def add_rule(rule: ScheduleRule) -> None:
    """Add a new schedule rule."""
    rules = _load_rules()
    rules.append(rule)
    _save_rules(rules)
    logger.info("rule_added", name=rule.name, time=rule.time, days=rule.days)


def remove_rule(rule_id: str) -> bool:
    """Remove a schedule rule by ID. Returns True if found and removed."""
    rules = _load_rules()
    before = len(rules)
    rules = [r for r in rules if r.id != rule_id]
    if len(rules) == before:
        return False
    _save_rules(rules)
    logger.info("rule_removed", id=rule_id)
    return True
