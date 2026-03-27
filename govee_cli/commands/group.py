"""group command — multi-device groups."""

from __future__ import annotations

import asyncio

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import Command
from govee_cli.config import load_config, save_config
from govee_cli.exceptions import GoveeError


@click.group()
def group() -> None:
    """Manage and execute commands on device groups.

    Groups are stored in ~/.config/govee-cli/config.json
    """
    pass


@group.command()
@click.argument("name")
@click.option("--macs", required=True, help="Comma-separated MAC addresses")
@click.option("--save/--no-save", default=True, help="Save to config (default: save)")
def add(name: str, macs: str, save: bool) -> None:
    """Create a group or add devices to an existing group."""
    mac_list = [m.strip() for m in macs.split(",") if m.strip()]
    if not mac_list:
        raise click.ClickException("No valid MAC addresses provided.")

    for mac in mac_list:
        if len(mac) != 17 or mac.count(":") != 5:
            raise click.ClickException(f"Invalid MAC address format: {mac}")

    cfg = load_config()
    existing = cfg.groups.get(name, [])
    # Merge, avoid duplicates
    combined = list(dict.fromkeys(existing + mac_list))
    cfg.groups[name] = combined

    if save:
        save_config(cfg)

    click.echo(f"Group '{name}': {', '.join(combined)}")


@group.command()
def list() -> None:
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
    macs = cfg.groups.get(name)
    if not macs:
        raise click.ClickException(f"Group '{name}' not found.")

    cmd_str = " ".join(command)
    parsed = _parse_inline_command(cmd_str)
    if parsed is None:
        raise click.ClickException(
            f"Could not parse command: {cmd_str}. "
            "Try: 'power on', 'color FF5500', 'brightness 75'"
        )

    async def run_one(mac: str) -> tuple[str, bool, str]:
        try:
            async with GoveeBLE(mac, adapter=adapter) as client:
                await client.execute(parsed)
                return (mac, True, "ok")
        except GoveeError as e:
            return (mac, False, str(e))

    async def run_all() -> None:
        results = await asyncio.gather(*[run_one(m) for m in macs])
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


def _parse_inline_command(cmd_str: str) -> Command | None:
    """Parse a string like 'power on' or 'color FF5500' into a Command."""
    parts = cmd_str.strip().split()
    if not parts:
        return None

    verb = parts[0].lower()
    args = parts[1:]

    from govee_cli.ble.protocol import (
        encode_brightness,
        encode_color_hex,
        encode_power,
        encode_temp,
    )

    if verb == "power" and len(args) == 1:
        return encode_power(args[0] == "on")
    if verb == "brightness" and len(args) == 1:
        try:
            return encode_brightness(int(args[0]))
        except ValueError:
            return None
    if verb == "color" and len(args) == 1:
        return encode_color_hex(args[0])
    if verb == "temp" and len(args) == 1:
        try:
            return encode_temp(int(args[0]))
        except ValueError:
            return None
    return None
