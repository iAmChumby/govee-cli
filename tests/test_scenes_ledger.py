"""Ledger writes from the scene/diy/music/snapshot/segments sidecar routes.

WEBUI_V3_SPEC.md §3.3 requires ``webui/api/routers/scenes.py``'s five mutating
routes to write the same ledger entry shape the CLI commands they parallel
already write (§3.3's CLI section, implemented by T03) — same mode, same
label-resolution rule, same payload shape, differing only in ``source``
("webui" here, "cli" there). This is a read-side gap fix (§1.1): before this,
applying a scene from the web console left the console unable to say what was
playing.

Run entirely in mock mode, mirroring ``tests/test_webui_api.py``'s fixture
pattern (module-scoped app, latency and scheduler disabled).
"""

from __future__ import annotations

import os
from typing import Any

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from govee_cli import ledger  # noqa: E402
from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

BARS = "Light Bars"
LAMP = "Shelf Lamp"

BARS_ID = "6D:19:DD:6E:86:46:44:0C"
LAMP_ID = "50:CE:E8:6E:80:C6:50:3F"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


def test_apply_scene_writes_ledger(client: TestClient) -> None:
    resp = client.put(f"/api/v1/devices/{BARS}/scenes", json={"name": "aurora"})
    assert resp.status_code == 200
    applied = resp.json()["applied"]

    entry = ledger.read_one(BARS_ID)
    assert entry is not None
    assert entry.mode == "scene"
    # The resolved scene name, never the numeric scene_id — matches scene.py's
    # CLI command exactly.
    assert entry.label == applied["name"]
    assert entry.payload == {
        "scene_id": applied["scene_id"], "param_id": applied["param_id"],
    }
    assert entry.source == "webui"


def test_apply_diy_writes_ledger(client: TestClient) -> None:
    # A signal-free, user-authored name on purpose: the ledger is the ONLY
    # record that this DIY scene is running (the device reports "" for
    # diyScene forever), and it has to round-trip a name the console can make
    # no sense of just as faithfully as a descriptive one. "madisonnnn" is a
    # real name off this project's own account.
    resp = client.put(f"/api/v1/devices/{LAMP}/diy", json={"name": "madisonnnn"})
    assert resp.status_code == 200
    applied = resp.json()["applied"]

    entry = ledger.read_one(LAMP_ID)
    assert entry is not None
    assert entry.mode == "diy"
    assert entry.label == applied["name"]
    assert entry.payload == {"diy_value": applied["value"]}
    assert entry.source == "webui"


def test_apply_snapshot_writes_ledger_with_resolved_name(client: TestClient) -> None:
    resp = client.put(f"/api/v1/devices/{LAMP}/snapshots", json={"name_or_id": "Cozy"})
    assert resp.status_code == 200
    applied = resp.json()["applied"]

    entry = ledger.read_one(LAMP_ID)
    assert entry is not None
    assert entry.mode == "snapshot"
    # Matched by name, so the label is the advertised option name, not a
    # "snapshot #N" fallback.
    assert entry.label == "Cozy"
    assert entry.payload == {"snapshot_value": applied["value"]}
    assert entry.source == "webui"


def test_apply_snapshot_by_raw_id_falls_back_to_numbered_label(
    client: TestClient,
) -> None:
    """A bare numeric id with no matching advertised option still gets a
    readable label — same fallback snapshot.py's CLI command uses."""
    resp = client.put(f"/api/v1/devices/{LAMP}/snapshots", json={"name_or_id": "99999"})
    assert resp.status_code == 200

    entry = ledger.read_one(LAMP_ID)
    assert entry is not None
    assert entry.mode == "snapshot"
    assert entry.label == "snapshot #99999"
    assert entry.payload == {"snapshot_value": 99999}


def test_apply_music_writes_ledger_with_mode_name_not_raw_int(
    client: TestClient,
) -> None:
    resp = client.put(
        f"/api/v1/devices/{LAMP}/music", json={"mode": "energic", "sensitivity": 80}
    )
    assert resp.status_code == 200

    entry = ledger.read_one(LAMP_ID)
    assert entry is not None
    assert entry.mode == "music"
    # The label is the per-model mode NAME, never the raw wire integer — the
    # same integer means a different mode on a different model (music.py's
    # own docstring warning), so the label must never be model-ambiguous.
    assert entry.label == "energic"
    assert isinstance(entry.payload, dict)
    assert entry.payload["sensitivity"] == 80
    assert isinstance(entry.payload["music_mode"], int)
    assert entry.source == "webui"


def test_apply_segments_writes_one_ledger_entry_for_color_and_brightness(
    client: TestClient,
) -> None:
    """One user action (color + brightness in a single call) must produce one
    ledger entry, not two — same as segments.py's CLI command."""
    resp = client.post(
        f"/api/v1/devices/{BARS}/segments",
        json={"segments": "0-2", "hex": "FF0000", "brightness": 40},
    )
    assert resp.status_code == 200

    entry = ledger.read_one(BARS_ID)
    assert entry is not None
    assert entry.mode == "segments"
    assert entry.label is None
    assert entry.payload == {
        "segments": [0, 1, 2], "rgb": [255, 0, 0], "brightness": 40,
    }
    assert entry.source == "webui"


def test_apply_segments_brightness_only(client: TestClient) -> None:
    resp = client.post(
        f"/api/v1/devices/{BARS}/segments", json={"segments": "all", "brightness": 55}
    )
    assert resp.status_code == 200

    entry = ledger.read_one(BARS_ID)
    assert entry is not None
    assert entry.mode == "segments"
    assert entry.payload is not None
    assert entry.payload["rgb"] is None
    assert entry.payload["brightness"] == 55


def test_apply_segments_ble_path_writes_ledger_too(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The CLI's segments.py records a ledger entry on its BLE branch too
    (source="cli") — not just the cloud branch. An unregistered ref that looks
    like a BLE MAC resolves with no ModelSpec and transport=BLE (per
    resolve_ref's fallback), which drives the sidecar's own BLE branch. The
    real GATT call is stubbed out; only the ledger side effect is under test
    here.
    """
    from webui.api.routers import scenes as scenes_router

    calls: list[tuple[Any, list[int], tuple[int, int, int]]] = []

    def fake_ble_paint(target: Any, segments: list[int],
                       rgb: tuple[int, int, int]) -> None:
        calls.append((target, segments, rgb))

    monkeypatch.setattr(scenes_router, "_ble_paint_segments", fake_ble_paint)

    ble_ref = "AA:BB:CC:11:22:33"
    resp = client.post(
        f"/api/v1/devices/{ble_ref}/segments",
        json={"segments": "0-1", "hex": "00FF00"},
    )
    assert resp.status_code == 200
    assert len(calls) == 1

    entry = ledger.read_one(ble_ref.upper())
    assert entry is not None
    assert entry.mode == "segments"
    assert entry.label is None
    assert entry.payload == {"segments": [0, 1], "rgb": [0, 255, 0], "brightness": None}
    assert entry.source == "webui"
