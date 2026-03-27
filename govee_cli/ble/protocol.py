"""Govee BLE protocol definitions.

This module encodes commands into the byte format Govee devices expect,
and decodes responses back into structured data.

GATT characteristics are device-specific and must be discovered via
BLE sniffer (see ARCHITECTURE.md). The values below are placeholders
derived from community research and must be verified against actual
device captures before use.
"""

import struct
from dataclasses import dataclass
from enum import Enum


# Govee GATT service and characteristic UUIDs (placeholder — TBD after sniffer)
# These are derived from govee-ble community research and need verification.
class GoveeService:
    """Govee device GATT service UUIDs."""

    LIGHT_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"  # Primary light service


class GoveeCharacteristic:
    """Govee device GATT characteristic UUIDs (TBR after reverse engineering)."""

    # Placeholder UUIDs — these MUST be verified with a BLE sniffer
    POWER = "0000fff1-0000-1000-8000-00805f9b34fb"
    COLOR = "0000fff2-0000-1000-8000-00805f9b34fb"
    TEMP = "0000fff3-0000-1000-8000-00805f9b34fb"
    BRIGHTNESS = "0000fff4-0000-1000-8000-00805f9b34fb"
    SCENE = "0000fff5-0000-1000-8000-00805f9b34fb"
    SEGMENT = "0000fff6-0000-1000-8000-00805f9b34fb"
    MUSIC = "0000fff8-0000-1000-8000-00805f9b34fb"
    EFFECT = "0000fff9-0000-1000-8000-00805f9b34fb"
    STATE = "0000fff7-0000-1000-8000-00805f9b34fb"  # Notification subscription


class CommandType(Enum):
    """Govee command types encoded into the protocol."""

    POWER = 0x01
    BRIGHTNESS = 0x02
    COLOR = 0x03
    TEMP = 0x04
    SCENE = 0x05
    SEGMENT = 0x06
    MUSIC = 0x07
    EFFECT = 0x08
    QUERY = 0x09


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
    """Encode an RGB color command."""
    for v in (r, g, b):
        if not 0 <= v <= 255:
            raise ValueError(f"Color component must be 0-255, got {v}")
    return Command(CommandType.COLOR, bytes([r, g, b]))


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
    """Encode a white color temperature command (2700-6500 K)."""
    if not 2700 <= kelvin <= 6500:
        raise ValueError(f"Color temp must be 2700-6500 K, got {kelvin}")
    # Govee encodes temp as a 2-byte LE value
    return Command(CommandType.TEMP, struct.pack("<H", kelvin))


def encode_scene(scene_id: int) -> Command:
    """Encode a built-in scene command (scene ID from Govee app)."""
    return Command(CommandType.SCENE, struct.pack("<H", scene_id))


def encode_segment(segment_id: int, r: int, g: int, b: int) -> Command:
    """Encode a per-segment color command."""
    if segment_id < 0 or segment_id > 15:
        raise ValueError(f"Segment ID must be 0-15, got {segment_id}")
    return Command(
        CommandType.SEGMENT, bytes([segment_id, r, g, b])
    )


def build_packet(command: Command) -> bytes:
    """
    Build a complete Govee BLE packet from a Command.

    Packet structure (TBR after verification):
    [0x33, cmd_type, ...payload, checksum]

    The leading 0x33 appears in captures from the Govee app.
    """
    body = bytes([command.type.value]) + command.payload
    checksum = sum(body) & 0xFF
    return bytes([0x33]) + body + bytes([checksum])


def parse_state(data: bytes) -> LightState:
    """
    Parse device state notification into a LightState.

    Format is TBD — placeholder that needs real captures.
    """
    if len(data) < 4:
        raise ValueError(f"State data too short: {data!r}")

    power_byte = data[0]
    brightness = data[1] if len(data) > 1 else 0

    if len(data) >= 4:
        r, g, b = data[2], data[3], data[4]
    else:
        r, g, b = 255, 255, 255

    return LightState(
        power=(power_byte & 0x01) == 1,
        brightness=brightness,
        color=(r, g, b),
    )
