"""scan-http command — discover Govee devices via the cloud API and register them."""

import click

from govee_cli.config import DeviceConfig, load_config, save_config
from govee_cli.devices import SUPPORTED_DEVICES
from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error
from govee_cli.transport import transport_for

# Govee returns saved app groups alongside real devices. They are not
# controllable in any useful way here and must not be written to the registry.
_PSEUDO_SKUS = {"BASEGROUP", "SAMEMODEGROUP"}


@click.command()
@click.option("--sync/--no-sync", default=True, help="Sync devices to config")
@click.pass_context
def command(ctx: click.Context, sync: bool) -> None:
    """Scan for Govee WiFi/Matter devices via the cloud API and register them.

    Uses the v2 API, which lists every device on the account along with its full
    capability set. The legacy v1 API omits some models entirely (the H6022, for
    one), so it is not used for discovery.

    Requires GOVEE_API_KEY in config or environment.
    """
    try:
        client = GoveeHTTPv2()
        devices = client.get_devices()
    except GoveeV2Error as e:
        raise click.ClickException(f"Failed to fetch devices: {e}") from e

    real = [d for d in devices if d.sku.upper() not in _PSEUDO_SKUS]
    if not real:
        click.echo("No devices found via the Govee cloud API.")
        return

    click.echo(f"\nFound {len(real)} device(s):\n")
    unsupported = []
    for d in real:
        supported = d.sku.upper() in SUPPORTED_DEVICES
        marker = "" if supported else "  (unsupported model — not registered)"
        click.echo(f"  {d.device_id}  {d.name or '(no name)'}  [{d.sku}]{marker}")
        click.echo(f"    Transport: {transport_for(d.sku)}")
        click.echo(f"    Capabilities: {', '.join(c.instance for c in d.capabilities)}")
        if not supported:
            unsupported.append(d.sku)

    if not sync:
        return

    cfg = load_config()
    synced = 0
    for d in real:
        if d.sku.upper() not in SUPPORTED_DEVICES:
            continue
        device_id = d.device_id.upper()
        # Preserve a locally-set name if the cloud has none.
        existing = cfg.devices.get(device_id)
        name = d.name or (existing.name if existing else None)
        cfg.devices[device_id] = DeviceConfig(model=d.sku.upper(), name=name)
        synced += 1

    save_config(cfg)
    click.echo(f"\nSynced {synced} device(s) to config.")
    if unsupported:
        click.echo(
            f"Skipped unsupported model(s): {', '.join(sorted(set(unsupported)))}. "
            f"Add a handler in govee_cli/devices/ to enable them."
        )
