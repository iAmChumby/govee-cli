"""Discover and interpret automation the sidecar's own rule store can't see.

The Schedules page's #2 complaint (WEBUI_V3_SPEC.md §1.2) is that
``~/.config/govee-cli/schedule.json`` can be genuinely empty while a light
still changes every weekday morning — because the real automation is a plain
crontab line (``30 6 * * * /home/chumby/.local/bin/wake-ramp run``) that this
codebase's native scheduler has never known about. This module is the read
side of that truth: it shells out to ``crontab -l``, classifies each relevant
line, and computes a next-fire time with an explicit confidence tier per
§6.1-§6.2.

Three tiers, not one, because they are not equally knowable:

- ``exact``     — a native ``ScheduleRule`` (elsewhere) or wake-ramp, whose
                  weekday-always / weekend-only-if-armed gating we can query
                  directly from the script itself (``wake-ramp status --json``,
                  added by T04). Never re-derived from the raw cron expression
                  — that field alone ("30 6 * * *") looks like "every day" and
                  would silently misreport every unarmed weekend.
- ``estimated`` — a generic ``govee-cli``/wake-ramp-adjacent cron line whose
                  next fire is read straight off the 5-field cron expression
                  via ``apscheduler``'s ``CronTrigger``. Honest about being an
                  estimate: a future script on that line could apply internal
                  gating exactly like wake-ramp does, invisible to cron syntax.
- ``unknown``   — the expression didn't parse, or the source (crontab, the
                  wake-ramp script) couldn't be read at all. Never silently
                  collapses into a blank field or a guessed time (§6.6).

An unreadable crontab is a first-class error state, not an empty result: see
:func:`read_crontab` and :data:`CrontabResult.readable`. Presenting "0 rows"
for a crontab this process simply failed to read would be exactly the kind of
lie this whole feature exists to stop telling.
"""

from __future__ import annotations

import getpass
import hashlib
import json
import pathlib
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any, Literal, cast

import structlog
from apscheduler.triggers.cron import CronTrigger

from .errors import bad_gateway

logger = structlog.get_logger(__name__)

# Absolute paths, not bare command names: the sidecar's systemd unit may run
# with a restricted PATH (see the NoNewPrivileges risk noted in §6.1), and a
# PATH-lookup miss must not be mistaken for "crontab isn't installed."
CRONTAB_BIN = "/usr/bin/crontab"
SPOOL_PATH = pathlib.Path("/var/spool/cron/crontabs") / getpass.getuser()
SNAPSHOT_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "crontab.snapshot"
WAKE_RAMP_BIN = "/home/chumby/.local/bin/wake-ramp"

Confidence = Literal["exact", "estimated", "unknown"]
CrontabSource = Literal["crontab", "spool", "snapshot", "none"]
EntryKind = Literal["wake-ramp", "cron"]

_GOVEE_CLI_RE = re.compile(r"\bgovee-cli\b")
_WAKE_RAMP_RE = re.compile(r"(^|/)wake-ramp(\s|$)")
_NO_CRONTAB_RE = re.compile(r"no crontab for", re.IGNORECASE)


@dataclass(frozen=True)
class CrontabResult:
    """The outcome of trying to read the user's crontab.

    ``source`` says which of the three routes answered, and ``stale_seconds`` is
    set only for the snapshot route — the console shows both so a cached answer
    is never mistaken for a live one.
    """

    readable: bool
    error: str | None
    raw_lines: list[str]
    source: CrontabSource = "crontab"
    stale_seconds: float | None = None


@dataclass(frozen=True)
class ParsedCronLine:
    """One non-blank, non-comment crontab line split into its cron/command halves."""

    raw: str
    cron_expr: str
    command: str


