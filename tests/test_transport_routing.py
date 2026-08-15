"""End-to-end routing tests: does each model reach the transport it should?

After the H6056/H6008 migration to cloud v2, the v1 branches in every command
are reached only by the H6183. Without a test they would rot unnoticed, and the
next person to add a v1 device would inherit broken code.
"""

from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from govee_cli.cli import main
from govee_cli.config import DeviceConfig, GoveeConfig

BARS = "6D:19:DD:6E:86:46:44:0C"
BULB = "82:1F:5C:E7:53:69:87:FA"
LAMP = "50:CE:E8:6E:80:C6:50:3F"
LEGACY = "AA:BB:CC:DD:EE:FF:11:22"


def _config() -> GoveeConfig:
    return GoveeConfig(
        api_key="test-key",
        devices={
            BARS: DeviceConfig(model="H6056", name="Light Bars"),
            BULB: DeviceConfig(model="H6008", name="Lamp Front"),
            LAMP: DeviceConfig(model="H6022", name="Shelf Lamp"),
            LEGACY: DeviceConfig(model="H6183", name="Legacy Strip"),
        },
    )


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def clients():
    """Patch both cloud clients and yield (v1, v2) mocks."""
    v1, v2 = MagicMock(), MagicMock()
    with patch("govee_cli.commands._common.load_config", return_value=_config()), \
         patch("govee_cli.http.GoveeHTTP", return_value=v1), \
         patch("govee_cli.http_v2.GoveeHTTPv2", return_value=v2):
        yield v1, v2


class TestBasicControlRouting:
    @pytest.mark.parametrize("device", ["Light Bars", "Lamp Front", "Shelf Lamp"])
    def test_migrated_models_use_v2(self, runner, clients, device) -> None:
        v1, v2 = clients
        result = runner.invoke(main, ["power", "on", "--device", device])
        assert result.exit_code == 0, result.output
        v2.turn_on.assert_called_once()
        v1.turn_on.assert_not_called()

    def test_h6183_still_uses_v1(self, runner, clients) -> None:
        # The only remaining v1 device. If this breaks, the v1 branches are dead.
        v1, v2 = clients
        result = runner.invoke(main, ["power", "on", "--device", "Legacy Strip"])
        assert result.exit_code == 0, result.output
        v1.turn_on.assert_called_once_with(LEGACY, "H6183")
        v2.turn_on.assert_not_called()

    def test_brightness_routes_per_model(self, runner, clients) -> None:
        v1, v2 = clients
        runner.invoke(main, ["brightness", "40", "--device", "Light Bars"])
        runner.invoke(main, ["brightness", "40", "--device", "Legacy Strip"])
        v2.set_brightness.assert_called_once_with("H6056", BARS, 40)
        v1.set_brightness.assert_called_once_with(LEGACY, "H6183", 40)

    def test_color_routes_per_model(self, runner, clients) -> None:
        v1, v2 = clients
        runner.invoke(main, ["color", "FF5500", "--device", "Lamp Front"])
        runner.invoke(main, ["color", "FF5500", "--device", "Legacy Strip"])
        v2.set_color.assert_called_once_with("H6008", BULB, 255, 85, 0)
        v1.set_color.assert_called_once_with(LEGACY, "H6183", 255, 85, 0)

    def test_temp_routes_per_model(self, runner, clients) -> None:
        v1, v2 = clients
        runner.invoke(main, ["temp", "3000", "--device", "Light Bars"])
        runner.invoke(main, ["temp", "3000", "--device", "Legacy Strip"])
        v2.set_color_temp.assert_called_once_with("H6056", BARS, 3000)
        v1.set_color_temp.assert_called_once_with(LEGACY, "H6183", 3000)


class TestPerModelValidation:
    def test_h6056_accepts_2000k(self, runner, clients) -> None:
        # The bars really do go to 2000K; the old global 2700 floor was wrong.
        _, v2 = clients
        result = runner.invoke(main, ["temp", "2000", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        v2.set_color_temp.assert_called_once_with("H6056", BARS, 2000)

    def test_h6008_rejects_2000k(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["temp", "2000", "--device", "Lamp Front"])
        assert result.exit_code != 0
        assert "out of range for H6008" in result.output
        v2.set_color_temp.assert_not_called()

    def test_h6008_has_no_segments(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["segments", "0", "FF0000", "--device", "Lamp Front"])
        assert result.exit_code != 0
        assert "no addressable segments" in result.output
        v2.set_segment_color.assert_not_called()

    def test_h6022_rejects_segment_brightness(self, runner, clients) -> None:
        # Advertised-but-rejected on this model; the H6056 supports it.
        _, v2 = clients
        result = runner.invoke(
            main, ["segments", "0-2", "--brightness", "50", "--device", "Shelf Lamp"])
        assert result.exit_code != 0
        assert "per-segment brightness" in result.output
        v2.set_segment_brightness.assert_not_called()

    def test_h6056_accepts_segment_brightness(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(
            main, ["segments", "0-2", "--brightness", "50", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        v2.set_segment_brightness.assert_called_once_with("H6056", BARS, [0, 1, 2], 50)


class TestMusicModeIsolation:
    """Music integers overlap across models, so a leak sets the WRONG mode."""

    def test_h6056_beat_is_four(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["music", "beat", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        assert v2.set_music_mode.call_args.args[2] == 4

    def test_h6022_rolling_is_also_four(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["music", "rolling", "--device", "Shelf Lamp"])
        assert result.exit_code == 0, result.output
        assert v2.set_music_mode.call_args.args[2] == 4

    def test_h6056_mode_name_rejected_on_h6022(self, runner, clients) -> None:
        # 'vivid' is H6056-only. Accepting it on an H6022 would silently pick
        # whatever mode 0 happens to be there.
        _, v2 = clients
        result = runner.invoke(main, ["music", "vivid", "--device", "Shelf Lamp"])
        assert result.exit_code != 0
        assert "Unknown music mode" in result.output
        v2.set_music_mode.assert_not_called()

    def test_h6022_mode_name_rejected_on_h6056(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["music", "spectrum", "--device", "Light Bars"])
        assert result.exit_code != 0
        assert "Unknown music mode" in result.output
        v2.set_music_mode.assert_not_called()

    def test_h6008_has_no_music_at_all(self, runner, clients) -> None:
        _, v2 = clients
        result = runner.invoke(main, ["music", "vivid", "--device", "Lamp Front"])
        assert result.exit_code != 0
        assert "no firmware music mode" in result.output
        v2.set_music_mode.assert_not_called()


class TestToggleRouting:
    def test_h6008_has_no_toggles(self, runner, clients) -> None:
        _, v2 = clients
        v2.get_device.return_value = None
        result = runner.invoke(main, ["toggle", "gradient", "on", "--device", "Lamp Front"])
        assert result.exit_code != 0
        v2.set_toggle.assert_not_called()
