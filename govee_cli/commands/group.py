"""group command — multi-device groups with BLE + HTTP support."""

from __future__ import annotations

import asyncio
import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import Command
from govee_cli.config import load_config, resolve_device_ref, save_config
from govee_cli.exceptions import DeviceNotConfigured, GoveeError
from govee_cli.http import GoveeHTTP, GoveeHTTPError


@click.group()
def group() -> None:
    """Manage and execute commands on device groups."""
    pass


@group.command()
@click.argument("name")
@click.option(
    "--devices", "--macs", required=True, help="Comma-separated device names or MAC addresses"
)
@click.option("--save/--no-save", default=True, help="Save to config (default: save)")
def add(name: str, devices: str, save: bool) -> None:
    """Create a group or add devices to an existing group."""
    cfg = load_config()

    refs = [r.strip() for r in devices.split(",") if r.strip()]
    if not refs:
        raise click.ClickException("No valid device references provided.")

    mac_list = []
    for ref in refs:
        try:
            mac, _ = resolve_device_ref(cfg, ref)
            mac_list.append(mac)
        except DeviceNotConfigured as e:
            raise click.ClickException(
                f"{e}. Add it with: govee-cli scan-http"
            ) from e

    existing = cfg.groups.get(name, [])
    combined = list(dict.fromkeys(existing + mac_list))
    cfg.groups[name] = combined

    if save:
        save_config(cfg)

    click.echo(f"Group '{name}': {', '.join(combined)}")


@group.command(name="list")
def list_groups() -> None:
    """List all groups."""
    cfg = load_config()
    if not cfg.groups:
        click.echo("No groups defined.")
        return

    for name, macs in cfg.groups.items():
        click.echo(f"{name}: {', '.join(macs)}")


@group.command()
@click.argument("name")
@click.argument("command", type=str, nargs=-1, required=True)
@click.option("--adapter", default="hci0", help="Bluetooth adapter (BLE only)")
def run(name: str, command: tuple[str, ...], adapter: str) -> None:
    """Execute a command on all devices in a group.

    Example: govee-cli group living-room power on
    """
    cfg = load_config()
    group_refs = cfg.groups.get(name)
    if not group_refs:
        raise click.ClickException(f"Group '{name}' not found.")

    macs = []
    for ref in group_refs:
        try:
            mac, _ = resolve_device_ref(cfg, ref)
            macs.append(mac)
        except DeviceNotConfigured:
            # Try as uppercase MAC directly from config (group stores MACs as-is)
            if ref.upper() in cfg.devices:
                macs.append(ref.upper())
            elif len(ref) == 17 and ref.count(":") == 5:
                macs.append(ref.upper())
            else:
                raise click.ClickException(
                    f"Device '{ref}' not found. Run: govee-cli scan-http"
                ) from None

    cmd_str = " ".join(command)
    results = []

    for mac in macs:
        device_cfg = cfg.devices.get(mac.upper())
        model = device_cfg.model if device_cfg else None

        # Route HTTP devices (H6008, H6056, H6183) to HTTP API
        http_models = ["H6008", "H6183", "H6056"]
        if model and model.upper() in http_models:
            try:
                client = GoveeHTTP()
                _apply_http_command(client, mac, model, cmd_str)
                results.append((mac, True, "ok"))
            except GoveeHTTPError as e:
                results.append((mac, False, str(e)))
            continue

        # BLE fallback
        try:
            parsed = _parse_inline_command(cmd_str, device_model=model)
            if parsed is None:
                results.append((mac, False, f"Unknown command: {cmd_str}"))
                continue

            async def run_ble():
                async with GoveeBLE(mac, adapter=adapter) as client:
                    await client.execute(parsed)

            asyncio.run(run_ble())
            results.append((mac, True, "ok"))
        except GoveeError as e:
            results.append((mac, False, str(e)))

    for mac, ok, msg in results:
        status = "✅" if ok else "❌"
        detail = f" — {msg}" if not ok else ""
        click.echo(f"{status} {mac}{detail}")

    if not all(r[1] for r in results):
        raise SystemExit(1)


def _apply_http_command(client: GoveeHTTP, mac: str, model: str, cmd_str: str) -> None:
    """Apply an HTTP command to a device."""
    parts = cmd_str.strip().split()
    verb = parts[0].lower()
    args = parts[1:]

    if verb == "power" and len(args) == 1:
        client.turn_on(mac, model) if args[0] == "on" else client.turn_off(mac, model)
        return

    if verb == "brightness" and len(args) == 1:
        client.set_brightness(mac, model, int(args[0]))
        return

    if verb == "color" and len(args) == 1:
        from govee_cli.http import parse_hex_color
        r, g, b = parse_hex_color(args[0])
        client.set_color(mac, model, r, g, b)
        return

    if verb == "temp" and len(args) == 1:
        client.set_color_temp(mac, model, int(args[0]))
        return

    raise click.ClickException(f"Unsupported HTTP command: {verb}")


def _parse_inline_command(cmd_str: str, device_model: str | None = None) -> Command | None:
    """Parse a string like 'power on' into a Command."""
    parts = cmd_str.strip().split()
    if not parts:
        return None

    verb = parts[0].lower()
    args = parts[1:]

    from govee_cli.ble.protocol import (
        encode_brightness,
        encode_color_hex_for_device,
        encode_power,
        encode_temp_for_device,
    )

    if verb == "power" and len(args) == 1:
        return encode_power(args[0] == "on")
    if verb == "brightness" and len(args) == 1:
        try:
            return encode_brightness(int(args[0]))
        except ValueError:
            return None
    if verb == "color" and len(args) == 1:
        return encode_color_hex_for_device(args[0], device_model)
    if verb == "temp" and len(args) == 1:
        try:
            return encode_temp_for_device(int(args[0]), device_model)
        except ValueError:
            return None
    return None