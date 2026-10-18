"""daemon command — run the scheduler as a long-lived background process."""

from __future__ import annotations

import asyncio
import datetime
import signal
import threading
from collections.abc import Callable
from dataclasses import replace
from typing import TYPE_CHECKING

import click
import structlog

from govee_cli.commands.group import _parse_inline_command
from govee_cli.schedule import engine, owner
from govee_cli.schedule.owner import SchedulerLock
from govee_cli.schedule.scheduler import (
    RuleResult,
    RuleState,
    ScheduleRule,
    list_rules,
    read_state,
    write_state,
)
from govee_cli.schedule.timespec import Location, resolve_location

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

    ``fire_rule`` (below) is the one firing path for both the standalone
    ``govee-cli daemon`` and the sidecar's runner; it delegates device rules to
    ``SchedulerDaemon()._execute_rule_detail``, which is the sole caller of
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


DAEMON_POLL_SECONDS = 30.0


def _utc_iso(moment: datetime.datetime) -> str:
    """UTC ISO of the minute containing ``moment`` (state files store UTC)."""
    return moment.astimezone(datetime.timezone.utc).replace(second=0, microsecond=0).isoformat()


def _now_in_zone() -> tuple[datetime.datetime, Location]:
    """Aware 'now' in the schedule zone, plus the Location it was computed for."""
    from zoneinfo import ZoneInfo

    from govee_cli.config import load_config

    loc = resolve_location(load_config())
    return datetime.datetime.now(ZoneInfo(loc.timezone)), loc


def fire_rule(rule: ScheduleRule, *, dry_run: bool) -> tuple[RuleResult, str]:
    """The one firing path, used by the CLI daemon and the sidecar.

    ``dry_run`` short-circuits BEFORE any client is built or config read for
    sending: mock mode must never reach a device.
    """
    if dry_run:
        return "would_fire", "dry run: nothing sent"

    if rule.room_scene:
        return _fire_room_scene(rule.room_scene)

    try:
        ok, detail = asyncio.run(SchedulerDaemon()._execute_rule_detail(rule))
    except Exception as e:
        logger.error("rule_execution_failed", id=rule.id, name=rule.name, error=str(e))
        return "error", str(e)
    return ("ok" if ok else "error"), detail


def _fire_room_scene(name: str) -> tuple[RuleResult, str]:
    from govee_cli import room_restore, room_scenes
    from govee_cli.config import load_config

    scene = room_scenes.read_scene(name)
    if scene is None:
        return "error", f"room scene '{name}' missing: rule will not fire"
    try:
        from govee_cli.http_v2 import GoveeHTTPv2

        result = room_restore.restore_scene(
            name, scene, cfg=load_config(),
            clients=room_restore.RestoreClients(v2=GoveeHTTPv2()),
            source="schedule",
        )
    except Exception as e:
        logger.error("room_scene_rule_failed", scene=name, error=str(e))
        return "error", str(e)
    if result.ok:
        return "ok", f"room scene '{name}' applied"
    counted = [r for r in result.results if r.skipped_reason is None]
    failed = [r for r in counted if not r.ok]
    detail = "; ".join(f"{r.ref}: {r.error or 'failed'}" for r in failed)
    return "error", f"{len(failed)} of {len(counted)} devices failed: {detail}"


def _read_state_or_empty() -> dict[str, RuleState]:
    try:
        return read_state()
    except Exception as e:  # corrupt file: log, treat as empty, never crash
        logger.error("schedule_state_unreadable", error=str(e))
        return {}


def acquire_and_record_missed(lock: SchedulerLock, now: datetime.datetime,
                              loc: Location) -> bool:
    """Take the lock; on success record fires missed while nobody owned it.

    The previous owner's last cycle is read BEFORE ``try_acquire`` overwrites
    it. Missed minutes are recorded, never caught up.
    """
    previous = owner.previous_last_cycle()
    if not lock.try_acquire():
        return False
    try:
        rules = list_rules()
        state = _read_state_or_empty()
        missed = engine.detect_missed(rules, now, loc, state, previous)
        if missed:
            at = _utc_iso(now)
            for rule_id, minute in missed.items():
                prior = state.get(rule_id, RuleState())
                state[rule_id] = replace(
                    prior, last_result="missed", missed_minute=_utc_iso(minute),
                    last_detail="no scheduler was running at the scheduled time",
                    last_at=at,
                )
            write_state(state)
    except Exception as e:
        logger.error("missed_detection_failed", error=str(e))
    return True