def read_crontab() -> CrontabResult:
    """The user's crontab, by whichever of three routes can actually reach it.

    ``crontab -l`` is the direct answer and the one that works from a shell. It
    does not work from the sidecar's systemd unit: ``/usr/bin/crontab`` is setgid
    ``crontab`` and ``/var/spool/cron/crontabs`` is mode 1730, and in a *user*
    unit any sandboxing directive (``ProtectSystem``, ``PrivateTmp``) implicitly
    turns on ``NoNewPrivileges``, which strips the setgid — so the traversal
    fails with EACCES no matter what the unit says about NoNewPrivileges itself.

    Rather than trade the sandbox away for one read, fall through:

    1. ``crontab -l`` — live and authoritative, works unsandboxed.
    2. the spool file directly — works when the user is in group ``crontab``.
    3. a snapshot written by ``govee-crontab-snapshot.timer``, an unsandboxed
       sibling unit — cached, and reported as such with its age.

    Every route reports which one answered, because "the crontab said so" and "a
    ten-minute-old copy of the crontab said so" are different claims and the
    console is not allowed to blur them.

    Blocking — run via ``run_blocking`` from a route.
    """
    live = _read_via_command()
    if live.readable:
        return live

    spool = _read_via_spool()
    if spool.readable:
        return spool

    snapshot = _read_via_snapshot()
    if snapshot.readable:
        return snapshot

    # Nothing worked. Report the direct attempt's error — it is the most
    # informative — with the fix appended, so the console can tell the user what
    # to do instead of just showing them EACCES.
    return CrontabResult(
        readable=False,
        error=(
            f"{live.error}. The sidecar cannot run setgid crontab under its systemd "
            f"sandbox; enable govee-crontab-snapshot.timer (deploy/) or add this user "
            f"to the 'crontab' group."
        ),
        raw_lines=[],
        source="none",
    )


def _read_via_command() -> CrontabResult:
    try:
        proc = subprocess.run(
            [CRONTAB_BIN, "-l"], timeout=3, capture_output=True, text=True
        )
    except FileNotFoundError:
        return CrontabResult(
            readable=False, error="crontab command not found on this host",
            raw_lines=[], source="none",
        )
    except subprocess.TimeoutExpired:
        return CrontabResult(
            readable=False, error="crontab -l timed out", raw_lines=[], source="none",
        )

    if proc.returncode != 0:
        if _NO_CRONTAB_RE.search(proc.stderr):
            # "no crontab for chumby" is a legitimately empty crontab, not a
            # read failure — the command worked, there's just nothing in it.
            return CrontabResult(readable=True, error=None, raw_lines=[])
        message = proc.stderr.strip()[:200] or f"crontab -l exited {proc.returncode}"
        return CrontabResult(readable=False, error=message, raw_lines=[], source="none")

    return CrontabResult(readable=True, error=None, raw_lines=proc.stdout.splitlines())


def _read_via_spool() -> CrontabResult:
    """The spool file, readable directly when the user is in group ``crontab``."""
    try:
        text = SPOOL_PATH.read_text()
    except OSError as e:
        return CrontabResult(readable=False, error=str(e), raw_lines=[], source="none")
    return CrontabResult(
        readable=True, error=None, raw_lines=text.splitlines(), source="spool"
    )


def _read_via_snapshot() -> CrontabResult:
    """A cached copy, with its age — never presented as a live read."""
    try:
        text = SNAPSHOT_PATH.read_text()
        age = datetime.now(timezone.utc).timestamp() - SNAPSHOT_PATH.stat().st_mtime
    except OSError as e:
        return CrontabResult(readable=False, error=str(e), raw_lines=[], source="none")
    return CrontabResult(
        readable=True, error=None, raw_lines=text.splitlines(),
        source="snapshot", stale_seconds=age,
    )


def parse_line(line: str) -> ParsedCronLine | None:
    """Split a crontab line into cron expression + command, or ``None`` to skip it.

    Blank lines, ``#``-comments, and env-var assignments (``MAILTO=...``, which
    tokenize to fewer than 6 fields since they contain no whitespace) all fall
    out of the "fewer than 6 fields" check naturally.
    """
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    fields = stripped.split(None, 5)
    if len(fields) < 6:
        return None
    return ParsedCronLine(raw=stripped, cron_expr=" ".join(fields[:5]), command=fields[5])


