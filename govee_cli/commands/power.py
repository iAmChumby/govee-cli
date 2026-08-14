"""power command — routes to cloud v1, cloud v2, or BLE per the model registry."""

import click

from govee_cli.commands._common import resolve
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V1, CLOUD_V2


@click.command()
@click.argument("state", type=click.Choice(["on", "off"]))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, state: str, mac: str | None, adapter: str) -> None:
    """Turn power on or off."""
    target = resolve(ctx, mac)
    on = state == "on"

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        client = v2_client()
        try:
            if on:
                client.turn_on(target.cloud_model, target.device_id)
            else:
                client.turn_off(target.cloud_model, target.device_id)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Power {'on' if on else 'off'}")
        return

    if target.transport == CLOUD_V1:
        from govee_cli.http import GoveeHTTP, GoveeHTTPError

        try:
            v1 = GoveeHTTP()
            if on:
                v1.turn_on(target.device_id, target.cloud_model)
            else:
                v1.turn_off(target.device_id, target.cloud_model)
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Power {'on' if on else 'off'}")
        return

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_power

    async def run() -> None:
        async with GoveeBLE(target.device_id, adapter=adapter) as client:
            await client.execute(encode_power(on))
            click.echo(f"Power {'on' if on else 'off'}")

    try:
        import asyncio

        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
