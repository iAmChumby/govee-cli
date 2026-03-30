#!/usr/bin/env python3
"""Discover H6008 GATT services and characteristics."""

import asyncio
import sys
from bleak import BleakClient

# H6008 Lamp Front MAC from your config
H6008_MAC = "5C:E7:53:69:87:FB"

# H6056 UUIDs (for comparison)
H6056_SERVICE = "00010203-0405-0607-0809-0a0b0c0d1910"
H6056_WRITE = "00010203-0405-0607-0809-0a0b0c0d2b11"
H6056_NOTIFY = "00010203-0405-0607-0809-0a0b0c0d2b10"


async def discover_device(mac: str):
    """Connect and discover all GATT services/characteristics."""
    print(f"\n{'=' * 70}")
    print(f"DISCOVERING: {mac}")
    print(f"{'=' * 70}\n")

    try:
        async with BleakClient(mac) as client:
            print(f"✅ Connected successfully!\n")

            print(f"{'=' * 70}")
            print(f"GATT SERVICES")
            print(f"{'=' * 70}")

            found_write = None
            found_notify = None

            for service in client.services:
                print(f"\n📡 Service: {service.uuid}")

                # Check if this is the H6056 service UUID
                if service.uuid.lower() == H6056_SERVICE.lower():
                    print(f"   ✓ MATCHES H6056 service UUID")

                for char in service.characteristics:
                    props = ",".join(char.properties)
                    print(f"\n   🔧 Characteristic: {char.uuid}")
                    print(f"      Handle: 0x{char.handle:04X}")
                    print(f"      Properties: {props}")

                    # Check against H6056 UUIDs
                    if char.uuid.lower() == H6056_WRITE.lower():
                        print(f"      ✓ MATCHES H6056 WRITE UUID")
                        found_write = char
                    if char.uuid.lower() == H6056_NOTIFY.lower():
                        print(f"      ✓ MATCHES H6056 NOTIFY UUID")
                        found_notify = char

                    # Try to read value
                    if "read" in char.properties:
                        try:
                            val = await client.read_gatt_char(char.uuid)
                            print(f"      Value: {val.hex()}")
                        except Exception as e:
                            print(f"      Read Error: {e}")

                    # Note if it's writeable
                    if "write" in char.properties:
                        print(f"      ✓ Can WRITE to this characteristic")

            # Summary
            print(f"\n{'=' * 70}")
            print(f"SUMMARY")
            print(f"{'=' * 70}")
            print(f"H6056 Write UUID found: {'YES' if found_write else 'NO'}")
            print(f"H6056 Notify UUID found: {'YES' if found_notify else 'NO'}")

            if found_write:
                print(f"\n✓ Device uses standard H6056 GATT UUIDs")
                print(f"  The 'Write Not Permitted' error is likely a")
                print(f"  PAIRING or BONDING issue, not UUID mismatch.")
            else:
                print(f"\n⚠ Device uses DIFFERENT GATT UUIDs than H6056")
                print(f"  Need to update protocol.py with correct UUIDs.")

    except Exception as e:
        print(f"\n❌ Error: {e}")
        return 1

    return 0


if __name__ == "__main__":
    # Check if MAC provided as argument
    mac = sys.argv[1] if len(sys.argv) > 1 else H6008_MAC
    result = asyncio.run(discover_device(mac))
    sys.exit(result)
