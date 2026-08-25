"""T21 — the meter route: a thin, honest read of ``request_meter.snapshot()``.

No task in WEBUI_V3_SPEC.md's work breakdown wires ``meter.router`` into
``webui/api/main.py`` — that's T24's ``include_router`` call, and T21's own
"Files:" line doesn't list ``main.py``. Per the hard "touch only your owned
files" rule, this mounts the router into a standalone app rather than going
through ``webui.api.main.create_app()``, same pattern as
``tests/test_calibration.py``.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from govee_cli import request_meter  # noqa: E402
from govee_cli.config import load_config, save_config  # noqa: E402
from webui.api.errors import install_error_handlers  # noqa: E402
from webui.api.mock import install as install_mock  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.routers import meter  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Isolate the meter file the same way tests/test_request_meter.py does —
    # this is a plain-attribute swap, not something mock.install() covers
    # (request_meter.py isn't a library the mock module redirects).
    monkeypatch.setattr(request_meter, "METER_PATH", tmp_path / "request-meter.json")
    monkeypatch.setattr(
        request_meter, "METER_LOCK_PATH", tmp_path / "request-meter.json.lock"
    )
    request_meter.reset()

    install_mock()  # redirects config.json so request_budget_per_day is isolated too
    app = FastAPI()
    app.include_router(meter.router, prefix="/api/v1")
    install_error_handlers(app)
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()
    request_meter.reset()


def test_fresh_meter_returns_a_zeroed_snapshot(client: TestClient) -> None:
    resp = client.get("/api/v1/meter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["v2_today"] == 0
    assert body["v1_today"] == 0
    assert body["rate_limited_today"] == 0
    assert body["errors_today"] == 0
    assert body["v2_last_minute"] == 0
    assert body["v2_last_hour"] == 0
    assert body["budget_per_day"] is None
    assert len(body["minutes"]) == 60
    assert all(count == 0 for _, count in body["minutes"])
    # "day" is a real date string, not a placeholder.
    assert len(body["day"]) == 10


def test_seeded_counts_come_back_correctly_bucketed(client: TestClient) -> None:
    request_meter.record("v2", status=200)
    request_meter.record("v2", status=200)
    request_meter.record("v2", status=429, rate_limited=True)
    request_meter.record("v1", status=200)
    request_meter.record("v2", status=500, error=True)

    resp = client.get("/api/v1/meter")
    body = resp.json()
    assert body["v2_today"] == 4
    assert body["v1_today"] == 1
    assert body["rate_limited_today"] == 1
    assert body["errors_today"] == 1
    assert body["v2_last_minute"] == 4
    assert body["v2_last_hour"] == 4


def test_budget_per_day_is_null_when_unset_and_the_int_when_set(
    client: TestClient,
) -> None:
    assert client.get("/api/v1/meter").json()["budget_per_day"] is None

    cfg = load_config()
    cfg.request_budget_per_day = 5000
    save_config(cfg)

    assert client.get("/api/v1/meter").json()["budget_per_day"] == 5000


def test_the_route_itself_never_counts_as_a_request(client: TestClient) -> None:
    """A meter that counts its own reads is worse than no meter (§10.2/T21) —
    the route makes zero upstream Govee calls, so polling it must never move
    v2_today."""
    first = client.get("/api/v1/meter").json()["v2_today"]
    assert first == 0
    second = client.get("/api/v1/meter").json()["v2_today"]
    assert second == 0

    # Prove the assertion actually distinguishes real traffic from route
    # reads, rather than the counter being broken/frozen: recording a real
    # request moves it, polling the route again does not move it further.
    request_meter.record("v2", status=200)
    after_real_request = client.get("/api/v1/meter").json()["v2_today"]
    assert after_real_request == 1
    still_one = client.get("/api/v1/meter").json()["v2_today"]
    assert still_one == 1
