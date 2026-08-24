"""End-to-end tests for the web console sidecar, run entirely in mock mode.

Every route gets a happy path and at least one error path. The app is built
once per module with latency and the embedded scheduler disabled so tests stay
fast and deterministic; mock.install() redirects all library writes to a temp
dir, so nothing here can touch real ~/.config/govee-cli files.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.deps import WriteEcho  # noqa: E402


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


BARS = "Light Bars"
LAMP = "Shelf Lamp"
BULB = "Bulb"


# --------------------------------------------------------------------- health


def test_health(client: TestClient) -> None:
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["mock"] is True
    assert body["scheduler"] is False


# ----------------------------------------------------------------- write echo


def test_write_echo_overlays_stale_reads() -> None:
    """A commanded value outranks lagging cloud reads until confirmed."""
    echo = WriteEcho()
    echo.record("dev", {"power": True, "brightness": 80})

    # Cloud still reports the pre-write state.
    stale = {"power": False, "brightness": 42, "color": None}
    overlaid = echo.overlay("dev", stale)
    assert overlaid["power"] is True
    assert overlaid["brightness"] == 80
    assert overlaid["color"] is None  # untouched fields pass through

    # Cloud catches up: the echo stands down.
    fresh = {"power": True, "brightness": 80}
    assert echo.overlay("dev", fresh) == fresh
    # ...and a later stale read is no longer corrected.
    assert echo.overlay("dev", stale)["power"] is False


def test_write_echo_clears_counterpart_field() -> None:
    """Setting color clears color_temp_k (mutually exclusive on hardware)."""
    echo = WriteEcho()
    echo.record("dev", {"color": {"hex": "#FF0000", "rgb": [255, 0, 0]},
                        "color_temp_k": None})
    state = {"color": None, "color_temp_k": 2700}
    overlaid = echo.overlay("dev", state)
    assert overlaid["color"] == {"hex": "#FF0000", "rgb": [255, 0, 0]}
    assert overlaid["color_temp_k"] is None


def test_write_echo_ttl_expiry() -> None:
    """After the TTL the device is trusted again, even without confirmation."""
    echo = WriteEcho(ttl=0.0)
    echo.record("dev", {"power": True})
    assert echo.overlay("dev", {"power": False})["power"] is False


def test_write_echo_is_per_device() -> None:
    echo = WriteEcho()
    echo.record("dev-a", {"power": True})
    assert echo.overlay("dev-b", {"power": False})["power"] is False


# -------------------------------------------------------------------- devices


def test_devices_list(client: TestClient) -> None:
    resp = client.get("/api/v1/devices")
    assert resp.status_code == 200
    devices = resp.json()["devices"]
    assert len(devices) == 3
    by_name = {d["name"]: d for d in devices}
    assert set(by_name) == {BARS, LAMP, BULB}
    lamp = by_name[LAMP]
    assert lamp["model"] == "H6022"
    assert lamp["transport"] == "cloud-v2"
    bulb = by_name[BULB]
    assert bulb["power"] is False
    assert bulb["color_temp_k"] == 2700


def test_device_detail(client: TestClient) -> None:
    resp = client.get(f"/api/v1/devices/{LAMP}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "50:CE:E8:6E:80:C6:50:3F"
    assert body["power"] is True
    assert body["brightness"] == 42
    assert body["color"]["hex"] == "#FF8800"
    caps = body["capabilities"]
    assert caps["segment_count_cloud"] == 15
    assert caps["music"] is True
    assert caps["segment_brightness"] is False
    bulb_caps = client.get(f"/api/v1/devices/{BULB}").json()["capabilities"]
    assert bulb_caps["segments"] is False
    assert bulb_caps["music"] is False


def test_device_state(client: TestClient) -> None:
    resp = client.get(f"/api/v1/devices/{LAMP}/state")
    assert resp.status_code == 200
    assert resp.json()["power"] is True
    assert "capabilities" in resp.json()


def test_unknown_ref_404(client: TestClient) -> None:
    resp = client.get("/api/v1/devices/Nope/state")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_discover(client: TestClient) -> None:
    resp = client.post("/api/v1/devices/discover", json={"sync": False})
    assert resp.status_code == 200
    found = resp.json()["devices"]
    assert {d["model"] for d in found} == {"H6056", "H6022", "H6008"}
    assert all(d["registered"] for d in found)


# ------------------------------------------------------------------- control


def test_power_cycle(client: TestClient) -> None:
    assert client.put(f"/api/v1/devices/{BULB}/power", json={"on": True}).status_code == 200
    state = client.get(f"/api/v1/devices/{BULB}/state").json()
    assert state["power"] is True
    assert client.put(f"/api/v1/devices/{BULB}/power", json={"on": False}).status_code == 200
    assert client.get(f"/api/v1/devices/{BULB}/state").json()["power"] is False


def test_brightness_and_color(client: TestClient) -> None:
    assert client.put(f"/api/v1/devices/{BARS}/brightness", json={"value": 77}).status_code == 200
    assert client.get(f"/api/v1/devices/{BARS}/state").json()["brightness"] == 77
    assert client.put(f"/api/v1/devices/{BARS}/color", json={"hex": "#00FF88"}).status_code == 200
    color = client.get(f"/api/v1/devices/{BARS}/state").json()["color"]
    assert color["rgb"] == [0, 255, 136]


def test_brightness_out_of_range_400(client: TestClient) -> None:
    resp = client.put(f"/api/v1/devices/{BARS}/brightness", json={"value": 0})
    assert resp.status_code == 400
    resp = client.put(f"/api/v1/devices/{BARS}/brightness", json={"value": 101})
    assert resp.status_code == 400


def test_bad_hex_400(client: TestClient) -> None:
    resp = client.put(f"/api/v1/devices/{BARS}/color", json={"hex": "#12345"})
    assert resp.status_code == 400


def test_temperature_bounds(client: TestClient) -> None:
    # H6008 accepts 2700-6500K.
    warmed = client.put(f"/api/v1/devices/{BULB}/temperature", json={"kelvin": 4000})
    assert warmed.status_code == 200
    assert client.get(f"/api/v1/devices/{BULB}/state").json()["color_temp_k"] == 4000
    resp = client.put(f"/api/v1/devices/{BULB}/temperature", json={"kelvin": 9000})
    assert resp.status_code == 400


def test_segments_happy_and_errors(client: TestClient) -> None:
    resp = client.post(
        f"/api/v1/devices/{BARS}/segments",
        json={"segments": "0-2", "hex": "FF0000"},
    )
    assert resp.status_code == 200
    out_of_range = client.post(
        f"/api/v1/devices/{BARS}/segments",
        json={"segments": [15], "hex": "FF0000"},
    )
    assert out_of_range.status_code == 400
    # Per-segment brightness exists on the bars but not on the lamp.
    ok = client.post(
        f"/api/v1/devices/{BARS}/segments",
        json={"segments": "all", "brightness": 30},
    )
    assert ok.status_code == 200
    rejected = client.post(
        f"/api/v1/devices/{LAMP}/segments", json={"segments": "all", "brightness": 30}
    )
    assert rejected.status_code == 409


# -------------------------------------------------------------------- scenes


def test_scenes_list_and_apply(client: TestClient) -> None:
    listing = client.get(f"/api/v1/devices/{BARS}/scenes")
    assert listing.status_code == 200
    scenes = listing.json()["scenes"]
    assert len(scenes) >= 60
    assert {"name", "param_id", "scene_id"} <= set(scenes[0])

    applied = client.put(f"/api/v1/devices/{BARS}/scenes", json={"name": "aurora"})
    assert applied.status_code == 200

    unknown = client.put(f"/api/v1/devices/{BARS}/scenes", json={"name": "does-not-exist"})
    assert unknown.status_code == 404


def test_diy(client: TestClient) -> None:
    listing = client.get(f"/api/v1/devices/{LAMP}/diy")
    assert listing.status_code == 200
    names = [s["name"] for s in listing.json()["scenes"]]
    assert "Rainbow Flow" in names
    applied = client.put(f"/api/v1/devices/{LAMP}/diy", json={"name": "rainbow flow"})
    assert applied.status_code == 200


def test_snapshots(client: TestClient) -> None:
    listing = client.get(f"/api/v1/devices/{LAMP}/snapshots")
    assert listing.status_code == 200
    assert listing.json()["snapshots"][0]["name"] == "Cozy"
    assert client.put(
        f"/api/v1/devices/{LAMP}/snapshots", json={"name_or_id": "Cozy"}
    ).status_code == 200


def test_music_modes_per_model(client: TestClient) -> None:
    bars = client.get(f"/api/v1/devices/{BARS}/music").json()
    assert len(bars["modes"]) == 8
    lamp = client.get(f"/api/v1/devices/{LAMP}/music").json()
    assert [m["key"] for m in lamp["modes"]] == ["rhythm", "rolling", "energic", "spectrum"]
    bulb = client.get(f"/api/v1/devices/{BULB}/music")
    assert bulb.status_code == 200
    assert bulb.json()["supported"] is False

    ok = client.put(
        f"/api/v1/devices/{LAMP}/music",
        json={"mode": "energic", "sensitivity": 80},
    )
    assert ok.status_code == 200
    wrong = client.put(f"/api/v1/devices/{LAMP}/music", json={"mode": "vivid"})
    assert wrong.status_code == 400


def test_toggles_verified_vs_advertised(client: TestClient) -> None:
    listing = client.get(f"/api/v1/devices/{BARS}/toggles")
    toggles = {t["instance"]: t["verified"] for t in listing.json()["toggles"]}
    assert toggles["gradientToggle"] is True
    assert toggles["dreamViewToggle"] is False

    ok = client.put(
        f"/api/v1/devices/{BARS}/toggles", json={"instance": "gradient", "on": True}
    )
    assert ok.status_code == 200
    # The advertised-but-unverified toggle reproduces the hardware rejection.
    rejected = client.put(
        f"/api/v1/devices/{BARS}/toggles",
        json={"instance": "dreamViewToggle", "on": True},
    )
    assert rejected.status_code == 409
    assert "DreamView" in rejected.json()["error"]["message"]


# -------------------------------------------------------------------- groups


def test_groups_crud_and_run(client: TestClient) -> None:
    created = client.post(
        "/api/v1/groups", json={"name": "desk", "devices": [BARS, BULB]}
    )
    assert created.status_code == 200

    listing = client.get("/api/v1/groups").json()["groups"]
    # Groups store resolved device ids, not display names.
    assert set(listing["desk"]) == {
        "6D:19:DD:6E:86:46:44:0C", "82:1F:5C:E7:53:69:87:FA",
    }
    assert "living-room" in listing

    state = client.get("/api/v1/groups/desk/state")
    assert state.status_code == 200
    members = state.json()["devices"]
    assert len(members) == 2

    run = client.post("/api/v1/groups/desk/run", json={"command": "brightness 25"})
    assert run.status_code == 200
    results = run.json()["results"]
    assert all(r["ok"] for r in results)
    for ref in (BARS, BULB):
        assert client.get(f"/api/v1/devices/{ref}/state").json()["brightness"] == 25

    assert client.delete("/api/v1/groups/desk").status_code == 200
    assert client.get("/api/v1/groups").json()["groups"].get("desk") is None


# ----------------------------------------------------------------- schedules


def test_schedules_crud_and_enable(client: TestClient) -> None:
    listing = client.get("/api/v1/schedules").json()["schedules"]
    assert {r["id"] for r in listing} >= {"a1b2c3d4", "e5f6a7b8"}

    created = client.post(
        "/api/v1/schedules",
        json={
            "name": "Sunset glow", "time": "18:45",
            "days": ["sat", "sun"], "command": "scene sunset", "device": LAMP,
        },
    )
    assert created.status_code == 200
    rule_id = created.json()["id"]

    patched = client.patch(f"/api/v1/schedules/{rule_id}", json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False

    bad_day = client.post(
        "/api/v1/schedules",
        json={"name": "x", "time": "10:00", "days": ["Funday"], "command": "power on"},
    )
    assert bad_day.status_code == 400

    assert client.delete(f"/api/v1/schedules/{rule_id}").status_code == 200
    assert client.delete(f"/api/v1/schedules/{rule_id}").status_code == 404


# -------------------------------------------------------------------- config


def test_config_redacted_and_patch(client: TestClient) -> None:
    body = client.get("/api/v1/config").json()
    assert body["api_key"].startswith("•••")
    assert body["api_key"].endswith("8899")
    assert "mock-key" not in body["api_key"]

    patched = client.patch("/api/v1/config", json={"default_timeout": 12.5})
    assert patched.status_code == 200
    assert client.get("/api/v1/config").json()["default_timeout"] == 12.5


def test_config_device_registry(client: TestClient) -> None:
    # Every supported model is cloud-routed, so the registry needs the 8-octet
    # cloud id form — a 6-octet MAC is rejected exactly like the CLI rejects it.
    six_octet = client.post(
        "/api/v1/config/devices",
        json={"mac": "AA:BB:CC:DD:EE:FF", "model": "H6183", "name": "Test Strip"},
    )
    assert six_octet.status_code == 400

    registered = client.post(
        "/api/v1/config/devices",
        json={"mac": "AA:BB:CC:DD:EE:FF:11:22", "model": "H6183", "name": "Test Strip"},
    )
    assert registered.status_code == 200

    devices = client.get("/api/v1/config").json()["devices"]
    assert devices["AA:BB:CC:DD:EE:FF:11:22"]["name"] == "Test Strip"

    removed = client.delete("/api/v1/config/devices/AA:BB:CC:DD:EE:FF:11:22")
    assert removed.status_code == 200


# ------------------------------------------------------------------- effects


def test_effects_library_play_stop(client: TestClient) -> None:
    library = client.get("/api/v1/effects").json()["effects"]
    assert {e["file"] for e in library} >= {"ocean", "party", "sunrise"}

    play = client.post(
        "/api/v1/effects/play", json={"device": BARS, "file": "ocean"}
    )
    assert play.status_code == 200
    playing = client.get("/api/v1/effects/playing").json()
    assert any(p["device"] == BARS for p in playing)

    stopped = client.delete(f"/api/v1/effects/playing/{BARS}")
    assert stopped.status_code == 200
    again = client.delete(f"/api/v1/effects/playing/{BARS}")
    assert again.status_code == 404

    unknown = client.post("/api/v1/effects/play", json={"device": BARS, "file": "nope"})
    assert unknown.status_code == 404
