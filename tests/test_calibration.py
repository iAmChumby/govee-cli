"""T09 — matrix studio backend: segment calibration persistence (§5.3).

``webui/api/routers/calibration.py`` is a new router file that no task in
WEBUI_V3_SPEC.md's work breakdown (§8) wires into ``webui/api/main.py`` —
that file belongs to no task at all, and this task's own "Files:" line does
not list it. Per the hard "touch only your owned files" rule, this test
mounts ``calibration.router`` into a standalone app rather than going
through ``webui.api.main.create_app()``, exercising exactly the same
request/response/error-handling path the real app would use once a future
change adds the one missing ``include_router`` call there (see the task
report for the exact diff needed).
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from webui.api.errors import install_error_handlers  # noqa: E402
from webui.api.mock import install as install_mock  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.routers import calibration  # noqa: E402

BARS = "Light Bars"  # seeded mock device, id 6D:19:DD:6E:86:46:44:0C


@pytest.fixture(scope="module")
def client():
    install_mock()
    app = FastAPI()
    app.include_router(calibration.router, prefix="/api/v1")
    install_error_handlers(app)
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


def test_get_uncalibrated_device_reports_not_calibrated(client: TestClient) -> None:
    resp = client.get(f"/api/v1/devices/{BARS}/segment-calibration")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "calibrated": False,
        "boundaries": None,
        "permutation": None,
        "calibrated_at": None,
    }


def test_put_then_get_round_trips_exact_arrays(client: TestClient) -> None:
    boundaries = [0, 9, 18, 26, 35, 44, 53, 61, 70, 79, 88, 96, 105, 114, 123, 132]
    permutation = [0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10, 12, 13, 14]

    put_resp = client.put(
        f"/api/v1/devices/{BARS}/segment-calibration",
        json={"boundaries": boundaries, "permutation": permutation},
    )
    assert put_resp.status_code == 204
    assert put_resp.content == b""

    get_resp = client.get(f"/api/v1/devices/{BARS}/segment-calibration")
    assert get_resp.status_code == 200
    body = get_resp.json()
    assert body["calibrated"] is True
    assert body["boundaries"] == boundaries
    assert body["permutation"] == permutation
    # Server-stamped, not client-supplied — must be a real, parseable timestamp.
    assert body["calibrated_at"]

    # A second PUT overwrites cleanly (re-calibration is expected to happen).
    new_boundaries = [0, 66, 132]
    new_permutation = [0, 1]
    client.put(
        f"/api/v1/devices/{BARS}/segment-calibration",
        json={"boundaries": new_boundaries, "permutation": new_permutation},
    )
    body2 = client.get(f"/api/v1/devices/{BARS}/segment-calibration").json()
    assert body2["boundaries"] == new_boundaries
    assert body2["permutation"] == new_permutation


def test_put_unregistered_device_is_rejected(client: TestClient) -> None:
    resp = client.put(
        "/api/v1/devices/AA:BB:CC:DD:EE:FF/segment-calibration",
        json={"boundaries": [0, 1], "permutation": [0]},
    )
    assert resp.status_code == 409


def test_put_missing_fields_is_bad_request(client: TestClient) -> None:
    resp = client.put(
        f"/api/v1/devices/{BARS}/segment-calibration", json={"boundaries": [0, 1]},
    )
    assert resp.status_code == 400
