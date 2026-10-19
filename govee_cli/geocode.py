"""City -> coordinates for sun-relative schedules (issue #2 follow-up).

SPINE: shapes and signature fixed by the main agent; the body is built by the
backend area.

The lookup runs ONCE, when the user picks a city; the chosen match's
latitude/longitude/timezone are stored in config and every sun time after that
is computed offline by astral. Online source: Open-Meteo's free geocoding API
(no key). If it fails (network down, timeout, bad response) the search falls
back to astral's bundled offline list (~390 cities) and says so, so a lookup
never silently returns nothing and never invents a place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

OPEN_METEO_URL = "https://geocoding-api.open-meteo.com/v1/search"
TIMEOUT_SECONDS = 8.0


@dataclass(frozen=True)
class CityMatch:
    name: str
    region: str | None
    country: str | None
    latitude: float
    longitude: float
    timezone: str | None
    population: int | None

    @property
    def label(self) -> str:
        """"Rochester, New York, United States" (missing parts omitted)."""
        return ", ".join(p for p in (self.name, self.region, self.country) if p)


@dataclass(frozen=True)
class CitySearch:
    query: str
    matches: list[CityMatch]
    source: Literal["open-meteo", "offline"]
    error: str | None  # why the online lookup failed, when source == "offline"


def search_city(query: str, count: int = 8) -> CitySearch:
    """Ranked candidates for ``query`` (most populous first, as Open-Meteo ranks)."""
    raise NotImplementedError
