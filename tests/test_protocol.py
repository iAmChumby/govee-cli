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
        assert cmd.type == CommandType.LIGHT_CONTROL
        # MODE_1501: [0x15, 0x01, R, G, B, 0×5, 0xFF, 0xFF] — confirmed on H6056
        assert cmd.payload == bytes([0x15, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0xFF, 0xFF])

    def test_white(self) -> None:
        cmd = encode_color(255, 255, 255)
        assert cmd.payload == bytes([0x15, 0x01, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0, 0xFF, 0xFF])

    def test_orange(self) -> None:
        cmd = encode_color(255, 85, 0)
        assert cmd.payload == bytes([0x15, 0x01, 0xFF, 0x55, 0x00, 0, 0, 0, 0, 0, 0xFF, 0xFF])

    def test_invalid_component_low(self) -> None:
        with pytest.raises(ValueError, match="0-255"):
            encode_color(-1, 0, 0)

    def test_invalid_component_high(self) -> None:
        with pytest.raises(ValueError, match="0-255"):
            encode_color(256, 0, 0)


class TestEncodeColorHex:
    def test_ff5500(self) -> None:
        cmd = encode_color_hex("FF5500")
        assert cmd.payload == bytes([0x15, 0x01, 0xFF, 0x55, 0x00, 0, 0, 0, 0, 0, 0xFF, 0xFF])

    def test_with_hash_prefix(self) -> None:
        cmd = encode_color_hex("#FF5500")
        assert cmd.payload == bytes([0x15, 0x01, 0xFF, 0x55, 0x00, 0, 0, 0, 0, 0, 0xFF, 0xFF])

    def test_invalid_length(self) -> None:
        with pytest.raises(ValueError, match="Invalid hex color"):
            encode_color_hex("FFF")


class TestEncodeTemp:
    def test_warm_white(self) -> None:
        cmd = encode_temp(2700)
        assert cmd.type == CommandType.LIGHT_CONTROL
        # MODE_1501 CCT: 2700K = 0x0A8C big-endian → hi=0x0A, lo=0x8C
        assert cmd.payload[:7] == bytes([0x15, 0x01, 0xFF, 0xFF, 0xFF, 0x0A, 0x8C])
        assert cmd.payload[7:10] == bytes([0xFF, 0x89, 0x12])  # CCT magic bytes

    def test_cool_white(self) -> None:
        cmd = encode_temp(6500)
        # 6500K = 0x1964 big-endian → hi=0x19, lo=0x64
        assert cmd.payload[:7] == bytes([0x15, 0x01, 0xFF, 0xFF, 0xFF, 0x19, 0x64])
        assert cmd.payload[7:10] == bytes([0xFF, 0x89, 0x12])

    def test_too_low(self) -> None:
        with pytest.raises(ValueError, match="2700-6500"):
            encode_temp(2600)

    def test_too_high(self) -> None:
        with pytest.raises(ValueError, match="2700-6500"):
            encode_temp(6600)


class TestEncodeSegment:
    def test_valid(self) -> None:
        cmd = encode_segment(0, 255, 0, 0)
        assert cmd.type == CommandType.LIGHT_CONTROL
        assert cmd.payload[:5] == bytes([0x15, 0x01, 0xFF, 0x00, 0x00])
        # segment 0 = bit 0 of byte 10: mask = 0x0001 → lo=0x01, hi=0x00
        assert cmd.payload[10] == 0x01
        assert cmd.payload[11] == 0x00

    def test_max_segment(self) -> None:
        cmd = encode_segment(15, 0, 255, 0)
        assert cmd.payload[:5] == bytes([0x15, 0x01, 0x00, 0xFF, 0x00])
        # segment 15 = bit 15: mask = 0x8000 → lo=0x00, hi=0x80
        assert cmd.payload[10] == 0x00
        assert cmd.payload[11] == 0x80

    def test_invalid_segment_negative(self) -> None:
        with pytest.raises(ValueError, match="0-15"):
            encode_segment(-1, 0, 0, 0)

    def test_invalid_segment_too_high(self) -> None:
        with pytest.raises(ValueError, match="0-15"):
            encode_segment(16, 0, 0, 0)


class TestBuildPacket:
    def test_packet_is_20_bytes(self) -> None:
        cmd = encode_power(on=True)
        packet = build_packet(cmd)
        assert len(packet) == 20

    def test_packet_structure(self) -> None:
        cmd = encode_power(on=True)
        packet = build_packet(cmd)
        assert packet[0] == 0x33   # header
        assert packet[1] == 0x01   # POWER command type
        assert packet[2] == 0x01   # payload (on)
        # bytes 3-18 are zero padding
        assert all(b == 0 for b in packet[3:19])
        # byte 19 is XOR checksum of bytes 0-18
        expected_checksum = 0
        for b in packet[:19]:
            expected_checksum ^= b
        assert packet[19] == expected_checksum

    def test_xor_checksum(self) -> None:
        # Power ON: 0x33 ^ 0x01 ^ 0x01 ^ 0x00 * 16 = 0x33
        cmd = encode_power(on=True)
        packet = build_packet(cmd)
        assert packet[19] == 0x33

    def test_power_off_checksum(self) -> None:
        # Power OFF: 0x33 ^ 0x01 ^ 0x00 = 0x32
        cmd = encode_power(on=False)
        packet = build_packet(cmd)
        assert packet[19] == 0x32

    def test_checksum_is_xor_not_sum(self) -> None:
        # Verify checksum is XOR, not arithmetic sum & 0xFF.
        # encode_brightness(100): type=0x04, payload=[0x64]
        # XOR:  0x33 ^ 0x04 ^ 0x64 = 0x53
        # Sum:  (0x33 + 0x04 + 0x64) & 0xFF = 0x9B  (different)
        cmd = encode_brightness(100)
        packet = build_packet(cmd)
        xor_result = 0x33 ^ 0x04 ^ 0x64  # = 0x53
        assert packet[19] == xor_result
