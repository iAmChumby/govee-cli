"""snapshot command — activate a snapshot saved in the Govee app.

Govee exposes no listing endpoint for snapshots (``/device/snapshots`` is a 404).
The only source is the ``snapshot`` capability's own options in the device
description, which is empty until the user saves at least one snapshot in the
app. So this command reads what the device advertises and accepts a raw numeric
id as a fallback.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import click

from govee_cli.commands._common import require_v2, resolve

if TYPE_CHECKING:
    from govee_cli.commands._common import Target
    from govee_cli.http_v2 import GoveeHTTPv2


def _snapshot_options(client: "GoveeHTTPv2", target: "Target") -> list[tuple[str, int]]:
    device = client.get_device(target.cloud_model, target.device_id)
    if device is None:
        return []
    cap = device.capability("snapshot")
    if cap is None:
        return []
    out = []
    for o in cap.parameters.get("options", []) or []:
        value = o.get("value")
        if isinstance(value, dict):
            value = value.get("id", value.get("value"))
        if isinstance(value, int):
            out.append((o.get("name", str(value)), value))
    return out


@click.command()
@click.argument("name", type=str, required=False)
@click.option("--device", "mac", help="Device MAC address or name")
@click.pass_context
def command(ctx: click.Context, name: str | None, mac: str | None) -> None:
    """Activate a saved snapshot by name or numeric id, or list them.

    \b
      govee-cli snapshot --device "Shelf Lamp"           # list
      govee-cli snapshot "Cozy" --device "Shelf Lamp"    # by name
      govee-cli snapshot 12345 --device "Shelf Lamp"     # by raw id
    """
    target = resolve(ctx, mac)
    client = require_v2(target, "Snapshots")

    from govee_cli.http_v2 import GoveeV2Error

    try:
        options = _snapshot_options(client, target)

        if name is None or name.lower() == "list":
            if not options:
                click.echo(
                    f"No snapshots saved for {target.label}. Save one in the Govee "
                    f"app (long-press a light state), then it will appear here."
                )
                return
            click.echo(f"Snapshots on {target.label} [{target.model}]:")
            for option_label, option_value in options:
                click.echo(f"  {option_label}  (id {option_value})")
            return

        value: int | None = None
        for label, option_value in options:
            if label.lower() == name.lower():
                value = option_value
                break

        if value is None:
            if name.isdigit():
                value = int(name)
            else:
                available = ", ".join(o[0] for o in options) or "(none saved)"
                raise click.ClickException(
                    f"Unknown snapshot '{name}'. Available: {available}"
                )

        client.set_snapshot(target.cloud_model, target.device_id, value)
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    click.echo(f"Activated snapshot: {name}")
