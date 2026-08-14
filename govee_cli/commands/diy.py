"""diy command — activate DIY scenes authored in the Govee app.

DIY scenes are user-created and live in the Govee cloud, so unlike firmware
scenes they are never cached: the user can add or edit one in the app at any
moment and expect the CLI to see it immediately.
"""

import click

from govee_cli.commands._common import require_v2, resolve


@click.command()
@click.argument("name", type=str, required=False)
@click.option("--device", "mac", help="Device MAC address or name")
@click.pass_context
def command(ctx: click.Context, name: str | None, mac: str | None) -> None:
    """Activate a DIY scene by name, or list them.

    \b
      govee-cli diy --device "Shelf Lamp"          # list
      govee-cli diy sleep --device "Shelf Lamp"    # activate
    """
    target = resolve(ctx, mac)
    client = require_v2(target, "DIY scenes")

    from govee_cli.http_v2 import GoveeV2Error

    try:
        scenes = client.get_diy_scenes(target.cloud_model, target.device_id)
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    if name is None or name.lower() == "list":
        if not scenes:
            click.echo(
                f"No DIY scenes found for {target.label}. "
                f"Create one in the Govee app and it will show up here."
            )
            return
        click.echo(f"DIY scenes on {target.label} [{target.model}]:")
        for s in scenes:
            click.echo(f"  {s.name}")
        return

    try:
        scene = client.find_diy_scene(target.cloud_model, target.device_id, name)
        if scene is None:
            available = ", ".join(s.name for s in scenes) or "(none)"
            raise click.ClickException(
                f"Unknown DIY scene '{name}'. Available: {available}"
            )
        client.set_diy_scene(target.cloud_model, target.device_id, scene.value)
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    click.echo(f"Playing DIY scene: {scene.name}")
