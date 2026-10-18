"""Local scheduling engine for Govee CLI.

Schedules are stored in ~/.config/govee-cli/schedule.json
No cloud dependency — all local using APScheduler.
"""

import json
import pathlib
from dataclasses import dataclass
from typing import Literal

import structlog

logger = structlog.get_logger(__name__)

SCHEDULE_DIR = pathlib.Path.home() / ".config" / "govee-cli"
SCHEDULE_FILE = SCHEDULE_DIR / "schedule.json"
# Per-rule firing state (issue #2). Written by whichever scheduler owns the lock.
# Module-level and read at call time so tests/conftest.py and mock.install() can
# repoint it, exactly like SCHEDULE_FILE.
SCHEDULE_STATE_PATH = SCHEDULE_DIR / "schedule-state.json"


@dataclass
class ScheduleRule:
    """A single scheduled rule."""

    id: str
    name: str
    # Canonical time string per govee_cli.schedule.timespec: "06:30",
    # "sunset", "sunset-1h15m". Old files hold plain HH:MM, which is canonical.
    time: str
    days: list[str]  # Mon, Tue, Wed, Thu, Fri, Sat, Sun
    command: str  # e.g. "power on", "color FF5500"
    enabled: bool = True
    # Device name or id this rule targets. None falls back to the configured
    # default_mac, which is how every rule behaved before this field existed.
    device: str | None = None
    # Name of a room scene in room-scenes.json. A rule has exactly one target:
    # (device? + command) XOR room_scene. When set, command is "".
    room_scene: str | None = None


RuleResult = Literal["ok", "error", "missed", "skipped", "would_fire"]


@dataclass
class RuleState:
    """What the owning scheduler last did with one rule (schedule-state.json)."""

    last_fired_minute: str | None = None  # UTC ISO instant of the minute last fired
    last_result: RuleResult | None = None
    last_detail: str | None = None
    last_at: str | None = None  # UTC ISO instant the result was recorded
    missed_minute: str | None = None  # UTC ISO instant; set when a fire was missed


def read_state() -> dict[str, RuleState]:
    """Load schedule-state.json. Missing file -> {}. Raises on an unreadable file
    so callers can report "unknown" rather than pretend nothing happened."""
    raise NotImplementedError


def write_state(state: dict[str, RuleState]) -> None:
    """Atomic write (tmp + os.replace, under a filelock); no fsync."""
    raise NotImplementedError


def get_rule(rule_id: str) -> ScheduleRule | None:
    raise NotImplementedError


def update_rule(rule: ScheduleRule) -> bool:
    """Replace the stored rule with the same id. Returns False if not found."""
    raise NotImplementedError


def _load_rules() -> list[ScheduleRule]:
    """Load schedule rules from disk."""
    if not SCHEDULE_FILE.exists():
        return []

    with open(SCHEDULE_FILE) as f:
        raw = json.load(f)

    # Ignore unknown keys so a schedule file written by a newer version does not
    # crash an older one, and so removed fields don't break loading.
    known = ScheduleRule.__dataclass_fields__.keys()
    return [ScheduleRule(**{k: v for k, v in r.items() if k in known}) for r in raw]


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


def set_rule_enabled(rule_id: str, enabled: bool) -> bool:
    """Enable or disable a schedule rule by ID. Returns True if found."""
    rules = _load_rules()
    for rule in rules:
        if rule.id == rule_id:
            rule.enabled = enabled
            _save_rules(rules)
            logger.info("rule_updated", id=rule_id, enabled=enabled)
            return True
    return False
