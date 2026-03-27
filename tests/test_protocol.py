"""Tests for the Govee BLE protocol encoder."""

import pytest

from govee_cli.ble.protocol import (
    CommandType,
    encode_brightness,
    encode_color,
    encode_color_hex,
    encode_power,
    encode_scene,
    encode_segment,
    encode_temp,
    build_packet,
)


class TestEncodePower:
    def test_power_on(self) -> None:
        cmd = encode_power(on=True)
        assert cmd.type == CommandType.POWER
        assert cmd.payload == b"\x01"

    def test_power_off(self) -> None:
        cmd = encode_power(on=False)
        assert cmd.payload == b"\x00"


class TestEncodeBrightness:
    def test_valid_range(self) -> None:
        for level in [0, 50, 100]:
            cmd = encode_brightness(level)
            assert cmd.type == CommandType.BRIGHTNESS
            assert cmd.payload == bytes([level])

    def test_invalid_too_low(self) -> None:
        with pytest.raises(ValueError, match="0-100"):
            encode_brightness(-1)

    def test_invalid_too_high(self) -> None:
        with pytest.raises(ValueError, match="0-100"):
            encode_brightness(101)


class TestEncodeColor:
    def test_black(self) -> None:
        cmd = encode_color(0, 0, 0)
        assert cmd.payload == b"\x00\x00\x00"

    def test_white(self) -> None:
        cmd = encode_color(255, 255, 255)
        assert cmd.payload == b"\xff\xff\xff"

    def test_orange(self) -> None:
        cmd = encode_color(255, 85, 0)
        assert cmd.payload == b"\xff\x55\x00"

    def test_invalid_component_low(self) -> None:
        with pytest.raises(ValueError, match="0-255"):
            encode_color(-1, 0, 0)

    def test_invalid_component_high(self) -> None:
        with pytest.raises(ValueError, match="0-255"):
            encode_color(256, 0, 0)


class TestEncodeColorHex:
    def test_ff5500(self) -> None:
        cmd = encode_color_hex("FF5500")
        assert cmd.payload == b"\xff\x55\x00"

    def test_with_hash_prefix(self) -> None:
        cmd = encode_color_hex("#FF5500")
        assert cmd.payload == b"\xff\x55\x00"

    def test_invalid_length(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex color"):
            encode_color_hex("FFF")


class TestEncodeTemp:
    def test_warm_white(self) -> None:
        cmd = encode_temp(2700)
        assert cmd.type == CommandType.TEMP
        # LE uint16: 2700 = 0x0A8C
        assert cmd.payload == b"\x8c\x0a"

    def test_cool_white(self) -> None:
        cmd = encode_temp(6500)
        # LE uint16: 6500 = 0x1964 → bytes are 0x64, 0x19
        assert cmd.payload == b"\x64\x19"

    def test_too_low(self) -> None:
        with pytest.raises(ValueError, match="2700-6500"):
            encode_temp(2600)

    def test_too_high(self) -> None:
        with pytest.raises(ValueError, match="2700-6500"):
            encode_temp(6600)


class TestEncodeSegment:
    def test_valid(self) -> None:
        cmd = encode_segment(0, 255, 0, 0)
        assert cmd.type == CommandType.SEGMENT
        assert cmd.payload == b"\x00\xff\x00\x00"

    def test_max_segment(self) -> None:
        cmd = encode_segment(15, 0, 255, 0)
        assert cmd.payload == b"\x0f\x00\xff\x00"

    def test_invalid_segment_negative(self) -> None:
        with pytest.raises(ValueError, match="0-15"):
            encode_segment(-1, 0, 0, 0)

    def test_invalid_segment_too_high(self) -> None:
        with pytest.raises(ValueError, match="0-15"):
            encode_segment(16, 0, 0, 0)


class TestBuildPacket:
    def test_packet_structure(self) -> None:
        cmd = encode_power(on=True)
        packet = build_packet(cmd)
        # Leading 0x33, cmd type, payload, checksum
        assert packet[0] == 0x33
        assert packet[1] == 0x01  # POWER type
        assert packet[2] == 0x01  # payload (on)
        # checksum = sum([0x01, 0x01]) & 0xFF = 0x02
        assert packet[3] == 0x02

    def test_checksum_wraps(self) -> None:
        # Checksum includes the command type byte: [0x33, type(3), r(100), g(100), b(100), checksum]
        # body = [3, 100, 100, 100] = 303 & 0xFF = 47
        cmd = encode_color(100, 100, 100)
        packet = build_packet(cmd)
        body_sum = cmd.type.value + 100 + 100 + 100
        assert packet[-1] == (body_sum & 0xFF)
