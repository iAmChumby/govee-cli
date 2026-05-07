"""power command — works for both BLE and HTTP devices."""

import click

from govee_cli.config import load_config
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("state", type=click.Choice(["on", "off"]))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, state: str, mac: str | None, adapter: str) -> None:
    """Turn power on or off."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    cfg = load_config()

    # Check if this is an HTTP-only device
    from govee_cli.config import resolve_device_ref

    try:
        resolved_mac, device_config = resolve_device_ref(cfg, mac)
        mac = resolved_mac
        model = device_config.model
    except Exception:
        model = None

    on = state == "on"

    # Route to HTTP or BLE
    from govee_cli.http import GoveeHTTP, GoveeHTTPError

    http_devices = ["H6008", "H6183", "H6056"]
    if model and model.upper() in http_devices:
        try:
            client = GoveeHTTP()
            client.turn_on(mac, model) if on else client.turn_off(mac, model)
            click.echo(f"Power {'on' if on else 'off'}")
            return
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e

    # Fall back to BLE
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_power

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_power(on))
            click.echo(f"Power {'on' if on else 'off'}")

    try:
        import asyncio
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e