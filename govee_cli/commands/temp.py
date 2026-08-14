"""temp command — white color temperature, validated against the model's real range."""

import click

from govee_cli.commands._common import resolve
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V1, CLOUD_V2


@click.command()
@click.argument("kelvin", type=int)
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, kelvin: int, mac: str | None, adapter: str) -> None:
    """Set white color temperature in Kelvin.

    The valid range is per-model (the H6022 accepts 2700-6500K, the H6056
    2000-9000K), so it is checked against the resolved device rather than a
    single global range.
    """
    target = resolve(ctx, mac)

    spec = target.spec
    if spec and not spec.temp_min <= kelvin <= spec.temp_max:
        raise click.ClickException(
            f"{kelvin}K is out of range for {spec.model}. "
            f"Valid range: {spec.temp_min}-{spec.temp_max}K."
        )

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        try:
            v2_client().set_color_temp(target.cloud_model, target.device_id, kelvin)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Color temperature set to {kelvin}K")
        return

    if target.transport == CLOUD_V1:
        from govee_cli.http import GoveeHTTP, GoveeHTTPError

        try:
            GoveeHTTP().set_color_temp(target.device_id, target.cloud_model, kelvin)
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e
        click.echo(f"Color temperature set to {kelvin}K")
        return

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_temp_for_device

    async def run() -> None:
        async with GoveeBLE(target.device_id, adapter=adapter) as client:
            await client.execute(encode_temp_for_device(kelvin, target.model))
            click.echo(f"Color temperature set to {kelvin}K")

    try:
        import asyncio

        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
