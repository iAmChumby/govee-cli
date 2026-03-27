"""replay command — play back a recorded capture."""

import pathlib

import click

from govee_cli.scenes.effects import Effect


@click.command()
@click.option("--file", "-f", type=click.Path(exists=True, path_type=pathlib.Path), required=True)
@click.option("--loop", is_flag=True, help="Loop the effect")
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context,
    file: pathlib.Path,
    loop: bool,
    mac: str | None,
    adapter: str,
) -> None:
    """Replay a recorded capture file or DIY effect."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    raise click.ClickException(
        "Replay not yet implemented — requires GATT characteristic verification."
    )
