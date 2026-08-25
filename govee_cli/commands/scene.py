"""scene command — firmware scenes over the cloud (v2 models) or BLE (H6056)."""

import asyncio
from typing import TYPE_CHECKING

import click

from govee_cli import ledger
from govee_cli.commands._common import resolve, v2_client
from govee_cli.exceptions import GoveeError
from govee_cli.scenes.effects import BuiltInScene
from govee_cli.transport import CLOUD_V2

if TYPE_CHECKING:
    from govee_cli.commands._common import Target


def _list_cloud_scenes(target: "Target") -> None:
    from govee_cli.http_v2 import GoveeV2Error

    try:
        scenes = v2_client().get_scenes(target.cloud_model, target.device_id)
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    if not scenes:
        raise click.ClickException(
            f"No scenes reported for '{target.label}'. The device may be offline."
        )
    click.echo(f"{len(scenes)} scene(s) available on {target.label} [{target.model}]:\n")
    for s in scenes:
        click.echo(f"  {s.name}")


def _list_ble_scenes() -> None:
    click.echo("Available built-in scenes:")
    for s in BuiltInScene.get_available_scenes():
        click.echo(f"  {s.id}: {s.name}")


@click.command()
@click.argument("scene_name", type=str)
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.option("--refresh", is_flag=True, help="Bypass the cached scene list")
@click.option("--ble", "force_ble", is_flag=True,
              help="Use the BLE built-in scene table instead of the cloud library")
@click.pass_context
def command(ctx: click.Context, scene_name: str, mac: str | None, adapter: str,
            refresh: bool, force_ble: bool) -> None:
    """Play a scene by name (e.g. sunrise, aurora, rainbow).

    Run 'govee-cli scene list --device <name>' to see what a device supports.
    Cloud-connected models fetch their real scene library from Govee, which is
    both larger and more reliable than the BLE table (the H6056 gets 69 scenes
    over the cloud versus 27 built in, several of which need a multi-packet BLE
    protocol that was never reverse engineered).

    --ble forces the built-in table on a device that can do both.
    """
    listing = scene_name.lower() == "list"
    try:
        target = resolve(ctx, mac)
    except click.ClickException:
        # Listing needs no device to show the BLE built-ins, so don't demand one.
        if listing:
            _list_ble_scenes()
            return
        raise

    if target.transport == CLOUD_V2 and not force_ble:
        from govee_cli.http_v2 import GoveeV2Error

        if scene_name.lower() == "list":
            _list_cloud_scenes(target)
            return

        client = v2_client()
        try:
            if refresh:
                client.get_scenes(target.cloud_model, target.device_id, use_cache=False)
            scene = client.find_scene(target.cloud_model, target.device_id, scene_name)
            if scene is None:
                names = [s.name for s in client.get_scenes(target.cloud_model, target.device_id)]
                raise click.ClickException(
                    f"Unknown scene '{scene_name}' for {target.model}. "
                    f"Run `govee-cli scene list --device \"{target.label}\"` "
                    f"to see all {len(names)} scenes."
                )
            client.set_scene(target.cloud_model, target.device_id, scene)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        ledger.record_mode(
            target.device_id, "scene", scene.name,
            {"scene_id": scene.scene_id, "param_id": scene.param_id},
            source="cli",
        )
        click.echo(f"Playing scene: {scene.name}")
        return

    # BLE path (H6056 and anything unregistered).
    if scene_name.lower() == "list":
        _list_ble_scenes()
        return

    builtin = BuiltInScene.get_by_name(scene_name)
    if builtin is None:
        available = [s.name for s in BuiltInScene.get_available_scenes()]
        raise click.ClickException(
            f"Unknown scene: '{scene_name}'. Available: {', '.join(available)}"
        )

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_scene

    async def run() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter) as client:
            await client.execute(encode_scene(builtin.id))
            click.echo(f"Playing scene: {builtin.name}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
