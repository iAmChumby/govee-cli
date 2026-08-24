"""Embedded schedule engine for the sidecar.

Runs ``SchedulerDaemon._execute_rule`` on a background thread so the web stack
can carry schedules without a second service. Rules are reloaded from disk every
cycle — API mutations take effect immediately, unlike the CLI daemon which builds
its rule map once at startup. A per-minute guard keeps a rule from firing twice
when several polls land inside the same minute.

Deliberately absent: the daemon's signal handlers and its ``run()`` loop — this
runner's lifecycle belongs to the FastAPI lifespan.
"""

from __future__ import annotations

import asyncio
import datetime
import threading

import structlog

from govee_cli.commands.daemon import SchedulerDaemon
from govee_cli.schedule.scheduler import ScheduleRule, list_rules

logger = structlog.get_logger(__name__)

# 20s cadence samples every wall-clock minute at least twice, so no due minute
# is skipped while the per-minute guard still prevents double-firing.
POLL_SECONDS = 20.0


class SchedulerRunner:
    """Fires due schedule rules inside the sidecar process."""

    def __init__(self, poll_seconds: float = POLL_SECONDS) -> None:
        self._poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_fired_minute: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

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
            asyncio.run(self._execute(rule))
        return len(due)

    async def _execute(self, rule: ScheduleRule) -> None:
        # The daemon's execution logic routes by transport and reports its own
        # failures; reusing it keeps API-scheduled behaviour identical to the CLI.
        await SchedulerDaemon()._execute_rule(rule)
