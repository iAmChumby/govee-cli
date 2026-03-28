"""info command — print device info and current state."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.exceptions import GoveeError


@click.command()
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(ctx: click.Context, mac: str | None, adapter: str) -> None:
    """Print device info and current state."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            state = await client.read_state()
            click.echo(f"Device: {mac}")
            click.echo(f"Power: {'On' if state.power else 'Off'}")
            brightness_str = (
                f"{state.brightness}%" if state.brightness is not None
                else "N/A (not reported by device)"
            )
            click.echo(f"Brightness: {brightness_str}")
            r, g, b = state.color
            click.echo(f"Color: #{r:02X}{g:02X}{b:02X}")
            if state.color_temp:
                click.echo(f"Color Temp: {state.color_temp}K")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
