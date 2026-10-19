"""schedule command — manage local schedules (issue #2: sun times, room scenes, edit)."""

from __future__ import annotations

import dataclasses
import datetime as dt
import uuid
from zoneinfo import ZoneInfo

import click

from govee_cli import room_scenes
from govee_cli.config import load_config, resolve_device_ref
from govee_cli.schedule import engine, owner, scheduler, timespec
from govee_cli.schedule.scheduler import RuleState, ScheduleRule

_DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_TIME_HELP = (
    "HH:MM (24h), sunrise or sunset, optionally with an offset: "
    "sunset-1h15m, sunrise+30m"
)


@click.group()
def schedule() -> None:
    """Manage local schedules: clock or sunrise/sunset times, one device command or a room scene."""
    pass


# ------------------------------------------------------------------ list


@schedule.command("list")
def list_cmd() -> None:
    """List schedule rules with their next run, the owner, and the last result."""
    loc = timespec.resolve_location(load_config())
    zone = ZoneInfo(loc.timezone)
    now = dt.datetime.now(zone).replace(second=0, microsecond=0)

    view = owner.read_owner(now)
    click.echo(
        f"location: {_location_text(loc)} · timezone: {_zone_text(loc)} · "
        f"owner: {_owner_text(view, now, zone)}"
    )

    rules = scheduler.list_rules()
    if not rules:
        click.echo("No schedules defined. See 'govee-cli schedule add --help'")
        return

    scene_names = set(room_scenes.list_scenes())
    state, readable = _read_state()
    for rule in rules:
        click.echo(_rule_line(rule, now, loc, zone, scene_names, state, readable))


def _location_text(loc: timespec.Location) -> str:
    if loc.has_coordinates:
        assert loc.latitude is not None and loc.longitude is not None
        return f"{loc.latitude:.4f}, {loc.longitude:.4f}"
    return "not set"


def _zone_text(loc: timespec.Location) -> str:
    return f"host: {loc.timezone}" if loc.timezone_source == "host" else loc.timezone


def _owner_text(view: owner.OwnerView, now: dt.datetime, zone: ZoneInfo) -> str:
    rec = view.record
    if view.state == "running" and rec is not None:
        if rec.kind == "sidecar":
            detail = "running, dry run" if rec.dry_run else "running"
            cycle = _cycle_ago(rec.last_cycle_at, now)
            if cycle is not None:
                detail += f", last cycle {cycle}"
            return f"web console sidecar ({detail})"
        return f"govee-cli daemon pid {rec.pid} (running)"
    if view.state == "stale":
        since = _hm(view.stale_since, zone) if view.stale_since is not None else "unknown"
        return f"nobody (stale since {since})"
    if view.state == "nobody":
        return "nobody"
    return f"unknown ({view.detail})" if view.detail else "unknown"


def _cycle_ago(last_cycle_at: str | None, now: dt.datetime) -> str | None:
    if not last_cycle_at:
        return None
    try:
        parsed = _parse_instant(last_cycle_at)
    except ValueError:
        return None
    seconds = max(0, int((now - parsed).total_seconds()))
    if seconds < 60:
        return f"{seconds}s ago"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m ago"
    return f"{minutes // 60}h {minutes % 60}m ago"


def _rule_line(
    rule: ScheduleRule,
    now: dt.datetime,
    loc: timespec.Location,
    zone: ZoneInfo,
    scene_names: set[str],
    state: dict[str, RuleState],
    readable: bool,
) -> str:
    status = engine.rule_status(rule, now, loc, scene_names)
    mark = "✓" if rule.enabled else "✗"
    normalised = engine.rule_days(rule)
    days = ",".join(day for day in _DAY_NAMES if day.lower() in normalised)
    if status.next_run is not None:
        next_text = f"next: {_run_text(status.next_run, zone)}"
    else:
        next_text = f"next: {status.next_run_reason or 'unknown'}"

    parts = [
        f"[{mark}] {rule.id}  {status.canonical_time or rule.time}  {days}  "
        f"→ {_target_text(rule)}",
        next_text,
    ]
    if not readable:
        parts.append("last: unknown")
    else:
        entry = state.get(rule.id)
        if entry is not None:
            if entry.missed_minute:
                parts.append(f"missed {_hm_text(entry.missed_minute, zone)}")
            if entry.last_result:
                last = f"last: {entry.last_result}"
                if entry.last_result == "error" and entry.last_detail:
                    last += f" {entry.last_detail}"
                parts.append(last)
    if status.target_problem:
        parts.append(f"problem: {status.target_problem}")
    return "  ".join(parts)


def _run_text(run_at: dt.datetime, zone: ZoneInfo) -> str:
    local = run_at.astimezone(zone)
    return f"{local:%a} {local.day} {local:%b} {local:%H:%M}"


def _target_text(rule: ScheduleRule) -> str:
    if rule.room_scene:
        return f"room scene '{rule.room_scene}'"
    return f"{rule.device or '(default device)'}: {rule.command}"


