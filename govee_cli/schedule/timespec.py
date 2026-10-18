"""Schedule time grammar and sun maths (issue #2).

SPINE — signatures and shapes are fixed by the main agent; bodies are built by
the core area. Grammar (canonical form is what gets stored and displayed)::

    time      := clock | sun
    clock     := HH ":" MM                 00:00..23:59
    sun       := event [ sign duration ]
    event     := "sunrise" | "sunset"
    duration  := hours "h" [ minutes "m" ] | minutes "m"

Offsets are 1..360 minutes. ``sunset+0m`` -> ``sunset``; ``Sunset-90M`` ->
``sunset-1h30m``; ``sunset-2h0m`` -> ``sunset-2h``.

Sun events come from astral at elevation 0. astral disagrees with
sunrise-sunset.org by about two minutes (exploration E1), so nothing built on
this module may display seconds.
"""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from astral import Observer
from astral.sun import sunrise as _astral_sunrise
from astral.sun import sunset as _astral_sunset

if TYPE_CHECKING:
    from govee_cli.config import GoveeConfig

TimeKind = Literal["clock", "sunrise", "sunset"]
MAX_OFFSET_MINUTES = 360


class TimeSpecError(ValueError):
    """A time string that does not match the grammar. The message is user-facing."""


@dataclass(frozen=True)
class TimeSpec:
    kind: TimeKind
    # Clock rules only; None for sun rules.
    hour: int | None = None
    minute: int | None = None
    # Sun rules only; signed minutes (negative = before the event). 0 for clock.
    offset_minutes: int = 0


@dataclass(frozen=True)
class Location:
    """Where and in which zone sun times are computed.

    ``latitude``/``longitude`` are None when unset — sun rules then have no
    next run, never a guessed one. ``timezone`` is always an IANA name;
    ``timezone_source`` says whether it came from config or the host, and the
    UI labels the host case ``host: <zone>``.
    """

    latitude: float | None
    longitude: float | None
    timezone: str
    timezone_source: Literal["config", "host"]

    @property
    def has_coordinates(self) -> bool:
        return self.latitude is not None and self.longitude is not None


_CLOCK_RE = re.compile(r"^(\d{1,2}):(\d{2})$")
_SUN_RE = re.compile(r"^(sunrise|sunset)(?:([+-])(.*))?$")
_DURATION_RE = re.compile(r"^(?:(\d+)h(?:(\d+)m)?|(\d+)m)$")

_FORMS = "use HH:MM, sunrise, sunset, or sunrise/sunset with an offset like sunset-1h15m"


def parse_time(text: str) -> TimeSpec:
    """Parse ``text`` per the grammar; raise TimeSpecError with a readable message."""
    shown = str(text).strip()
    raw = "".join(shown.split()).lower()
    if not raw:
        raise TimeSpecError(f"time is empty: {_FORMS}")

    clock = _CLOCK_RE.match(raw)
    if clock:
        hour, minute = int(clock.group(1)), int(clock.group(2))
        if hour > 23 or minute > 59:
            raise TimeSpecError(f"'{shown}' is not a valid time of day (00:00 to 23:59)")
        return TimeSpec(kind="clock", hour=hour, minute=minute)

    sun = _SUN_RE.match(raw)
    if not sun:
        raise TimeSpecError(f"'{shown}' is not a valid time: {_FORMS}")
    event = cast(TimeKind, sun.group(1))
    sign, duration = sun.group(2), sun.group(3) or ""
    if sign is None:
        return TimeSpec(kind=event)

    dur = _DURATION_RE.match(duration)
    if not dur:
        raise TimeSpecError(
            f"'{shown}' has an invalid offset after {event}{sign}: "
            "use hours and/or minutes like 1h, 90m or 1h15m"
        )
    if dur.group(3) is not None:
        minutes = int(dur.group(3))
    else:
        minutes = int(dur.group(1)) * 60 + int(dur.group(2) or 0)
    if minutes > MAX_OFFSET_MINUTES:
        raise TimeSpecError(
            f"offset {minutes}m is too large: offsets run from 1m to "
            f"{MAX_OFFSET_MINUTES // 60}h ({MAX_OFFSET_MINUTES}m)"
        )
    return TimeSpec(kind=event, offset_minutes=-minutes if sign == "-" else minutes)


def canonical(spec: TimeSpec) -> str:
    """The one stored/displayed spelling: ``06:30``, ``sunset``, ``sunset-1h15m``."""
    if spec.kind == "clock":
        return f"{spec.hour or 0:02d}:{spec.minute or 0:02d}"
    if spec.offset_minutes == 0:
        return spec.kind
    sign = "-" if spec.offset_minutes < 0 else "+"
    hours, minutes = divmod(abs(spec.offset_minutes), 60)
    out = f"{hours}h" if hours else ""
    if minutes:
        out += f"{minutes}m"
    return f"{spec.kind}{sign}{out}"


