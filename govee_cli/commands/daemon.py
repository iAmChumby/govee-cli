"""daemon command — run the scheduler as a long-lived background process."""

from __future__ import annotations

import asyncio
import datetime
import signal
from typing import TYPE_CHECKING

import click
import structlog

from govee_cli.commands.group import _parse_inline_command
from govee_cli.schedule.scheduler import (
    ScheduleRule,
    list_rules,
)

if TYPE_CHECKING:
    from govee_cli.http_v2 import GoveeHTTPv2

logger = structlog.get_logger(__name__)


def _record_schedule_ledger(
    cmd_str: str,
    device_id: str,
    model: str | None,
    v2_client: "GoveeHTTPv2 | None" = None,
) -> None:
    """Ledger write-through for a fired schedule rule (§3.3's daemon.py rule).

    Mirrors the mode-selection each interactive command file applies for the
    same verb — power.py, color.py, temp.py, scene.py, diy.py, music.py,
    segments.py — but with ``source="schedule"`` instead of ``"cli"``, since a
    schedule rule only ever carries a verb+args string, not an already-resolved
    Scene/DIYScene object. Called only after the caller's own dispatch to
    ``_apply_v2_command``/``_apply_http_command``/BLE ``client.execute`` has
    already succeeded.

    ``SchedulerRunner._execute`` (webui/api/scheduler_runner.py) delegates
    straight to ``SchedulerDaemon()._execute_rule``, which is the sole caller of
    this function — so this one hook covers both the standalone ``govee-cli
    daemon`` process and the sidecar's embedded scheduler without duplicating
    the mode-selection logic in two places.

    Unlike ``ledger.record_mode`` itself, this helper does real work before it
    ever reaches that call — most notably a *second* cloud lookup
    (``v2_client.find_scene``/``find_diy_scene``) for the scene/diy verbs, which
    can raise on its own (rate limit, network blip) independently of the device
    command that already succeeded. ``_execute_rule`` calls this from inside the
    same try/except that decides whether a rule is reported as failed, and its
    BLE branch catches only ``GoveeError`` — so an unguarded exception here
    would either mislabel an already-successful command as failed, or (over
    BLE) escape uncaught and kill the daemon's run loop. The whole body is
    therefore wrapped the same never-raise way ``ledger.record_mode`` itself
    is: log at WARNING and return, never propagate.
    """
    try:
        _record_schedule_ledger_unsafe(cmd_str, device_id, model, v2_client)
    except Exception:
        logger.warning(
            "schedule_ledger.record.failed",
            device_id=device_id,
            cmd=cmd_str,
        )


