#!/usr/bin/env python3
"""
Diagnostic script for H6008.

Tests whether subscribing to the fff6 indicate characteristic
before writing commands is required to gate command processing.
"""

import asyncio
from bleak import BleakClient, BleakGATTCharacteristic

MAC = "5C:E7:53:69:87:FB"

STD_WRITE  = "00010203-0405-0607-0809-0a0b0c0d2b11"
STD_NOTIFY = "00010203-0405-0607-0809-0a0b0c0d2b10"

# fff6 service — H6008-only
ALT_WRITE  = "18ee2ef5-263d-4559-959f-4f9c429f9d11"
ALT_IND    = "18ee2ef5-263d-4559-959f-4f9c429f9d12"  # indicate char (never subscribed before)

def build_packet(cmd: int, payload: list[int]) -> bytes:
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

POWER_OFF = build_packet(0x01, [0x00])
POWER_ON  = build_packet(0x01, [0x01])
RED       = build_packet(0x05, [0x02, 0xFF, 0x00, 0x00])

print(f"POWER OFF: {POWER_OFF.hex(' ')}")
print(f"POWER ON:  {POWER_ON.hex(' ')}")
print()

async def run():
    received: list[bytes] = []

    def ind_handler(char: BleakGATTCharacteristic, data: bytearray) -> None:
        received.append(bytes(data))
        print(f"  << INDICATION received: {bytes(data).hex(' ')}")

    print(f"Connecting to {MAC}...")
    async with BleakClient(MAC, timeout=15.0) as client:
        print("Connected.\n")

        # --- Test A: subscribe ALT_IND then write to ALT_WRITE ---
        print("=== Test A: subscribe ALT_IND (indicate) → write POWER OFF to ALT_WRITE ===")
        print("  Watch the lamp.")
        try:
            await client.start_notify(ALT_IND, ind_handler)
            print("  Subscribed to ALT_IND indications")
        except Exception as e:
            print(f"  Could not subscribe to ALT_IND: {e}")

        await asyncio.sleep(0.3)

        try:
            await client.write_gatt_char(ALT_WRITE, POWER_OFF, response=False)
            print("  Sent POWER OFF to ALT_WRITE")
        except Exception as e:
            print(f"  Write failed: {e}")

        await asyncio.sleep(3)

        try:
            await client.write_gatt_char(ALT_WRITE, POWER_ON, response=False)
            print("  Sent POWER ON to ALT_WRITE")
        except Exception as e:
            print(f"  Write failed: {e}")

        await asyncio.sleep(3)

        # --- Test B: subscribe STD_NOTIFY then write to STD_WRITE ---
        print()
        print("=== Test B: subscribe STD_NOTIFY → write POWER OFF to STD_WRITE ===")
        print("  Watch the lamp.")
        try:
            await client.start_notify(STD_NOTIFY, ind_handler)
            print("  Subscribed to STD_NOTIFY")
        except Exception as e:
            print(f"  Could not subscribe to STD_NOTIFY: {e}")

        await asyncio.sleep(0.3)

        try:
            await client.write_gatt_char(STD_WRITE, POWER_OFF, response=False)
            print("  Sent POWER OFF to STD_WRITE")
        except Exception as e:
            print(f"  Write failed: {e}")

        await asyncio.sleep(3)

        try:
            await client.write_gatt_char(STD_WRITE, POWER_ON, response=False)
            print("  Sent POWER ON to STD_WRITE")
        except Exception as e:
            print(f"  Write failed: {e}")

        await asyncio.sleep(3)

        if received:
            print(f"\nTotal indications/notifications received: {len(received)}")
        else:
            print("\nNo indications or notifications received from device.")

        print("Done.")

asyncio.run(run())
