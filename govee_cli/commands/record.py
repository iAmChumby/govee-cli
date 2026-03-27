"""record command — capture BLE packets from Govee app."""

import asyncio
import pathlib

import click

from govee_cli.scenes.capture import run_capture


@click.command()
@click.option("--output", "-o", type=click.Path(path_type=pathlib.Path), default="capture.json")
@click.option("--timeout", type=float, default=60.0)
@click.option("--device", "mac", help="Device MAC address")
@click.pass_context
def command(ctx: click.Context, output: pathlib.Path, timeout: float, mac: str | None) -> None:
    """Record BLE packets from the Govee app for reverse engineering.

    Run this command, then use the Govee app on your phone to trigger
    the effect you want to capture. Press Ctrl+C when done.
    """
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException(
            "No device MAC specified. Use --device or set default."
        )

    click.echo(f"Recording BLE traffic to {output}. Trigger effects in the Govee app.")
    click.echo("Press Ctrl+C to stop.")

    try:
        asyncio.run(run_capture(mac, output, timeout))
    except Exception as e:
        raise click.ClickException(str(e)) from e
