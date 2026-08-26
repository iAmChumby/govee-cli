"""Tests for govee_cli.config."""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

from govee_cli.config import (
    CONFIG_VERSION,
    DeviceConfig,
    GoveeConfig,
    SegmentCalibration,
    load_config,
    save_config,
)


@pytest.fixture
def config_path(tmp_path, monkeypatch):
    """Point config at a temp location."""
    p = tmp_path / "config.json"
    monkeypatch.setattr("govee_cli.config._CONFIG_PATH", p)
    return p


class TestGoveeConfig:
    def test_load_config_defaults_when_no_file(self, config_path):
        cfg = load_config()
        assert cfg.default_mac is None
        # `config._DEFAULT_ADAPTER` is already deliberately platform-aware —
        # "hci0" is a BlueZ adapter name and means nothing off Linux, so the
        # module resolves it to None elsewhere. This assertion hardcoded the
        # Linux value and so could only ever pass on Linux; it now asserts the
        # same rule the production code states, on whichever platform is
        # running it.
        assert cfg.default_adapter == ("hci0" if sys.platform == "linux" else None)
        assert cfg.default_timeout == 10.0
        assert cfg.groups == {}

    def test_save_and_load_round_trip(self, config_path):
        cfg = GoveeConfig(
            default_mac="AA:BB:CC:DD:EE:FF",
            default_adapter="hci1",
            default_timeout=5.0,
            default_brightness=75,
            default_color="FF5500",
            groups={"living_room": ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"]},
        )
        save_config(cfg)
        loaded = load_config()
        assert loaded.default_mac == "AA:BB:CC:DD:EE:FF"
        assert loaded.default_adapter == "hci1"
        assert loaded.default_timeout == 5.0
        assert loaded.default_brightness == 75
        assert loaded.default_color == "FF5500"
        assert loaded.groups == {"living_room": ["AA:BB:CC:DD:EE:FF", "11:22:33:44:55:66"]}

    def test_save_does_not_write_none_values(self, config_path):
        cfg = GoveeConfig(default_mac="AA:BB:CC:DD:EE:FF")
        save_config(cfg)
        with open(config_path) as f:
            data = json.load(f)
        # default_brightness and default_color are None → not written
        assert "default_brightness" not in data
        assert "default_color" not in data

    def test_save_includes_version(self, config_path):
        """Verify that save_config includes version field."""
        cfg = GoveeConfig(default_mac="AA:BB:CC:DD:EE:FF")
        save_config(cfg)
        with open(config_path) as f:
            data = json.load(f)
        assert "version" in data
        assert data["version"] == CONFIG_VERSION


class TestConfigMigration:
    """Tests for v1 to v2 config migration."""

    def test_migrate_v1_with_default_mac(self, config_path):
        """Test migration of v1 config with default_mac."""
        # Create a v1 config (no version field, no devices dict)
        v1_config = {
            "default_mac": "AA:BB:CC:DD:EE:FF",
            "default_adapter": "hci1",
            "default_timeout": 15.0,
            "default_brightness": 80,
            "default_color": "00FF00",
            "groups": {"bedroom": ["AA:BB:CC:DD:EE:FF"]},
        }
        with open(config_path, "w") as f:
            json.dump(v1_config, f)

        # Load config - should trigger migration
        cfg = load_config()

        # Verify migrated values
        assert cfg.default_mac == "AA:BB:CC:DD:EE:FF"
        assert cfg.default_adapter == "hci1"
        assert cfg.default_timeout == 15.0
        assert cfg.default_brightness == 80
        assert cfg.default_color == "00FF00"
        assert cfg.groups == {"bedroom": ["AA:BB:CC:DD:EE:FF"]}

        # Verify device was created from default_mac
        assert len(cfg.devices) == 1
        assert "AA:BB:CC:DD:EE:FF" in cfg.devices
        device = cfg.devices["AA:BB:CC:DD:EE:FF"]
        assert device.model == "H6056"  # Default for backward compatibility
        assert device.name is None
        assert device.static_mac is None

        # Verify saved config now has version
        with open(config_path) as f:
            saved_data = json.load(f)
        assert saved_data["version"] == CONFIG_VERSION
        assert "devices" in saved_data

    def test_migrate_v1_without_default_mac(self, config_path):
        """Test migration of v1 config without default_mac."""
        v1_config = {
            "default_adapter": "hci2",
            "groups": {"office": ["11:22:33:44:55:66"]},
        }
        with open(config_path, "w") as f:
            json.dump(v1_config, f)

        cfg = load_config()

        assert cfg.default_mac is None
        assert cfg.default_adapter == "hci2"
        assert cfg.devices == {}  # No devices created without default_mac

    def test_migrate_v1_minimal(self, config_path):
        """Test migration of minimal v1 config."""
        v1_config = {}
        with open(config_path, "w") as f:
            json.dump(v1_config, f)

        cfg = load_config()

        assert cfg.default_mac is None
        assert cfg.default_timeout == 10.0  # Default value
        assert cfg.devices == {}
        assert cfg.groups == {}

    def test_v2_config_loads_without_migration(self, config_path):
        """Test that v2 configs load normally without triggering migration."""
        v2_config = {
            "version": CONFIG_VERSION,
            "default_mac": "AA:BB:CC:DD:EE:FF",
            "devices": {
                "AA:BB:CC:DD:EE:FF": {
                    "model": "H6056",
                    "name": "Desk Lamp",
                }
            },
        }
        with open(config_path, "w") as f:
            json.dump(v2_config, f)

        cfg = load_config()

        assert cfg.default_mac == "AA:BB:CC:DD:EE:FF"
        assert len(cfg.devices) == 1
        device = cfg.devices["AA:BB:CC:DD:EE:FF"]
        assert device.model == "H6056"
        assert device.name == "Desk Lamp"
        # No segment_calibration key anywhere in this file — this is exactly
        # the shape of Luke's real, pre-existing ~/.config/govee-cli/config.json.
        # Adding the field must not break loading it.
        assert device.segment_calibration is None


class TestSegmentCalibration:
    """WEBUI_V3_SPEC.md §5.3 — DeviceConfig.segment_calibration round-trip."""

    def test_save_and_load_round_trip(self, config_path):
        calibration = SegmentCalibration(
            boundaries=[0, 9, 18, 26, 35, 44, 53, 61, 70, 79, 88, 96, 105, 114, 123, 132],
            permutation=[0, 3, 1, 2, 4, 7, 5, 6, 8, 11, 9, 10, 12, 13, 14],
            calibrated_at="2026-08-25T14:00:00+00:00",
        )
        cfg = GoveeConfig(devices={
            "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(
                model="H6022", name="Shelf Lamp", segment_calibration=calibration,
            ),
        })
        save_config(cfg)
        loaded = load_config()

        device = loaded.devices["50:CE:E8:6E:80:C6:50:3F"]
        assert device.segment_calibration == calibration

    def test_uncalibrated_device_round_trips_as_none(self, config_path):
        cfg = GoveeConfig(devices={
            "AA:BB:CC:DD:EE:FF": DeviceConfig(model="H6056", name="Light Bars"),
        })
        save_config(cfg)
        loaded = load_config()

        assert loaded.devices["AA:BB:CC:DD:EE:FF"].segment_calibration is None

    def test_uncalibrated_device_omits_key_from_disk(self, config_path):
        """A never-calibrated device's JSON stays exactly as small as before
        this field existed — no ``"segment_calibration": null`` clutter."""
        cfg = GoveeConfig(devices={
            "AA:BB:CC:DD:EE:FF": DeviceConfig(model="H6056", name="Light Bars"),
        })
        save_config(cfg)
        with open(config_path) as f:
            data = json.load(f)
        assert "segment_calibration" not in data["devices"]["AA:BB:CC:DD:EE:FF"]

    def test_pre_v3_config_missing_field_entirely_loads_cleanly(self, config_path):
        """A config.json written before this field existed — the exact shape
        of Luke's on-disk config — must keep loading without raising."""
        raw = {
            "version": CONFIG_VERSION,
            "default_mac": "6D:19:DD:6E:86:46:44:0C",
            "devices": {
                "6D:19:DD:6E:86:46:44:0C": {"model": "H6056", "name": "Light Bars"},
            },
        }
        with open(config_path, "w") as f:
            json.dump(raw, f)

        cfg = load_config()
        assert cfg.devices["6D:19:DD:6E:86:46:44:0C"].segment_calibration is None


