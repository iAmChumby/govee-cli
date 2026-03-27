"""Tests for govee_cli.config."""

from __future__ import annotations

import json
import pathlib

import pytest

from govee_cli.config import GoveeConfig, load_config, save_config


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
