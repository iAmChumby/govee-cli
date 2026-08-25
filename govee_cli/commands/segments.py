"""segments command — per-segment color and brightness, over cloud v2 or BLE."""

import asyncio

import click

from govee_cli import ledger
from govee_cli.commands._common import parse_hex, parse_segments, resolve, v2_client
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V2


@click.command()
@click.argument("segment_spec", type=str)
@click.argument("hex_color", type=str, required=False)
@click.option("--brightness", type=click.IntRange(0, 100),
              help="Set per-segment brightness instead of, or alongside, color")
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, segment_spec: str, hex_color: str | None,
            brightness: int | None, mac: str | None, adapter: str) -> None:
    """Set the color and/or brightness of one or more segments.

    SEGMENT_SPEC accepts a single index, a comma-separated list, inclusive
    ranges, or 'all':

    \b
      govee-cli segments 3 FF0000              # one segment
      govee-cli segments 0,4,9 00FF00          # a list
      govee-cli segments 2-6 0000FF            # a range
      govee-cli segments 0-2,8,11-14 FFAA00
      govee-cli segments all 200020            # every segment
      govee-cli segments 0-2 --brightness 30   # per-segment brightness
      govee-cli segments all FF0000 --brightness 80

    Per-segment brightness is not universal among segmented models — the H6056
    supports it, the H6022 does not.
    """
    if hex_color is None and brightness is None:
        raise click.ClickException(
            "Give a color, --brightness, or both. "
            "Example: `govee-cli segments 0-2 FF0000`."
        )

    target = resolve(ctx, mac)
    spec = target.spec
    on_cloud = target.transport == CLOUD_V2 and bool(spec and spec.cloud_segments)

    if spec:
        # The same device can address a different number of segments per
        # transport, so the bound depends on which path this command will take.
        segment_count = spec.segment_count if on_cloud else spec.ble_segment_count
        if not segment_count:
            raise click.ClickException(
                f"{spec.model} has no addressable segments — use "
                f"`govee-cli color` / `govee-cli brightness` instead."
            )
    else:
        segment_count = 16

    segments = parse_segments(segment_spec, segment_count)
    label = ("all segments" if len(segments) == segment_count
             else f"segment(s) {segments}")
    rgb = parse_hex(hex_color) if hex_color else None

    if on_cloud:
        from govee_cli.http_v2 import GoveeV2Error

        if brightness is not None and not (spec and spec.cloud_segment_brightness):
            raise click.ClickException(
                f"{spec.model if spec else 'This model'} does not support "
                f"per-segment brightness. Use `govee-cli brightness` to set the "
                f"whole device."
            )

        client = v2_client()
        done = []
        try:
            if rgb is not None:
                client.set_segment_color(
                    target.cloud_model, target.device_id, segments, *rgb
                )
                done.append(f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}")
            if brightness is not None:
                client.set_segment_brightness(
                    target.cloud_model, target.device_id, segments, brightness
                )
                done.append(f"{brightness}% brightness")
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        # One ledger entry for the whole invocation even though color and
        # brightness are two separate client calls above — splitting this into
        # two writes would make "segments 0-2 FF0000 --brightness 30" look like
        # two independent mode changes instead of one user action.
        ledger.record_mode(
            target.device_id, "segments", None,
            {"segments": segments, "rgb": list(rgb) if rgb else None,
             "brightness": brightness},
            source="cli",
        )
        click.echo(f"Set {label} to {' and '.join(done)}")
        return

    # BLE path — one packet per segment, colour only.
    if brightness is not None:
        raise click.ClickException(
            "Per-segment brightness is not available over BLE for this device."
        )
    if rgb is None:
        raise click.ClickException("A color is required for BLE segment control.")

    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_segment

    r, g, b = rgb

    async def run() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter) as client:
            for seg in segments:
                await client.execute(encode_segment(seg, r, g, b))
            # Same single-entry-per-invocation rule as the cloud branch above.
            # This is exactly the case §3.3's "Rejected" reasoning names as the
            # motivation for hooking at the command layer instead of inside
            # GoveeHTTPv2.control() — BLE segment paint never goes through that
            # client, so it must be captured here or not at all.
            ledger.record_mode(
                target.device_id, "segments", None,
                {"segments": segments, "rgb": [r, g, b], "brightness": None},
                source="cli",
            )
            click.echo(f"Set {label} to #{r:02X}{g:02X}{b:02X}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
