#!/usr/bin/env python3
"""Dump full advertisement data for the H6008 bulbs."""

import asyncio
from bleak import BleakScanner
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

TARGETS = {"5C:E7:53:69:87:FB", "5C:E7:53:63:8F:01"}


def dump_adv(device: BLEDevice, adv: AdvertisementData) -> None:
    print(f"\n{'='*60}")
    print(f"  Name   : {device.name or adv.local_name or '(none)'}")
    print(f"  Address: {device.address}")
    print(f"  RSSI   : {adv.rssi}")
    if adv.manufacturer_data:
        for company_id, data in adv.manufacturer_data.items():
            print(f"  Mfr ID : 0x{company_id:04X} ({company_id})  data: {data.hex(' ')}")
    if adv.service_uuids:
        print(f"  Service UUIDs:")
        for uuid in adv.service_uuids:
            print(f"    - {uuid}")
    if adv.service_data:
        print(f"  Service Data:")
        for uuid, data in adv.service_data.items():
            print(f"    - {uuid}: {data.hex(' ')}")
    if adv.tx_power is not None:
        print(f"  TX Power: {adv.tx_power} dBm")


async def run() -> None:
    print("Scanning 10 seconds for H6008 bulbs...")

    def callback(device: BLEDevice, adv: AdvertisementData) -> None:
        if device.address.upper() in TARGETS:
            dump_adv(device, adv)

    async with BleakScanner(callback) as scanner:
        await asyncio.sleep(10)

    print("\nDone.")


asyncio.run(run())
