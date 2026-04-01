#!/usr/bin/env python3
import asyncio
from bleak import BleakClient

WRITE_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b11'
NOTIFY_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b10'
WRITE_ALT = '00010203-0405-0607-0809-0a0b0c0d1911'
NOTIFY_ALT = '00010203-0405-0607-0809-0a0b0c0d1910'

def xor(data):
    r = 0
    for b in data: r ^= b
    return r

def make_packet(cmd, payload):
    data = bytes([0x33, cmd] + list(payload))
    return data + bytes([xor(data)])

def test_device(mac, label):
    results = []
    async def run():
        async with BleakClient(mac) as client:
            await asyncio.sleep(0.5)
            # Power ON
            await client.write_gatt_char(WRITE_CHAR, make_packet(0x01, bytes([1]+[0]*18)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Power ON', 'OK'))
            # RGB (swapped - device maps R_in→B_out, G_in→R_out, B_in→G_out)
            for name, rgb in [('RED(0,255,0)', (0,255,0)), ('GREEN(255,0,0)', (255,0,0)), ('BLUE(0,0,255)', (0,0,255))]:
                await client.write_gatt_char(WRITE_CHAR, make_packet(0x05, bytes([2,rgb[0],rgb[1],rgb[2]]+[0]*15)), response=False)
                await asyncio.sleep(0.8)
                results.append((f'Color {name}', 'OK'))
            # Brightness
            for pct in [0, 127, 255]:
                await client.write_gatt_char(WRITE_CHAR, make_packet(0x04, bytes([1,pct]+[0]*17)), response=False)
                await asyncio.sleep(0.8)
                results.append((f'Brightness {pct}', 'OK'))
            # Temp warm/cool
            await client.write_gatt_char(WRITE_CHAR, make_packet(0x05, bytes([3,0,0]+[0]*16)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Temp WARM', 'OK'))
            await client.write_gatt_char(WRITE_CHAR, make_packet(0x05, bytes([3,255,255]+[0]*16)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Temp COOL', 'OK'))
            # Scene
            await client.write_gatt_char(WRITE_CHAR, make_packet(0x05, bytes([0x18]+[0x00,0x01]+[0]*16)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Scene 0x0018', 'OK'))
            # Proprietary
            await client.write_gatt_char(WRITE_CHAR, make_packet(0x15, bytes([1]+[0]*18)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Proprietary 0x15', 'OK'))
            await client.write_gatt_char(WRITE_CHAR, make_packet(0xA1, bytes([1]+[0]*18)), response=False)
            await asyncio.sleep(0.8)
            results.append(('Proprietary 0xA1', 'OK'))
            # ALT UUID test - skip if not found
            try:
                await client.write_gatt_char(WRITE_ALT, make_packet(0x01, bytes([1]+[0]*18)), response=False)
                await asyncio.sleep(0.8)
                results.append(('ALT UUID Power', 'OK'))
            except Exception as e:
                results.append(('ALT UUID Power', f'SKIP ({e})'))
    asyncio.run(run())
    return results

if __name__ == '__main__':
    devices = [
        ('5C:E7:53:69:87:FB', 'GVH600887FB'),
        ('5C:E7:53:63:8F:01', 'GVH60088F01'),
    ]
    for mac, label in devices:
        r = test_device(mac, label)
        ok = sum(1 for _, s in r if s == 'OK')
        print(f'{label} ({mac}): {ok}/{len(r)} OK')
        for name, status in r:
            print(f'  {name}: {status}')
