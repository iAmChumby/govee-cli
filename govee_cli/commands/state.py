"""state command — read current device state via HTTP API (no side effects)."""

from __future__ import annotations

import click

from govee_cli.config import resolve_device_ref, load_config
from govee_cli.http import GoveeHTTP, GoveeHTTPError


@click.command(name="state")
@click.option("--device", help="Device name or MAC address")
@click.pass_context
def command(ctx: click.Context, device: str | None) -> None:
    """Read current device state (power, brightness, color) via HTTP API.

    Does NOT send any commands — safe to check status anytime.
    """
    cfg = load_config()

    if not device:
        device = cfg.default_mac

    if not device:
        raise click.ClickException("No device specified. Use --device or set a default.")

    try:
        mac, dev_cfg = resolve_device_ref(cfg, device)
        model = dev_cfg.model if dev_cfg else None
    except Exception:
        raise click.ClickException(
            f"Device '{device}' not found. Run: govee-cli scan-http"
        ) from None

    http_models = ["H6008", "H6183", "H6056"]
    if model and model.upper() not in http_models:
        raise click.ClickException(
            f"State command requires HTTP device (H6008/H6183/H6056). "
            f"Device '{device}' is model '{model}'."
        )

    try:
        client = GoveeHTTP()
        state = client.get_state(mac, model)
    except GoveeHTTPError as e:
        raise click.ClickException(str(e)) from e
    except Exception as e:
        raise click.ClickException(f"Failed to read state: {e}") from e

    power = state.get("powerState", "unknown")
    brightness = state.get("brightness", "?")
    color_temp = state.get("colorTem", "?")
    color_rgb = state.get("color", {})

    click.echo(f"Device: {mac} [{model}]")
    click.echo(f"  Power: {power}")
    click.echo(f"  Brightness: {brightness}%")

    if color_temp and color_temp != 0:
        click.echo(f"  Color Temp: {color_temp}K")
    if color_rgb:
        r, g, b = color_rgb.get("r", "?"), color_rgb.get("g", "?"), color_rgb.get("b", "?")
        click.echo(f"  Color: RGB({r}, {g}, {b})")

    # Show whether device is on or off as a status
    if power == "on":
        click.echo("  Status: ✅ ON")
    else:
        click.echo("  Status: ⚪ OFF")