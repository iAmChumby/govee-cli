"""scene command."""

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import encode_scene
from govee_cli.exceptions import GoveeError
from govee_cli.scenes.effects import BuiltInScene


@click.command()
@click.argument("scene_name", type=str)
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context, scene_name: str, mac: str | None, adapter: str
) -> None:
    """Play a built-in scene by name (e.g. ocean, fireplace).

    Run 'govee-cli scene list' to see available scenes.
    """
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    # Handle 'list' subcommand
    if scene_name == "list":
        scenes = BuiltInScene.get_available_scenes()
        click.echo("Available built-in scenes:")
        for s in scenes:
            click.echo(f"  {s.id}: {s.name}")
        return

    # Look up scene by name
    scene = BuiltInScene.get_by_name(scene_name)
    if scene is None:
        available = [s.name for s in BuiltInScene.get_available_scenes()]
        raise click.ClickException(
            f"Unknown scene: '{scene_name}'. Available: {', '.join(available)}"
        )

    async def run() -> None:
        async with GoveeBLE(mac, adapter=adapter) as client:
            await client.execute(encode_scene(scene.id))
            click.echo(f"Playing scene: {scene.name}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
