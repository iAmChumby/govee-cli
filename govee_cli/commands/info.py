"""info command — print device info, capabilities and current state."""

import asyncio

import click

from govee_cli.commands._common import resolve
from govee_cli.exceptions import GoveeError
from govee_cli.transport import BLE, CLOUD_V2


@click.command()
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
@click.pass_context
def command(ctx: click.Context, mac: str | None, adapter: str) -> None:
    """Print device info and current state."""
    target = resolve(ctx, mac)
    spec = target.spec

    click.echo(f"Device: {target.label}")
    click.echo(f"  ID: {target.device_id}")
    click.echo(f"  Model: {target.model or 'unknown'}")
    click.echo(f"  Transport: {target.transport}")
    if spec:
        if spec.segment_count > 1:
            click.echo(
                f"  Segments (cloud): {spec.segment_count} "
                f"(0-{spec.segment_count - 1})"
            )
        if spec.ble_segment_count:
            # The same device can address a different count per transport.
            click.echo(
                f"  Segments (BLE): {spec.ble_segment_count} "
                f"(0-{spec.ble_segment_count - 1})"
            )
        click.echo(f"  Color temp range: {spec.temp_min}-{spec.temp_max}K")
        features = []
        if spec.cloud_scenes:
            features.append("scenes")
        if spec.cloud_diy:
            features.append("diy")
        if spec.cloud_segments:
            features.append("segments")
        if spec.cloud_segment_brightness:
            features.append("segment-brightness")
        if spec.cloud_music:
            features.append("music")
        click.echo(f"  Cloud features: {', '.join(features) if features else 'basic control only'}")
        if spec.toggles:
            click.echo(f"  Toggles: {', '.join(spec.toggles)}")
        if spec.prefer_ble_effects:
            click.echo("  Effects: BLE preferred (full frame rate; --cloud to override)")

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        client = v2_client()
        try:
            state = client.get_state(target.cloud_model, target.device_id)
            scenes = client.get_scenes(target.cloud_model, target.device_id)
            diy = client.get_diy_scenes(target.cloud_model, target.device_id)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e

        click.echo(f"  Scenes available: {len(scenes)}")
        diy_names = f" ({', '.join(d.name for d in diy)})" if diy else ""
        click.echo(f"  DIY scenes: {len(diy)}{diy_names}")
        click.echo("")
        click.echo(f"Online: {'yes' if state.get('online') else 'no'}")
        click.echo(f"Power: {'On' if state.get('powerSwitch') == 1 else 'Off'}")
        click.echo(f"Brightness: {state.get('brightness', '?')}%")
        rgb_int = state.get("colorRgb")
        if isinstance(rgb_int, int) and rgb_int > 0:
            click.echo(f"Color: #{rgb_int:06X}")
        if state.get("colorTemperatureK"):
            click.echo(f"Color Temp: {state['colorTemperatureK']}K")
        return

    if target.transport != BLE:
        from govee_cli.http import GoveeHTTP, GoveeHTTPError

        try:
            state = GoveeHTTP().get_state(target.device_id, target.cloud_model)
        except GoveeHTTPError as e:
            raise click.ClickException(str(e)) from e
        click.echo("")
        click.echo(f"Power: {state.get('powerState', 'unknown')}")
        click.echo(f"Brightness: {state.get('brightness', '?')}%")
        color = state.get("color") or {}
        if color:
            click.echo(
                f"Color: #{color.get('r', 0):02X}{color.get('g', 0):02X}{color.get('b', 0):02X}"
            )
        if state.get("colorTem"):
            click.echo(f"Color Temp: {state['colorTem']}K")
        return

    from govee_cli.ble import GoveeBLE

    async def run() -> None:
        async with GoveeBLE(target.ble_mac, adapter=adapter) as client:
            state = await client.read_state()
            click.echo("")
            click.echo(f"Power: {'On' if state.power else 'Off'}")
            brightness_str = (
                f"{state.brightness}%" if state.brightness is not None
                else "N/A (not reported by device)"
            )
            click.echo(f"Brightness: {brightness_str}")
            r, g, b = state.color
            click.echo(f"Color: #{r:02X}{g:02X}{b:02X}")
            if state.color_temp:
                click.echo(f"Color Temp: {state.color_temp}K")

    try:
        asyncio.run(run())
    except GoveeError as e:
        raise click.ClickException(str(e)) from e
