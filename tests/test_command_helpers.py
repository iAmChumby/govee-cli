"""Tests for the shared command helpers (segment/colour parsing)."""

import click
import pytest

from govee_cli.commands._common import parse_hex, parse_segments


class TestParseSegments:
    def test_single_index(self) -> None:
        assert parse_segments("3", 15) == [3]

    def test_comma_list(self) -> None:
        assert parse_segments("0,4,9", 15) == [0, 4, 9]

    def test_inclusive_range(self) -> None:
        assert parse_segments("2-6", 15) == [2, 3, 4, 5, 6]

    def test_mixed_list_and_ranges(self) -> None:
        assert parse_segments("0-2,8,11-14", 15) == [0, 1, 2, 8, 11, 12, 13, 14]

    def test_all_expands_to_every_segment(self) -> None:
        assert parse_segments("all", 15) == list(range(15))
        assert parse_segments("ALL", 6) == list(range(6))

    def test_duplicates_are_dropped_preserving_order(self) -> None:
        # Sending the same segment twice in one call is wasted API budget.
        assert parse_segments("0-2,1,0", 15) == [0, 1, 2]

    def test_whitespace_is_tolerated(self) -> None:
        assert parse_segments(" 0 , 2 ", 15) == [0, 2]

    def test_out_of_range_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="out of range"):
            parse_segments("15", 15)
        with pytest.raises(click.ClickException, match="out of range"):
            parse_segments("0-20", 15)

    def test_negative_rejected(self) -> None:
        with pytest.raises(click.ClickException):
            parse_segments("-1", 15)

    def test_backwards_range_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="greater than end"):
            parse_segments("6-2", 15)

    def test_garbage_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid segment"):
            parse_segments("abc", 15)

    def test_empty_selection_rejected(self) -> None:
        with pytest.raises(click.ClickException):
            parse_segments(",", 15)

    def test_range_honours_device_segment_count(self) -> None:
        # The same spec is valid on a 15-zone lamp and invalid on a 6-zone bar.
        assert parse_segments("all", 6) == list(range(6))
        with pytest.raises(click.ClickException):
            parse_segments("9", 6)


class TestParseHex:
    def test_plain_hex(self) -> None:
        assert parse_hex("FF5500") == (255, 85, 0)

    def test_leading_hash(self) -> None:
        assert parse_hex("#FF5500") == (255, 85, 0)

    def test_lowercase(self) -> None:
        assert parse_hex("ff5500") == (255, 85, 0)

    def test_black_and_white(self) -> None:
        assert parse_hex("000000") == (0, 0, 0)
        assert parse_hex("FFFFFF") == (255, 255, 255)

    def test_wrong_length_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            parse_hex("FFF")

    def test_non_hex_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            parse_hex("GGGGGG")


class TestBleMacDerivation:
    """BLE needs the 6-octet address, not Govee's 8-octet cloud id.

    Confirmed against `bluetoothctl devices`: the Light Bars are
    `6D:19:DD:6E:86:46:44:0C` in the cloud and advertise as
    `DD:6E:86:46:44:0C` over Bluetooth. Handing the 8-octet id to bleak can
    never connect.
    """

    @staticmethod
    def _target(device_id: str, static_mac: str | None = None):
        from govee_cli.commands._common import Target
        from govee_cli.config import DeviceConfig, GoveeConfig

        cfg = GoveeConfig(devices={
            device_id.upper(): DeviceConfig(
                model="H6056", name="Light Bars", static_mac=static_mac),
        })
        return Target(device_id, "H6056", "cloud-v2", cfg)

    def test_eight_octet_id_drops_the_first_two(self) -> None:
        target = self._target("6D:19:DD:6E:86:46:44:0C")
        assert target.ble_mac == "DD:6E:86:46:44:0C"

    def test_six_octet_mac_is_unchanged(self) -> None:
        target = self._target("DD:6E:86:46:44:0C")
        assert target.ble_mac == "DD:6E:86:46:44:0C"

    def test_configured_static_mac_wins(self) -> None:
        # The sticker MAC is authoritative when the user has recorded it.
        target = self._target("6D:19:DD:6E:86:46:44:0C",
                              static_mac="D0:C9:07:FE:B6:F0")
        assert target.ble_mac == "D0:C9:07:FE:B6:F0"

    def test_unregistered_device_falls_back_to_the_reference(self) -> None:
        from govee_cli.commands._common import Target
        from govee_cli.config import GoveeConfig

        target = Target("AA:BB:CC:DD:EE:FF", None, "ble", GoveeConfig())
        assert target.ble_mac == "AA:BB:CC:DD:EE:FF"
