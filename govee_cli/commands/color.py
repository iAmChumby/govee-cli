"""color command — works for both BLE and HTTP devices."""

import click

from govee_cli.config import load_config, resolve_device_ref
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("hex_color", type=str)
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, hex_color: str, mac: str | None, adapter: str) -> None:
    """Set RGB color (e.g. FF5500 or #FF5500)."""
    mac = mac or ctx.obj.get("default_mac")
    cfg = load_config()

    hex_color = hex_color.lstrip("#")

    # Try to resolve model
    model = None
    if mac:
        try:
            resolved_mac, device_config = resolve_device_ref(cfg, mac)
            mac = resolved_mac
            model = device_config.model
        except Exception:
            pass

    from govee_cli.http import GoveeHTTP, GoveeHTTPError, parse_hex_color

    http_devices = ["H6008", "H6183", "H6056"]
    if model and model.upper() in http_devices:
        try:
            client = GoveeHTTP()
            r, g, b = parse_hex_color(hex_color)
            client.set_color(mac, model, r, g, b)
            click.echo(f"Color set to #{hex_color.upper()}")
            return
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e

    # Fall back to BLE
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_color_hex_for_device

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_color_hex_for_device(hex_color, model))
            click.echo(f"Color set to #{hex_color.upper()}")

    try:
        import asyncio
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e