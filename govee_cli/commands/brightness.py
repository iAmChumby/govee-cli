"""brightness command — routes to cloud v1, cloud v2, or BLE per the model registry."""

import click

from govee_cli.commands._common import resolve
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V1, CLOUD_V2


@click.command()
@click.argument("value", type=click.IntRange(1, 100))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, value: int, mac: str | None, adapter: str) -> None:
    """Set brightness (1-100)."""
    target = resolve(ctx, mac)

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        try:
            v2_client().set_brightness(target.cloud_model, target.device_id, value)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Brightness set to {value}%")
        return

    if target.transport == CLOUD_V1:
        from govee_cli.http import GoveeHTTP, GoveeHTTPError

        try:
            GoveeHTTP().set_brightness(target.device_id, target.cloud_model, value)
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Brightness set to {value}%")
        return

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_brightness

    async def run() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter) as client:
            await client.execute(encode_brightness(value))
            click.echo(f"Brightness set to {value}%")

    try:
        import asyncio

        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
