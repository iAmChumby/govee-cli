#!/usr/bin/env python3
"""Test CLI with alternative H6008 UUID."""

import asyncio
import click
from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_power, GoveeCharacteristic

H6008_MAC = "5C:E7:53:69:87:FB"


@click.command()
@click.argument("state", type=click.Choice(["on", "off"]))
@click.option("--alt-uuid", is_flag=True, help="Use alternative H6008 UUID")
def test_command(state: str, alt_uuid: bool):
    """Test power command with optional alternative UUID."""
    write_uuid = GoveeCharacteristic.ALT_WRITE if alt_uuid else GoveeCharacteristic.WRITE

    click.echo(f"Testing: Power {state}")
    click.echo(f"Device: {H6008_MAC}")
    click.echo(f"UUID: {write_uuid}")
    click.echo(f"Type: {'Alternative' if alt_uuid else 'Standard'}")

    async def run():
        async with GoveeBLE(H6008_MAC, adapter="hci0") as client:
            on = state == "on"
            packet = encode_power(on)

            # Force use of alternative UUID by monkey-patching
            if alt_uuid:
                from govee_cli.ble import gatt

                original_write = gatt.GoveeCharacteristic.WRITE
                gatt.GoveeCharacteristic.WRITE = GoveeCharacteristic.ALT_WRITE
                click.echo("⚠️  Using alternative UUID")

            try:
                await client.execute(packet)
                click.echo(f"✅ Command sent: Power {state}")
            finally:
                if alt_uuid:
                    gatt.GoveeCharacteristic.WRITE = original_write

    asyncio.run(run())


if __name__ == "__main__":
    test_command()
