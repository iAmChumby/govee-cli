"""Tests for device handlers."""

import pytest

from govee_cli.devices import SUPPORTED_DEVICES, get_device_handler
from govee_cli.devices.h6056 import H6056
from govee_cli.devices.h6008 import H6008
from govee_cli.exceptions import UnsupportedDevice


class TestSupportedDevices:
    def test_h6056_in_registry(self) -> None:
        assert "H6056" in SUPPORTED_DEVICES
        assert SUPPORTED_DEVICES["H6056"] == H6056

    def test_h6008_in_registry(self) -> None:
        assert "H6008" in SUPPORTED_DEVICES
        assert SUPPORTED_DEVICES["H6008"] == H6008

    def test_registry_has_two_devices(self) -> None:
        assert len(SUPPORTED_DEVICES) == 2


class TestGetDeviceHandler:
    def test_get_h6056(self) -> None:
        handler = get_device_handler("H6056")
        assert handler == H6056

    def test_get_h6008(self) -> None:
        handler = get_device_handler("H6008")
        assert handler == H6008

    def test_case_insensitive_lookup(self) -> None:
        assert get_device_handler("h6056") == H6056
        assert get_device_handler("H6056") == H6056
        assert get_device_handler("h6008") == H6008
        assert get_device_handler("H6008") == H6008

    def test_unsupported_device_raises(self) -> None:
        with pytest.raises(UnsupportedDevice, match="Unsupported device"):
            get_device_handler("H9999")

    def test_unsupported_device_lists_supported(self) -> None:
        with pytest.raises(UnsupportedDevice) as exc_info:
            get_device_handler("UNKNOWN")
        assert "H6056" in str(exc_info.value)
        assert "H6008" in str(exc_info.value)


class TestH6056Device:
    def test_model_constant(self) -> None:
        assert H6056.MODEL == "H6056"

    def test_segment_count(self) -> None:
        assert H6056.SEGMENT_COUNT == 6

    def test_segment_map_has_six_entries(self) -> None:
        assert len(H6056.SEGMENT_MAP) == 6

    def test_validate_segment_valid_range(self) -> None:
        device = H6056()
        # Valid segments: 0-5
        for i in range(6):
            device.validate_segment_id(i)  # Should not raise

    def test_validate_segment_negative_raises(self) -> None:
        device = H6056()
        with pytest.raises(ValueError, match="Segment ID must be 0-5"):
            device.validate_segment_id(-1)

    def test_validate_segment_too_high_raises(self) -> None:
        device = H6056()
        with pytest.raises(ValueError, match="Segment ID must be 0-5"):
            device.validate_segment_id(6)

    def test_scenes_is_dict(self) -> None:
        assert isinstance(H6056.SCENES, dict)


class TestH6008Device:
    def test_model_constant(self) -> None:
        assert H6008.MODEL == "H6008"

    def test_segment_count(self) -> None:
        assert H6008.SEGMENT_COUNT == 1

    def test_segment_map_has_one_entry(self) -> None:
        assert len(H6008.SEGMENT_MAP) == 1
        assert H6008.SEGMENT_MAP[0] == "bulb"

    def test_validate_segment_zero_is_valid(self) -> None:
        device = H6008()
        device.validate_segment_id(0)  # Should not raise

    def test_validate_segment_one_raises(self) -> None:
        device = H6008()
        with pytest.raises(ValueError, match="Segment ID must be 0"):
            device.validate_segment_id(1)

    def test_validate_segment_negative_raises(self) -> None:
        device = H6008()
        with pytest.raises(ValueError, match="Segment ID must be 0"):
            device.validate_segment_id(-1)

    def test_scenes_is_dict(self) -> None:
        assert isinstance(H6008.SCENES, dict)
