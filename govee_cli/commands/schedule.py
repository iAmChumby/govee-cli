"""schedule command — manage local schedules."""

import uuid

import click

from govee_cli.schedule.scheduler import ScheduleRule, add_rule, list_rules, remove_rule


@click.group()
def schedule() -> None:
    """Manage local schedules (list, add, remove)."""
    pass


@schedule.command()
def list() -> None:
    """List all schedule rules."""
    rules = list_rules()
    if not rules:
        click.echo("No schedules defined. See 'govee-cli schedule add --help'")
        return

    for r in rules:
        status = "✓" if r.enabled else "✗"
        target = r.device or "(default device)"
        click.echo(
            f"[{status}] {r.id}  {r.time} {', '.join(r.days)} — "
            f"{r.name}: {r.command}  → {target}"
        )


@schedule.command()
@click.option("--name", required=True, help="Schedule name")
@click.option("--time", "time_str", required=True, help="Time (HH:MM, 24h)")
@click.option("--days", required=True, help="Days (comma-separated: Mon,Wed,Fri)")
@click.option("--command", required=True, help="Command to run (e.g. 'power on')")
@click.option("--device", help="Device name or ID (default: the configured default device)")
def add(name: str, time_str: str, days: str, command: str, device: str | None) -> None:
    """Add a new schedule rule.

    Each rule targets one device. Without --device it falls back to the
    configured default, which is how rules behaved before per-rule targeting
    existed, so existing schedules are unaffected.
    """
    if device:
        # Fail now rather than silently at 07:00 on a Tuesday.
        from govee_cli.config import load_config, resolve_device_ref

        try:
            resolve_device_ref(load_config(), device)
        except Exception as e:
            raise click.ClickException(
                f"Device '{device}' not found: {e}. Run `govee-cli scan-http`."
            ) from e

    add_rule(
        ScheduleRule(
            id=str(uuid.uuid4())[:8],
            name=name,
            time=time_str,
            days=[d.strip() for d in days.split(",")],
            command=command,
            device=device,
        )
    )
    click.echo(f"Added schedule: {name}" + (f" → {device}" if device else ""))


@schedule.command()
@click.argument("rule_id")
def remove(rule_id: str) -> None:
    """Remove a schedule rule by ID."""
    if remove_rule(rule_id):
        click.echo(f"Removed schedule {rule_id}")
    else:
        click.echo(f"Schedule {rule_id} not found")
