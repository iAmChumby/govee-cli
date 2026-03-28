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
        click.echo(f"[{status}] {r.id}  {r.time} {', '.join(r.days)} — {r.name}: {r.command}")


@schedule.command()
@click.option("--name", required=True, help="Schedule name")
@click.option("--time", "time_str", required=True, help="Time (HH:MM, 24h)")
@click.option("--days", required=True, help="Days (comma-separated: Mon,Wed,Fri)")
@click.option("--command", required=True, help="Command to run (e.g. 'power on')")
def add(name: str, time_str: str, days: str, command: str) -> None:
    """Add a new schedule rule."""
    add_rule(
        ScheduleRule(
            id=str(uuid.uuid4())[:8],
            name=name,
            time=time_str,
            days=[d.strip() for d in days.split(",")],
            command=command,
        )
    )
    click.echo(f"Added schedule: {name}")


@schedule.command()
@click.argument("rule_id")
def remove(rule_id: str) -> None:
    """Remove a schedule rule by ID."""
    if remove_rule(rule_id):
        click.echo(f"Removed schedule {rule_id}")
    else:
        click.echo(f"Schedule {rule_id} not found")
