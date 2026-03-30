"""config command — view and edit govee-cli configuration."""

import asyncio
import json

import click

from govee_cli.config import (
    GoveeConfig,
    _validate_device_name,
    _validate_mac,
    _validate_model,
    get_device_by_mac,
    load_config,
    save_config,
)
from govee_cli.exceptions import (
    DuplicateDeviceName,
    InvalidMACAddress,
    ModelDetectionFailed,
    UnsupportedDevice,
)


@click.command()
@click.option("--mac", "default_mac", help="Default device MAC address")
@click.option("--adapter", "default_adapter", help="Default Bluetooth adapter (e.g. hci0)")
@click.option("--timeout", "default_timeout", type=float, help="Default BLE timeout in seconds")
@click.option("--brightness", "default_brightness", type=int, help="Default brightness 0-100")
@click.option("--color", "default_color", help="Default color as RRGGBB hex")
@click.option("--show", "show_only", is_flag=True, help="Show current config and exit")
@click.option("--device-mac", "target_mac", help="Device MAC address (BLE address)")
@click.option("--model", "device_model", help="Device model (H6056, H6008, etc.)")
@click.option("--name", "device_name", help="User-friendly name for the device")
@click.option("--static-mac", "static_mac", help="Static MAC if different from BLE address (H6008)")
@click.option("--list-devices", "list_devices", is_flag=True, help="List all configured devices")
@click.option("--remove-device", "remove_mac", help="Remove device by MAC address")
@click.option("--detect", "auto_detect", is_flag=True, help="Auto-detect model from BLE scan")
@click.pass_context
def command(
    ctx: click.Context,
    default_mac: str | None,
    default_adapter: str | None,
    default_timeout: float | None,
    default_brightness: int | None,
    default_color: str | None,
    show_only: bool,
    target_mac: str | None,
    device_model: str | None,
    device_name: str | None,
    static_mac: str | None,
    list_devices: bool,
    remove_mac: str | None,
    auto_detect: bool,
) -> None:
    """View or edit govee-cli configuration.

    Calling with no options shows the current config.
    Any option provided updates the config.

    Device management examples:

    \b
        govee-cli config --device-mac AA:BB:CC:DD:EE:FF --model H6056 --name "Bedroom Light"
        govee-cli config --device-mac AA:BB:CC:DD:EE:FF --detect --name "Living Room"
        govee-cli config --list-devices
        govee-cli config --remove-device AA:BB:CC:DD:EE:FF
    """
    cfg = load_config()

    # Validate conflicting flags early
    if auto_detect and device_model:
        raise click.ClickException(
            "Cannot use both --detect and --model. "
            "Use --detect to auto-detect, or --model to specify explicitly."
        )

    # Handle device listing
    if list_devices:
        _print_devices(cfg)
        return

    # Handle device removal
    if remove_mac:
        try:
            _remove_device(cfg, remove_mac)
        except InvalidMACAddress as e:
            raise click.ClickException(str(e)) from None
        return

    # Handle device addition/update
    if target_mac:
        try:
            asyncio.run(
                _add_or_update_device(
                    cfg,
                    target_mac,
                    device_model,
                    device_name,
                    static_mac,
                    auto_detect,
                    ctx.obj.get("default_adapter"),
                    ctx.obj.get("default_timeout", 10.0),
                )
            )
        except (
            InvalidMACAddress,
            UnsupportedDevice,
            DuplicateDeviceName,
            ModelDetectionFailed,
        ) as e:
            raise click.ClickException(str(e)) from None
        return

    # Handle global config settings
    config_options = [
        default_mac,
        default_adapter,
        default_timeout,
        default_brightness,
        default_color,
    ]
    if show_only or all(v is None for v in config_options):
        _print_config(cfg)
        return

    # Update provided global fields
    if default_mac is not None:
        try:
            _validate_mac(default_mac)
            cfg.default_mac = default_mac.upper()
        except InvalidMACAddress as e:
            raise click.ClickException(str(e)) from None
    if default_adapter is not None:
        cfg.default_adapter = default_adapter
    if default_timeout is not None:
        cfg.default_timeout = default_timeout
    if default_brightness is not None:
        if not 0 <= default_brightness <= 100:
            raise click.ClickException("Brightness must be 0-100")
        cfg.default_brightness = default_brightness
    if default_color is not None:
        cfg.default_color = default_color.lstrip("#")

    save_config(cfg)
    click.echo("Config updated:")
    _print_config(cfg)


