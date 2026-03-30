"""group command — multi-device groups."""

from __future__ import annotations

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import Command
from govee_cli.config import load_config, resolve_device_ref, save_config
from govee_cli.exceptions import DeviceNotConfigured, GoveeError


@click.group()
def group() -> None:
    """Manage and execute commands on device groups.

    Groups are stored in ~/.config/govee-cli/config.json
    """
    pass


@group.command()
@click.argument("name")
@click.option(
    "--devices", "--macs", required=True, help="Comma-separated device names or MAC addresses"
)
@click.option("--save/--no-save", default=True, help="Save to config (default: save)")
def add(name: str, devices: str, save: bool) -> None:
    """Create a group or add devices to an existing group.

    Devices can be specified by name (if configured) or MAC address.
    Example: govee-cli group add living-room --devices "Lamp Front,Lamp Top"
    Example: govee-cli group add living-room --devices "AA:BB:CC:DD:EE:FF,11:22:33:44:55:66"
    """
    cfg = load_config()

    # Parse device references (names or MACs)
    refs = [r.strip() for r in devices.split(",") if r.strip()]
    if not refs:
        raise click.ClickException("No valid device references provided.")

    # Resolve each reference to a MAC address
    mac_list = []
    for ref in refs:
        try:
            mac, _ = resolve_device_ref(cfg, ref)
            mac_list.append(mac)
        except DeviceNotConfigured as e:
            raise click.ClickException(
                f"{e}. Add it with: govee-cli config --device-mac {ref} --model <model>"
            ) from e

    existing = cfg.groups.get(name, [])
    # Merge, avoid duplicates (preserve order)
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
        click.echo("No groups defined. See 'govee-cli group add --help'")
        return

    for name, macs in cfg.groups.items():
        click.echo(f"{name}: {', '.join(macs)}")


@group.command()
@click.argument("name")
@click.argument("command", type=str, nargs=-1, required=True)
@click.option("--adapter", default="hci0", help="Bluetooth adapter")
def run(name: str, command: tuple[str, ...], adapter: str) -> None:
    """Execute a command on all devices in a group.

    Example: govee-cli group living-room power on
    """
    cfg = load_config()
    group_refs = cfg.groups.get(name)
    if not group_refs:
        raise click.ClickException(f"Group '{name}' not found.")

    # Resolve any device names in the group to MAC addresses
    # (for backward compatibility with legacy groups that stored MACs)
    macs = []
    for ref in group_refs:
        try:
            mac, _ = resolve_device_ref(cfg, ref)
            macs.append(mac)
        except DeviceNotConfigured:
            # Keep as-is if it looks like a MAC (legacy behavior)
            if len(ref) == 17 and ref.count(":") == 5:
                macs.append(ref)
            else:
                raise click.ClickException(
                    f"Device '{ref}' not found in configuration. "
                    f"Add it with: govee-cli config --device-mac {ref} --model <model>"
                ) from None

    cmd_str = " ".join(command)

    # Validate the command string up-front (model-agnostic check)
    if _parse_inline_command(cmd_str, device_model=None) is None:
        raise click.ClickException(
            f"Could not parse command: {cmd_str}. Try: 'power on', 'color FF5500', 'brightness 75'"
        )

    async def run_one(mac: str) -> tuple[str, bool, str]:
        try:
            device_cfg = cfg.devices.get(mac.upper())
            model = device_cfg.model if device_cfg else None
            parsed = _parse_inline_command(cmd_str, device_model=model)
            if parsed is None:
                return (mac, False, f"Could not parse command: {cmd_str}")
            async with GoveeBLE(mac, adapter=adapter) as client:
                await client.execute(parsed)
                return (mac, True, "ok")
        except GoveeError as e:
            return (mac, False, str(e))

    async def run_all() -> None:
        # Connect sequentially to avoid BlueZ "Operation already in progress" errors
        results = []
        for m in macs:
            result = await run_one(m)
            results.append(result)
            # Small delay between devices to let BlueZ complete the operation
            await asyncio.sleep(0.5)
        all_ok = True
        for mac, ok, msg in results:
            status = "✅" if ok else "❌"
            detail = f" — {msg}" if not ok else ""
            click.echo(f"{status} {mac}{detail}")
            if not ok:
                all_ok = False
        if not all_ok:
            raise SystemExit(1)

    asyncio.run(run_all())


def _parse_inline_command(cmd_str: str, device_model: str | None = None) -> Command | None:
    """Parse a string like 'power on' or 'color FF5500' into a Command.

    Uses device_model to select the correct encoder for color and temp commands
    (H6008 uses MODE_2; H6056 uses MODE_1501).
    """
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
