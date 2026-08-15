"""color command — routes to cloud v1, cloud v2, or BLE per the model registry."""

import click

from govee_cli.commands._common import parse_hex, resolve
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V1, CLOUD_V2


@click.command()
@click.argument("hex_color", type=str)
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, hex_color: str, mac: str | None, adapter: str) -> None:
    """Set RGB color (e.g. FF5500 or #FF5500)."""
    target = resolve(ctx, mac)
    r, g, b = parse_hex(hex_color)
    pretty = f"#{r:02X}{g:02X}{b:02X}"

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        try:
            v2_client().set_color(target.cloud_model, target.device_id, r, g, b)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Color set to {pretty}")
        return

    if target.transport == CLOUD_V1:
        from govee_cli.http import GoveeHTTP, GoveeHTTPError

        try:
            GoveeHTTP().set_color(target.device_id, target.cloud_model, r, g, b)
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Color set to {pretty}")
        return

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_color_hex_for_device

    async def run() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter) as client:
            await client.execute(
                encode_color_hex_for_device(hex_color.lstrip("#"), target.model)
            )
            click.echo(f"Color set to {pretty}")

    try:
        import asyncio

        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