def is_govee_relevant(command: str) -> bool:
    """True for anything this console should surface — wake-ramp or a govee-cli call."""
    return "wake-ramp" in command or bool(_GOVEE_CLI_RE.search(command))


def classify(parsed: ParsedCronLine) -> EntryKind:
    """"wake-ramp" only for a command that actually invokes that binary by path."""
    return "wake-ramp" if _WAKE_RAMP_RE.search(parsed.command) else "cron"


def wake_ramp_status() -> dict[str, Any] | None:
    """``wake-ramp status --json`` (the shape T04 added), or ``None`` on any failure.

    Every failure mode — binary missing, timeout, non-zero exit, unparseable
    stdout, or JSON that isn't an object — is logged and folded into the same
    ``None`` so callers have one honest "couldn't ask the script" branch
    instead of a menu of exception types to guess at.
    """
    try:
        proc = subprocess.run(
            [WAKE_RAMP_BIN, "status", "--json"], timeout=3, capture_output=True, text=True
        )
    except FileNotFoundError:
        logger.warning("wake_ramp_status_failed", reason="binary not found")
        return None
    except subprocess.TimeoutExpired:
        logger.warning("wake_ramp_status_failed", reason="timed out")
        return None

    if proc.returncode != 0:
        logger.warning(
            "wake_ramp_status_failed",
            returncode=proc.returncode,
            stderr=proc.stderr.strip()[:200],
        )
        return None

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        logger.warning("wake_ramp_status_unparseable", error=str(e))
        return None

    if not isinstance(data, dict):
        logger.warning("wake_ramp_status_wrong_shape", type=type(data).__name__)
        return None
    return cast(dict[str, Any], data)


def _parse_hhmm(value: str | None, default: tuple[int, int]) -> tuple[int, int]:
    if not value:
        return default
    try:
        hour_s, minute_s = value.split(":", 1)
        return int(hour_s), int(minute_s)
    except (ValueError, AttributeError):
        return default


def next_fire_for_wake_ramp(
    status: dict[str, Any], now: datetime
) -> tuple[str | None, Confidence]:
    """Mirror wake-ramp's own weekday-always / weekend-only-if-armed gating.

    This deliberately does NOT re-derive next-fire from the raw cron
    expression — ``"30 6 * * *"`` reads as "every day," but the script only
    actually runs weekends when ``armed_date`` matches. Re-deriving from cron
    syntax is exactly the trap this whole confidence-tier system exists to
    avoid (§6.1).
    """
    ramp = status.get("ramp") or {}
    hour, minute = _parse_hhmm(ramp.get("start"), default=(6, 30))
    armed_date = status.get("armed_date")
    today = now.date()

    candidates: list[datetime] = []
    for offset in range(8):
        d = today + timedelta(days=offset)
        fire_at = datetime.combine(d, time(hour, minute), tzinfo=now.tzinfo)
        is_weekday = d.weekday() < 5  # Mon=0 .. Fri=4
        if is_weekday:
            armed_or_default = True
        else:
            armed_or_default = armed_date == d.isoformat()
        if not armed_or_default:
            continue
        if offset == 0 and now >= fire_at:
            continue  # today's window has already passed
        candidates.append(fire_at)

    if not candidates:
        return None, "unknown"
    return min(candidates).isoformat(), "exact"


def next_fire_for_cron(cron_expr: str, now: datetime) -> tuple[str | None, Confidence]:
    """Next fire straight from the cron expression — an estimate, never asserted as fact."""
    try:
        trigger = CronTrigger.from_crontab(cron_expr)
        fire = trigger.get_next_fire_time(None, now)
    except Exception:
        # A malformed field (out-of-range value, bad step, etc.) must never
        # guess — "unknown" is the honest answer, not a crash or a fabricated time.
        return None, "unknown"
    if fire is None:
        return None, "unknown"
    return fire.isoformat(), "estimated"


