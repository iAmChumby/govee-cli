"""temp command — white color temperature."""

import click

from govee_cli.config import load_config, resolve_device_ref
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("kelvin", type=click.IntRange(2700, 9000))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, kelvin: int, mac: str | None, adapter: str) -> None:
    """Set white color temperature in Kelvin (2700-9000)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    cfg = load_config()
    model = None

    if mac:
        try:
            resolved_mac, device_config = resolve_device_ref(cfg, mac)
            mac = resolved_mac
            model = device_config.model
        except Exception:
            pass

    # HTTP path (H6008 supports colorTemperature)
    from govee_cli.http import GoveeHTTP, GoveeHTTPError

    http_devices = ["H6008", "H6183", "H6056"]
    if model and model.upper() in http_devices:
        try:
            client = GoveeHTTP()
            client.set_color_temp(mac, model, kelvin)
            click.echo(f"Color temperature set to {kelvin}K")
            return
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e

    # BLE fallback
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_temp_for_device

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_temp_for_device(kelvin, model))
            click.echo(f"Color temperature set to {kelvin}K")

    try:
        import asyncio
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e