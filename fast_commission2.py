#!/usr/bin/env python3
"""Pre-warm chip-tool, then trigger factory reset - catch the device immediately."""
import asyncio
import subprocess
import time
import threading
import sys

TARGET_MAC = "5C:E7:53:69:87:FB"
TARGET_NAME = "GVH600887FB"
PASSCODE = 3521152
DISCRIMINATOR = 2354

# chip-tool output collector
chip_output = []
chip_returncode = None
chip_done = False

def run_chip_tool():
    global chip_output, chip_returncode, chip_done
    result = subprocess.run(
        ["chip-tool", "pairing", "ble-wifi", "1", "", "", str(PASSCODE), str(DISCRIMINATOR)],
        capture_output=True, text=True, timeout=120
    )
    chip_output = (result.stdout + "\n" + result.stderr).split("\n")
    chip_returncode = result.returncode
    chip_done = True

async def watch_for_device():
    """Watch for our GVH device with a DIFFERENT advertisement."""
    from bleak import BleakScanner
    
    print("Starting BLE scanner to find GVH in commissioning mode...")
    print(f"Target: {TARGET_MAC} ({TARGET_NAME})")
    print()
    print("Waiting for device to appear with Matter service data (0000fff6-*)...")
    print("Factory reset the bulb NOW - I'll detect it immediately.")
    print()
    
    seen_normal = set()
    last_change = time.time()
    
    async with BleakScanner() as scanner:
        start = time.time()
        
        while True:
            await asyncio.sleep(0.3)
            
            for dev in scanner.discovered_devices:
                addr = dev.address
                if addr != TARGET_MAC:
                    continue
                
                now = time.time()
                
                # Get full advertisement data
                key = f"{addr}:{dev.name}"
                if key not in seen_normal:
                    # First time seeing this device
                    seen_normal.add(key)
                    last_change = now
                    elapsed = now - start
                    print(f"[+{elapsed:.1f}s] Saw {addr} ({dev.name or 'unknown'})")
                    print(f"  service_uuids: {getattr(dev, 'metadata', {}).get('service_uuids', [])}")
                
                # Check if advertisement changed (might indicate commissioning mode)
                # In commissioning mode, the device should add the Matter service to service_uuids
                svc_uuids = getattr(dev, 'metadata', {}).get('service_uuids', [])
                
                if '0000fff6-0000-1000-8000-00805f9b34fb' in svc_uuids:
                    elapsed = now - start
                    print(f"\n*** COMMISSIONING MODE DETECTED at +{elapsed:.1f}s! ***")
                    print(f"Device: {addr}")
                    print()
                    return True
                    
            # Check if chip-tool is done
            if chip_done:
                return False

async def main():
    global chip_done
    
    # Start chip-tool in background thread FIRST
    print("Starting chip-tool in background...")
    chip_thread = threading.Thread(target=run_chip_tool)
    chip_thread.start()
    
    # Give chip-tool a moment to initialize
    await asyncio.sleep(2)
    
    # Now watch for the device
    found = await watch_for_device()
    
    # Wait for chip-tool to finish
    print("\nWaiting for chip-tool to complete...")
    chip_thread.join(timeout=120)
    
    # Print chip-tool output
    print("\n" + "="*60)
    print("CHIP-TOOL OUTPUT:")
    print("="*60)
    for line in chip_output[:100]:
        print(line)
    print(f"Return code: {chip_returncode}")
    
    if chip_returncode == 0:
        print("\n*** SUCCESS! Device commissioned! ***")
    else:
        print("\n*** FAILED ***")

if __name__ == "__main__":
    asyncio.run(main())
