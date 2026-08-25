"""T07 — playback ledger integration + group broadcast ledger writes.

Covers WEBUI_V3_SPEC.md §3.3/§3.5's playback rows directly against
:class:`PlaybackManager` (no HTTP layer needed — ``start_mock`` already
exercises the same start/finish/stop paths ``start_ble``/``start_cloud`` do),
plus ``groups.py``'s ``run_group_command`` broadcast through the full mock
sidecar, since that one needs the group-membership/config machinery a
TestClient already provides.
"""

from __future__ import annotations

import asyncio
import os
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from fastapi.testclient import TestClient  # noqa: E402

from govee_cli import ledger  # noqa: E402
from govee_cli.http_v2 import GoveeV2Error  # noqa: E402
from govee_cli.scenes.effects import Effect  # noqa: E402
from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402
from webui.api.playback import PlaybackManager  # noqa: E402

DEVICE = "AA:BB:CC:DD:EE:FF:00:11"


def _effect(*, loop: bool) -> Effect:
    """Two frames (t=0 red, t=100 green) at fps=10 — one frame per 100ms tick,
    short enough that a non-looping run finishes in ~0.1s of wall time."""
    return Effect.from_dict({
        "name": "test-effect", "fps": 10, "loop": loop,
        "segments": [{"id": 0, "keyframes": [
            {"t": 0, "color": "FF0000"},
            {"t": 100, "color": "00FF00"},
        ]}],
    })


@pytest.fixture(autouse=True)
def _isolated_ledger(tmp_path, monkeypatch):
    """Every test in this module gets its own throwaway ledger file, matching
    mock.py's own redirect pattern — never touch the real ~/.config file."""
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")


# --------------------------------------------------------------- PlaybackManager


async def test_start_records_effect_mode() -> None:
    mgr = PlaybackManager()
    mock_client = MagicMock()
    entry = await mgr.start_mock(
        "Bars", DEVICE, _effect(loop=True), mock_client, 10, "cloud"
    )
    assert entry.transport == "cloud"

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.mode == "effect"
    assert recorded.label == "test-effect"
    assert recorded.payload == {"effect_file": "test-effect", "transport": "cloud"}
    assert recorded.source == "webui"

    await mgr.stop(DEVICE)


async def test_natural_finish_downgrades_to_basic_with_last_frame_color() -> None:
    mgr = PlaybackManager()
    mock_client = MagicMock()
    await mgr.start_mock("Bars", DEVICE, _effect(loop=False), mock_client, 10, "ble")

    # The non-looping effect ends on its own; poll until the manager's
    # done-callback has removed it (that callback is where the ledger
    # downgrade happens, so its completion is what we're waiting on).
    for _ in range(100):
        if mgr.get(DEVICE) is None:
            break
        await asyncio.sleep(0.05)
    assert mgr.get(DEVICE) is None, "effect never finished naturally"

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.mode == "basic"
    assert recorded.label is None
    assert recorded.payload == {"color_rgb": [0, 255, 0]}  # the t=100 keyframe
    assert recorded.source == "webui"


async def test_user_initiated_stop_leaves_effect_mode_unchanged() -> None:
    mgr = PlaybackManager()
    mock_client = MagicMock()
    # loop=True so it would never finish naturally within the test's lifetime.
    await mgr.start_mock("Bars", DEVICE, _effect(loop=True), mock_client, 10, "ble")
    await asyncio.sleep(0.12)  # let it render at least one frame

    stopped = await mgr.stop(DEVICE)
    assert stopped is not None

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.mode == "effect"
    assert recorded.payload == {"effect_file": "test-effect", "transport": "ble"}


async def test_cloud_effect_aborted_by_transport_error_leaves_effect_mode_unchanged() -> None:
    """A non-looping effect that dies mid-run (cloud rate limit / API error)
    must NOT be treated as a natural finish — the runner never reached the
    last keyframe, so recording that colour would assert a device state that
    may never have existed. Regression for a bug where any task ending
    without the user calling stop() — including one that errored out on its
    very first frame — was recorded as if the effect had played to
    completion, fabricating ``mode=basic`` with the *final* keyframe's
    colour."""
    mgr = PlaybackManager()

    class _FailingClient:
        def set_segment_color(self, sku: str, device_id: str, segs: list[int],
                               r: int, g: int, b: int) -> None:
            raise GoveeV2Error("simulated transport failure")

    long_effect = Effect.from_dict({
        "name": "long-effect", "fps": 10, "loop": False,
        "segments": [{"id": 0, "keyframes": [
            {"t": 0, "color": "FF0000"},
            {"t": 5000, "color": "00FF00"},
        ]}],
    })
    await mgr.start_cloud("Bars", DEVICE, long_effect, _FailingClient(), "sku123", 10)

    for _ in range(100):
        if mgr.get(DEVICE) is None:
            break
        await asyncio.sleep(0.05)
    assert mgr.get(DEVICE) is None, "aborted task never finished"

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.mode == "effect"
    assert recorded.payload == {"effect_file": "long-effect", "transport": "cloud"}


