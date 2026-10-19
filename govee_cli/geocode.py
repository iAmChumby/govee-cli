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
from typing import Any, Literal

import requests

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


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _parse_online(payload: Any) -> list[CityMatch]:
    """Open-Meteo ``results[]`` -> matches. A missing ``results`` key means none."""
    if not isinstance(payload, dict):
        raise ValueError("response is not a JSON object")
    results = payload.get("results") or []
    if not isinstance(results, list):
        raise ValueError("'results' is not a list")
    matches: list[CityMatch] = []
    for item in results:
        if not isinstance(item, dict):
            raise ValueError("a result is not an object")
        name = _opt_str(item.get("name"))
        lat, lon = item.get("latitude"), item.get("longitude")
        if name is None or not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue  # never keep a place we cannot place
        pop = item.get("population")
        matches.append(
            CityMatch(
                name=name,
                region=_opt_str(item.get("admin1")),
                country=_opt_str(item.get("country")),
                latitude=float(lat),
                longitude=float(lon),
                timezone=_opt_str(item.get("timezone")),
                population=pop if isinstance(pop, int) and not isinstance(pop, bool) else None,
            )
        )
    return matches


def _offline(query: str, count: int, error: str) -> CitySearch:
    from astral.geocoder import all_locations, database

    needle = query.casefold()
    hits = [loc for loc in all_locations(database()) if needle in loc.name.casefold()]
    # Prefix matches first, then alphabetical; the bundled list has no population.
    hits.sort(key=lambda loc: (not loc.name.casefold().startswith(needle), loc.name.casefold()))
    matches = [
        CityMatch(
            name=loc.name,
            region=_opt_str(loc.region),
            country=None,
            latitude=float(loc.latitude),
            longitude=float(loc.longitude),
            timezone=_opt_str(loc.timezone),
            population=None,
        )
        for loc in hits[:count]
    ]
    return CitySearch(query=query, matches=matches, source="offline", error=error)


def search_city(query: str, count: int = 8) -> CitySearch:
    """Ranked candidates for ``query`` (most populous first, as Open-Meteo ranks)."""
    query = query.strip()
    if not query:
        raise ValueError("City name is empty.")
    try:
        resp = requests.get(
            OPEN_METEO_URL,
            params={"name": query, "count": str(count), "language": "en", "format": "json"},
            timeout=TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        matches = _parse_online(resp.json())
    except requests.Timeout:
        return _offline(query, count, "timed out")
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "error"
        return _offline(query, count, f"HTTP {status}")
    except requests.RequestException:
        return _offline(query, count, "network unreachable")
    except ValueError as e:  # includes JSON decode errors
        return _offline(query, count, f"bad response ({e})")
    return CitySearch(query=query, matches=matches, source="open-meteo", error=None)
