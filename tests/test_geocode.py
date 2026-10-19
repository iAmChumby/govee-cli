"""City lookup (issue #2 follow-up): parsing, offline fallback, API route, CLI.

No test touches the network: ``requests.get`` is always replaced.
"""

from __future__ import annotations

import os
from typing import Any

import pytest
import requests
from click.testing import CliRunner
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_LATENCY", "0-0")

from govee_cli import geocode  # noqa: E402
from govee_cli.commands.config_cmd import command as config_group  # noqa: E402
from govee_cli.config import load_config, save_config  # noqa: E402
from webui.api import main as main_mod  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

PAYLOAD = {
    "results": [
        {"id": 1, "name": "Rochester", "latitude": 43.15478, "longitude": -77.61556,
         "elevation": 154.0, "country_code": "US", "timezone": "America/New_York",
         "population": 211328, "country": "United States", "admin1": "New York"},
        {"id": 2, "name": "Rochester", "latitude": 44.02163, "longitude": -92.46985,
         "timezone": "America/Chicago", "population": 121395,
         "country": "United States", "admin1": "Minnesota"},
        {"id": 3, "name": "Nowhere", "country": "Atlantis"},  # no coordinates: dropped
    ]
}


class FakeResponse:
    def __init__(self, payload: Any = None, status: int = 200, bad_json: bool = False) -> None:
        self._payload, self.status_code, self._bad = payload, status, bad_json

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)  # type: ignore[arg-type]

    def json(self) -> Any:
        if self._bad:
            raise ValueError("Expecting value")
        return self._payload


def _fake_get(monkeypatch: pytest.MonkeyPatch, result: Any) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def get(url: str, **kw: Any) -> Any:
        calls.append({"url": url, **kw})
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(geocode.requests, "get", get)
    return calls


# ------------------------------------------------------------------ search_city


def test_parses_open_meteo_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_get(monkeypatch, FakeResponse(PAYLOAD))
    out = geocode.search_city("  Rochester ")
    assert out.source == "open-meteo" and out.error is None and out.query == "Rochester"
    assert [m.label for m in out.matches] == [
        "Rochester, New York, United States",
        "Rochester, Minnesota, United States",
    ]
    first = out.matches[0]
    assert (first.latitude, first.longitude, first.timezone, first.population) == (
        43.15478, -77.61556, "America/New_York", 211328)
    assert calls[0]["url"] == geocode.OPEN_METEO_URL
    assert calls[0]["timeout"] == geocode.TIMEOUT_SECONDS
    assert calls[0]["params"]["name"] == "Rochester"


def test_zero_results_is_a_real_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_get(monkeypatch, FakeResponse({"generationtime_ms": 0.4}))
    out = geocode.search_city("Zzzzqx")
    assert out.source == "open-meteo" and out.matches == [] and out.error is None


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (requests.ConnectionError("down"), "network unreachable"),
        (requests.Timeout("slow"), "timed out"),
        (FakeResponse(status=503), "HTTP 503"),
        (FakeResponse(bad_json=True), "bad response"),
        (FakeResponse(["not", "an", "object"]), "bad response"),
    ],
)
def test_failure_falls_back_to_offline_list(
    monkeypatch: pytest.MonkeyPatch, failure: Any, reason: str
) -> None:
    _fake_get(monkeypatch, failure)
    out = geocode.search_city("New York")
    assert out.source == "offline"
    assert out.error is not None and reason in out.error
    assert out.matches, "astral's bundled list should hold New York"
    assert all("new york" in m.name.lower() for m in out.matches)
    assert all(m.timezone for m in out.matches)


