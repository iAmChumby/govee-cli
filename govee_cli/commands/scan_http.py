"""scan-http command — discover Govee devices via the HTTP API and register them."""

import click

from govee_cli.config import DeviceConfig, load_config, save_config
from govee_cli.http import GoveeHTTP, GoveeHTTPError


@click.command()
@click.option("--sync/--no-sync", default=True, help="Sync devices to config")
@click.pass_context
def command(ctx: click.Context, sync: bool) -> None:
    """Scan for Govee WiFi/Matter devices via the HTTP API.

    Fetches all devices linked to your Govee account and registers
    them in the local config so they can be controlled by name.

    Requires GOVEE_API_KEY in config or environment.
    """
    try:
        client = GoveeHTTP()
        devices = client.get_devices()
    except GoveeHTTPError as e:
        raise click.ClickException(f"Failed to fetch devices: {e}") from e
    except Exception as e:
        raise click.ClickException(f"API error: {e}") from e

    if not devices:
        click.echo("No devices found via HTTP API.")
        return

    click.echo(f"\nFound {len(devices)} device(s):\n")
    for d in devices:
        cmds = ", ".join(d.supported_commands)
        click.echo(f"  {d.device_id}  {d.name or '(no name)'}  [{d.model}]")
        click.echo(f"    Commands: {cmds}")

    if not sync:
        return

    cfg = load_config()
    for d in devices:
        mac = d.device_id.upper()
        # Don't overwrite existing names unless this one has one
        existing = cfg.devices.get(mac)
        name = d.name or (existing.name if existing else None)
        cfg.devices[mac] = DeviceConfig(model=d.model, name=name)

    save_config(cfg)
    click.echo(f"\nSynced {len(devices)} device(s) to config.")