"""Tests for the Govee Open API v2 client.

Payload shapes here are not guesses — each one was verified against the live API
and the device. The wrong shape is silently accepted in some cases and rejected
in others, so these tests pin the forms that actually worked.
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from govee_cli.http_v2 import (
    CAP_COLOR,
    CAP_DYNAMIC_SCENE,
    CAP_MUSIC,
    CAP_SEGMENT,
    DIYScene,
    GoveeHTTPv2,
    GoveeV2Error,
    Scene,
    V2Device,
    Capability,
    _slug,
)

SKU = "H6022"
DEVICE = "50:CE:E8:6E:80:C6:50:3F"


def _ok(payload: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"code": 200, "msg": "success", **(payload or {})}
    return resp


@pytest.fixture
def client() -> GoveeHTTPv2:
    return GoveeHTTPv2(api_key="test-key")


class TestControlPayloads:
    def test_color_is_packed_into_a_single_int(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_color(SKU, DEVICE, 0x12, 0x34, 0x56)
        capability = req.call_args.kwargs["json"]["payload"]["capability"]
        assert capability["type"] == CAP_COLOR
        assert capability["instance"] == "colorRgb"
        assert capability["value"] == 0x123456

    def test_segment_color_sends_an_array_of_indices(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_segment_color(SKU, DEVICE, [0, 3, 7], 255, 0, 0)
        capability = req.call_args.kwargs["json"]["payload"]["capability"]
        assert capability["type"] == CAP_SEGMENT
        assert capability["value"] == {"segment": [0, 3, 7], "rgb": 0xFF0000}

    def test_scene_sends_both_ids(self, client: GoveeHTTPv2) -> None:
        # A scene needs paramId AND id; sending one alone does not select it.
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_scene(SKU, DEVICE, Scene("Rainbow", param_id=18595, scene_id=11275))
        capability = req.call_args.kwargs["json"]["payload"]["capability"]
        assert capability["type"] == CAP_DYNAMIC_SCENE
        assert capability["instance"] == "lightScene"
        assert capability["value"] == {"paramId": 18595, "id": 11275}

    def test_diy_scene_value_is_bare_not_wrapped(self, client: GoveeHTTPv2) -> None:
        # Verified: {"value": n} is rejected with "Missing relevant parameters: id".
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_diy_scene(SKU, DEVICE, 22391958)
        capability = req.call_args.kwargs["json"]["payload"]["capability"]
        assert capability["value"] == 22391958

    def test_music_mode_omits_optional_fields_when_unset(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_music_mode(SKU, DEVICE, 3, 50)
        value = req.call_args.kwargs["json"]["payload"]["capability"]["value"]
        assert value == {"musicMode": 3, "sensitivity": 50}

    def test_music_mode_includes_optional_fields_when_set(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_music_mode(SKU, DEVICE, 5, 80, auto_color=False, rgb=0xFF0066)
        value = req.call_args.kwargs["json"]["payload"]["capability"]["value"]
        assert value == {
            "musicMode": 5, "sensitivity": 80, "autoColor": 0, "rgb": 0xFF0066,
        }
        assert req.call_args.kwargs["json"]["payload"]["capability"]["type"] == CAP_MUSIC

    def test_power_uses_one_and_zero(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.turn_on(SKU, DEVICE)
        assert req.call_args.kwargs["json"]["payload"]["capability"]["value"] == 1
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.turn_off(SKU, DEVICE)
        assert req.call_args.kwargs["json"]["payload"]["capability"]["value"] == 0

    def test_every_request_carries_a_request_id(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()) as req:
            client.set_brightness(SKU, DEVICE, 50)
        assert req.call_args.kwargs["json"]["requestId"]


class TestStateParsing:
    def test_state_flattens_capabilities_to_instance_value(self, client: GoveeHTTPv2) -> None:
        resp = _ok({
            "payload": {"capabilities": [
                {"type": "x", "instance": "powerSwitch", "state": {"value": 1}},
                {"type": "x", "instance": "brightness", "state": {"value": 80}},
                {"type": "x", "instance": "colorTemperatureK", "state": {"value": 3000}},
            ]}
        })
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            state = client.get_state(SKU, DEVICE)
        assert state == {"powerSwitch": 1, "brightness": 80, "colorTemperatureK": 3000}

    def test_empty_scene_state_is_preserved_not_dropped(self, client: GoveeHTTPv2) -> None:
        # The device reports "" for scene/segment/music. Callers must be able to
        # tell "reported empty" from "not present".
        resp = _ok({
            "payload": {"capabilities": [
                {"instance": "lightScene", "state": {"value": ""}},
            ]}
        })
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            assert client.get_state(SKU, DEVICE) == {"lightScene": ""}


class TestErrorHandling:
    def test_non_200_body_code_raises(self, client: GoveeHTTPv2) -> None:
        resp = MagicMock()
        resp.status_code = 400
        resp.json.return_value = {"code": 400, "msg": "devices not support this instance"}
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            with pytest.raises(GoveeV2Error, match="not support this instance"):
                client.set_brightness(SKU, DEVICE, 50)

    def test_retries_then_succeeds_on_429(self, client: GoveeHTTPv2) -> None:
        limited = MagicMock()
        limited.status_code = 429
        limited.text = "Too Many Requests"
        with patch("govee_cli.http_v2.requests.request",
                   side_effect=[limited, _ok()]) as req:
            with patch("govee_cli.http_v2.time.sleep"):
                client.set_brightness(SKU, DEVICE, 50)
        assert req.call_count == 2

    def test_exhausted_429_raises_rate_limited(self, client: GoveeHTTPv2) -> None:
        from govee_cli.http_v2 import GoveeV2RateLimited

        limited = MagicMock()
        limited.status_code = 429
        limited.text = "Too Many Requests"
        with patch("govee_cli.http_v2.requests.request", return_value=limited):
            with patch("govee_cli.http_v2.time.sleep"):
                with pytest.raises(GoveeV2RateLimited):
                    client.set_brightness(SKU, DEVICE, 50)

    def test_non_json_response_raises_clearly(self, client: GoveeHTTPv2) -> None:
        resp = MagicMock()
        resp.status_code = 200
        resp.json.side_effect = ValueError("not json")
        resp.text = "<html>gateway error</html>"
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            with pytest.raises(GoveeV2Error, match="Non-JSON"):
                client.set_brightness(SKU, DEVICE, 50)


class TestSceneLookup:
    SCENES = [
        {"name": "Snow flake", "value": {"paramId": 18601, "id": 11281}},
        {"name": "Sunrise", "value": {"paramId": 18593, "id": 11273}},
    ]

    def _scene_response(self) -> MagicMock:
        return _ok({"payload": {"capabilities": [
            {"instance": "lightScene", "parameters": {"options": self.SCENES}}
        ]}})

    def test_find_scene_ignores_spaces_and_case(self, client: GoveeHTTPv2) -> None:
        with patch("govee_cli.http_v2.requests.request",
                   return_value=self._scene_response()):
            with patch("govee_cli.http_v2._read_scene_cache", return_value=None):
                with patch("govee_cli.http_v2._write_scene_cache"):
                    assert client.find_scene(SKU, DEVICE, "snowflake").scene_id == 11281
                    assert client.find_scene(SKU, DEVICE, "SNOW FLAKE").scene_id == 11281

    def test_miss_on_a_live_fetch_does_not_refetch(self, client: GoveeHTTPv2) -> None:
        # With no cache the first lookup is already live, so a second identical
        # fetch would spend API budget to get the same answer.
        with patch("govee_cli.http_v2.requests.request",
                   return_value=self._scene_response()) as req:
            with patch("govee_cli.http_v2._read_scene_cache", return_value=None):
                with patch("govee_cli.http_v2._write_scene_cache"):
                    assert client.find_scene(SKU, DEVICE, "nonexistent") is None
        assert req.call_count == 1

    def test_miss_on_a_cached_lookup_refetches_once(self, client: GoveeHTTPv2) -> None:
        # A stale cache can predate a firmware update that added the scene, so
        # exactly one live retry is worth it here.
        cached = [{"name": "Sunrise", "paramId": 18593, "id": 11273}]
        with patch("govee_cli.http_v2.requests.request",
                   return_value=self._scene_response()) as req:
            with patch("govee_cli.http_v2._read_scene_cache", return_value=cached):
                with patch("govee_cli.http_v2._write_scene_cache"):
                    found = client.find_scene(SKU, DEVICE, "snowflake")
        assert found is not None and found.scene_id == 11281
        assert req.call_count == 1

    def test_scenes_missing_ids_are_skipped(self, client: GoveeHTTPv2) -> None:
        broken = _ok({"payload": {"capabilities": [
            {"instance": "lightScene", "parameters": {"options": [
                {"name": "Broken", "value": {"paramId": 1}},   # no id
                {"name": "Good", "value": {"paramId": 2, "id": 3}},
            ]}}
        ]}})
        with patch("govee_cli.http_v2.requests.request", return_value=broken):
            with patch("govee_cli.http_v2._read_scene_cache", return_value=None):
                with patch("govee_cli.http_v2._write_scene_cache"):
                    scenes = client.get_scenes(SKU, DEVICE)
        assert [s.name for s in scenes] == ["Good"]

    def test_diy_scenes_parse_bare_int_values(self, client: GoveeHTTPv2) -> None:
        resp = _ok({"payload": {"capabilities": [
            {"instance": "diyScene", "parameters": {"options": [
                {"name": "sleep", "value": 22391958},
            ]}}
        ]}})
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            scenes = client.get_diy_scenes(SKU, DEVICE)
        assert scenes == [DIYScene(name="sleep", value=22391958)]

    def test_slug_normalisation(self) -> None:
        assert _slug("Snow flake") == "snowflake"
        assert _slug("Saint Patrick's Day") == "saintpatricksday"
        assert _slug("Rubik's Cube") == "rubikscube"


class TestDeviceParsing:
    def test_devices_expose_capability_lookup(self, client: GoveeHTTPv2) -> None:
        resp = _ok({"data": [{
            "sku": SKU, "device": DEVICE, "deviceName": "Shelf Lamp",
            "type": "devices.types.light",
            "capabilities": [
                {"type": "t", "instance": "powerSwitch", "parameters": {}},
                {"type": "t", "instance": "musicMode", "parameters": {"a": 1}},
            ],
        }]})
        with patch("govee_cli.http_v2.requests.request", return_value=resp):
            devices = client.get_devices()
        assert len(devices) == 1
        assert devices[0].has("musicMode")
        assert not devices[0].has("segmentedColorRgb")
        assert devices[0].capability("musicMode").parameters == {"a": 1}
        assert devices[0].capability("nope") is None


class TestSceneCacheRobustness:
    """A corrupt cache file must degrade to a refetch, never break a command."""

    def test_non_dict_cache_file_returns_none(self, tmp_path) -> None:
        from govee_cli import http_v2

        path = tmp_path / "scene-cache.json"
        path.write_text('["not", "a", "dict"]')
        with patch.object(http_v2, "_SCENE_CACHE_PATH", path):
            assert http_v2._read_scene_cache(DEVICE, "lightScene") is None

    def test_non_dict_entry_returns_none(self, tmp_path) -> None:
        from govee_cli import http_v2

        path = tmp_path / "scene-cache.json"
        path.write_text(json.dumps({f"{DEVICE}:lightScene": "garbage"}))
        with patch.object(http_v2, "_SCENE_CACHE_PATH", path):
            assert http_v2._read_scene_cache(DEVICE, "lightScene") is None

    def test_corrupt_json_returns_none(self, tmp_path) -> None:
        from govee_cli import http_v2

        path = tmp_path / "scene-cache.json"
        path.write_text("{ this is not json")
        with patch.object(http_v2, "_SCENE_CACHE_PATH", path):
            assert http_v2._read_scene_cache(DEVICE, "lightScene") is None

    def test_expired_entry_returns_none(self, tmp_path) -> None:
        from govee_cli import http_v2

        path = tmp_path / "scene-cache.json"
        path.write_text(json.dumps({f"{DEVICE}:lightScene": {
            "fetched_at": 0, "scenes": [{"name": "X", "paramId": 1, "id": 2}],
        }}))
        with patch.object(http_v2, "_SCENE_CACHE_PATH", path):
            assert http_v2._read_scene_cache(DEVICE, "lightScene") is None

    def test_fresh_entry_is_returned(self, tmp_path) -> None:
        import time as _time

        from govee_cli import http_v2

        path = tmp_path / "scene-cache.json"
        scenes = [{"name": "X", "paramId": 1, "id": 2}]
        path.write_text(json.dumps({f"{DEVICE}:lightScene": {
            "fetched_at": _time.time(), "scenes": scenes,
        }}))
        with patch.object(http_v2, "_SCENE_CACHE_PATH", path):
            assert http_v2._read_scene_cache(DEVICE, "lightScene") == scenes

    def test_write_failure_never_propagates(self, tmp_path) -> None:
        from govee_cli import http_v2

        # An unwritable path must not break a scene command.
        with patch.object(http_v2, "_SCENE_CACHE_PATH", tmp_path / "no" / "such" / "f.json"):
            with patch("govee_cli.http_v2.open", side_effect=OSError("read-only")):
                http_v2._write_scene_cache(DEVICE, "lightScene", [])
