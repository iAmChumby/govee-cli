#!/usr/bin/env python3
"""
Subscribe to all notify/indicate characteristics on the H6008 and watch
for any data the bulb sends while the Govee app controls it.
"""

import asyncio
from bleak import BleakClient, BleakGATTCharacteristic

MAC = "5C:E7:53:69:87:FB"


async def run() -> None:
    def handler(char: BleakGATTCharacteristic, data: bytearray) -> None:
        print(f"  << {char.uuid}  {bytes(data).hex(' ')}")

    async with BleakClient(MAC, timeout=15.0) as client:
        print("Connected. Subscribing to all notify/indicate characteristics...")
        for svc in client.services:
            for ch in svc.characteristics:
                if "notify" in ch.properties or "indicate" in ch.properties:
                    try:
                        await client.start_notify(ch.uuid, handler)
                        print(f"  Subscribed: {ch.uuid}  [{', '.join(ch.properties)}]")
                    except Exception as e:
                        print(f"  Failed {ch.uuid}: {e}")

        print()
        print("Now use the Govee app to turn the bulb off and on.")
        print("Watching for 30 seconds...")
        await asyncio.sleep(30)
        print("Done.")


asyncio.run(run())
