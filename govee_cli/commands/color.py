"""color command."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_color_hex_for_device
from govee_cli.config import load_config, resolve_device_ref
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("hex_color", type=str)
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(ctx: click.Context, hex_color: str, mac: str | None, adapter: str) -> None:
    """Set RGB color (e.g. FF5500)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    cfg = load_config()
    device_model = None

    if mac:
        try:
            resolved_mac, device_config = resolve_device_ref(cfg, mac)
            mac = resolved_mac
            device_model = device_config.model
        except Exception:
            # Keep original MAC if resolution fails, model stays None
            pass

    hex_color = hex_color.lstrip("#")

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_color_hex_for_device(hex_color, device_model))
            click.echo(f"Color set to #{hex_color.upper()}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
