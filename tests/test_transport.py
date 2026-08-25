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

    def test_h6056_and_h6008_moved_to_v2(self) -> None:
        # Moved 2026-08-14 after re-verifying power/brightness/color/temp over
        # v2 with state readback on all three units. v1 could not carry scenes,
        # segments or music, which left most of their feature set unreachable.
        assert transport_for("H6056") == CLOUD_V2
        assert transport_for("H6008") == CLOUD_V2

    def test_h6183_stays_on_v1(self) -> None:
        # No hardware on hand to verify a v2 move against; an unverified switch
        # is exactly what breaks silently.
        assert transport_for("H6183") == CLOUD_V1

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

    def test_h6056_claims_the_features_it_verified(self) -> None:
        spec = get_spec("H6056")
        assert spec.cloud_scenes          # 69 scenes returned by /device/scenes
        assert spec.cloud_segments        # segments 0-14 accepted
        assert spec.cloud_segment_brightness  # segmentedBrightness accepted
        assert spec.cloud_music           # 8 firmware music modes accepted
        assert spec.cloud_diy

    def test_h6056_excludes_the_toggle_its_hardware_rejects(self) -> None:
        # dreamViewToggle is advertised by the API but rejected by this unit
        # with "The device does not has DreamView", so it must not be claimed.
        spec = get_spec("H6056")
        assert "gradientToggle" in spec.toggles
        assert "dreamViewToggle" not in spec.toggles

    def test_h6056_keeps_ble_for_effects(self) -> None:
        # Cloud playback is capped at 2fps; BLE animates at full speed, so a
        # device that can do both must not silently lose frame rate.
        spec = get_spec("H6056")
        assert spec.prefer_ble_effects
        assert spec.ble_segment_count == 6
        assert spec.segment_count == 15   # the cloud API's own bound

    def test_h6008_claims_scenes_but_not_segments_or_music(self) -> None:
        # Both were verified rejected: 400 "devices not support this instance".
        spec = get_spec("H6008")
        assert spec.cloud_scenes and spec.cloud_diy
        assert not spec.cloud_segments
        assert not spec.cloud_music
        assert spec.segment_count == 0

    def test_h6022_has_no_segment_brightness(self) -> None:
        # Verified rejected on the H6022 while the H6056 accepts it — the two
        # must not be conflated.
        assert not get_spec("H6022").cloud_segment_brightness
        assert get_spec("H6056").cloud_segment_brightness

    def test_unknown_spec_is_none(self) -> None:
        assert get_spec("H9999") is None
        assert get_spec(None) is None

    def test_every_spec_key_matches_its_model(self) -> None:
        for key, spec in MODEL_SPECS.items():
            assert key == spec.model == key.upper()

    def test_every_spec_has_a_sane_temp_range(self) -> None:
        for spec in MODEL_SPECS.values():
            assert spec.temp_min < spec.temp_max

    def test_h6022_matrix_geometry(self) -> None:
        # The H6022 is a 132-LED drum: 12 columns wrapped around × 11 rows.
        # The cloud API addresses it through 15 linear segments.
        spec = get_spec("H6022")
        assert spec.matrix_rows == 11
        assert spec.matrix_cols == 12
        assert spec.matrix_wrap_col is True

    def test_h6056_matrix_geometry(self) -> None:
        # The H6056 has 2 bars (rows), with an authoring resolution of 48
        # columns per bar for smooth gradients/motion. No column wrapping (linear).
        spec = get_spec("H6056")
        assert spec.matrix_rows == 2
        assert spec.matrix_cols == 48
        assert spec.matrix_wrap_col is False

    def test_h6008_has_no_matrix(self) -> None:
        # H6008 is a single-zone bulb, not a matrix device.
        spec = get_spec("H6008")
        assert spec.matrix_rows == 0
        assert spec.matrix_cols == 0
        assert spec.matrix_wrap_col is False

    def test_h6183_has_no_matrix(self) -> None:
        # H6183 is a single-zone device on the legacy v1 API, not a matrix.
        spec = get_spec("H6183")
        assert spec.matrix_rows == 0
        assert spec.matrix_cols == 0
        assert spec.matrix_wrap_col is False

    def test_matrix_geometry_defaults_to_zero(self) -> None:
        # Any unregistered device (returned as None) should not break, and all
        # defaults should be sensible.
        from govee_cli.transport import ModelSpec

        # Create a minimal spec with only required fields.
        spec = ModelSpec(model="TEST", transport="test-transport")
        assert spec.matrix_rows == 0
        assert spec.matrix_cols == 0
        assert spec.matrix_wrap_col is False


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
        assert transport == CLOUD_V2

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


class TestCloudDeviceIdGuard:
    """Both Govee cloud APIs address devices by an 8-octet id.

    A 6-octet BLE MAC in the registry means the device was added by hand via
    `config --device-mac`, which was the only way before these models had a
    cloud path. Sending that to the cloud asks about a device Govee has never
    heard of, so it must fail locally with the fix.
    """

    @staticmethod
    def _config_with(device_id: str, model: str) -> GoveeConfig:
        return GoveeConfig(devices={device_id: DeviceConfig(model=model, name="Bars")})

    def test_six_octet_id_on_a_cloud_model_is_refused(self) -> None:
        import click

        cfg = self._config_with("D0:C9:07:FE:B6:F0", "H6056")
        with pytest.raises(click.ClickException, match="8-octet device id"):
            resolve_target(cfg, "Bars")

    def test_the_error_names_the_fix(self) -> None:
        import click

        cfg = self._config_with("D0:C9:07:FE:B6:F0", "H6056")
        with pytest.raises(click.ClickException, match="scan-http"):
            resolve_target(cfg, "Bars")

    def test_eight_octet_id_on_a_cloud_model_is_fine(self) -> None:
        cfg = self._config_with("6D:19:DD:6E:86:46:44:0C", "H6056")
        device_id, model, transport = resolve_target(cfg, "Bars")
        assert transport == CLOUD_V2
        assert device_id == "6D:19:DD:6E:86:46:44:0C"

    def test_six_octet_id_is_fine_for_a_ble_model(self) -> None:
        # An unregistered model still routes to BLE, where a 6-octet MAC is right.
        cfg = GoveeConfig()
        device_id, model, transport = resolve_target(cfg, "D0:C9:07:FE:B6:F0")
        assert transport == BLE
        assert device_id == "D0:C9:07:FE:B6:F0"


class TestH6183KeepsV1Reachable:
    def test_h6183_is_registerable(self) -> None:
        # Without a device handler, load_config rejects the model outright and
        # every v1 branch in the codebase becomes unreachable.
        from govee_cli.devices import SUPPORTED_DEVICES

        assert "H6183" in SUPPORTED_DEVICES

    def test_h6183_config_round_trips(self) -> None:
        from govee_cli.config import _validate_model

        _validate_model("H6183")   # must not raise
