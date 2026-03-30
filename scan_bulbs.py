#!/usr/bin/env python3
"""Scan for H6008 bulbs and show their current BLE addresses."""

import asyncio
from bleak import BleakScanner


async def scan():
    print("Scanning for 10 seconds...")
    print("=" * 70)

    devices = await BleakScanner.discover(timeout=10, return_adv=True)

    found = False
    for addr, (device, adv) in devices.items():
        name = device.name or adv.local_name or "Unknown"
        if any(x in name.lower() for x in ["h6008", "gv", "ihoment"]):
            print(f"\n🎯 {name}")
            print(f"   Address: {addr}")
            print(f"   RSSI: {adv.rssi}")
            found = True

    if not found:
        print("\nNo H6008 bulbs found")


if __name__ == "__main__":
    asyncio.run(scan())
