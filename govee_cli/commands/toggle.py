"""toggle command — boolean device features such as the H6056 gradient toggle.

The device's advertised capability list is a starting point, not a guarantee:
the H6056 advertises ``dreamViewToggle`` and then rejects it at control time
with "The device does not has DreamView". So the registry records the toggles
that were *verified working*, and anything else the device advertises is still
offered but clearly marked unverified, with the device's own error surfaced
rather than swallowed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import click

from govee_cli.commands._common import require_v2, resolve

if TYPE_CHECKING:
    from govee_cli.commands._common import Target
    from govee_cli.http_v2 import GoveeHTTPv2


def _advertised_toggles(client: GoveeHTTPv2, target: Target) -> list[str]:
    """Return toggle instances the device advertises, verified or not."""
    device = client.get_device(target.cloud_model, target.device_id)
    if device is None:
        return []
    return [
        c.instance for c in device.capabilities
        if c.type == "devices.capabilities.toggle"
    ]


@click.command()
@click.argument("name", type=str, required=False)
@click.argument("state", type=click.Choice(["on", "off"]), required=False)
@click.option("--device", "mac", help="Device MAC address or name")
@click.pass_context
def command(ctx: click.Context, name: str | None, state: str | None,
            mac: str | None) -> None:
    """Turn a boolean device feature on or off, or list what's available.

    \b
      govee-cli toggle --device "Light Bars"              # list
      govee-cli toggle gradient on --device "Light Bars"
      govee-cli toggle gradientToggle off --device "Light Bars"
    """
    target = resolve(ctx, mac)
    client = require_v2(target, "Toggles")
    spec = target.spec
    verified = list(spec.toggles) if spec else []

    from govee_cli.http_v2 import GoveeV2Error

    if name is None or name.lower() == "list":
        try:
            advertised = _advertised_toggles(client, target)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        if not advertised and not verified:
            click.echo(f"{target.label} exposes no toggles.")
            return
        click.echo(f"Toggles on {target.label} [{target.model}]:")
        for advertised_name in advertised or verified:
            mark = ("" if advertised_name in verified
                    else "   (advertised, unverified)")
            click.echo(f"  {advertised_name}{mark}")
        return

    if state is None:
        raise click.ClickException(
            f"Say on or off, e.g. `govee-cli toggle {name} on`."
        )

    # Accept a short name: `gradient` resolves to `gradientToggle`.
    wanted = name.lower().removesuffix("toggle")
    try:
        candidates = _advertised_toggles(client, target) or verified
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    instance: str | None = None
    for candidate in candidates:
        if candidate.lower() in (name.lower(), f"{wanted}toggle"):
            instance = candidate
            break

    if instance is None:
        available = ", ".join(candidates) or "(none)"
        raise click.ClickException(
            f"Unknown toggle '{name}' for {target.model}. Available: {available}"
        )

    try:
        client.set_toggle(target.cloud_model, target.device_id, instance, state == "on")
    except GoveeV2Error as e:
        # The device rejecting an advertised toggle is a real and useful answer,
        # not a bug to hide.
        raise click.ClickException(
            f"{instance} was rejected by the device: {e}"
        ) from e

    click.echo(f"{instance} {state}")