def _read_state() -> tuple[dict[str, RuleState], bool]:
    """``(state, readable)``. An unreadable file shows "unknown", never "nothing happened"."""
    try:
        return scheduler.read_state(), True
    except Exception:
        return {}, False


def _parse_instant(text: str) -> dt.datetime:
    """A stored UTC ISO instant as an aware datetime (naive text is UTC by contract)."""
    parsed = dt.datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed


def _hm(value: dt.datetime, zone: ZoneInfo) -> str:
    aware = value if value.tzinfo is not None else value.replace(tzinfo=dt.timezone.utc)
    return aware.astimezone(zone).strftime("%H:%M")


def _hm_text(text: str, zone: ZoneInfo) -> str:
    try:
        return _hm(_parse_instant(text), zone)
    except ValueError:
        return "unknown"


# ------------------------------------------------------------ add / edit


@schedule.command("add")
@click.option("--name", required=True, help="Schedule name")
@click.option("--time", "time_str", required=True, help=_TIME_HELP)
@click.option("--days", required=True, help="Days (comma-separated: Mon,Wed,Fri)")
@click.option("--command", "command", default=None,
              help="Command to run (e.g. 'power on'); give this or --room-scene")
@click.option("--device", help="Device name or ID (default: the configured default device)")
@click.option("--room-scene", "room_scene", default=None,
              help="Replay this room scene instead of a single command")
def add_cmd(
    name: str,
    time_str: str,
    days: str,
    command: str | None,
    device: str | None,
    room_scene: str | None,
) -> None:
    """Add a schedule rule.

    A rule has exactly one target: --command (with an optional --device, which
    otherwise falls back to the configured default) or --room-scene.
    """
    canonical = _canonical_time(time_str)
    day_list = _parse_days(days)
    scene = (room_scene or "").strip() or None
    command_text = (command or "").strip()
    _check_target(command_text, device, scene)
    if scene is not None:
        _check_room_scene(scene)
    else:
        _check_device(device)

    rule = ScheduleRule(
        id=str(uuid.uuid4())[:8],
        name=name,
        time=canonical,
        days=day_list,
        command="" if scene else command_text,
        enabled=True,
        device=None if scene else device,
        room_scene=scene,
    )
    scheduler.add_rule(rule)
    stamp_baseline(rule.id)
    click.echo(
        f"Added schedule {rule.id}: {name} at {canonical} on {_days_text(day_list)} "
        f"→ {_target_text(rule)}"
    )


@schedule.command("edit")
@click.argument("rule_id")
@click.option("--name", default=None, help="New name")
@click.option("--time", "time_str", default=None, help=_TIME_HELP)
@click.option("--days", default=None, help="New days (comma-separated: Mon,Wed,Fri)")
@click.option("--command", default=None,
              help="New command. On a room-scene rule this switches it to a command.")
@click.option("--device", default=None,
              help="New device name or ID. An empty string means the default device.")
@click.option("--room-scene", "room_scene", default=None,
              help="Switch the rule to replay this room scene")
@click.option("--enable/--disable", "enabled", default=None, help="Turn the rule on or off")
def edit_cmd(
    rule_id: str,
    name: str | None,
    time_str: str | None,
    days: str | None,
    command: str | None,
    device: str | None,
    room_scene: str | None,
    enabled: bool | None,
) -> None:
    """Change fields of an existing rule. Only the options you pass change."""
    changes = (name, time_str, days, command, device, room_scene, enabled)
    if all(value is None for value in changes):
        raise click.ClickException(
            "Nothing to change. Pass --name, --time, --days, --command, --device, "
            "--room-scene or --enable/--disable."
        )
    rule = scheduler.get_rule(rule_id)
    if rule is None:
        raise click.ClickException(f"Schedule {rule_id} not found")

    updated = dataclasses.replace(rule)
    if name is not None:
        if not name.strip():
            raise click.ClickException("The name cannot be empty.")
        updated.name = name
    if time_str is not None:
        updated.time = _canonical_time(time_str)
    if days is not None:
        updated.days = _parse_days(days)
    if enabled is not None:
        updated.enabled = enabled
    _retarget(updated, command, device, room_scene)
    _check_target(updated.command, updated.device, updated.room_scene)
    if updated.room_scene is not None:
        _check_room_scene(updated.room_scene)
    else:
        _check_device(updated.device)

    if not scheduler.update_rule(updated):
        raise click.ClickException(f"Schedule {rule_id} not found")
    if starts_new_baseline(rule, updated):
        stamp_baseline(rule_id)
    click.echo(
        f"Updated schedule {rule_id}: {updated.name} at {updated.time} on "
        f"{_days_text(updated.days)} → {_target_text(updated)}"
    )


