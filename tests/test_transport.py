"""Tests for the model/transport registry."""

import pytest

from govee_cli.config import DeviceConfig, GoveeConfig
from govee_cli.transport import (
    BLE,
    CLOUD_V1,
    CLOUD_V2,
    MODEL_SPECS,
    get_spec,
    is_cloud,
    resolve_target,
    transport_for,
)


class TestTransportFor:
    def test_h6022_is_cloud_v2(self) -> None:
        assert transport_for("H6022") == CLOUD_V2

    def test_h6056_and_h6008_stay_on_v1(self) -> None:
        # Regression guard: moving the existing devices to v2 would change
        # long-verified behaviour, so this must not drift silently.
        assert transport_for("H6056") == CLOUD_V1
        assert transport_for("H6008") == CLOUD_V1

    def test_lookup_is_case_insensitive(self) -> None:
        assert transport_for("h6022") == CLOUD_V2

    def test_unknown_model_falls_back_to_ble(self) -> None:
        assert transport_for("H9999") == BLE

    def test_none_model_falls_back_to_ble(self) -> None:
        assert transport_for(None) == BLE

    def test_is_cloud(self) -> None:
        assert is_cloud("H6022")
        assert is_cloud("H6056")
        assert not is_cloud("H9999")


class TestModelSpecs:
    def test_h6022_has_fifteen_segments(self) -> None:
        # Verified against hardware: segment 15 is rejected by the API with
        # "Parameter value out of range".
        assert get_spec("H6022").segment_count == 15

    def test_h6022_temp_range_matches_hardware(self) -> None:
        spec = get_spec("H6022")
        assert (spec.temp_min, spec.temp_max) == (2700, 6500)

    def test_h6022_advertises_cloud_features(self) -> None:
        spec = get_spec("H6022")
        assert spec.cloud_scenes
        assert spec.cloud_segments
        assert spec.cloud_music

    def test_h6056_does_not_claim_cloud_scenes(self) -> None:
        # The v1 client has no scene vocabulary; scenes for the bars are BLE-only.
        spec = get_spec("H6056")
        assert not spec.cloud_scenes
        assert not spec.cloud_segments

    def test_unknown_spec_is_none(self) -> None:
        assert get_spec("H9999") is None
        assert get_spec(None) is None

    def test_every_spec_key_matches_its_model(self) -> None:
        for key, spec in MODEL_SPECS.items():
            assert key == spec.model == key.upper()

    def test_every_spec_has_a_sane_temp_range(self) -> None:
        for spec in MODEL_SPECS.values():
            assert spec.temp_min < spec.temp_max


class TestResolveTarget:
    @staticmethod
    def _config() -> GoveeConfig:
        return GoveeConfig(
            devices={
                "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
                "6D:19:DD:6E:86:46:44:0C": DeviceConfig(model="H6056", name="Light Bars"),
            },
            default_mac="50:CE:E8:6E:80:C6:50:3F",
        )

    def test_resolves_by_name(self) -> None:
        device_id, model, transport = resolve_target(self._config(), "Shelf Lamp")
        assert device_id == "50:CE:E8:6E:80:C6:50:3F"
        assert model == "H6022"
        assert transport == CLOUD_V2

    def test_resolves_by_id(self) -> None:
        _, model, transport = resolve_target(self._config(), "6D:19:DD:6E:86:46:44:0C")
        assert model == "H6056"
        assert transport == CLOUD_V1

    def test_falls_back_to_default_device(self) -> None:
        _, model, _ = resolve_target(self._config(), None)
        assert model == "H6022"

    def test_unknown_reference_falls_back_to_ble(self) -> None:
        device_id, model, transport = resolve_target(self._config(), "AA:BB:CC:DD:EE:FF")
        assert device_id == "AA:BB:CC:DD:EE:FF"
        assert model is None
        assert transport == BLE

    def test_no_device_and_no_default_raises(self) -> None:
        import click

        with pytest.raises(click.ClickException, match="No device specified"):
            resolve_target(GoveeConfig(), None)
