"""daemon command — run the scheduler as a long-lived background process."""

from __future__ import annotations

import asyncio
import datetime
import signal

import click
import structlog

from govee_cli.commands.group import _parse_inline_command
from govee_cli.schedule.scheduler import (
    ScheduleRule,
    list_rules,
)

logger = structlog.get_logger(__name__)


@click.command()
@click.option(
    "--once",
    is_flag=True,
    help="Run pending schedules once and exit (don't loop)",
)
@click.pass_context
def command(ctx: click.Context, once: bool) -> None:
    """Run the scheduler daemon.

    Executes scheduled commands at their configured times.
    Schedules are managed via 'govee-cli schedule add/remove'.
    """
    click.echo("govee-cli scheduler daemon starting...")
    click.echo("Press Ctrl+C to stop.")

    rules = list_rules()
    if not rules:
        click.echo("No schedules defined. Add one with: govee-cli schedule add")
        return

    for r in rules:
        status = "✓" if r.enabled else "✗ (disabled)"
        click.echo(f"  [{status}] {r.time} {','.join(r.days)} — {r.name}: {r.command}")

    daemon = SchedulerDaemon(once=once)
    asyncio.run(daemon.run())


class SchedulerDaemon:
    """Long-lived scheduler daemon that executes rules at their scheduled times."""

    def __init__(self, once: bool = False):
        self._running = False
        self._once = once
        # Map (HH:MM, day) -> list of rules
        self._rule_map: dict[tuple[str, str], list[ScheduleRule]] = {}
        self._load_rules()

    def _load_rules(self) -> None:
        """Build the time->rules lookup map."""
        self._rule_map.clear()
        for rule in list_rules():
            if not rule.enabled:
                continue
            for day in rule.days:
                key = (rule.time, day.lower()[:3])
                self._rule_map.setdefault(key, []).append(rule)

    def stop(self) -> None:
        """Request daemon shutdown."""
        self._running = False

    async def run(self) -> None:
        """Run the daemon loop."""
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stop)

        self._running = True
        last_minute = ""

        while self._running:
            await asyncio.sleep(30)

            if not self._running:
                break

            now_dt = datetime.datetime.now()
            current_minute = now_dt.strftime("%H:%M")
            current_day = now_dt.strftime("%a").lower()[:3]

            if current_minute == last_minute:
                continue
            last_minute = current_minute

            key = (current_minute, current_day)
            rules = self._rule_map.get(key, [])

            for rule in rules:
                click.echo(f"\n[Firing] {rule.name}: {rule.command}")
                await self._execute_rule(rule)

            if self._once and rules:
                break

    async def _execute_rule(self, rule: ScheduleRule) -> None:
        """Execute a single scheduled rule against its target device.

        Routes by transport like every other command, so a rule can target a
        cloud-only device. Previously this went straight to BLE against the
        single configured default_mac, which meant cloud-only models (the H6022
        has no BLE path at all) could never be scheduled.
        """
        from govee_cli.commands.group import _apply_http_command, _apply_v2_command
        from govee_cli.config import load_config
        from govee_cli.exceptions import GoveeError
        from govee_cli.transport import CLOUD_V1, CLOUD_V2, resolve_target

        cfg = load_config()

        try:
            device_id, model, transport = resolve_target(cfg, rule.device)
        except click.ClickException as e:
            click.echo(f"  ⚠ {e.format_message()}")
            return

        try:
            if transport == CLOUD_V2:
                from govee_cli.http_v2 import GoveeHTTPv2

                _apply_v2_command(GoveeHTTPv2(), device_id, model or "", rule.command)
                click.echo("  ✅ Done")
                return

            if transport == CLOUD_V1:
                from govee_cli.http import GoveeHTTP

                _apply_http_command(GoveeHTTP(), device_id, model or "", rule.command)
                click.echo("  ✅ Done")
                return
        except Exception as e:
            click.echo(f"  ❌ Error: {e}")
            return

        from govee_cli.ble import GoveeBLE

        cmd = _parse_inline_command(rule.command, device_model=model)
        if cmd is None:
            click.echo(f"  ⚠ Could not parse command: {rule.command}")
            return

        try:
            async with GoveeBLE(device_id, adapter=cfg.default_adapter) as client:
                await client.execute(cmd)
                click.echo("  ✅ Done")
        except GoveeError as e:
            click.echo(f"  ❌ Error: {e}")
