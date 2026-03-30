#!/usr/bin/env python3
"""Scan for H6008 bulbs and show current addresses."""

import asyncio
from bleak import BleakScanner


async def scan():
    print("Scanning for 10 seconds...")
    print("Look for devices with names like 'GVH6008' or 'ihoment_H6008'")
    print("=" * 70)

    devices = await BleakScanner.discover(timeout=10, return_adv=True)

    for addr, (device, adv) in devices.items():
        name = device.name or adv.local_name or "Unknown"
        if "h6008" in name.lower() or "gv" in name.lower() or "ihoment" in name.lower():
            print(f"\n🎯 {name}")
            print(f"   Address: {addr}")
            print(f"   RSSI: {adv.rssi}")
            print(f"   Use this address: {addr}")


if __name__ == "__main__":
    asyncio.run(scan())
