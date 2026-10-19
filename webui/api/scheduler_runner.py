"""Embedded schedule runner for the sidecar (issue #2).

Runs the same cycle as ``govee-cli daemon`` (``govee_cli.commands.daemon.run_cycle``)
on a background thread. Only the process holding the scheduler lock fires
rules: a sidecar that does not hold it reports ``waiting`` and retries the lock
every cycle forever, never stealing it (G1). Rules and state are re-read every
cycle, and ``govee_cli.schedule.engine`` is the only code that matches a rule to
a clock.

Mock mode runs the runner with ``dry_run=True``: it takes the lock as a
"sidecar (mock, dry run)" owner and records ``would_fire``. ``fire_rule``
short-circuits before any client is built, so nothing is ever sent.

``GOVEE_WEBUI_MOCK_OWNER`` (mock mode only) pins the displayed ownership state
for fixtures: ``nobody``/``stale`` -> ``lock_status()`` is ``disabled`` (mock.py
seeds the owner file); ``waiting``/``daemon`` -> ``waiting``. In those states
the runner never tries to acquire the lock.
"""

from __future__ import annotations

import datetime
import threading
from dataclasses import dataclass
from typing import Any, Literal

import structlog

from govee_cli.commands import daemon as daemon_mod
from govee_cli.schedule import owner
from govee_cli.schedule.owner import SchedulerLock
from govee_cli.schedule.scheduler import ScheduleRule

logger = structlog.get_logger(__name__)

# 20s cadence samples every wall-clock minute at least twice; the engine's
# per-UTC-minute state keeps a rule from firing twice.
POLL_SECONDS = 20.0

LockStatus = Literal["owner", "waiting", "disabled"]
MOCK_OWNER_STATES = ("nobody", "stale", "daemon", "waiting")


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


def _zone_iso(value: str | datetime.datetime | None, tz: datetime.tzinfo) -> str | None:
    """Wire form: ISO in the schedule zone, floored to the minute."""
    if value is None:
        return None
    moment = datetime.datetime.fromisoformat(value) if isinstance(value, str) else value
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(tz).replace(second=0, microsecond=0).isoformat()


class SchedulerRunner:
    """Fires due schedule rules inside the sidecar process."""

    def __init__(
        self,
        poll_seconds: float = POLL_SECONDS,
        *,
        dry_run: bool = False,
        mock_owner: str | None = None,
    ) -> None:
        self._poll_seconds = poll_seconds
        self._dry_run = dry_run
        # Only honoured in dry-run / mock mode.
        self._mock_owner = mock_owner if dry_run and mock_owner in MOCK_OWNER_STATES else None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = SchedulerLock("sidecar", poll_seconds, dry_run=dry_run)
        # Guards the health fields below: written from the poll thread,
        # read from the event loop via snapshot().
        self._health_lock = threading.Lock()
        self._last_cycle_at: str | None = None
        self._last_fire: LastFire | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def lock_status(self) -> LockStatus:
        """What the schedule API reads: ``owner`` (this process holds the lock),
        ``waiting`` (another scheduler holds it; we retry each cycle) or
        ``disabled`` (mock fixture pinned to nobody/stale). A missing runner is
        "disabled" too, decided by the caller."""
        if self._mock_owner is not None:
            return "waiting" if self._mock_owner in ("waiting", "daemon") else "disabled"
        return "owner" if self._lock.held else "waiting"

    def snapshot(self) -> dict[str, Any]:
        """A JSON-ready health snapshot for the ``scheduler.native`` health field."""
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
            # No UI reads `alive` any more (G4): the owner view below is the
            # source of truth. Kept so older health consumers do not break.
            "alive": self.running,
            "poll_seconds": self._poll_seconds,
            "last_cycle_at": last_cycle_at,
            "last_fire": last_fire_out,
            "lock_status": self.lock_status(),
            "owner": self._owner_dict(),
        }

    def _owner_dict(self) -> dict[str, Any]:
        """The ``read_owner`` view with every datetime ISO in the schedule zone."""
        try:
            from zoneinfo import ZoneInfo

            from govee_cli.config import load_config
            from govee_cli.schedule.timespec import resolve_location

            tz = ZoneInfo(resolve_location(load_config()).timezone)
            view = owner.read_owner(datetime.datetime.now(tz))
        except Exception as e:
            logger.warning("owner_read_failed", error=str(e))
            return {"state": "unknown", "detail": f"owner record unreadable: {e}"}
        rec = view.record
        return {
            "state": view.state,
            "kind": rec.kind if rec else None,
            "dry_run": rec.dry_run if rec else None,
            "pid": rec.pid if rec else None,
            "host": rec.host if rec else None,
            "started_at": _zone_iso(rec.started_at, tz) if rec else None,
            "last_cycle_at": _zone_iso(rec.last_cycle_at, tz) if rec else None,
            "poll_seconds": rec.poll_seconds if rec else None,
            "stale_since": _zone_iso(view.stale_since, tz),
            "detail": view.detail,
        }

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._loop, name="govee-webui-scheduler", daemon=True
        )
        self._thread.start()
        logger.info("scheduler_started", poll_seconds=self._poll_seconds,
                    dry_run=self._dry_run, mock_owner=self._mock_owner)

    def stop(self) -> None:
        if self._thread is not None:
            self._stop.set()
            self._thread.join(timeout=self._poll_seconds + 5)
            self._thread = None
        # The lock is NOT released here: try_acquire and release must run on the
        # same thread (filelock's in-process mutex is an RLock), so the runner
        # thread releases it when its loop exits. If the join timed out, process
        # exit frees the OS lock.
        logger.info("scheduler_stopped")

    def _loop(self) -> None:
        try:
            while True:
                try:
                    self.cycle()
                except Exception as e:
                    # One bad cycle (disk hiccup, device error) must not kill
                    # the thread; the next poll retries with fresh rules.
                    logger.error("scheduler_cycle_failed", error=str(e))
                if self._stop.wait(self._poll_seconds):
                    return
        finally:
            try:
                self._lock.release()
            except Exception as e:
                logger.error("scheduler_lock_release_failed", error=str(e))

    def _record_fire(self, rule: ScheduleRule, result: str, detail: str, at: str) -> None:
        ok = result in ("ok", "would_fire")
        with self._health_lock:
            self._last_fire = LastFire(
                rule_id=rule.id, name=rule.name, at=at, ok=ok,
                error=None if ok else detail,
            )

    def cycle(self) -> int:
        """One poll: (re)try the lock if not held, then run the shared cycle.
        Returns how many rules fired."""
        with self._health_lock:
            self._last_cycle_at = _now_iso()

        if self._mock_owner is not None:
            return 0  # fixture owner states never touch the lock

        if not self._lock.held:
            now, loc = daemon_mod._now_in_zone()
            if not daemon_mod.acquire_and_record_missed(self._lock, now, loc):
                return 0  # waiting; retry next cycle, never steal (G1)
        return daemon_mod.run_cycle(
            self._lock, dry_run=self._dry_run, on_fire=self._record_fire
        )
