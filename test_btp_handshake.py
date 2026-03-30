#!/usr/bin/env python3
"""
Test Matter BTP handshake on H6008.

Sends the BTP (Bluetooth Transport Protocol) handshake to the Matter C1
characteristic and listens on C2 for an indication response.

If the device replies, it confirms Matter BTP is active and we know the
control channel. If it stays silent, BTP is not in use here.
"""

import asyncio
from bleak import BleakClient, BleakGATTCharacteristic

MAC = "5C:E7:53:69:87:FB"

# Matter CHIPoBLE C1 (write to device) / C2 (device indicates back)
C1_WRITE  = "18ee2ef5-263d-4559-959f-4f9c429f9d11"
C2_NOTIFY = "18ee2ef5-263d-4559-959f-4f9c429f9d12"

# BTP handshake request (Matter spec §3.12):
#   0x65 = control flags (handshake request)
#   0x6C = management opcode
#   0x04 = BTP version 4
#   0xF4 0x00 = fragment size 244 (LE)
#   0x04 = window size 4
#   0x00 0x00 0x00 = reserved
BTP_HANDSHAKE = bytes([0x65, 0x6C, 0x04, 0xF4, 0x00, 0x04, 0x00, 0x00, 0x00])


async def run() -> None:
    received: list[bytes] = []

    def on_indicate(char: BleakGATTCharacteristic, data: bytearray) -> None:
        received.append(bytes(data))
        print(f"  << C2 indication: {bytes(data).hex(' ')}")

    print(f"Connecting to {MAC}...")
    async with BleakClient(MAC, timeout=15.0) as client:
        print("Connected.\n")

        # Subscribe to C2 indications
        try:
            await client.start_notify(C2_NOTIFY, on_indicate)
            print(f"Subscribed to C2 indications ({C2_NOTIFY})")
        except Exception as e:
            print(f"Could not subscribe to C2: {e}")
            return

        await asyncio.sleep(0.3)

        # Send BTP handshake to C1 — try with response=True first (ATT Write Request)
        print(f"Sending BTP handshake to C1 (response=True): {BTP_HANDSHAKE.hex(' ')}")
        try:
            await client.write_gatt_char(C1_WRITE, BTP_HANDSHAKE, response=True)
            print("  >> Write with response succeeded")
        except Exception as e:
            print(f"  >> Write with response failed: {e}")
            print(f"     Retrying with response=False...")
            try:
                await client.write_gatt_char(C1_WRITE, BTP_HANDSHAKE, response=False)
                print("  >> Write without response succeeded")
            except Exception as e2:
                print(f"  >> Both writes failed: {e2}")
                return

        # Wait for response
        print("\nWaiting 5 seconds for C2 indication...")
        await asyncio.sleep(5)

        if received:
            print(f"\n✅ Got {len(received)} indication(s) — device speaks BTP!")
            for i, pkt in enumerate(received):
                print(f"   [{i}] {pkt.hex(' ')}  (len={len(pkt)})")
                # Decode BTP handshake response fields if it looks like one
                if len(pkt) >= 6 and pkt[0] & 0x65:
                    print(f"       flags=0x{pkt[0]:02x} opcode=0x{pkt[1]:02x} "
                          f"version={pkt[2]} frag_size={int.from_bytes(pkt[3:5], 'little')} "
                          f"window={pkt[5]}")
        else:
            print("\n❌ No indication received — device did not respond to BTP handshake.")

        try:
            await client.stop_notify(C2_NOTIFY)
        except Exception:
            pass

        print("Done.")


asyncio.run(run())
