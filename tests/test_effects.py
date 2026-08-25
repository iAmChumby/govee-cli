"""T09 — matrix studio backend: ``GET /effects/{file}`` and ``POST /effects``.

WEBUI_V3_SPEC.md §5.6/§8 (T09): the paint studio's "save as effect" flow must
validate through the exact same ``Effect.from_dict`` the CLI's own ``effect``
command uses (not a looser parallel check), plus segment-bounds checking
against the target device's ``ModelSpec``. Run entirely in mock mode,
mirroring ``tests/test_scenes_ledger.py``'s fixture pattern.

``scenes/`` is the real, repo-rooted effect library (unlike config/schedule/
ledger, ``SCENES_DIR`` is never redirected by mock mode — it's the actual
scene *library*, not per-run state), so every test that creates an effect
must clean its own file up afterward rather than leaving fixtures in the
real repo.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("GOVEE_WEBUI_MOCK", "1")
os.environ.setdefault("GOVEE_WEBUI_MOCK_LATENCY", "0-0")
os.environ.setdefault("GOVEE_WEBUI_SCHEDULER", "0")

from fastapi.testclient import TestClient  # noqa: E402

from govee_cli.scenes.effects import SCENES_DIR  # noqa: E402
from webui.api.main import create_app  # noqa: E402
from webui.api.mock import uninstall as uninstall_mock  # noqa: E402

BARS = "Light Bars"  # H6056: segment_count=15, ble_segment_count=6

# A name distinctive enough that it can never collide with a real scenes/*.json
# checked into the repo, and easy to spot (and delete) if cleanup ever fails.
_PREFIX = "zz-test-studio-effect"


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client
    uninstall_mock()


@pytest.fixture
def created_files():
    """Tracks every file this test's POSTs create so it can delete them after,
    regardless of the real (non-redirected) scenes/ directory."""
    slugs: list[str] = []
    yield slugs
    for slug in slugs:
        path = SCENES_DIR / f"{slug}.json"
        if path.exists():
            path.unlink()


def _valid_body(name: str, **overrides: object) -> dict:
    body = {
        "device": BARS,
        "name": name,
        "loop": True,
        "fps": 5,
        "segments": [
            {"id": 0, "keyframes": [
                {"t": 0, "color": "FF0000"}, {"t": 1000, "color": "00FF00"},
            ]},
            {"id": 1, "keyframes": [{"t": 0, "color": "0000FF"}]},
        ],
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------- POST /effects


def test_create_effect_round_trips_through_get(client: TestClient, created_files) -> None:
    resp = client.post("/api/v1/effects", json=_valid_body(f"{_PREFIX}-roundtrip"))
    assert resp.status_code == 200
    saved = resp.json()
    created_files.append(saved["file"])

    # Response matches GET /effects's list-item metadata shape.
    assert saved["name"] == f"{_PREFIX}-roundtrip"
    assert saved["fps"] == 5
    assert saved["loop"] is True
    assert saved["segments"] == 2
    assert saved["segment_ids"] == [0, 1]

    # And it is now a real, playable file: appears in the library listing...
    library = client.get("/api/v1/effects").json()["effects"]
    assert any(e["file"] == saved["file"] for e in library)

    # ...and GET /effects/{file} returns the full keyframe body, not just
    # metadata — genuinely new capability per §5.6.
    full = client.get(f"/api/v1/effects/{saved['file']}").json()
    assert full["name"] == f"{_PREFIX}-roundtrip"
    assert full["segments"][0]["keyframes"][0]["color"] == "FF0000"
    assert full["segments"][1]["id"] == 1


def test_create_effect_slug_collision_is_suffixed(client: TestClient, created_files) -> None:
    name = f"{_PREFIX}-collide"
    first = client.post("/api/v1/effects", json=_valid_body(name)).json()
    second = client.post("/api/v1/effects", json=_valid_body(name)).json()
    created_files.extend([first["file"], second["file"]])

    assert first["file"] != second["file"]
    assert second["file"].startswith(first["file"])


def test_get_unknown_effect_is_404(client: TestClient) -> None:
    resp = client.get("/api/v1/effects/does-not-exist-anywhere")
    assert resp.status_code == 404


# ------------------------------------------------------- POST /effects: 422s


def test_create_effect_malformed_body_rejected_by_same_validator_as_cli(
    client: TestClient,
) -> None:
    """A segment missing 'keyframes' is exactly what ``Effect.from_dict``
    (the CLI's own parser) raises a KeyError on — not a separate, looser
    schema-level check that might accept something the CLI would refuse to
    play."""
    body = _valid_body(f"{_PREFIX}-malformed", segments=[{"id": 0}])
    resp = client.post("/api/v1/effects", json=body)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "unprocessable_entity"


def test_create_effect_no_keyframes_rejected(client: TestClient) -> None:
    body = _valid_body(f"{_PREFIX}-empty-kf", segments=[{"id": 0, "keyframes": []}])
    resp = client.post("/api/v1/effects", json=body)
    assert resp.status_code == 422


def test_create_effect_segment_out_of_bounds_rejected(client: TestClient) -> None:
    """Light Bars (H6056) addresses at most 15 segments over cloud, 6 over
    BLE — segment 99 exceeds both, so bounds-checking must reject it
    regardless of which transport the create defaults to."""
    body = _valid_body(
        f"{_PREFIX}-oob",
        segments=[{"id": 99, "keyframes": [{"t": 0, "color": "FF0000"}]}],
    )
    resp = client.post("/api/v1/effects", json=body)
    assert resp.status_code == 422
    assert "99" in resp.json()["error"]["message"]


def test_create_effect_unknown_device_is_error(client: TestClient) -> None:
    resp = client.post("/api/v1/effects", json=_valid_body(
        f"{_PREFIX}-nodevice", device="Nonexistent Device Xyz",
    ))
    assert resp.status_code == 404
