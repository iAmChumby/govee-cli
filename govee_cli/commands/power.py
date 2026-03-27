"""power command."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_power
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("state", type=click.Choice(["on", "off"]))
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(ctx: click.Context, state: str, mac: str | None, adapter: str) -> None:
    """Turn power on or off."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    on = state == "on"

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_power(on))
            click.echo(f"Power {'on' if on else 'off'}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
