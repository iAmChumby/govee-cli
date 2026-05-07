"""brightness command — works for both BLE and HTTP devices."""

import click

from govee_cli.config import load_config, resolve_device_ref
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("value", type=click.IntRange(1, 100))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, value: int, mac: str | None, adapter: str) -> None:
    """Set brightness (1-100)."""
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

    from govee_cli.http import GoveeHTTP, GoveeHTTPError

    http_devices = ["H6008", "H6183", "H6056"]
    if model and model.upper() in http_devices:
        try:
            client = GoveeHTTP()
            client.set_brightness(mac, model, value)
            click.echo(f"Brightness set to {value}%")
            return
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e

    # Fall back to BLE
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_brightness

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_brightness(value))
            click.echo(f"Brightness set to {value}%")

    try:
        import asyncio
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e