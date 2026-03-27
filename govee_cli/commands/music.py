"""music command — music sync mode."""

import click


@click.command()
@click.option("--input", "input_src", type=click.Choice(["mic", "file"]), default="mic")
@click.option("--file", "audio_file", type=str, help="Audio file to use (for 'file' mode)")
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
@click.pass_context
def command(
    ctx: click.Context,
    input_src: str,
    audio_file: str | None,
    mac: str | None,
    adapter: str,
) -> None:
    """Real-time music sync mode (mic input or audio file)."""
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    raise click.ClickException(
        "Music sync not yet implemented — requires audio analysis + GATT research."
    )
