#!/usr/bin/env python3
"""Comprehensive H6008 command test — all known command types."""
import asyncio
from bleak import BleakClient, BleakGATTCharacteristic

# Custom GATT UUIDs (from live H7126 GATT dump + sisiphamus)
WRITE_CHAR = "00010203-0405-0607-0809-0a0b0c0d2b11"
NOTIFY_CHAR = "00010203-0405-0607-0809-0a0b0c0d2b10"

# H6008-specific alternate UUIDs (from debug_h6008.py)
ALT_WRITE = "18ee2ef5-263d-4559-959f-4f9c429f9d11"
ALT_IND = "18ee2ef5-263d-4559-959f-4f9c429f9d12"

DEVICES = [
    ("GVH600887FB", "5C:E7:53:69:87:FB"),
    ("GVH60088F01", "5C:E7:53:63:8F:01"),
]


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


COMMANDS = [
    # (name, build_fn)
    ("POWER OFF",    lambda: build_packet(0x01, [0x00])),
    ("POWER ON",     lambda: build_packet(0x01, [0x01])),
    # Color — channel swap: send (0,255,0) → device shows BLUE
    ("COLOR RED (swapped)",   lambda: build_packet(0x05, [0x02, 0x00, 0xFF, 0x00])),
    ("COLOR GREEN (swapped)", lambda: build_packet(0x05, [0x02, 0xFF, 0x00, 0x00])),
    ("COLOR BLUE",            lambda: build_packet(0x05, [0x02, 0x00, 0x00, 0xFF])),
    # Brightness
    ("BRIGHTNESS 100%", lambda: build_packet(0x04, [0x01, 0xFF])),
    ("BRIGHTNESS 50%",  lambda: build_packet(0x04, [0x01, 0x80])),
    ("BRIGHTNESS 0%",   lambda: build_packet(0x04, [0x01, 0x00])),
    # Color temperature
    ("TEMP WARM", lambda: build_packet(0x0D, [0x01, 0x07, 0xD0])),
    ("TEMP COOL", lambda: build_packet(0x0D, [0x01, 0x07, 0xFF])),
    # Scene (0x0018 = disco scene?)
    ("SCENE 0x0018", lambda: build_packet(0x05, [0x03, 0x00, 0x18])),
    # Proprietary commands seen in captures
    ("PROP 0x15 00", lambda: build_packet(0x15, [0x00])),
    ("PROP 0xA1 01", lambda: build_packet(0xA1, [0x01])),
]


async def test_device(name: str, mac: str, results: list):
    received = []

    def ind_handler(char: BleakGATTCharacteristic, data: bytearray):
        received.append(bytes(data))

    print(f"\n{'='*60}")
    print(f"  Testing {name} ({mac})")
    print(f"{'='*60}")

    try:
        async with BleakClient(mac, timeout=15.0) as client:
            print(f"  Connected")

            # Try subscribing to notify char
            try:
                await client.start_notify(NOTIFY_CHAR, ind_handler)
                print(f"  Subscribed to notify char")
            except Exception as e:
                print(f"  Notify subscribe failed: {e}")

            await asyncio.sleep(0.5)

            for cmd_name, cmd_fn in COMMANDS:
                try:
                    cmd_bytes = cmd_fn()
                    await client.write_gatt_char(WRITE_CHAR, cmd_bytes, response=False)
                    print(f"  ✅ {cmd_name}: {cmd_bytes.hex(' ')}")
                    results.append((name, cmd_name, "OK", None))
                except Exception as e:
                    print(f"  ❌ {cmd_name}: {e}")
                    results.append((name, cmd_name, "FAIL", str(e)))

                await asyncio.sleep(0.5)

            # Also try ALT UUIDs if available
            print(f"\n  --- Testing ALT UUIDs ---")
            for cname, cbytes in [("ALT POWER OFF", build_packet(0x01, [0x00])), ("ALT POWER ON", build_packet(0x01, [0x01]))]:
                try:
                    await client.write_gatt_char(ALT_WRITE, cbytes, response=False)
                    print(f"  ✅ {cname} via ALT: {cbytes.hex(' ')}")
                    results.append((name, cname, "OK", None))
                except Exception as e:
                    print(f"  ❌ {cname} via ALT: {e}")
                    results.append((name, cname, "FAIL", str(e)))
                await asyncio.sleep(0.5)

            if received:
                print(f"\n  Notifications received: {len(received)}")
                for r in received:
                    print(f"    {r.hex(' ')}")
            else:
                print(f"\n  No notifications received.")

    except Exception as e:
        print(f"  ❌ Connection failed: {e}")
        results.append((name, "CONNECTION", "FAIL", str(e)))


async def main():
    results = []
    # Run sequentially to avoid BLE stack conflicts
    for name, mac in DEVICES:
        await test_device(name, mac, results)

    print(f"\n\n{'='*60}")
    print("  SUMMARY")
    print(f"{'='*60}")
    for device, cmd, status, err in results:
        if status == "OK":
            print(f"  ✅ {device}: {cmd}")
        else:
            print(f"  ❌ {device}: {cmd} — {err}")


if __name__ == "__main__":
    asyncio.run(main())
