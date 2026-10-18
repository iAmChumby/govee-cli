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
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

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


def parse_time(text: str) -> TimeSpec:
    """Parse ``text`` per the grammar; raise TimeSpecError with a readable message."""
    raise NotImplementedError


def canonical(spec: TimeSpec) -> str:
    """The one stored/displayed spelling: ``06:30``, ``sunset``, ``sunset-1h15m``."""
    raise NotImplementedError


def normalise_time(text: str) -> str:
    """``canonical(parse_time(text))``. Raises TimeSpecError."""
    return canonical(parse_time(text))


def host_timezone() -> str:
    """The host's IANA zone name (e.g. ``America/New_York``); ``UTC`` if undeterminable."""
    raise NotImplementedError


def resolve_location(cfg: GoveeConfig) -> Location:
    """Location from config, timezone falling back to ``host_timezone()``."""
    raise NotImplementedError


def event_time_on(event: Literal["sunrise", "sunset"], day: dt.date,
                  loc: Location) -> tuple[dt.datetime | None, str | None]:
    """The raw sun event on local ``day`` (aware, in loc's zone, floored to the minute).

    Returns ``(None, reason)`` when there is no location
    (``"no location"``) or no such event that day
    (``"no sunset on 2026-06-21 at this location"``).
    """
    raise NotImplementedError


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
    raise NotImplementedError
