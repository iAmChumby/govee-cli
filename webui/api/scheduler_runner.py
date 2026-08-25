"""Embedded schedule engine for the sidecar.

Runs ``SchedulerDaemon._execute_rule`` on a background thread so the web stack
can carry schedules without a second service. Rules are reloaded from disk every
cycle — API mutations take effect immediately, unlike the CLI daemon which builds
its rule map once at startup. A per-minute guard keeps a rule from firing twice
when several polls land inside the same minute.

Deliberately absent: the daemon's signal handlers and its ``run()`` loop — this
runner's lifecycle belongs to the FastAPI lifespan.

Also tracks its own health (§6.5) so ``StatusStrip``'s single dot and the
Settings page's full breakdown are reading something real instead of the old
flat "is a thread object truthy" boolean: :attr:`_last_cycle_at` proves the
poll loop is actually turning over, and :attr:`_last_fire` records the most
recent rule execution's outcome. ``snapshot()`` is the read side other code
(the health route, once it's wired) reaches for both.
"""

from __future__ import annotations

import asyncio
import datetime
import threading
from dataclasses import dataclass
from typing import Any

import structlog

from govee_cli.commands.daemon import SchedulerDaemon
from govee_cli.schedule.scheduler import ScheduleRule, list_rules

logger = structlog.get_logger(__name__)

# 20s cadence samples every wall-clock minute at least twice, so no due minute
# is skipped while the per-minute guard still prevents double-firing.
POLL_SECONDS = 20.0


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


@dataclass(frozen=True)
class LastFire:
    """The most recent rule execution this runner attempted."""

    rule_id: str
    name: str
    at: str
    ok: bool
    error: str | None = None


class SchedulerRunner:
    """Fires due schedule rules inside the sidecar process."""

    def __init__(self, poll_seconds: float = POLL_SECONDS) -> None:
        self._poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_fired_minute: str | None = None
        # Guards the two health fields below: written from the poll thread,
        # read from the event loop via snapshot().
        self._health_lock = threading.Lock()
        self._last_cycle_at: str | None = None
        self._last_fire: LastFire | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def snapshot(self) -> dict[str, Any]:
        """A JSON-ready health snapshot for the ``scheduler.native`` health field (§6.5)."""
        with self._health_lock:
            last_cycle_at = self._last_cycle_at
            last_fire = self._last_fire
        last_fire_out: dict[str, Any] | None = None
        if last_fire is not None:
            last_fire_out = {
                "rule_id": last_fire.rule_id,
                "name": last_fire.name,
                "at": last_fire.at,
                "ok": last_fire.ok,
            }
            if last_fire.error is not None:
                last_fire_out["error"] = last_fire.error
        return {
            "alive": self.running,
            "poll_seconds": self._poll_seconds,
            "last_cycle_at": last_cycle_at,
            "last_fire": last_fire_out,
        }

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="govee-webui-scheduler", daemon=True
        )
        self._thread.start()
        logger.info("scheduler_started", poll_seconds=self._poll_seconds)

    def stop(self) -> None:
        if self._thread is None:
            return
        self._stop.set()
        self._thread.join(timeout=self._poll_seconds + 5)
        self._thread = None
        logger.info("scheduler_stopped")

    def _loop(self) -> None:
        while not self._stop.wait(self._poll_seconds):
            try:
                self.fire_due()
            except Exception as e:
                # One bad cycle (disk hiccup, device error) must not kill the
                # thread; the next poll retries with fresh rules.
                logger.error("scheduler_cycle_failed", error=str(e))

    def fire_due(self) -> int:
        """Execute every enabled rule due now. Returns how many fired."""
        # Set on every poll — success or not — so `last_cycle_at` proves the
        # loop is alive even on a cycle that fires nothing (§6.5).
        with self._health_lock:
            self._last_cycle_at = _now_iso()

        now = datetime.datetime.now()
        current_minute = now.strftime("%H:%M")
        if current_minute == self._last_fired_minute:
            return 0

        current_day = now.strftime("%a").lower()[:3]
        # Rules load before the minute guard is committed: a transient read
        # failure must leave this minute retryable, not silently skipped.
        rules = list_rules()
        self._last_fired_minute = current_minute

        due = [
            rule for rule in rules
            if rule.enabled
            and rule.time == current_minute
            and current_day in (d.lower()[:3] for d in rule.days)
        ]
        for rule in due:
            logger.info("rule_firing", id=rule.id, name=rule.name, command=rule.command)
            self._run_rule(rule)
        return len(due)

    def _run_rule(self, rule: ScheduleRule) -> None:
        """Run one rule and record its outcome, isolating one bad rule from the rest.

        ``last_fire.ok`` means the device obeyed, not merely that the runner
        tried. ``SchedulerDaemon._execute_rule`` returns that outcome as a bool
        — every failure it can reach (unresolvable device ref, cloud error,
        unparseable command, BLE failure) is handled internally and reported
        through the return value rather than raised. The try/except still wraps
        it so an *un*handled failure (a bug, a future code path) also lands as
        ``ok=False`` instead of only reaching the journal.
        """
        fired_at = _now_iso()
        try:
            obeyed = asyncio.run(self._execute(rule))
        except Exception as e:
            logger.error("rule_execution_failed", id=rule.id, name=rule.name, error=str(e))
            with self._health_lock:
                self._last_fire = LastFire(
                    rule_id=rule.id, name=rule.name, at=fired_at, ok=False, error=str(e)
                )
            return
        with self._health_lock:
            self._last_fire = LastFire(
                rule_id=rule.id,
                name=rule.name,
                at=fired_at,
                ok=obeyed,
                error=None if obeyed else "device did not accept the command — see the sidecar log",
            )

    async def _execute(self, rule: ScheduleRule) -> bool:
        # The daemon's execution logic routes by transport and reports its own
        # failures; reusing it keeps API-scheduled behaviour identical to the CLI.
        return await SchedulerDaemon()._execute_rule(rule)
