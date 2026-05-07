#!/usr/bin/env python3
import asyncio
import sys
sys.path.insert(0, '/home/chumby/projects/govee-cli')
from bleak import BleakScanner, BleakClient

WRITE_CHAR = "00010203-0405-0607-0809-0a0b0c0d2b11"

def make_packet(cmd, payload):
    data = bytes([0x33, cmd] + list(payload))
    checksum = 0
    for b in data:
        checksum ^= b
    return data + bytes([checksum])

async def test_device(name, mac):
    results = []
    try:
        async with BleakClient(mac) as client:
            await asyncio.sleep(0.5)
            
            rssi = getattr(client, 'RSSI', None)
            if rssi:
                results.append(f"  RSSI={rssi}")
            
            cmds = [
                ("Power ON", make_packet(0x01, bytes([1] + [0]*18))),
                ("Color R", make_packet(0x05, bytes([2, 255, 0, 0] + [0]*15))),
                ("Color G", make_packet(0x05, bytes([2, 0, 255, 0] + [0]*15))),
                ("Color B", make_packet(0x05, bytes([2, 0, 0, 255] + [0]*15))),
                ("Brightness 50%", make_packet(0x04, bytes([2, 127] + [0]*17))),
                ("Brightness 100%", make_packet(0x04, bytes([2, 255] + [0]*17))),
                ("Temp Warm", make_packet(0x05, bytes([1, 255, 178, 0] + [0]*15))),
                ("Temp Cool", make_packet(0x05, bytes([1, 255, 255, 255] + [0]*15))),
                ("Scene 0x0018", make_packet(0x05, bytes([0x18, 0x00, 100, 100, 100] + [0]*14))),
                ("Power OFF", make_packet(0x01, bytes([0] + [0]*18))),
            ]
            
            ok = 0
            for label, pkt in cmds:
                try:
                    await client.write_gatt_char(WRITE_CHAR, pkt, response=False)
                    await asyncio.sleep(0.8)
                    ok += 1
                except Exception as e:
                    results.append(f"  FAIL {label}: {e}")
            results.append(f"  {ok}/{len(cmds)} commands succeeded")
            
    except Exception as e:
        results.append(f"  CONNECTION FAILED: {e}")
    
    return results

async def main():
    targets = {
        "GVH600887FB": "5C:E7:53:69:87:FB",
        "GVH60088F01": "5C:E7:53:63:8F:01",
    }
    
    for name, mac in targets.items():
        print(f"Testing {name} ({mac})...", flush=True)
        res = await test_device(name, mac)
        for r in res:
            print(r, flush=True)
        print(flush=True)
    
    # Also test H7126 as reference
    print("Testing H7126 (reference)...", flush=True)
    res = await test_device("H7126", "60:74:F4:94:5A:E9")
    for r in res:
        print(r, flush=True)

asyncio.run(main())
