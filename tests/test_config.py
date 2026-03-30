"""Tests for govee_cli.config."""

from __future__ import annotations

import json
import pathlib

import pytest

from govee_cli.config import GoveeConfig, DeviceConfig, load_config, save_config, CONFIG_VERSION


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
        assert cfg.default_adapter == "hci0"
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
