#!/usr/bin/env python3
"""Test different H6008 packet formats based on sisiphamus/govee-controller research."""

import asyncio
from bleak import BleakClient

# H6008 MAC
H6008_MAC = "5C:E7:53:69:87:FB"

# GATT UUIDs (same as H6056)
WRITE_UUID = "00010203-0405-0607-0809-0a0b0c0d2b11"
NOTIFY_UUID = "00010203-0405-0607-0809-0a0b0c0d2b10"


def build_packet(cmd: int, payload: list) -> bytes:
    """Build 20-byte Govee packet with XOR checksum."""
    packet = bytearray(20)
    packet[0] = 0x33
    packet[1] = cmd
    for i, b in enumerate(payload):
        if 2 + i < 19:
            packet[2 + i] = b & 0xFF
    # XOR checksum of first 19 bytes
    xor = 0
    for b in packet[:19]:
        xor ^= b
    packet[19] = xor
    return bytes(packet)


def print_packet(name: str, data: bytes):
    """Print packet in readable format."""
    print(f"{name:20s}: {data.hex(' ')}")


# Different packet formats to test
TEST_PACKETS = {
    # Standard H6056 format
    "h6056_power_on": build_packet(0x01, [0x01]),
    "h6056_power_off": build_packet(0x01, [0x00]),
    # H6056 brightness
    "h6056_brightness_50": build_packet(0x04, [50]),
    "h6056_brightness_100": build_packet(0x04, [100]),
    # H6056 color (MODE_2)
    "h6056_red_mode2": build_packet(0x05, [0x02, 0xFF, 0x00, 0x00]),
    "h6056_blue_mode2": build_packet(0x05, [0x02, 0x00, 0x00, 0xFF]),
    # sisiphamus mentioned mode 0x01 might work
    "h6008_red_mode1": build_packet(0x05, [0x01, 0xFF, 0x00, 0x00]),
    "h6008_blue_mode1": build_packet(0x05, [0x01, 0x00, 0x00, 0xFF]),
}


async def test_packets(mac: str):
    """Test each packet format."""
    print(f"Testing H6008 at {mac}")
    print("=" * 70)

    # First, just print all packets
    print("\nPACKET FORMATS TO TEST:")
    print("-" * 70)
    for name, packet in TEST_PACKETS.items():
        print_packet(name, packet)

    print("\n" + "=" * 70)
    print("CONNECTING AND TESTING...")
    print("=" * 70)

    async with BleakClient(mac) as client:
        print(f"✅ Connected to {mac}")

        # Test each packet
        for name, packet in TEST_PACKETS.items():
            print(f"\n📤 Testing: {name}")
            print_packet("  Sending", packet)

            try:
                await client.write_gatt_char(WRITE_UUID, packet, response=False)
                print("  ✅ Write succeeded")
                await asyncio.sleep(2)  # Wait to see if bulb responds
            except Exception as e:
                print(f"  ❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(test_packets(H6008_MAC))