def today_occurrences(
    cron_expr: str, now: datetime, cap: int = 20
) -> tuple[list[str], bool]:
    """Every fire time for ``cron_expr`` on ``now``'s date, capped against a runaway line.

    Returns ``(occurrences, truncated)`` — a pathological ``"* * * * *"`` would
    otherwise produce 1440 timeline markers for one day.
    """
    try:
        trigger = CronTrigger.from_crontab(cron_expr)
    except Exception:
        return [], False

    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cursor = midnight
    occurrences: list[str] = []
    truncated = False
    while True:
        fire = trigger.get_next_fire_time(None, cursor)
        if fire is None or fire.date() != now.date():
            break
        if len(occurrences) >= cap:
            truncated = True
            break
        occurrences.append(fire.isoformat())
        # apscheduler's get_next_fire_time is inclusive of `cursor`, so the
        # cursor must move strictly past the fire we just recorded.
        cursor = fire + timedelta(minutes=1)
    return occurrences, truncated


def _duration_minutes(start: str | None, end: str | None) -> int | None:
    if not start or not end:
        return None
    try:
        t0 = datetime.strptime(start, "%H:%M")
        t1 = datetime.strptime(end, "%H:%M")
    except ValueError:
        return None
    delta = int((t1 - t0).total_seconds() // 60)
    return delta if delta >= 0 else None


def _build_wake_ramp_entry(
    parsed: ParsedCronLine | None, status: dict[str, Any] | None, now: datetime
) -> dict[str, Any]:
    if status is None:
        return {
            "id": "wake-ramp",
            "kind": "wake-ramp",
            "raw_line": parsed.raw if parsed else None,
            "cron_expr": parsed.cron_expr if parsed else None,
            "command": parsed.command if parsed else f"{WAKE_RAMP_BIN} run",
            "device_hint": None,
            "duration_minutes": None,
            "wake_ramp_status": None,
            "next_fire": None,
            "next_fire_confidence": "unknown",
            "today_occurrences": [],
            "today_occurrences_truncated": False,
            "parse_error": "could not read wake-ramp status (script unavailable or failed)",
        }

    next_fire, confidence = next_fire_for_wake_ramp(status, now)
    ramp = status.get("ramp") or {}
    devices = ramp.get("devices") or []
    return {
        "id": "wake-ramp",
        "kind": "wake-ramp",
        "raw_line": parsed.raw if parsed else None,
        "cron_expr": parsed.cron_expr if parsed else None,
        "command": parsed.command if parsed else f"{WAKE_RAMP_BIN} run",
        "device_hint": ", ".join(devices) if devices else None,
        "duration_minutes": _duration_minutes(ramp.get("start"), ramp.get("end")),
        "wake_ramp_status": {
            "armed_date": status.get("armed_date"),
            "weekdays_always": status.get("weekdays_always"),
            # Trust our own crontab read over the script's. wake-ramp checks
            # `crontab -l | grep wake-ramp`, which fails the same sandboxed way
            # the sidecar's direct read does — so when the script is invoked from
            # the service it reports cron_installed:false while we are holding
            # the very line that proves otherwise. Having parsed that line is
            # strictly better evidence than a subprocess that could not look.
            "cron_installed": (
                True if parsed is not None else status.get("cron_installed")
            ),
            "today_will_run": status.get("today_will_run"),
        },
        "next_fire": next_fire,
        "next_fire_confidence": confidence,
        # Rendered as a duration band on the timeline (§6.4), not points — an
        # occurrence list would be misleading for a 30-minute ramp.
        "today_occurrences": [],
        "today_occurrences_truncated": False,
        "parse_error": None,
    }


def _build_cron_entry(parsed: ParsedCronLine, now: datetime) -> dict[str, Any]:
    next_fire, confidence = next_fire_for_cron(parsed.cron_expr, now)
    if confidence == "unknown":
        occurrences: list[str] = []
        truncated = False
        parse_error: str | None = "could not parse cron expression"
    else:
        occurrences, truncated = today_occurrences(parsed.cron_expr, now)
        parse_error = None
    # Stable across polls (derived from the line's own text) so the frontend
    # can key a list item on it without entries reshuffling identity.
    entry_id = hashlib.sha1(parsed.raw.encode()).hexdigest()[:10]
    return {
        "id": entry_id,
        "kind": "cron",
        "raw_line": parsed.raw,
        "cron_expr": parsed.cron_expr,
        "command": parsed.command,
        "device_hint": None,
        "duration_minutes": None,
        "wake_ramp_status": None,
        "next_fire": next_fire,
        "next_fire_confidence": confidence,
        "today_occurrences": occurrences,
        "today_occurrences_truncated": truncated,
        "parse_error": parse_error,
    }


def _find_wake_ramp_line(crontab: CrontabResult) -> ParsedCronLine | None:
    if not crontab.readable:
        return None
    for raw in crontab.raw_lines:
        parsed = parse_line(raw)
        if parsed and is_govee_relevant(parsed.command) and classify(parsed) == "wake-ramp":
            return parsed
    return None


def build_external_schedule(now: datetime | None = None) -> dict[str, Any]:
    """Assemble the full ``GET /schedules/external`` payload (§6.2's JSON shape).

    Blocking (shells out up to twice) — run via ``run_blocking`` from a route.
    """
    now = now or datetime.now().astimezone()
    crontab = read_crontab()
    checked_at = datetime.now(timezone.utc).isoformat()

    if not crontab.readable:
        # First-class error state, not "0 external automations" — see §6.6.
        # A light can still be firing on a schedule this payload cannot see.
        return {
            "crontab": {
                "readable": False, "error": crontab.error, "checked_at": checked_at,
                "source": crontab.source, "stale_seconds": crontab.stale_seconds,
            },
            "entries": [],
        }

    entries: list[dict[str, Any]] = []
    status: dict[str, Any] | None = None
    status_fetched = False
    for raw in crontab.raw_lines:
        parsed = parse_line(raw)
        if parsed is None or not is_govee_relevant(parsed.command):
            continue
        if classify(parsed) == "wake-ramp":
            if not status_fetched:
                status = wake_ramp_status()
                status_fetched = True
            entries.append(_build_wake_ramp_entry(parsed, status, now))
        else:
            entries.append(_build_cron_entry(parsed, now))

    return {
        "crontab": {
            "readable": True, "error": None, "checked_at": checked_at,
            "source": crontab.source, "stale_seconds": crontab.stale_seconds,
        },
        "entries": entries,
    }


def _run_wake_ramp_action(action: Literal["arm", "disarm"]) -> None:
    """Shell out verbatim — the flag file is the script's own state, never touched directly."""
    try:
        proc = subprocess.run(
            [WAKE_RAMP_BIN, action], timeout=5, capture_output=True, text=True
        )
    except FileNotFoundError as e:
        raise bad_gateway(f"wake-ramp binary not found at {WAKE_RAMP_BIN}: {e}") from e
    except subprocess.TimeoutExpired as e:
        raise bad_gateway(f"wake-ramp {action} timed out") from e
    if proc.returncode != 0:
        message = proc.stderr.strip()[:200] or f"exited {proc.returncode}"
        raise bad_gateway(f"wake-ramp {action} failed: {message}")


def _fresh_wake_ramp_entry(now: datetime | None = None) -> dict[str, Any]:
    """Re-read crontab and wake-ramp's own status live — never served from cache.

    The flag file arm/disarm toggles is consumed by the script itself, so a
    cached armed state could lie about what the next click will actually do.
    """
    now = now or datetime.now().astimezone()
    crontab = read_crontab()
    parsed = _find_wake_ramp_line(crontab)
    status = wake_ramp_status()
    return _build_wake_ramp_entry(parsed, status, now)


def arm_wake_ramp(now: datetime | None = None) -> dict[str, Any]:
    _run_wake_ramp_action("arm")
    return _fresh_wake_ramp_entry(now)


def disarm_wake_ramp(now: datetime | None = None) -> dict[str, Any]:
    _run_wake_ramp_action("disarm")
    return _fresh_wake_ramp_entry(now)
