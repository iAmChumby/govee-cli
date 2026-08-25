"""music command — firmware music-reactive mode.

Cloud v2 models expose ``musicMode`` as a device capability: the lamp listens on
its own microphone and reacts in firmware. Nothing is sampled or streamed from
this machine, so this is not the "audio analysis + GATT research" the BLE path
would have needed — it is a mode selection, and it works today.

Models without that capability still raise, because for them the feature genuinely
does not exist over any transport we can drive.
"""

from typing import TYPE_CHECKING

import click

from govee_cli import ledger
from govee_cli.commands._common import resolve, v2_client
from govee_cli.transport import CLOUD_V2

if TYPE_CHECKING:
    from govee_cli.commands._common import Target


def _modes_for(target: "Target") -> dict[str, int]:
    """Return the model's music modes, which differ per model."""
    from govee_cli.devices import SUPPORTED_DEVICES

    handler = SUPPORTED_DEVICES.get((target.model or "").upper())
    return dict(getattr(handler, "MUSIC_MODES", {}) or {})


@click.command()
@click.argument("mode", type=str, required=False)
@click.option("--sensitivity", type=click.IntRange(0, 100), default=60,
              show_default=True, help="Microphone sensitivity")
@click.option("--auto-color/--no-auto-color", default=None,
              help="Let the device pick colors instead of using --color")
@click.option("--color", "hex_color", type=str,
              help="Fixed color for the effect (implies --no-auto-color)")
@click.option("--device", "mac", help="Device MAC address or name")
@click.pass_context
def command(ctx: click.Context, mode: str | None, sensitivity: int,
            auto_color: bool | None, hex_color: str | None,
            mac: str | None) -> None:
    """Put the light into a music-reactive mode.

    The device does its own audio pickup — no audio leaves this machine.
    Run without a MODE (or with 'list') to see what the device supports.

    \b
      govee-cli music list --device "Shelf Lamp"
      govee-cli music rhythm --device "Shelf Lamp"
      govee-cli music energic --sensitivity 80 --device "Shelf Lamp"
      govee-cli music spectrum --color FF0066 --device "Shelf Lamp"
    """
    target = resolve(ctx, mac)
    modes = _modes_for(target)

    spec = target.spec
    if not modes or not (spec and spec.cloud_music):
        # Distinguish "this hardware has no music mode" from "we can't reach it
        # over this transport" — the H6008 is cloud-connected and still has none,
        # so blaming the transport would send someone debugging the wrong thing.
        raise click.ClickException(
            f"{target.model or 'This model'} has no firmware music mode "
            f"('{target.label}'). The device rejects musicMode with "
            f"\"devices not support this instance\"."
        )

    if target.transport != CLOUD_V2:
        raise click.ClickException(
            f"Music mode for {target.model} needs the cloud v2 transport, but "
            f"'{target.label}' resolves to {target.transport}."
        )

    if mode is None or mode.lower() == "list":
        click.echo(f"Music modes for {target.label} [{target.model}]:")
        for name in modes:
            click.echo(f"  {name}")
        return

    key = mode.lower()
    if key not in modes:
        raise click.ClickException(
            f"Unknown music mode '{mode}' for {target.model}. "
            f"Available: {', '.join(modes)}."
        )

    rgb = None
    if hex_color:
        from govee_cli.commands._common import parse_hex

        r, g, b = parse_hex(hex_color)
        rgb = (r << 16) | (g << 8) | b
        # A fixed color and device-chosen color are mutually exclusive; an
        # explicit --auto-color still wins so the user can override.
        if auto_color is None:
            auto_color = False

    from govee_cli.http_v2 import GoveeV2Error

    try:
        v2_client().set_music_mode(
            target.cloud_model, target.device_id, modes[key], sensitivity,
            auto_color=auto_color, rgb=rgb,
        )
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e

    # `key` is already the per-model mode NAME ("rhythm", "energic", ...), not
    # the integer `modes[key]` sent over the wire — the same integer means a
    # different mode on a different model (see module docstring), so writing
    # the raw int to the ledger would silently mislabel the UI on whichever
    # model doesn't happen to share that mapping.
    ledger.record_mode(
        target.device_id, "music", key,
        {"music_mode": modes[key], "sensitivity": sensitivity}, source="cli",
    )

    detail = f"sensitivity {sensitivity}"
    if rgb is not None:
        detail += f", color #{rgb:06X}"
    click.echo(f"Music mode: {key} ({detail})")
