"""Tests for `PUT /devices/{ref}/active-mode` (WEBUI_V3_SPEC.md §10, T23).

The load-bearing property under test: this route corrects the ledger's
record of reality, it does not touch the device. Every test that exercises
the route through the mock app also asserts on ``MockV2.control`` — the
single funnel all of its write methods route through (mock.py:219) — to
prove no command reached the (simulated) light.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

LAMP = "Shelf Lamp"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


def test_put_diy_mode_reads_back_assumed(client: TestClient) -> None:
    resp = client.put(
        f"/api/v1/devices/{LAMP}/active-mode",
        json={"mode": "diy", "label": "sleep"},
    )
    assert resp.status_code == 200, resp.text

    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["active"]["mode"] == "diy"
    assert state["active"]["label"] == "sleep"
    # Rule 3 (§3.6): a cloud-unverifiable mode never rises above "assumed",
    # even freshly corrected by hand — a manual correction is still not
    # something the cloud API can confirm mid-playback.
    assert state["active"]["confidence"] == "assumed"


def test_put_response_carries_the_merged_active_block_directly(
    client: TestClient,
) -> None:
    """The PUT's own response must carry the corrected state — the whole
    point is letting the client render it without a second round trip."""
    resp = client.put(
        f"/api/v1/devices/{LAMP}/active-mode",
        json={"mode": "scene", "label": "sunset"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["active"]["mode"] == "scene"
    assert body["active"]["label"] == "sunset"
    assert body["active"]["confidence"] == "assumed"
    assert body["active"]["source"] == "webui"


def test_put_basic_mode_with_matching_payload_reads_back_confirmed(
    client: TestClient,
) -> None:
    """Shelf Lamp's mock fixture starts on colorRgb 0xFF8800 = (255, 136, 0) —
    a "basic" correction whose payload matches live state has nothing to
    diverge from, so it reads back confirmed (§3.6 rule 4)."""
    resp = client.put(
        f"/api/v1/devices/{LAMP}/active-mode",
        json={"mode": "basic", "payload": {"color_rgb": [255, 136, 0]}},
    )
    assert resp.status_code == 200
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["active"]["mode"] == "basic"
    assert state["active"]["confidence"] == "confirmed"


def test_invalid_mode_is_rejected_not_silently_coerced(client: TestClient) -> None:
    """An out-of-vocabulary ``mode`` must be a pydantic validation failure, not
    a value that quietly lands in the ledger.

    T23's spec text says this is "422 from pydantic" — but every
    ``RequestValidationError`` in this app is already remapped to 400 by the
    app-wide handler in ``errors.py`` (a file this task does not own and must
    not touch, and whose "pin bad input at 400" contract every other route's
    tests rely on). What's actually load-bearing is that pydantic's
    Literal[Mode] validation rejects it before ``ledger.record_mode`` ever
    runs — asserted below by checking no ledger entry was written — so this
    test pins the app's real, consistent behaviour (400) instead of a status
    code the rest of the sidecar does not produce.
    """
    from govee_cli import ledger

    before = ledger.read_one("50:CE:E8:6E:80:C6:50:3F")

    resp = client.put(
        f"/api/v1/devices/{LAMP}/active-mode",
        json={"mode": "not-a-real-mode"},
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "bad_request"
    # The rejected write must never reach record_mode — whatever the ledger
    # held before this request (from an earlier test in this module) is
    # exactly what it holds after.
    assert ledger.read_one("50:CE:E8:6E:80:C6:50:3F") == before


def test_no_control_call_reaches_the_mock_client(client: TestClient) -> None:
    """The load-bearing assertion: correcting the ledger must never command
    the device. ``MockV2.control`` (mock.py:219) is the one method every
    write path — turn_on/off, set_brightness, set_color, set_scene, etc. —
    funnels through, so spying on it alone is sufficient to prove none of
    them ran.
    """
    mock_client = client.app.state.mock_client
    with patch.object(
        mock_client, "control", wraps=mock_client.control
    ) as spy_control:
        resp = client.put(
            f"/api/v1/devices/{LAMP}/active-mode",
            json={"mode": "diy", "label": "sleep", "payload": {"diy_value": 4}},
        )
        assert resp.status_code == 200
        spy_control.assert_not_called()

        # The state read the merge needs is still allowed — only *control*
        # is forbidden. get_state must not be confused with a command.
        client.get(f"/api/v1/devices/{LAMP}/state")
        spy_control.assert_not_called()


def test_existing_delete_active_mode_route_is_unchanged(client: TestClient) -> None:
    """T23's contract: 'The existing DELETE .../active-mode stays exactly as
    it is.' A quick regression check that PUT's addition didn't disturb it."""
    client.put(
        f"/api/v1/devices/{LAMP}/active-mode",
        json={"mode": "diy", "label": "sleep"},
    )
    resp = client.delete(f"/api/v1/devices/{LAMP}/active-mode")
    assert resp.status_code == 204
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["active"]["mode"] == "unknown"
