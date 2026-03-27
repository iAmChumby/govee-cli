"""segments command."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_segment
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("segment_id", type=click.IntRange(0, 15))
@click.argument("hex_color", type=str)
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context, segment_id: int, hex_color: str, mac: str | None, adapter: str
) -> None:
    """Set color for a specific segment (0-15)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    hex_color = hex_color.lstrip("#")
    r = int(hex_color[0:2], 16)
    g = int(hex_color[2:4], 16)
    b = int(hex_color[4:6], 16)

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_segment(segment_id, r, g, b))
            click.echo(f"Segment {segment_id} set to #{hex_color.upper()}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
