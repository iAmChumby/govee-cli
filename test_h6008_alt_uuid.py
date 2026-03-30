#!/usr/bin/env python3
"""Test H6008 with alternative UUID that doesn't require pairing."""

import asyncio
from bleak import BleakClient

H6008_MAC = "5C:E7:53:69:87:FB"
ALT_WRITE_UUID = "18ee2ef5-263d-4559-959f-4f9c429f9d11"


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


async def test_alt_uuid():
    """Test power off via alternative UUID."""
    print(f"Testing H6008 at {H6008_MAC}")
    print(f"Alternative UUID: {ALT_WRITE_UUID}")
    print("=" * 70)

    power_off = build_packet(0x01, [0x00])
    power_on = build_packet(0x01, [0x01])
    red = build_packet(0x05, [0x02, 0xFF, 0x00, 0x00])

    print(f"Power OFF packet: {power_off.hex(' ')}")
    print(f"Power ON packet:  {power_on.hex(' ')}")
    print(f"RED color packet: {red.hex(' ')}")
    print()

    async with BleakClient(H6008_MAC) as client:
        print(f"✓ Connected to {H6008_MAC}")

        # Test power off
        print(f"\n📤 Sending POWER OFF...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, power_off, response=False)
            print("✓ Write succeeded - Did the bulb turn OFF?")
        except Exception as e:
            print(f"✗ Error: {e}")

        await asyncio.sleep(3)

        # Test power on
        print(f"\n📤 Sending POWER ON...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, power_on, response=False)
            print("✓ Write succeeded - Did the bulb turn ON?")
        except Exception as e:
            print(f"✗ Error: {e}")

        await asyncio.sleep(3)

        # Test red color
        print(f"\n📤 Sending RED color...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, red, response=False)
            print("✓ Write succeeded - Did the bulb turn RED?")
        except Exception as e:
            print(f"✗ Error: {e}")

        await asyncio.sleep(1)
        print("\n✓ Done")


if __name__ == "__main__":
    asyncio.run(test_alt_uuid())
