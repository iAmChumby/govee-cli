#!/usr/bin/env python3
"""Watch for GVH devices and fire chip-tool immediately when seen."""
import asyncio
import subprocess
import time
from bleak import BleakScanner

OUR_DEVICES = {
    "5C:E7:53:69:87:FB": "GVH600887FB",
    "5C:E7:53:63:8F:01": "GVH60088F01",
}
TARGET_DISCRIMINATOR = 2354
PASSCODE = 3521152
NODE_ID = 1

async def main():
    print(f"Watching for GVH devices...")
    print(f"Target: discriminator={TARGET_DISCRIMINATOR}, passcode={PASSCODE}")
    print(f"When you power cycle the bulb (4x fast), it will blink.")
    print(f"I'll fire chip-tool the moment I see either GVH MAC.")
    print()

    fired = False
    last_seen = {}

    while not fired:
        # Continuous scan - no timeout, just keep scanning
        try:
            async with BleakScanner() as scanner:
                start = time.time()
                seen_this_round = False
                
                while time.time() - start < 10:
                    # Check for devices every 0.5s for 10 seconds
                    await asyncio.sleep(0.5)
                    
                    for dev in scanner.discovered_devices:
                        addr = dev.address
                        if addr not in OUR_DEVICES:
                            continue
                        
                        name = dev.name or OUR_DEVICES[addr]
                        now = time.time()
                        
                        if addr not in last_seen or now - last_seen[addr] > 2:
                            last_seen[addr] = now
                            elapsed = now - start
                            print(f"[+{elapsed:.1f}s] Saw {addr} ({name})")
                            seen_this_round = True
                            
                            # ANY GVH device seen - fire chip-tool immediately!
                            print(f"\n*** FIRING chip-tool NOW for {addr} ({name}) ***")
                            print()
                            
                            result = subprocess.run(
                                ["chip-tool", "pairing", "ble-wifi",
                                 str(NODE_ID), "", "", str(PASSCODE), str(TARGET_DISCRIMINATOR)],
                                capture_output=True, text=True, timeout=120
                            )
                            print("STDOUT:", result.stdout[:3000] if result.stdout else "(empty)")
                            print("STDERR:", result.stderr[:3000] if result.stderr else "(empty)")
                            print("Return code:", result.returncode)
                            
                            if result.returncode == 0:
                                print("*** SUCCESS ***")
                            else:
                                print("*** FAILED ***")
                            
                            fired = True
                            break
                
                if not seen_this_round:
                    print(f"[{time.time()-start:.1f}s] No GVH devices seen in this 10s window")
                    
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"Error: {e}")
            await asyncio.sleep(1)

    print("\nDone.")

if __name__ == "__main__":
    asyncio.run(main())