class TestRequestBudgetPerDay:
    """WEBUI_V3_SPEC.md §10.2 — the request meter's opt-in soft budget."""

    def test_defaults_to_none(self, config_path):
        cfg = load_config()
        assert cfg.request_budget_per_day is None

    def test_save_and_load_round_trip(self, config_path):
        cfg = GoveeConfig(default_mac="AA:BB:CC:DD:EE:FF", request_budget_per_day=5000)
        save_config(cfg)
        loaded = load_config()
        assert loaded.request_budget_per_day == 5000

    def test_unset_omits_key_from_disk(self, config_path):
        cfg = GoveeConfig(default_mac="AA:BB:CC:DD:EE:FF")
        save_config(cfg)
        with open(config_path) as f:
            data = json.load(f)
        assert "request_budget_per_day" not in data

    def test_pre_existing_v2_config_without_key_loads_as_none(self, config_path):
        """A config.json written before this field existed — no CONFIG_VERSION bump
        accompanied this change, so this is the exact shape of a config saved by
        yesterday's code. It must keep loading, with the field defaulting to None."""
        raw = {
            "version": CONFIG_VERSION,
            "default_mac": "6D:19:DD:6E:86:46:44:0C",
            "devices": {
                "6D:19:DD:6E:86:46:44:0C": {"model": "H6056", "name": "Light Bars"},
            },
        }
        with open(config_path, "w") as f:
            json.dump(raw, f)

        cfg = load_config()
        assert cfg.request_budget_per_day is None
