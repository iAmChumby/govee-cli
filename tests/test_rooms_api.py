"""T22 — room-scene routes: capture, list, delete, and restore across every
registered device.

No task in WEBUI_V3_SPEC.md's work breakdown wires ``rooms.router`` into
``webui/api/main.py`` — that's T24's ``include_router`` call, and T22's own
"Files:" line doesn't list ``main.py``. Per the hard "touch only your owned
files" rule, this test mounts the router into a standalone app rather than
going through ``webui.api.main.create_app()``, same pattern as
``tests/test_calibration.py`` and ``tests/test_meter_api.py``.

``mock.py``'s ``install()`` does not yet redirect ``room_scenes``' on-disk
paths either — that redirect is T24's job (its own "Files:" line names
``mock.py``, not this task's) — so, like ``test_meter_api.py`` does for
``request_meter``, this monkeypatches ``room_scenes.ROOM_SCENES_PATH`` /
``ROOM_SCENES_LOCK_PATH`` directly.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from govee_cli import ledger, room_scenes  # noqa: E402
from govee_cli.room_scenes import CapturedDevice  # noqa: E402
from webui.api.deps import Settings, TTLCache, WriteEcho  # noqa: E402
from webui.api.errors import install_error_handlers  # noqa: E402
from webui.api.mock import MOCK_DEVICES, MockV2  # noqa: E402
from webui.api.mock import install as install_mock  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.routers import rooms  # noqa: E402

BARS = "6D:19:DD:6E:86:46:44:0C"  # Light Bars, H6056 — starts on
LAMP = "50:CE:E8:6E:80:C6:50:3F"  # Shelf Lamp, H6022 — starts on
BULB = "82:1F:5C:E7:53:69:87:FA"  # Bulb, H6008 — starts off


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(room_scenes, "ROOM_SCENES_PATH", tmp_path / "room-scenes.json")
    monkeypatch.setattr(
        room_scenes, "ROOM_SCENES_LOCK_PATH", tmp_path / "room-scenes.json.lock"
    )

    install_mock()  # redirects config.json + the ledger into a seeded temp dir
    app = FastAPI()
    app.state.settings = Settings(mock=True, scheduler_enabled=False, port=6057)
    app.state.state_cache = TTLCache()
    app.state.write_echo = WriteEcho()
    app.state.mock_client = MockV2()
    app.state.v2_client = None
    app.include_router(rooms.router, prefix="/api/v1")
    install_error_handlers(app)
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


def _mock(client: TestClient) -> MockV2:
    return client.app.state.mock_client


def _spy(mock: MockV2, calls: list[str], *names: str) -> None:
    """Wrap named methods on the mock client so call order is observable —
    proves the route executes power-before-mode-before-brightness itself,
    not merely that plan_restore() emits steps in that order (already covered
    by tests/test_room_scenes.py)."""
    for name in names:
        original = getattr(mock, name)

        def make_wrapper(n: str, orig):
            def wrapper(*args, **kwargs):
                calls.append(n)
                return orig(*args, **kwargs)
            return wrapper

        setattr(mock, name, make_wrapper(name, original))


class TestCapture:
    def test_capture_writes_one_entry_per_registered_device(self, client) -> None:
        resp = client.post("/api/v1/rooms", json={"name": "Fresh"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["device_count"] == len(MOCK_DEVICES)
        # No ledger entries exist yet in a fresh mock — every device is unknown.
        assert body["unknown_count"] == len(MOCK_DEVICES)
        assert set(body["unknown"]) == {"Light Bars", "Shelf Lamp", "Bulb"}

        scene = room_scenes.read_scene("Fresh")
        assert scene is not None
        assert len(scene.devices) == len(MOCK_DEVICES)
        assert {d.mode for d in scene.devices} == {"unknown"}

    def test_device_with_no_ledger_entry_is_captured_as_unknown(self, client) -> None:
        ledger.record_mode(BARS, "basic", None, {"color_rgb": [51, 204, 255]},
                           source="webui")

        resp = client.post("/api/v1/rooms", json={"name": "One Known"})
        body = resp.json()
        assert "Light Bars" not in body["unknown"]
        assert set(body["unknown"]) == {"Shelf Lamp", "Bulb"}

        scene = room_scenes.read_scene("One Known")
        assert scene is not None
        bars = next(d for d in scene.devices if d.device_id == BARS)
        # mode/label/payload transcribed verbatim from the ledger entry...
        assert bars.mode == "basic"
        assert bars.payload == {"color_rgb": [51, 204, 255]}
        # ...while power/brightness/color come from live device state, which
        # the mock fixture seeds independently (colorRgb 0x33CCFF == 51,204,255).
        assert bars.power is True
        assert bars.color == [51, 204, 255]
        lamp = next(d for d in scene.devices if d.device_id == LAMP)
        assert lamp.mode == "unknown"
        assert lamp.label is None
        assert lamp.payload is None

    def test_unreadable_device_with_stale_ledger_entry_is_captured_as_unknown(
        self, client
    ) -> None:
        """A device that fails its live-state read at capture time must not be
        recorded as a confident power=False/brightness=0 paired with whatever
        mode the ledger last remembered — that combination is exactly the
        "confident-looking all-zero state" CLAUDE.md's honesty rule forbids,
        and restoring it later would send a real, fabricated brightness=0
        command to a device that may actually have been at full brightness.
        """
        ledger.record_mode(LAMP, "diy", "Sunrise Circuit", {"diy_value": 3},
                           source="webui")

        mock = _mock(client)
        real_get_state = mock.get_state

        def broken_get_state(sku, device_id):
            if device_id == LAMP:
                raise RuntimeError("simulated offline read failure")
            return real_get_state(sku, device_id)

        mock.get_state = broken_get_state
        try:
            resp = client.post("/api/v1/rooms", json={"name": "Offline"})
        finally:
            mock.get_state = real_get_state

        body = resp.json()
        assert "Shelf Lamp" in body["unknown"]

        scene = room_scenes.read_scene("Offline")
        assert scene is not None
        lamp = next(d for d in scene.devices if d.device_id == LAMP)
        # Not "diy" (the stale ledger entry) — and not a fabricated
        # power/brightness reading either.
        assert lamp.mode == "unknown"
        assert lamp.power is False
        assert lamp.brightness == 0

        # A scene built from this capture must restore inert for this device
        # (no client call, real brightness left untouched) rather than
        # replaying the fabricated zero.
        real_brightness_before = mock.state[LAMP]["brightness"]
        restore_resp = client.post("/api/v1/rooms/Offline/restore")
        results = {r["ref"]: r for r in restore_resp.json()["results"]}
        assert results["Shelf Lamp"]["skipped_reason"] == (
            "mode was unknown when this room scene was captured"
        )
        assert mock.state[LAMP]["brightness"] == real_brightness_before


class TestListAndDelete:
    def test_list_reports_summary_fields(self, client) -> None:
        client.post("/api/v1/rooms", json={"name": "Alpha"})
        ledger.record_mode(BARS, "off", None, None, source="webui")
        client.post("/api/v1/rooms", json={"name": "Beta"})

        resp = client.get("/api/v1/rooms")
        assert resp.status_code == 200
        names = {row["name"]: row for row in resp.json()["scenes"]}
        assert set(names) == {"Alpha", "Beta"}
        assert names["Alpha"]["device_count"] == len(MOCK_DEVICES)
        assert names["Alpha"]["unknown_count"] == len(MOCK_DEVICES)
        assert names["Beta"]["unknown_count"] == len(MOCK_DEVICES) - 1
        assert names["Alpha"]["created_at"]

    def test_delete_removes_scene_and_404s_on_missing(self, client) -> None:
        client.post("/api/v1/rooms", json={"name": "Gone Soon"})
        resp = client.delete("/api/v1/rooms/Gone Soon")
        assert resp.status_code == 204
        assert room_scenes.read_scene("Gone Soon") is None

        resp2 = client.delete("/api/v1/rooms/Gone Soon")
        assert resp2.status_code == 404

    def test_restore_of_unknown_scene_is_404(self, client) -> None:
        resp = client.post("/api/v1/rooms/Nope/restore")
        assert resp.status_code == 404


class TestRestore:
    def test_basic_device_restores_in_power_mode_brightness_order_and_writes_ledger(
        self, client
    ) -> None:
        device = CapturedDevice(
            device_id=BARS, model="H6056", power=True, brightness=77,
            color=[10, 20, 30], color_temp_k=None, mode="basic", label=None,
            payload={"color_rgb": [10, 20, 30]},
        )
        room_scenes.save_scene("Basic Restore", [device])

        mock = _mock(client)
        calls: list[str] = []
        _spy(mock, calls, "turn_on", "set_color", "set_brightness")

        resp = client.post("/api/v1/rooms/Basic Restore/restore")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert body["results"] == [{"ref": "Light Bars", "ok": True}]

        assert calls == ["turn_on", "set_color", "set_brightness"]

        state = mock.state[BARS]
        assert state["powerSwitch"] == 1
        assert state["colorRgb"] == (10 << 16) | (20 << 8) | 30
        assert state["brightness"] == 77

        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.payload == {"color_rgb": [10, 20, 30]}
        assert entry.source == "webui"

    def test_off_device_restores_power_only_no_brightness_call(self, client) -> None:
        device = CapturedDevice(
            device_id=LAMP, model="H6022", power=False, brightness=42,
            color=None, color_temp_k=None, mode="off", label=None, payload=None,
        )
        room_scenes.save_scene("Off Restore", [device])

        mock = _mock(client)
        calls: list[str] = []
        _spy(mock, calls, "turn_off", "set_brightness")

        resp = client.post("/api/v1/rooms/Off Restore/restore")
        body = resp.json()
        assert body["results"] == [{"ref": "Shelf Lamp", "ok": True}]
        assert calls == ["turn_off"]  # "off: power off, nothing else" (room_scenes.py)
        assert mock.state[LAMP]["powerSwitch"] == 0

        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "off"

    def test_diy_device_restores_by_label_then_brightness(self, client) -> None:
        device = CapturedDevice(
            device_id=LAMP, model="H6022", power=True, brightness=64,
            color=None, color_temp_k=None, mode="diy", label="Sunrise Circuit",
            payload={"diy_value": 1},
        )
        room_scenes.save_scene("DIY Restore", [device])

        resp = client.post("/api/v1/rooms/DIY Restore/restore")
        body = resp.json()
        assert body["ok"] is True
        assert body["results"] == [{"ref": "Shelf Lamp", "ok": True}]
        assert _mock(client).state[LAMP]["brightness"] == 64

        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "diy"
        assert entry.label == "Sunrise Circuit"
        assert entry.payload == {"diy_value": 1}

    def test_effect_and_unknown_devices_are_skipped_with_no_client_call(
        self, client
    ) -> None:
        effect_device = CapturedDevice(
            device_id=BARS, model="H6056", power=True, brightness=50,
            color=None, color_temp_k=None, mode="effect", label="keyframe show",
            payload=None,
        )
        unknown_device = CapturedDevice(
            device_id=LAMP, model="H6022", power=True, brightness=50,
            color=None, color_temp_k=None, mode="unknown", label=None, payload=None,
        )
        room_scenes.save_scene("Skips", [effect_device, unknown_device])

        mock = _mock(client)
        before_bars = dict(mock.state[BARS])
        before_lamp = dict(mock.state[LAMP])

        resp = client.post("/api/v1/rooms/Skips/restore")
        body = resp.json()
        assert body["ok"] is True

        by_ref = {r["ref"]: r for r in body["results"]}
        assert by_ref["Light Bars"]["skipped_reason"] == (
            "effects are live playback, not a device state"
        )
        assert by_ref["Shelf Lamp"]["skipped_reason"] == (
            "mode was unknown when this room scene was captured"
        )
        # No client call means no fixture mutation and no ledger write.
        assert mock.state[BARS] == before_bars
        assert mock.state[LAMP] == before_lamp
        assert ledger.read_one(BARS) is None
        assert ledger.read_one(LAMP) is None

    def test_a_failing_device_does_not_abort_the_rest(self, client) -> None:
        # "scene" mode with a payload missing its ids fails inside the scene
        # step — simulates a captured record that can no longer be replayed.
        broken = CapturedDevice(
            device_id=BARS, model="H6056", power=True, brightness=50,
            color=None, color_temp_k=None, mode="scene", label="Ghost Scene",
            payload={},
        )
        healthy = CapturedDevice(
            device_id=LAMP, model="H6022", power=True, brightness=88,
            color=[1, 2, 3], color_temp_k=None, mode="basic", label=None,
            payload={"color_rgb": [1, 2, 3]},
        )
        room_scenes.save_scene("Mixed", [broken, healthy])

        resp = client.post("/api/v1/rooms/Mixed/restore")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False

        by_ref = {r["ref"]: r for r in body["results"]}
        assert by_ref["Light Bars"]["ok"] is False
        assert "error" in by_ref["Light Bars"]
        assert by_ref["Shelf Lamp"]["ok"] is True
        assert "error" not in by_ref["Shelf Lamp"]

        # The failed device gets no ledger write (we don't know it actually
        # restored); the healthy one does.
        assert ledger.read_one(BARS) is None
        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "basic"
        assert _mock(client).state[LAMP]["brightness"] == 88

    def test_deregistered_device_is_refused_not_sent_over_ad_hoc_ble(
        self, client, monkeypatch
    ) -> None:
        """A room scene's device_id is written at capture time and can outlive
        that device's registration (removed, renamed, re-scanned). resolve_ref
        happily treats any MAC-shaped, no-longer-registered id as "an address
        someone just typed at the CLI" and falls back to driving it over real
        BLE (govee_cli.commands.group._apply_http_command's sibling,
        _apply_ble_command in devices.py, opens an actual bleak connection —
        nothing about it is mocked by GOVEE_WEBUI_MOCK). A stale captured
        device_id must never reach that function: this device is deregistered
        from the config after being captured, and the fix's device_cfg-is-None
        guard must refuse it before any command dispatch, not fall back to
        guessing a live BLE address.

        _apply_ble_command is monkeypatched to raise so this test cannot ever
        touch real hardware even if the guard regresses.
        """
        def _must_not_be_called(*args, **kwargs):
            raise AssertionError(
                "a stale/deregistered device_id must never reach _apply_ble_command "
                "(this would be a real BLE command in production)"
            )
        monkeypatch.setattr(rooms, "_apply_ble_command", _must_not_be_called)

        device = CapturedDevice(
            device_id=LAMP, model="H6022", power=True, brightness=50,
            color=[1, 2, 3], color_temp_k=None, mode="basic", label=None,
            payload={"color_rgb": [1, 2, 3]},
        )
        room_scenes.save_scene("Stale", [device])

        # Deregister the device after capture — same shape as a device being
        # removed, renamed, or re-scanned under a new cloud id. get_config()
        # reloads from disk on every call (no in-process caching), so the
        # on-disk (mock-redirected) config file has to be rewritten, not an
        # in-memory GoveeConfig mutated and discarded.
        from govee_cli import config as config_mod
        live_cfg = config_mod.load_config()
        del live_cfg.devices[LAMP]
        config_mod.save_config(live_cfg)

        resp = client.post("/api/v1/rooms/Stale/restore")
        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        result = body["results"][0]
        assert result["ok"] is False
        assert "no longer registered" in result["error"]
