"""Tests for the sidecar's read-side ledger merge (WEBUI_V3_SPEC.md §3.6).

Two layers:

- Pure unit tests of ``deps.overlay_active_mode()`` against a freshly redirected
  ledger file, one per merge rule — the fastest and most precise way to pin
  down the five-rule priority order, including the ``online: False`` case no
  mock fixture can otherwise produce (every seeded mock device is online).
- A handful of end-to-end tests through the real FastAPI app (mock mode) that
  prove the wiring in ``routers/devices.py`` actually calls the merge and the
  ledger write-through in ``_basic_control``, so a route-level regression
  (forgetting to call ``overlay_active_mode`` or ``ledger.record_mode``)
  would be caught even if the pure unit tests above stayed green.
"""

from __future__ import annotations

import json
import os
import pathlib

import pytest
from fastapi.testclient import TestClient

from govee_cli import ledger
from govee_cli.config import GoveeConfig
from webui.api.deps import Resolved, overlay_active_mode

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

DEVICE_ID = "50:CE:E8:6E:80:C6:50:3F"


@pytest.fixture()
def isolated_ledger(tmp_path: pathlib.Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the ledger at a scratch file for one test, independent of any
    mock app's own redirected temp dir."""
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")


def _target(model: str = "H6022") -> Resolved:
    return Resolved(
        device_id=DEVICE_ID, model=model, transport="cloud-v2",
        config=GoveeConfig(), device_cfg=None,
    )


# ------------------------------------------------------------ pure-function


def test_rule1_offline_is_unknown_even_with_a_ledger_entry(isolated_ledger: None) -> None:
    ledger.record_mode(DEVICE_ID, "diy", "sleep", {"diy_value": 4}, source="cli")
    state = {"online": False, "power": True, "brightness": 50}
    active = overlay_active_mode(_target(), state)["active"]
    assert active == {
        "mode": "unknown", "label": None, "confidence": "unknown",
        "source": None, "set_at": None, "age_seconds": None,
    }


def test_rule2_power_false_overrides_a_stale_scene_entry(isolated_ledger: None) -> None:
    """Power is the one thing cloud state proves outright — it wins even when
    the ledger still claims a scene is running (e.g. turned off from the
    phone app mid-DIY)."""
    ledger.record_mode(DEVICE_ID, "diy", "sleep", {"diy_value": 4}, source="cli")
    state = {"online": True, "power": False, "brightness": 0}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "off"
    assert active["confidence"] == "confirmed"
    assert active["label"] is None
    # The stale diy entry is contradicted, not trusted for source/set_at either.
    assert active["source"] is None
    assert active["set_at"] is None


def test_rule2_power_false_uses_the_off_entrys_own_metadata(isolated_ledger: None) -> None:
    """When the ledger's own mode really is 'off', its source/set_at carry
    through instead of being discarded."""
    ledger.record_mode(DEVICE_ID, "off", None, None, source="schedule")
    state = {"online": True, "power": False}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "off"
    assert active["confidence"] == "confirmed"
    assert active["source"] == "schedule"
    assert active["set_at"] is not None
    assert isinstance(active["age_seconds"], int)


def test_rule3_non_basic_mode_returned_verbatim_and_never_upgraded(
    isolated_ledger: None,
) -> None:
    ledger.record_mode(
        DEVICE_ID, "diy", "sleep", {"diy_value": 4}, source="cli"
    )
    state = {"online": True, "power": True, "brightness": 65,
              "color": None, "color_temp_k": 2700}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "diy"
    assert active["label"] == "sleep"
    assert active["confidence"] == "assumed"
    assert active["source"] == "cli"
    assert isinstance(active["age_seconds"], int)
    assert active["age_seconds"] >= 0


def test_rule3_malformed_set_at_degrades_to_null_age_not_a_crash(
    isolated_ledger: None,
) -> None:
    """A hand-edited or corrupted ledger file can carry a non-string ``set_at``
    (JSON ``null``, a number) — ``_entry_from_dict`` only guards against
    missing keys, not wrong types. That must degrade to ``age_seconds: None``
    like every other malformed-input path here, not raise ``TypeError`` and
    501 a state read."""
    ledger.LEDGER_PATH.write_text(json.dumps({
        "version": 1,
        "devices": {
            DEVICE_ID: {
                "mode": "diy", "label": "sleep", "payload": {"diy_value": 4},
                "source": "cli", "set_at": None,
            }
        },
    }))
    state = {"online": True, "power": True}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "diy"
    assert active["age_seconds"] is None


@pytest.mark.parametrize(
    "mode", ["scene", "diy", "music", "snapshot", "segments", "effect"]
)
def test_rule3_covers_every_unverifiable_mode(isolated_ledger: None, mode: str) -> None:
    ledger.record_mode(DEVICE_ID, mode, "whatever", None, source="cli")  # type: ignore[arg-type]
    state = {"online": True, "power": True}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == mode
    assert active["confidence"] == "assumed"


def test_rule4_basic_mode_match_is_confirmed(isolated_ledger: None) -> None:
    ledger.record_mode(
        DEVICE_ID, "basic", None, {"color_rgb": [255, 136, 0]}, source="webui"
    )
    state = {"online": True, "power": True,
             "color": {"hex": "#FF8800", "rgb": [255, 136, 0]}, "color_temp_k": None}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "basic"
    assert active["confidence"] == "confirmed"


def test_rule4_basic_mode_divergence_is_external(isolated_ledger: None) -> None:
    """The one case drift can be detected: live color disagrees with what we
    last commanded, and nothing explains the gap — the phone-app case."""
    ledger.record_mode(
        DEVICE_ID, "basic", None, {"color_rgb": [255, 136, 0]}, source="webui"
    )
    state = {"online": True, "power": True,
             "color": {"hex": "#00FF00", "rgb": [0, 255, 0]}, "color_temp_k": None}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "basic"
    assert active["confidence"] == "external"
    # The merge only touches the `active` block — the state's own live color
    # is left exactly as read, never silently replaced by the stale payload.
    result = overlay_active_mode(_target(), state)
    assert result["color"]["rgb"] == [0, 255, 0]


def test_rule4_basic_mode_temp_divergence_is_external(isolated_ledger: None) -> None:
    ledger.record_mode(DEVICE_ID, "basic", None, {"color_temp_k": 4000}, source="cli")
    state = {"online": True, "power": True, "color": None, "color_temp_k": 2700}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["confidence"] == "external"


def test_rule4_bare_power_on_payload_none_is_trivially_confirmed(
    isolated_ledger: None,
) -> None:
    ledger.record_mode(DEVICE_ID, "basic", None, None, source="webui")
    state = {"online": True, "power": True, "color": None, "color_temp_k": 2700}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["confidence"] == "confirmed"


def test_rule5_no_entry_at_all_is_unknown_never_basic(isolated_ledger: None) -> None:
    state = {"online": True, "power": True, "brightness": 50,
             "color": {"hex": "#FFFFFF", "rgb": [255, 255, 255]}, "color_temp_k": None}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "unknown"
    assert active["confidence"] == "unknown"


def test_rule5_explicit_unknown_mode_entry_is_unknown(isolated_ledger: None) -> None:
    ledger.record_mode(DEVICE_ID, "unknown", None, None, source="cli")
    state = {"online": True, "power": True}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "unknown"
    assert active["confidence"] == "unknown"


def test_power_unreadable_is_unknown(isolated_ledger: None) -> None:
    """BLE devices with no readable state (power is None, not True/False) —
    nothing downstream can be claimed, same as the offline case."""
    ledger.record_mode(DEVICE_ID, "diy", "sleep", {"diy_value": 4}, source="cli")
    state = {"online": None, "power": None}
    active = overlay_active_mode(_target(), state)["active"]
    assert active["mode"] == "unknown"
    assert active["confidence"] == "unknown"


# --------------------------------------------------------------- end-to-end


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


LAMP = "Shelf Lamp"


def test_state_response_carries_active_block(client: TestClient) -> None:
    resp = client.get(f"/api/v1/devices/{LAMP}/state")
    assert resp.status_code == 200
    body = resp.json()
    assert "active" in body
    assert body["active"]["mode"] in ("unknown", "off", "basic")


def test_devices_list_items_carry_active_block(client: TestClient) -> None:
    resp = client.get("/api/v1/devices")
    assert resp.status_code == 200
    for device in resp.json()["devices"]:
        assert "active" in device


def test_power_off_writes_off_and_reads_back_confirmed(client: TestClient) -> None:
    client.put(f"/api/v1/devices/{LAMP}/power", json={"on": False})
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["power"] is False
    assert state["active"]["mode"] == "off"
    assert state["active"]["confidence"] == "confirmed"
    assert state["active"]["source"] == "webui"
    client.put(f"/api/v1/devices/{LAMP}/power", json={"on": True})


def test_color_write_reads_back_basic_confirmed(client: TestClient) -> None:
    client.put(f"/api/v1/devices/{LAMP}/power", json={"on": True})
    client.put(f"/api/v1/devices/{LAMP}/color", json={"hex": "#123456"})
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["active"]["mode"] == "basic"
    assert state["active"]["confidence"] == "confirmed"
    assert state["active"]["source"] == "webui"


def test_brightness_alone_does_not_disturb_an_active_scene(client: TestClient) -> None:
    """§3.5: brightness-only writes never call record_mode — a scene the
    sidecar itself doesn't yet write (scenes.py is a different task's file)
    is simulated here by seeding the ledger directly."""
    ledger.record_mode(
        "50:CE:E8:6E:80:C6:50:3F", "diy", "sleep", {"diy_value": 4}, source="cli"
    )
    client.put(f"/api/v1/devices/{LAMP}/brightness", json={"value": 33})
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["brightness"] == 33
    assert state["active"]["mode"] == "diy"
    assert state["active"]["label"] == "sleep"


def test_delete_active_mode_clears_it(client: TestClient) -> None:
    ledger.record_mode(
        "50:CE:E8:6E:80:C6:50:3F", "diy", "sleep", {"diy_value": 4}, source="cli"
    )
    resp = client.delete(f"/api/v1/devices/{LAMP}/active-mode")
    assert resp.status_code == 204
    state = client.get(f"/api/v1/devices/{LAMP}/state").json()
    assert state["active"]["mode"] == "unknown"
    assert state["active"]["confidence"] == "unknown"


def test_delete_active_mode_on_a_device_with_no_entry_is_still_204(
    client: TestClient,
) -> None:
    resp = client.delete(f"/api/v1/devices/{LAMP}/active-mode")
    assert resp.status_code == 204


def test_capabilities_carry_matrix_geometry(client: TestClient) -> None:
    lamp_caps = client.get(f"/api/v1/devices/{LAMP}").json()["capabilities"]
    assert lamp_caps["matrix_rows"] == 11
    assert lamp_caps["matrix_cols"] == 12
    assert lamp_caps["matrix_wrap_col"] is True

    bars_caps = client.get("/api/v1/devices/Light Bars").json()["capabilities"]
    assert bars_caps["matrix_rows"] == 2
    assert bars_caps["matrix_cols"] == 48
    assert bars_caps["matrix_wrap_col"] is False