def _record_schedule_ledger_unsafe(
    cmd_str: str,
    device_id: str,
    model: str | None,
    v2_client: "GoveeHTTPv2 | None" = None,
) -> None:
    from govee_cli import ledger

    parts = cmd_str.strip().split()
    if not parts:
        return
    verb, args = parts[0].lower(), parts[1:]

    if verb == "power" and args:
        if args[0] == "on":
            ledger.record_mode(device_id, "basic", None, None, source="schedule")
        else:
            ledger.record_mode(device_id, "off", None, None, source="schedule")
        return

    if verb == "brightness":
        return  # brightness-only writes never change mode — see §3.5

    if verb == "color" and len(args) == 1:
        from govee_cli.commands._common import parse_hex

        try:
            r, g, b = parse_hex(args[0])
        except click.ClickException:
            return
        ledger.record_mode(
            device_id, "basic", None, {"color_rgb": [r, g, b]}, source="schedule"
        )
        return

    if verb == "temp" and len(args) == 1:
        try:
            kelvin = int(args[0])
        except ValueError:
            return
        ledger.record_mode(
            device_id, "basic", None, {"color_temp_k": kelvin}, source="schedule"
        )
        return

    if verb == "scene" and args and v2_client is not None and model:
        name = " ".join(args)
        scene = v2_client.find_scene(model, device_id, name)
        if scene is not None:
            ledger.record_mode(
                device_id, "scene", scene.name,
                {"scene_id": scene.scene_id, "param_id": scene.param_id},
                source="schedule",
            )
        return

    if verb == "diy" and args and v2_client is not None and model:
        name = " ".join(args)
        diy = v2_client.find_diy_scene(model, device_id, name)
        if diy is not None:
            ledger.record_mode(
                device_id, "diy", diy.name, {"diy_value": diy.value}, source="schedule"
            )
        return

    if verb == "music" and args and model:
        # Same isolation rule as music.py: the mode NAME, resolved per model,
        # never the raw integer — a schedule that fires "music beat" against an
        # H6022 (where 4 means "rolling") must not silently mislabel the UI.
        from govee_cli.devices import SUPPORTED_DEVICES

        handler = SUPPORTED_DEVICES.get(model.upper())
        modes = dict(getattr(handler, "MUSIC_MODES", {}) or {})
        key = args[0].lower()
        if key in modes:
            sensitivity = 60
            if len(args) > 1:
                try:
                    sensitivity = int(args[1])
                except ValueError:
                    sensitivity = 60
            ledger.record_mode(
                device_id, "music", key,
                {"music_mode": modes[key], "sensitivity": sensitivity},
                source="schedule",
            )
        return

    if verb == "segments" and len(args) == 2 and model:
        from govee_cli.commands._common import parse_hex, parse_segments
        from govee_cli.transport import get_spec

        spec = get_spec(model)
        count = spec.segment_count if spec else 15
        try:
            segments = parse_segments(args[0], count)
            r, g, b = parse_hex(args[1])
        except click.ClickException:
            return
        ledger.record_mode(
            device_id, "segments", None,
            {"segments": segments, "rgb": [r, g, b], "brightness": None},
            source="schedule",
        )
        return


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

    async def _execute_rule(self, rule: ScheduleRule) -> bool:
        """Execute a single scheduled rule against its target device.

        Routes by transport like every other command, so a rule can target a
        cloud-only device. Previously this went straight to BLE against the
        single configured default_mac, which meant cloud-only models (the H6022
        has no BLE path at all) could never be scheduled.

        Returns whether the device actually obeyed. Every failure here is
        reachable and already handled — an unresolvable device ref, a cloud
        error, an unparseable command, a BLE failure — and each one used to
        ``click.echo`` a message and return the same ``None`` a success
        returned. That made the sidecar's ``last_fire.ok`` health field
        structurally incapable of ever being False: it reported that the
        scheduler had *attempted* a rule, while the console presented it as
        proof the rule worked. The boolean is what makes that field honest.
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
            return False

        try:
            if transport == CLOUD_V2:
                from govee_cli.http_v2 import GoveeHTTPv2

                v2 = GoveeHTTPv2()
                _apply_v2_command(v2, device_id, model or "", rule.command)
                _record_schedule_ledger(rule.command, device_id, model, v2_client=v2)
                click.echo("  ✅ Done")
                return True

            if transport == CLOUD_V1:
                from govee_cli.http import GoveeHTTP

                _apply_http_command(GoveeHTTP(), device_id, model or "", rule.command)
                _record_schedule_ledger(rule.command, device_id, model)
                click.echo("  ✅ Done")
                return True
        except Exception as e:
            click.echo(f"  ❌ Error: {e}")
            return False

        from govee_cli.ble import GoveeBLE
        from govee_cli.commands._common import Target

        # BLE needs the 6-octet address, not the 8-octet cloud id.
        ble_mac = Target(device_id, model, transport, cfg).ble_mac

        cmd = _parse_inline_command(rule.command, device_model=model)
        if cmd is None:
            click.echo(f"  ⚠ Could not parse command: {rule.command}")
            return False

        try:
            async with GoveeBLE(ble_mac, adapter=cfg.default_adapter) as client:
                await client.execute(cmd)
                _record_schedule_ledger(rule.command, device_id, model)
                click.echo("  ✅ Done")
                return True
        except GoveeError as e:
            click.echo(f"  ❌ Error: {e}")
            return False
