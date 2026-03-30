#!/usr/bin/env python3
"""Test H6008 with static MAC address."""

import asyncio
from bleak import BleakClient

# Static MAC from config (different from BLE MAC)
H6008_STATIC_MAC = "5C:E7:53:69:87:FA"
WRITE_UUID = "00010203-0405-0607-0809-0a0b0c0d2b11"


def build_packet(cmd, payload):
    """Build 20-byte Govee packet with XOR checksum."""
    packet = bytearray(20)
    packet[0] = 0x33
    packet[1] = cmd
    for i, b in enumerate(payload):
        if 2 + i < 19:
            packet[2 + i] = b & 0xFF
    xor = 0
    for b in packet[:19]:
        xor ^= b
    packet[19] = xor
    return bytes(packet)


async def test_static_mac():
    """Test using static MAC instead of BLE MAC."""
    print(f"Testing H6008 with STATIC MAC: {H6008_STATIC_MAC}")
    print("=" * 70)

    power_off = build_packet(0x01, [0x00])

    print(f"Packet: {power_off.hex(' ')}")
    print()

    async with BleakClient(H6008_STATIC_MAC) as client:
        print(f"✓ Connected")
        await client.write_gatt_char(WRITE_UUID, power_off, response=False)
        print("✓ Sent power off - Did the bulb turn OFF?")

        await asyncio.sleep(3)

        power_on = build_packet(0x01, [0x01])
        await client.write_gatt_char(WRITE_UUID, power_on, response=False)
        print("✓ Sent power on - Did the bulb turn ON?")


if __name__ == "__main__":
    asyncio.run(test_static_mac())
