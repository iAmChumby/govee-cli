"""effect command."""

import pathlib

import click


@click.command()
@click.argument("effect_file", type=click.Path(exists=True, path_type=pathlib.Path))
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context,
    effect_file: pathlib.Path,
    mac: str | None,
    adapter: str,
) -> None:
    """Play a DIY effect from a JSON file (see SPEC.md for format)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    raise click.ClickException(
        "Effect playback not yet implemented — requires GATT characteristic verification."
    )
