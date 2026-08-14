"""Tests for group command dispatch.

`group run` takes free-text arguments, so bad input must produce a message
rather than a raw ValueError traceback out of int().
"""

from unittest.mock import MagicMock

import click
import pytest

from govee_cli.commands.group import _apply_http_command, _apply_v2_command, _int_arg

SKU = "H6022"
DEVICE = "50:CE:E8:6E:80:C6:50:3F"


class TestIntArg:
    def test_parses_a_number(self) -> None:
        assert _int_arg("42", "brightness") == 42

    def test_names_the_field_and_the_bad_value(self) -> None:
        with pytest.raises(click.ClickException, match="brightness must be a number, got 'abc'"):
            _int_arg("abc", "brightness")


class TestApplyV2Command:
    def test_power(self) -> None:
        client = MagicMock()
        _apply_v2_command(client, DEVICE, SKU, "power on")
        client.turn_on.assert_called_once_with(SKU, DEVICE)

    def test_brightness(self) -> None:
        client = MagicMock()
        _apply_v2_command(client, DEVICE, SKU, "brightness 40")
        client.set_brightness.assert_called_once_with(SKU, DEVICE, 40)

    def test_segments_accepts_a_range(self) -> None:
        client = MagicMock()
        _apply_v2_command(client, DEVICE, SKU, "segments 2-4 FF0000")
        client.set_segment_color.assert_called_once_with(SKU, DEVICE, [2, 3, 4], 255, 0, 0)

    def test_scene_looks_up_by_name(self) -> None:
        client = MagicMock()
        scene = MagicMock()
        client.find_scene.return_value = scene
        _apply_v2_command(client, DEVICE, SKU, "scene snow flake")
        client.find_scene.assert_called_once_with(SKU, DEVICE, "snow flake")
        client.set_scene.assert_called_once_with(SKU, DEVICE, scene)

    def test_unknown_scene_is_a_cli_error(self) -> None:
        client = MagicMock()
        client.find_scene.return_value = None
        with pytest.raises(click.ClickException, match="Unknown scene"):
            _apply_v2_command(client, DEVICE, SKU, "scene nope")

    def test_music_mode_resolves_per_model(self) -> None:
        client = MagicMock()
        _apply_v2_command(client, DEVICE, SKU, "music energic 80")
        client.set_music_mode.assert_called_once_with(SKU, DEVICE, 5, 80)

    def test_unknown_music_mode_is_a_cli_error(self) -> None:
        client = MagicMock()
        # "vivid" is an H6056 mode and must not be accepted for an H6022.
        with pytest.raises(click.ClickException, match="Unknown music mode"):
            _apply_v2_command(client, DEVICE, SKU, "music vivid")

    def test_bad_brightness_is_a_cli_error_not_a_traceback(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="must be a number"):
            _apply_v2_command(client, DEVICE, SKU, "brightness abc")

    def test_bad_color_is_a_cli_error(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            _apply_v2_command(client, DEVICE, SKU, "color ZZZZZZ")

    def test_unsupported_verb_is_a_cli_error(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="Unsupported command"):
            _apply_v2_command(client, DEVICE, SKU, "teleport now")

    def test_empty_command_is_a_cli_error(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="Empty command"):
            _apply_v2_command(client, DEVICE, SKU, "   ")


class TestApplyHttpCommand:
    def test_bad_brightness_is_a_cli_error_not_a_traceback(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="must be a number"):
            _apply_http_command(client, DEVICE, "H6008", "brightness abc")

    def test_bad_temp_is_a_cli_error(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="must be a number"):
            _apply_http_command(client, DEVICE, "H6008", "temp hot")

    def test_bad_color_is_a_cli_error(self) -> None:
        client = MagicMock()
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            _apply_http_command(client, DEVICE, "H6008", "color NOTHEX")

    def test_valid_commands_still_dispatch(self) -> None:
        client = MagicMock()
        _apply_http_command(client, DEVICE, "H6008", "brightness 40")
        client.set_brightness.assert_called_once_with(DEVICE, "H6008", 40)
        _apply_http_command(client, DEVICE, "H6008", "color FF5500")
        client.set_color.assert_called_once_with(DEVICE, "H6008", 255, 85, 0)
