"""scan command — discover nearby Govee devices."""

import asyncio

import click

from govee_cli.ble.scanner import discover_devices, is_govee_device


@click.command()
@click.option("--timeout", type=float, default=5.0)
@click.pass_context
def command(ctx: click.Context, timeout: float) -> None:
    """Scan for nearby Govee BLE devices."""
    click.echo(f"Scanning for {timeout}s...")

    async def run() -> None:
        devices = await discover_devices(timeout)
        govee_devices = [d for d in devices if is_govee_device(d)]

        if not govee_devices:
            click.echo("No Govee devices found.")
            return

        click.echo(f"\nFound {len(govee_devices)} Govee device(s):\n")
        for d in govee_devices:
            click.echo(f"  {d.mac}  {d.name or '(no name)'}  (RSSI: {d.rssi} dBm)")

    asyncio.run(run())