def normalise_time(text: str) -> str:
    """``canonical(parse_time(text))``. Raises TimeSpecError."""
    return canonical(parse_time(text))


def _valid_zone(name: str) -> bool:
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


def host_timezone() -> str:
    """The host's IANA zone name (e.g. ``America/New_York``); ``UTC`` if undeterminable."""
    env = os.environ.get("TZ", "").strip().lstrip(":")
    if env and _valid_zone(env):
        return env
    try:
        name = pathlib.Path("/etc/timezone").read_text(encoding="utf-8").strip()
        if name and _valid_zone(name):
            return name
    except OSError:
        pass
    try:
        target = os.readlink("/etc/localtime")
        marker = "zoneinfo/"
        if marker in target:
            name = target.split(marker, 1)[1]
            if _valid_zone(name):
                return name
    except OSError:
        pass
    return "UTC"


def resolve_location(cfg: GoveeConfig) -> Location:
    """Location from config, timezone falling back to ``host_timezone()``."""
    configured = (cfg.timezone or "").strip()
    if configured:
        tz, source = configured, "config"
    else:
        tz, source = host_timezone(), "host"
    return Location(
        latitude=cfg.latitude,
        longitude=cfg.longitude,
        timezone=tz,
        timezone_source=cast(Literal["config", "host"], source),
    )


def _zone(loc: Location) -> ZoneInfo | None:
    try:
        return ZoneInfo(loc.timezone)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return None


def _floor_minute(value: dt.datetime) -> dt.datetime:
    return value.replace(second=0, microsecond=0)


def event_time_on(event: Literal["sunrise", "sunset"], day: dt.date,
                  loc: Location) -> tuple[dt.datetime | None, str | None]:
    """The raw sun event on local ``day`` (aware, in loc's zone, floored to the minute).

    Returns ``(None, reason)`` when there is no location
    (``"no location"``) or no such event that day
    (``"no sunset on 2026-06-21 at this location"``).
    """
    if loc.latitude is None or loc.longitude is None:
        return None, "no location"
    tz = _zone(loc)
    if tz is None:
        return None, f"unknown timezone '{loc.timezone}'"
    try:
        observer = Observer(loc.latitude, loc.longitude, 0)
    except ValueError:
        return None, "invalid location"
    func = _astral_sunrise if event == "sunrise" else _astral_sunset
    # astral anchors to a UTC date; far from Greenwich the event can land on a
    # neighbouring local date. Try the date itself, then its neighbours, and
    # keep the occurrence whose LOCAL date is `day`.
    for probe in (day, day - dt.timedelta(days=1), day + dt.timedelta(days=1)):
        try:
            when = func(observer, date=probe, tzinfo=tz)
        except ValueError:
            continue
        local = when.astimezone(tz)
        if local.date() == day:
            return _floor_minute(local), None
    return None, f"no {event} on {day.isoformat()} at this location"


def fire_time_on(spec: TimeSpec, day: dt.date,
                 loc: Location) -> tuple[dt.datetime | None, str | None]:
    """When a rule with ``spec`` fires for local date ``day``.

    Aware datetime in loc's zone, floored to the minute, or ``(None, reason)``.
    Clock rules on a DST gap return
    ``(None, "02:30 does not exist on 2027-03-14 (DST)")``; on a DST overlap
    they return the FIRST occurrence (fires once). For sun rules the returned
    datetime's own local date is the one whose ``days`` filter applies — callers
    compute candidates for neighbouring days and filter by that.
    """
    tz = _zone(loc)
    if tz is None:
        return None, f"unknown timezone '{loc.timezone}'"
    if spec.kind == "clock":
        hour, minute = spec.hour or 0, spec.minute or 0
        wall = dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz, fold=0)
        # Round-trip through UTC: a wall time inside a spring-forward gap comes
        # back shifted, a real one comes back unchanged.
        back = wall.astimezone(dt.timezone.utc).astimezone(tz)
        if back.replace(tzinfo=None) != wall.replace(tzinfo=None):
            return None, f"{hour:02d}:{minute:02d} does not exist on {day.isoformat()} (DST)"
        return wall, None
    event = cast(Literal["sunrise", "sunset"], spec.kind)
    base, reason = event_time_on(event, day, loc)
    if base is None:
        return None, reason
    # Offsets are elapsed time: add in UTC so a transition inside the window
    # cannot shift the result by an hour.
    shifted = base.astimezone(dt.timezone.utc) + dt.timedelta(minutes=spec.offset_minutes)
    return _floor_minute(shifted.astimezone(tz)), None