def _retarget(
    rule: ScheduleRule,
    command: str | None,
    device: str | None,
    room_scene: str | None,
) -> None:
    """Apply --command/--device/--room-scene. Switching target clears the other one."""
    if room_scene is not None:
        if command is not None or device is not None:
            raise click.ClickException(
                "--room-scene cannot be combined with --command or --device: "
                "a rule has one target."
            )
        rule.room_scene = room_scene.strip() or None
        rule.command = ""
        rule.device = None
        return
    if command is None and device is None:
        return
    if rule.room_scene:
        if command is None:
            raise click.ClickException(
                f"Rule {rule.id} replays room scene '{rule.room_scene}'. Pass --command to "
                f"switch it to a device command, or --room-scene to pick another scene."
            )
        rule.room_scene = None
    if command is not None:
        rule.command = command.strip()
    if device is not None:
        rule.device = device.strip() or None


# ----------------------------------------------------------- enable/disable


@schedule.command("enable")
@click.argument("rule_id")
def enable_cmd(rule_id: str) -> None:
    """Turn a schedule rule on."""
    _set_enabled(rule_id, True)


@schedule.command("disable")
@click.argument("rule_id")
def disable_cmd(rule_id: str) -> None:
    """Turn a schedule rule off (it keeps its place and fires again when enabled)."""
    _set_enabled(rule_id, False)


def _set_enabled(rule_id: str, enabled: bool) -> None:
    before = scheduler.get_rule(rule_id)
    if not scheduler.set_rule_enabled(rule_id, enabled):
        raise click.ClickException(f"Schedule {rule_id} not found")
    if enabled and before is not None and not before.enabled:
        stamp_baseline(rule_id)
    click.echo(f"{'Enabled' if enabled else 'Disabled'} schedule {rule_id}")


def starts_new_baseline(before: ScheduleRule, after: ScheduleRule) -> bool:
    """True when a save starts a new schedule baseline: enabled, time, or days changed."""
    return (
        (after.enabled and not before.enabled)
        or before.time != after.time
        or _day_set(before.days) != _day_set(after.days)
    )


def _day_set(days: list[str]) -> set[str]:
    return {d.strip().title()[:3] for d in days}


# ------------------------------------------------------------------ remove


@schedule.command("remove")
@click.argument("rule_id")
def remove_cmd(rule_id: str) -> None:
    """Remove a schedule rule by ID."""
    if scheduler.remove_rule(rule_id):
        click.echo(f"Removed schedule {rule_id}")
    else:
        click.echo(f"Schedule {rule_id} not found")


# ----------------------------------------------------------------- helpers


def _canonical_time(text: str) -> str:
    try:
        return timespec.normalise_time(text)
    except timespec.TimeSpecError as e:
        raise click.ClickException(str(e)) from e


def _parse_days(text: str) -> list[str]:
    chosen: set[str] = set()
    for raw in text.split(","):
        if not raw.strip():
            continue
        day = raw.strip().title()[:3]
        if day not in _DAY_NAMES:
            raise click.ClickException(
                f"Invalid day '{raw.strip()}'. Expected any of Mon Tue Wed Thu Fri Sat Sun."
            )
        chosen.add(day)
    if not chosen:
        raise click.ClickException("Give at least one day, e.g. --days Mon,Wed,Fri.")
    return [day for day in _DAY_NAMES if day in chosen]


def _days_text(days: list[str]) -> str:
    return ",".join(day for day in _DAY_NAMES if day in days)


def _check_target(command: str, device: str | None, room_scene: str | None) -> None:
    """A rule has exactly one target: a command (optionally on a device) or a room scene."""
    has_command = bool(command.strip())
    has_scene = bool(room_scene and room_scene.strip())
    if has_command and has_scene:
        raise click.ClickException(
            "A rule takes one target: --command (with an optional --device) or "
            "--room-scene, not both."
        )
    if not has_command and not has_scene:
        raise click.ClickException(
            "A rule needs a target: --command 'power on' (optional --device) or "
            "--room-scene NAME."
        )
    if has_scene and device:
        raise click.ClickException(
            "--device does not apply to a room-scene rule: the scene's devices are used."
        )


def _check_device(device: str | None) -> None:
    """Fail now rather than silently at 07:00 on a Tuesday."""
    if not device:
        return
    try:
        resolve_device_ref(load_config(), device)
    except Exception as e:
        raise click.ClickException(
            f"Device '{device}' not found: {e}. Run `govee-cli scan-http`."
        ) from e


def _check_room_scene(name: str) -> None:
    if name not in room_scenes.list_scenes():
        raise click.ClickException(f"Room scene '{name}' not found.")


def stamp_baseline(rule_id: str) -> None:
    """Record that a rule's schedule starts now, so a missed-fire check never reaches back past it.

    Written whenever a rule is created, enabled, or has its time or days changed.
    Every other field of the rule's state is preserved. Never raises: an
    unreadable state file must not fail the save that triggered this.
    """
    try:
        state = scheduler.read_state()
        now = dt.datetime.now(dt.timezone.utc).replace(second=0, microsecond=0).isoformat()
        current = state.get(rule_id, RuleState())
        state[rule_id] = dataclasses.replace(current, baseline_at=now)
        scheduler.write_state(state)
    except Exception:
        return
