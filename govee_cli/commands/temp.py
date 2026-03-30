"""temp command — white color temperature."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_temp
from govee_cli.config import load_config, resolve_device_ref
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("kelvin", type=click.IntRange(2700, 6500))
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(ctx: click.Context, kelvin: int, mac: str | None, adapter: str) -> None:
    """Set white color temperature in Kelvin (2700-6500)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    if mac:
        cfg = load_config()
        try:
            resolved_mac, _ = resolve_device_ref(cfg, mac)
            mac = resolved_mac
        except Exception:
            pass  # Keep original if resolution fails

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_temp(kelvin))
            click.echo(f"Color temperature set to {kelvin}K")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
