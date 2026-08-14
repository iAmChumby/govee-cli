"""state command — read current device state via the cloud API (no side effects)."""

from __future__ import annotations

import click

from govee_cli.commands._common import resolve
from govee_cli.transport import CLOUD_V1, CLOUD_V2


def _render(label: str, model: str | None, power: str, brightness: object,
            color_temp: object, rgb: tuple[int, int, int] | None,
            online: bool | None = None,
            extras: dict[str, object] | None = None) -> None:
    click.echo(f"Device: {label} [{model or 'unknown'}]")
    if online is not None:
        click.echo(f"  Online: {'yes' if online else 'no'}")
    click.echo(f"  Power: {power}")
    click.echo(f"  Brightness: {brightness}%")
    if color_temp:
        click.echo(f"  Color Temp: {color_temp}K")
    if rgb:
        click.echo(
            f"  Color: RGB({rgb[0]}, {rgb[1]}, {rgb[2]}) "
            f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"
        )
    for key, value in (extras or {}).items():
        click.echo(f"  {key}: {value}")
    click.echo(f"  Status: {'✅ ON' if power == 'on' else '⚪ OFF'}")


@click.command(name="state")
@click.option("--device", help="Device name or MAC address")
@click.pass_context
def command(ctx: click.Context, device: str | None) -> None:
    """Read current device state (power, brightness, color) via the cloud API.

    Does NOT send any commands — safe to check status anytime.
    """
    target = resolve(ctx, device)

    if target.transport == CLOUD_V2:
        from govee_cli.commands._common import v2_client
        from govee_cli.http_v2 import GoveeV2Error

        try:
            state = v2_client().get_state(target.cloud_model, target.device_id)
        except GoveeV2Error as e:
            raise click.ClickException(str(e)) from e

        power = "on" if state.get("powerSwitch") == 1 else "off"
        rgb_int = state.get("colorRgb")
        rgb = None
        if isinstance(rgb_int, int) and rgb_int > 0:
            rgb = ((rgb_int >> 16) & 0xFF, (rgb_int >> 8) & 0xFF, rgb_int & 0xFF)
        temp = state.get("colorTemperatureK")
        _render(
            target.label, target.model, power,
            state.get("brightness", "?"),
            temp if temp else None,
            rgb,
            online=state.get("online"),
        )
        # The v2 state endpoint lists scene/segment/music instances but always
        # returns empty strings for them — the device does not report them back.
        # Say so rather than printing blanks that look like a failure.
        click.echo(
            "  (scene / segment / music state is not reported by the device)"
        )
        return

    if target.transport != CLOUD_V1:
        raise click.ClickException(
            f"State reads require a cloud-connected device. "
            f"'{target.label}' is model '{target.model or 'unknown'}' "
            f"(transport: {target.transport})."
        )

    from govee_cli.http import GoveeHTTP, GoveeHTTPError

    try:
        state = GoveeHTTP().get_state(target.device_id, target.cloud_model)
    except GoveeHTTPError as e:
        raise click.ClickException(str(e)) from e
    except Exception as e:
        raise click.ClickException(f"Failed to read state: {e}") from e

    color = state.get("color") or {}
    rgb = None
    if color:
        rgb = (color.get("r", 0), color.get("g", 0), color.get("b", 0))
    temp = state.get("colorTem")
    _render(
        target.label, target.model,
        state.get("powerState", "unknown"),
        state.get("brightness", "?"),
        temp if temp else None,
        rgb,
        online=state.get("online"),
    )