def run_cycle(
    lock: SchedulerLock,
    *,
    dry_run: bool,
    fire: Callable[..., tuple[RuleResult, str]] | None = None,
    on_fire: Callable[[ScheduleRule, RuleResult, str, str], None] | None = None,
) -> int:
    """One scheduler cycle for the lock holder. Returns how many rules fired.

    Rules and state are re-read every cycle. ``engine.due_rules`` is the only
    code that matches a rule to a clock. ``on_fire(rule, result, detail, at)``
    lets the sidecar keep its health snapshot.
    """
    fire_fn = fire or fire_rule
    now, loc = _now_in_zone()
    rules = list_rules()
    state = _read_state_or_empty()
    due = engine.due_rules(rules, now, loc, state)
    for rule, minute in due:
        logger.info("rule_firing", id=rule.id, name=rule.name, command=rule.command,
                    room_scene=rule.room_scene)
        try:
            result, detail = fire_fn(rule, dry_run=dry_run)
        except Exception as e:  # one bad rule never stops the others
            result, detail = "error", str(e)
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        state[rule.id] = RuleState(
            last_fired_minute=_utc_iso(minute), last_result=result,
            last_detail=detail, last_at=at,
        )
        if on_fire is not None:
            on_fire(rule, result, detail, at)
    if due:
        try:
            write_state(state)
        except Exception as e:
            logger.error("schedule_state_write_failed", error=str(e))
    lock.heartbeat(now)
    return len(due)


@click.command()
@click.option(
    "--once",
    is_flag=True,
    help="Run one scheduler cycle (fire what is due now) and exit",
)
@click.pass_context
def command(ctx: click.Context, once: bool) -> None:
    """Run the scheduler daemon.

    Executes scheduled commands at their configured times (clock or
    sunrise/sunset). Exits 1 if another scheduler already owns the schedule.
    """
    lock = SchedulerLock("daemon", DAEMON_POLL_SECONDS)
    now, loc = _now_in_zone()
    if not acquire_and_record_missed(lock, now, loc):
        click.echo(owner.describe_holder(owner.read_owner(now)), err=True)
        ctx.exit(1)

    stop = threading.Event()

    def _handle(_signum: int, _frame: object) -> None:
        stop.set()

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)

    click.echo("govee-cli scheduler daemon starting...")
    click.echo("Press Ctrl+C to stop.")
    try:
        while not stop.is_set():
            try:
                run_cycle(lock, dry_run=False)
            except Exception as e:
                logger.error("daemon_cycle_failed", error=str(e))
                click.echo(f"cycle failed: {e}", err=True)
            if once:
                break
            stop.wait(DAEMON_POLL_SECONDS)
    finally:
        lock.release()


class SchedulerDaemon:
    """Executes one rule's device command. Timing lives in ``schedule.engine``."""

    async def _execute_rule(self, rule: ScheduleRule) -> bool:
        ok, _detail = await self._execute_rule_detail(rule)
        return ok

    async def _execute_rule_detail(self, rule: ScheduleRule) -> tuple[bool, str]:
        """Execute a single device rule; returns (device obeyed, detail).

        Routes by transport like every other command, so a rule can target a
        cloud-only device. Every failure here is reachable and handled: an
        unresolvable device ref, a cloud error, an unparseable command, a BLE
        failure. The boolean is what keeps ``last_result`` honest.
        """
        from govee_cli.commands.group import _apply_http_command, _apply_v2_command
        from govee_cli.config import load_config
        from govee_cli.exceptions import GoveeError
        from govee_cli.transport import CLOUD_V1, CLOUD_V2, resolve_target

        cfg = load_config()

        try:
            device_id, model, transport = resolve_target(cfg, rule.device)
        except click.ClickException as e:
            msg = e.format_message()
            click.echo(f"  ⚠ {msg}")
            return False, msg

        try:
            if transport == CLOUD_V2:
                from govee_cli.http_v2 import GoveeHTTPv2

                v2 = GoveeHTTPv2()
                _apply_v2_command(v2, device_id, model or "", rule.command)
                _record_schedule_ledger(rule.command, device_id, model, v2_client=v2)
                click.echo("  ✅ Done")
                return True, "ok"

            if transport == CLOUD_V1:
                from govee_cli.http import GoveeHTTP

                _apply_http_command(GoveeHTTP(), device_id, model or "", rule.command)
                _record_schedule_ledger(rule.command, device_id, model)
                click.echo("  ✅ Done")
                return True, "ok"
        except Exception as e:
            click.echo(f"  ❌ Error: {e}")
            return False, str(e)

        from govee_cli.ble import GoveeBLE
        from govee_cli.commands._common import Target

        # BLE needs the 6-octet address, not the 8-octet cloud id.
        ble_mac = Target(device_id, model, transport, cfg).ble_mac

        cmd = _parse_inline_command(rule.command, device_model=model)
        if cmd is None:
            click.echo(f"  ⚠ Could not parse command: {rule.command}")
            return False, f"could not parse command: {rule.command}"

        try:
            async with GoveeBLE(ble_mac, adapter=cfg.default_adapter) as client:
                await client.execute(cmd)
                _record_schedule_ledger(rule.command, device_id, model)
                click.echo("  ✅ Done")
                return True, "ok"
        except GoveeError as e:
            click.echo(f"  ❌ Error: {e}")
            return False, str(e)
