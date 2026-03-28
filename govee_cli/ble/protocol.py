"""Govee BLE protocol definitions.

This module encodes commands into the byte format Govee devices expect,
and decodes responses back into structured data.

GATT characteristics confirmed via hardware dump (H6056 MAC D0:C9:07:FE:B6:F0)
and cross-referenced against community reverse engineering:
  - wez/govee-py
  - egold555/Govee-Reverse-Engineering (H6053, H6127)
  - Beshelmek/govee_ble_lights
  - timniklas/hass-govee_light_ble
"""

import struct
from dataclasses import dataclass
from enum import Enum


class GoveeService:
    """Govee device GATT service UUID."""

    LIGHT_SERVICE = "00010203-0405-0607-0809-0a0b0c0d1910"


class GoveeCharacteristic:
    """Govee H6056 GATT characteristic UUIDs (confirmed via hardware dump)."""

    # All commands are written to this single characteristic.
    # Command type and mode are encoded in the packet payload.
    WRITE = "00010203-0405-0607-0809-0a0b0c0d2b11"
    # Device sends state notifications on this characteristic.
    NOTIFY = "00010203-0405-0607-0809-0a0b0c0d2b10"


class CommandType(Enum):
    """
    Govee command type bytes (confirmed by community reverse engineering).

    Color, temperature, scene, and segment control all share command byte
    0x05 (LIGHT_CONTROL). A mode sub-byte in the payload differentiates them.
    """

    POWER = 0x01
    BRIGHTNESS = 0x04
    LIGHT_CONTROL = 0x05  # color, temp, scene, segment — mode byte in payload
    MUSIC = 0x07          # placeholder — format TBD after btmon capture
    EFFECT = 0x08         # placeholder — format TBD after btmon capture


@dataclass
class LightState:
    """Current state of the light, read from the device."""

    power: bool = False
    brightness: int = 0  # 0-100
    color: tuple[int, int, int] = (255, 255, 255)
    color_temp: int | None = None  # Kelvin, if in white mode
    segments: dict[int, tuple[int, int, int]] | None = None


@dataclass
class Command:
    """A Govee command to encode and send."""

    type: CommandType
    payload: bytes


def encode_power(on: bool) -> Command:
    """Encode a power on/off command."""
    return Command(CommandType.POWER, b"\x01" if on else b"\x00")


def encode_brightness(level: int) -> Command:
    """Encode a brightness command (0-100)."""
    if not 0 <= level <= 100:
        raise ValueError(f"Brightness must be 0-100, got {level}")
    return Command(CommandType.BRIGHTNESS, bytes([level]))


def encode_color(r: int, g: int, b: int) -> Command:
    """
    Encode an RGB color command (MODE_1501 — sets all segments to one color).

    Confirmed on H6056: packet 33 05 15 01 RR GG BB 00×5 FF FF [zeros] XOR
    The 0xFF 0xFF segment mask enables all 16 segments simultaneously.
    """
    for v in (r, g, b):
        if not 0 <= v <= 255:
            raise ValueError(f"Color component must be 0-255, got {v}")
    return Command(
        CommandType.LIGHT_CONTROL,
        bytes([0x15, 0x01, r, g, b, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF]),
    )


def encode_color_hex(hex_color: str) -> Command:
    """Encode a color from a hex string like 'FF5500'."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        raise ValueError(f"Invalid hex color: #{hex_color}")
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)
    return encode_color(r, g, b)


def encode_temp(kelvin: int) -> Command:
    """
    Encode a white color temperature command (2700-6500 K).

    Confirmed format for MODE_1501 RGBICWW devices (wez/govee-py + egold555/H6053):
    33 05 15 01 FF FF FF <kelvin_hi> <kelvin_lo> FF 89 12 FF FF [zeros] XOR

    Kelvin is big-endian. FF 89 12 are fixed CCT magic bytes. FF FF = all segments.
    """
    if not 2700 <= kelvin <= 6500:
        raise ValueError(f"Color temp must be 2700-6500 K, got {kelvin}")
    kelvin_hi = (kelvin >> 8) & 0xFF
    kelvin_lo = kelvin & 0xFF
    return Command(
        CommandType.LIGHT_CONTROL,
        bytes([0x15, 0x01, 0xFF, 0xFF, 0xFF, kelvin_hi, kelvin_lo, 0xFF, 0x89, 0x12, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00]),
    )


def encode_scene(scene_code: int) -> Command:
    """
    Encode a built-in scene command.

    Scene codes are 16-bit little-endian (confirmed via Govee API + egold555):
    Packet: 33 05 04 <code_lo> <code_hi> [zeros] XOR

    Use real H6056 scene codes from BuiltInScene — not sequential IDs.
    """
    return Command(CommandType.LIGHT_CONTROL, bytes([0x04]) + struct.pack("<H", scene_code))


def encode_segment(segment_id: int, r: int, g: int, b: int) -> Command:
    """
    Encode a per-segment color command (MODE_1501).

    The H6056 uses a 16-bit segment bitmask (2 bytes). Segment 0 = bit 0 of
    byte 10; segment 8 = bit 0 of byte 11. Confirmed format from all-segments
    test (mask 0xFF 0xFF lit all segments).

    NOTE: Individual segment addressing unverified — needs btmon capture.
    """
    if segment_id < 0 or segment_id > 15:
        raise ValueError(f"Segment ID must be 0-15, got {segment_id}")
    # Set just the bit for this segment in the 16-bit mask
    mask = 1 << segment_id
    seg_lo = mask & 0xFF
    seg_hi = (mask >> 8) & 0xFF
    return Command(
        CommandType.LIGHT_CONTROL,
        bytes([0x15, 0x01, r, g, b, 0x00, 0x00, 0x00, 0x00, 0x00, seg_lo, seg_hi]),
    )


def build_packet(command: Command) -> bytes:
    """
    Build a complete Govee BLE packet from a Command.

    Packet structure (confirmed via community reverse engineering):
    - Byte 0:     0x33 (header)
    - Bytes 1-18: cmd_type + payload, zero-padded to 18 bytes
    - Byte 19:    XOR checksum of bytes 0-18

    Total: always 20 bytes.
    """
    inner = bytes([command.type.value]) + command.payload
    inner = inner[:18].ljust(18, b"\x00")  # pad or trim to exactly 18 bytes
    frame = bytes([0x33]) + inner           # 19 bytes
    checksum = 0
    for b in frame:
        checksum ^= b
    return frame + bytes([checksum])        # 20 bytes total


def parse_state(data: bytes) -> LightState:
    """
    Parse device state notification into a LightState.

    Format is TBD — placeholder that needs real captures via btmon.
    """
    if len(data) < 1:
        raise ValueError(f"State data too short: {data!r}")

    power_byte = data[0]
    brightness = data[1] if len(data) > 1 else 0

    if len(data) >= 5:
        r, g, b = data[2], data[3], data[4]
    else:
        r, g, b = 255, 255, 255

    color_temp: int | None = None
    if len(data) >= 7:
        # 2-byte LE Kelvin at bytes 5-6 (placeholder — needs verification)
        color_temp = struct.unpack("<H", data[5:7])[0]

    return LightState(
        power=(power_byte & 0x01) == 1,
        brightness=brightness,
        color=(r, g, b),
        color_temp=color_temp,
    )