async def _add_or_update_device(
    cfg: GoveeConfig,
    target_mac: str,
    device_model: str | None,
    device_name: str | None,
    static_mac: str | None,
    auto_detect: bool,
    adapter: str | None,
    timeout: float,
) -> None:
    """Add or update a device configuration."""
    # Validate MAC format
    _validate_mac(target_mac)
    target_mac = target_mac.upper()

    # Validate static MAC if provided
    if static_mac:
        _validate_mac(static_mac)
        static_mac = static_mac.upper()

    # Auto-detect model if requested
    if auto_detect and not device_model:
        device_model = await _detect_model_from_ble(target_mac, timeout)

    # Validate model if provided
    if device_model:
        _validate_model(device_model)
        device_model = device_model.upper()

    # Validate name uniqueness (only if name is changing)
    if device_name:
        existing_device = get_device_by_mac(cfg, target_mac)
        if not existing_device or existing_device.name != device_name:
            _validate_device_name(device_name, cfg.devices)

    # Add/update device
    from govee_cli.config import DeviceConfig

    cfg.devices[target_mac] = DeviceConfig(
        model=device_model or "",
        name=device_name,
        static_mac=static_mac,
    )

    # If this is the first device, set it as default
    if len(cfg.devices) == 1 and cfg.default_mac is None:
        cfg.default_mac = target_mac
        click.echo(f"Set {target_mac} as default device.")

    save_config(cfg)
    click.echo(f"Device {target_mac} configured successfully.")


async def _detect_model_from_ble(mac: str, timeout: float) -> str:
    """Scan for device and detect model from advertisement name."""
    from govee_cli.ble.scanner import discover_devices, is_govee_device

    click.echo(f"Scanning for device {mac}...")
    devices = await discover_devices(timeout=timeout)

    for device in devices:
        if device.mac.upper() == mac.upper() and is_govee_device(device):
            name = device.name or ""
            # Extract model from name patterns
            if "H6008" in name or "GVH6008" in name:
                return "H6008"
            elif "H6056" in name:
                return "H6056"
            elif "H7126" in name:
                return "H7126"
            elif "H613E" in name or "H613" in name:
                return "H613E"
            raise ModelDetectionFailed(f"Unknown model from name: {name}")

    raise ModelDetectionFailed(f"Device {mac} not found during BLE scan")


def _remove_device(cfg: GoveeConfig, remove_mac: str) -> None:
    """Remove a device from configuration."""
    _validate_mac(remove_mac)
    remove_mac = remove_mac.upper()

    if remove_mac in cfg.devices:
        device_name = cfg.devices[remove_mac].name or remove_mac
        del cfg.devices[remove_mac]

        # Also remove from any groups
        for group_name, group_macs in list(cfg.groups.items()):
            if remove_mac in group_macs:
                group_macs.remove(remove_mac)
                if not group_macs:
                    del cfg.groups[group_name]

        # If this was the default device, clear default
        if cfg.default_mac == remove_mac:
            cfg.default_mac = None
            click.echo("Cleared default device setting.")

        save_config(cfg)
        click.echo(f"Device {device_name} ({remove_mac}) removed.")
    else:
        raise click.ClickException(f"Device {remove_mac} not found.")


def _print_devices(cfg: GoveeConfig) -> None:
    """Print all configured devices."""
    if not cfg.devices:
        click.echo("No devices configured.")
        return

    click.echo("Configured Devices:")
    for mac, dev in cfg.devices.items():
        display_name = dev.name or mac
        click.echo(f"\n  {display_name} ({dev.model})")
        click.echo(f"    BLE Address: {mac}")
        if dev.static_mac:
            click.echo(f"    Static MAC:  {dev.static_mac}")

    if cfg.groups:
        click.echo("\nGroups:")
        for group_name, macs in cfg.groups.items():
            # Resolve MACs to names where possible
            names = []
            for m in macs:
                dev = cfg.devices.get(m)
                names.append(dev.name if dev and dev.name else m)
            click.echo(f"  {group_name}: {', '.join(names)}")


def _replace_none(obj):
    """Recursively replace None with '(not set)' and empty dicts with '(none)'."""
    if obj is None:
        return "(not set)"
    if isinstance(obj, dict):
        if not obj:
            return "(none)"
        return {k: _replace_none(v) for k, v in obj.items()}
    if isinstance(obj, list):
        if not obj:
            return "(none)"
        return [_replace_none(v) for v in obj]
    return obj


def _print_config(cfg: GoveeConfig) -> None:
    """Print a human-readable config."""
    output = {
        "default_mac": cfg.default_mac,
        "default_adapter": cfg.default_adapter,
        "default_timeout": cfg.default_timeout,
        "default_brightness": cfg.default_brightness,
        "default_color": cfg.default_color,
    }

    # Add devices info
    if cfg.devices:
        output["devices"] = {
            mac: {
                "model": dev.model,
                "name": dev.name,
                "static_mac": dev.static_mac,
            }
            for mac, dev in cfg.devices.items()
        }

    output["groups"] = cfg.groups

    print(json.dumps(_replace_none(output), indent=2))
