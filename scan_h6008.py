#!/usr/bin/env python3
import asyncio
import sys
sys.path.insert(0, '/home/chumby/projects/govee-cli')
from bleak import BleakScanner

async def scan():
    print("Starting BLE scan...", flush=True)
    devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
    print(f"Scan complete, {len(devices)} devices found", flush=True)
    
    h6008 = {}
    h7126 = {}
    other_govee = {}
    
    for k, v in devices.items():
        name = ""
        if isinstance(v, tuple):
            adv = v[0]
            name = getattr(adv, 'name', '') or ''
        else:
            name = getattr(v, 'name', '') or ''
        
        print(f"  {name} ({k}) RSSI={getattr(v[0] if isinstance(v, tuple) else v, 'rssi', '?')}", flush=True)
        
        if 'H6008' in name:
            h6008[k] = v
        elif 'H7126' in name:
            h7126[k] = v
        elif 'Govee' in name or 'ihoment' in name:
            other_govee[k] = v
    
    print(f"\n=== SUMMARY ===", flush=True)
    print(f"Total: {len(devices)}", flush=True)
    print(f"H6008: {len(h6008)}", flush=True)
    print(f"H7126: {len(h7126)}", flush=True)
    print(f"Other Govee: {len(other_govee)}", flush=True)
    
    return h6008, h7126

asyncio.run(scan())