def test_offline_unknown_name_returns_nothing_invented(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_get(monkeypatch, requests.ConnectionError("down"))
    out = geocode.search_city("Zzzzqx")
    assert out.source == "offline" and out.matches == []


def test_empty_query_raises() -> None:
    with pytest.raises(ValueError):
        geocode.search_city("   ")


# ------------------------------------------------------------------ API


@pytest.fixture(scope="module")
def mock_client():
    app = main_mod.create_app(main_mod.Settings(mock=True, scheduler_enabled=False, port=1))
    with TestClient(app) as c:
        yield c
    uninstall_mock()


def test_cities_route_mock_mode_never_hits_network(
    mock_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*a: Any, **k: Any) -> None:
        raise AssertionError("network touched in mock mode")

    monkeypatch.setattr(geocode.requests, "get", boom)
    r = mock_client.get("/api/v1/config/cities", params={"q": "rochester"})
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "open-meteo" and body["error"] is None
    assert [m["region"] for m in body["matches"]] == ["New York", "Minnesota", "England"]
    assert body["matches"][0]["label"] == "Rochester, New York, United States"


def test_cities_route_rejects_empty_query(mock_client: TestClient) -> None:
    assert mock_client.get("/api/v1/config/cities", params={"q": ""}).status_code == 422
    assert mock_client.get("/api/v1/config/cities", params={"q": "  "}).status_code == 422
    assert mock_client.get("/api/v1/config/cities").status_code == 422


def test_cities_route_real_mode_uses_search(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_get(monkeypatch, requests.ConnectionError("down"))
    app = main_mod.create_app(main_mod.Settings(mock=False, scheduler_enabled=False, port=1))
    with TestClient(app) as c:
        body = c.get("/api/v1/config/cities", params={"q": "Rochester"}).json()
    assert body["source"] == "offline" and body["error"]


def test_patch_name_rules(mock_client: TestClient) -> None:
    def patch(**b: Any) -> Any:
        return mock_client.patch("/api/v1/config", json=b)

    r = patch(latitude=43.15, longitude=-77.61, timezone="America/New_York",
              location_name="Rochester, New York, United States")
    assert r.status_code == 200
    assert r.json()["location_name"] == "Rochester, New York, United States"
    assert mock_client.get("/api/v1/config").json()["location_name"].startswith("Rochester")
    sched = mock_client.get("/api/v1/schedules").json()["location"]
    assert sched["name"] == "Rochester, New York, United States"

    # A timezone-only change keeps the label (coordinates unchanged).
    assert patch(timezone="America/Chicago").json()["location_name"].startswith("Rochester")
    # Raw coordinates without a label drop the old label.
    assert patch(latitude=10.0, longitude=20.0).json()["location_name"] is None
    # A label without coordinates is refused.
    assert patch(location_name="Nowhere").status_code == 422
    # clear_location clears the label too.
    patch(latitude=43.15, longitude=-77.61, location_name="Rochester")
    r = patch(clear_location=True)
    assert r.json()["location_name"] is None and r.json()["latitude"] is None


# ------------------------------------------------------------------ CLI

ROC_NY = geocode.CityMatch("Rochester", "New York", "United States", 43.1548, -77.6156,
                           "America/New_York", 211328)
ROC_MN = geocode.CityMatch("Rochester", "Minnesota", "United States", 44.0216, -92.4699,
                           "America/Chicago", 121395)


def _result(matches: list[geocode.CityMatch], source: Any = "open-meteo",
            error: str | None = None) -> geocode.CitySearch:
    return geocode.CitySearch("q", matches, source, error)


def _invoke(monkeypatch: pytest.MonkeyPatch, result: geocode.CitySearch, *args: str) -> Any:
    monkeypatch.setattr(geocode, "search_city", lambda q, count=8: result)
    return CliRunner().invoke(config_group, ["location", *args])


def test_cli_pick_saves_name_and_zone(monkeypatch: pytest.MonkeyPatch) -> None:
    res = _invoke(monkeypatch, _result([ROC_NY, ROC_MN]), "--city", "Rochester", "--pick", "2")
    assert res.exit_code == 0, res.output
    assert ("1. Rochester, New York, United States (43.1548, -77.6156) America/New_York"
            in res.output)
    cfg = load_config()
    assert cfg.location_name == "Rochester, Minnesota, United States"
    assert (cfg.latitude, cfg.longitude, cfg.timezone) == (44.0216, -92.4699, "America/Chicago")
    shown = CliRunner().invoke(config_group, ["location"])
    assert "location: Rochester, Minnesota, United States (44.0216, -92.4699)" in shown.output


def test_cli_single_match_saves_without_pick(monkeypatch: pytest.MonkeyPatch) -> None:
    res = _invoke(monkeypatch, _result([ROC_NY]), "--city", "Rochester")
    assert res.exit_code == 0, res.output
    assert load_config().location_name == "Rochester, New York, United States"


def test_cli_several_non_tty_exits_2_and_saves_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = load_config()
    cfg.latitude, cfg.longitude, cfg.location_name = 1.0, 2.0, None
    save_config(cfg)
    res = _invoke(monkeypatch, _result([ROC_NY, ROC_MN]), "--city", "Rochester")
    assert res.exit_code == 2
    assert "--pick" in res.output
    assert load_config().latitude == 1.0 and load_config().location_name is None


def test_cli_pick_out_of_range_and_no_match(monkeypatch: pytest.MonkeyPatch) -> None:
    res = _invoke(monkeypatch, _result([ROC_NY, ROC_MN]), "--city", "R", "--pick", "5")
    assert res.exit_code != 0 and "out of range" in res.output
    res = _invoke(monkeypatch, _result([]), "--city", "Zzz")
    assert res.exit_code != 0 and "No city matches" in res.output


def test_cli_offline_label_and_raw_coords_clear_name(monkeypatch: pytest.MonkeyPatch) -> None:
    res = _invoke(monkeypatch, _result([ROC_NY], "offline", "network unreachable"),
                  "--city", "Rochester")
    assert "(offline list: network unreachable)" in res.output
    assert load_config().location_name
    CliRunner().invoke(config_group, ["location", "10", "20"])
    assert load_config().location_name is None
