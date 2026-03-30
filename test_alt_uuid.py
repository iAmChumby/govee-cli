#!/usr/bin/env python3
"""Test alternative GATT UUID for H6008."""

import asyncio
from bleak import BleakClient

H6008_MAC = "5C:E7:53:69:87:FB"

# Alternative UUID from discovery
ALT_WRITE_UUID = "18ee2ef5-263d-4559-959f-4f9c429f9d11"


def build_packet(cmd: int, payload: list) -> bytes:
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
    print(f"Testing alternative UUID on {H6008_MAC}")
    print(f"UUID: {ALT_WRITE_UUID}")
    print("=" * 70)

    power_off = build_packet(0x01, [0x00])
    power_on = build_packet(0x01, [0x01])
    red = build_packet(0x05, [0x02, 0xFF, 0x00, 0x00])

    async with BleakClient(H6008_MAC) as client:
        print("✅ Connected")

        # Test alternative UUID
        print(f"\n📤 Testing POWER OFF via alternative UUID...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, power_off, response=False)
            print("✅ Write succeeded")
        except Exception as e:
            print(f"❌ Error: {e}")

        await asyncio.sleep(3)

        print(f"\n📤 Testing POWER ON via alternative UUID...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, power_on, response=False)
            print("✅ Write succeeded")
        except Exception as e:
            print(f"❌ Error: {e}")

        await asyncio.sleep(3)

        print(f"\n📤 Testing RED color via alternative UUID...")
        try:
            await client.write_gatt_char(ALT_WRITE_UUID, red, response=False)
            print("✅ Write succeeded")
        except Exception as e:
            print(f"❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(test_alt_uuid())
