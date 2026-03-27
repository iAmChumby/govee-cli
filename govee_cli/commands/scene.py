"""scene command."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_scene
from govee_cli.devices.h6056 import BuiltInScene
from govee_cli.exceptions import GoveeError


@click.command()
@click.argument("scene_name", type=str)
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context, scene_name: str, mac: str | None, adapter: str
) -> None:
    """Play a built-in scene by name (e.g. ocean, fireplace)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    scene = BuiltInScene.get_name(scene_name)
    # TODO: look up scene ID once registry is built
    raise click.ClickException(
        f"Scene '{scene_name}' lookup not yet implemented — "
        "GATT characteristics still need reverse engineering."
    )

    async def run() -> None:
        pass  # placeholder

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