async def test_ble_effect_ending_in_exception_leaves_effect_mode_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same principle as the cloud case, for the BLE runner: a disconnect or
    other exception mid-animation is not a natural finish."""
    import govee_cli.commands.effect as effect_module

    async def _raising_play(effect: Effect, mac: str, adapter: str,
                            timeout: float) -> None:
        raise RuntimeError("simulated BLE disconnect")

    monkeypatch.setattr(effect_module, "_play", _raising_play)

    mgr = PlaybackManager()
    await mgr.start_ble(
        "Bars", DEVICE, _effect(loop=False), "AA:BB:CC:DD:EE:FF", "hci0", 10.0, 10
    )

    for _ in range(100):
        if mgr.get(DEVICE) is None:
            break
        await asyncio.sleep(0.05)
    assert mgr.get(DEVICE) is None, "failed task never finished"

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.mode == "effect"
    assert recorded.payload == {"effect_file": "test-effect", "transport": "ble"}


async def test_starting_a_new_effect_stops_the_previous_one_first() -> None:
    """Belt-and-suspenders: the ledger should reflect whichever effect is
    actually playing, not a stale entry from one that got superseded."""
    mgr = PlaybackManager()
    mock_client = MagicMock()
    await mgr.start_mock("Bars", DEVICE, _effect(loop=True), mock_client, 10, "ble")
    second = Effect.from_dict({
        "name": "second", "fps": 10, "loop": True,
        "segments": [{"id": 0, "keyframes": [{"t": 0, "color": "0000FF"}]}],
    })
    await mgr.start_mock("Bars", DEVICE, second, mock_client, 10, "cloud")

    recorded = ledger.read_one(DEVICE)
    assert recorded is not None
    assert recorded.label == "second"
    assert recorded.payload == {"effect_file": "second", "transport": "cloud"}

    await mgr.stop(DEVICE)


# ------------------------------------------------------------------------ groups


@pytest.fixture()
def client():
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


BARS = "Light Bars"
BULB = "Bulb"
BARS_ID = "6D:19:DD:6E:86:46:44:0C"
BULB_ID = "82:1F:5C:E7:53:69:87:FA"


def _make_group(client: TestClient, name: str = "desk") -> None:
    created = client.post(
        "/api/v1/groups", json={"name": name, "devices": [BARS, BULB]}
    )
    assert created.status_code == 200


def test_group_run_records_one_ledger_entry_per_member_with_group_source(
    client: TestClient,
) -> None:
    _make_group(client)
    run = client.post("/api/v1/groups/desk/run", json={"command": "color 00FF00"})
    assert run.status_code == 200
    assert all(r["ok"] for r in run.json()["results"])

    for device_id in (BARS_ID, BULB_ID):
        entry = ledger.read_one(device_id)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.payload == {"color_rgb": [0, 255, 0]}
        assert entry.source == "group"


def test_group_run_power_off_records_off_with_group_source(
    client: TestClient,
) -> None:
    _make_group(client)
    run = client.post("/api/v1/groups/desk/run", json={"command": "power off"})
    assert run.status_code == 200

    for device_id in (BARS_ID, BULB_ID):
        entry = ledger.read_one(device_id)
        assert entry is not None
        assert entry.mode == "off"
        assert entry.payload is None
        assert entry.source == "group"


def test_group_run_brightness_only_does_not_touch_the_ledger(
    client: TestClient,
) -> None:
    _make_group(client)
    # Seed a running-scene-like entry first, exactly as §3.5 requires
    # brightness-only writes to leave alone.
    ledger.record_mode(BARS_ID, "diy", "sleep", {"diy_value": 4}, source="cli")

    run = client.post("/api/v1/groups/desk/run", json={"command": "brightness 40"})
    assert run.status_code == 200

    entry = ledger.read_one(BARS_ID)
    assert entry is not None
    assert entry.mode == "diy"
    assert entry.label == "sleep"
    assert entry.source == "cli"


def test_group_run_scene_verb_is_outside_this_tasks_mapping(
    client: TestClient,
) -> None:
    """Only the basic power/color/temp verbs get a group ledger write here —
    same mapping as devices.py's ``_record_ledger_mode``. A verb outside that
    mapping (scene, on a group whose members don't even share a scene
    library) must not raise and must not fabricate a ledger entry."""
    _make_group(client)
    before = ledger.read_one(BARS_ID)
    run = client.post("/api/v1/groups/desk/run", json={"command": "scene rainbow"})
    assert run.status_code == 200
    after = ledger.read_one(BARS_ID)
    assert after == before
