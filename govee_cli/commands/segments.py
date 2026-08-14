"""segments command — per-segment color over the cloud (v2 models) or BLE."""

import asyncio

import click

from govee_cli.commands._common import parse_hex, parse_segments, resolve, v2_client
from govee_cli.exceptions import GoveeError
from govee_cli.transport import CLOUD_V2


@click.command()
@click.argument("segment_spec", type=str)
@click.argument("hex_color", type=str)
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, segment_spec: str, hex_color: str, mac: str | None,
            adapter: str) -> None:
    """Set the color of one or more segments.

    SEGMENT_SPEC accepts a single index, a comma-separated list, inclusive
    ranges, or 'all':

    \b
      govee-cli segments 3 FF0000          # one segment
      govee-cli segments 0,4,9 00FF00      # a list
      govee-cli segments 2-6 0000FF        # a range
      govee-cli segments 0-2,8,11-14 FFAA00
      govee-cli segments all 200020        # every segment
    """
    target = resolve(ctx, mac)
    spec = target.spec

    segment_count = spec.segment_count if spec else 16
    if spec and segment_count <= 1:
        raise click.ClickException(
            f"{spec.model} has no addressable segments — use `govee-cli color` instead."
        )

    segments = parse_segments(segment_spec, segment_count)
    r, g, b = parse_hex(hex_color)
    pretty = f"#{r:02X}{g:02X}{b:02X}"

    if target.transport == CLOUD_V2 and spec and spec.cloud_segments:
        from govee_cli.http_v2 import GoveeV2Error

        try:
            v2_client().set_segment_color(
                target.cloud_model, target.device_id, segments, r, g, b
            )
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e
        label = "all segments" if len(segments) == segment_count else f"segment(s) {segments}"
        click.echo(f"Set {label} to {pretty}")
        return

    # BLE path — one packet per segment.
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_segment

    async def run() -> None:
        async with GoveeBLE(target.device_id, adapter=adapter) as client:
            for seg in segments:
                await client.execute(encode_segment(seg, r, g, b))
            click.echo(f"Set segment(s) {segments} to {pretty}")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
