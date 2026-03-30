"""Local config file for govee-cli.

Config lives at ~/.config/govee-cli/config.json
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
from dataclasses import dataclass, field

_DEFAULT_ADAPTER = "hci0" if sys.platform == "linux" else None

# Config version for migration support
CONFIG_VERSION = 2

# MAC address validation regex
_MAC_PATTERN = re.compile(r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")


def _migrate_v1_to_v2(raw: dict) -> dict:
    """Migrate v1 config (no devices registry) to v2 format.

    v1 format had: default_mac, default_adapter, default_timeout,
                   default_brightness, default_color, groups

    v2 adds: version, devices dict
    """
    # Try to detect model from default_mac if it exists
    devices = {}
    if raw.get("default_mac"):
        mac = raw["default_mac"]
        # Default to H6056 for backward compatibility (existing users likely have this)
        devices[mac] = {
            "model": "H6056",
            "name": None,
            "static_mac": None,
        }

    return {
        "version": 2,
        "default_mac": raw.get("default_mac"),
        "default_adapter": raw.get("default_adapter"),
        "default_timeout": raw.get("default_timeout", 10.0),
        "default_brightness": raw.get("default_brightness"),
        "default_color": raw.get("default_color"),
        "devices": devices,
        "groups": raw.get("groups", {}),
    }


@dataclass
class DeviceConfig:
    """Per-device configuration.

    Attributes:
        model: Device model (e.g., "H6056", "H6008")
        name: Optional human-readable name for the device
        static_mac: Optional static MAC address if different from connection MAC
    """

    model: str
    name: str | None = None
    static_mac: str | None = None


@dataclass
class GoveeConfig:
    """govee-cli configuration."""

    default_mac: str | None = None
    default_adapter: str | None = _DEFAULT_ADAPTER
    default_timeout: float = 10.0
    default_brightness: int | None = None
    default_color: str | None = None  # RRGGGGBB hex
    groups: dict[str, list[str]] = field(default_factory=dict)  # group_name -> [mac, ...]
    devices: dict[str, DeviceConfig] = field(default_factory=dict)  # mac -> DeviceConfig


_CONFIG_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "config.json"


def _validate_mac(mac: str) -> None:
    """Validate MAC address format XX:XX:XX:XX:XX:XX.

    Args:
        mac: MAC address string to validate

    Raises:
        InvalidMACAddress: If the MAC format is invalid
    """
    from govee_cli.exceptions import InvalidMACAddress

    if not _MAC_PATTERN.match(mac):
        raise InvalidMACAddress(
            f"Invalid MAC address format: {mac}. Expected format: XX:XX:XX:XX:XX:XX"
        )


def _validate_device_name(name: str, existing_devices: dict[str, DeviceConfig]) -> None:
    """Ensure device name is unique (case-insensitive).

    Args:
        name: Device name to validate
        existing_devices: Current devices dictionary

    Raises:
        DuplicateDeviceName: If the name is already in use
    """
    from govee_cli.exceptions import DuplicateDeviceName

    name_lower = name.lower()
    for device in existing_devices.values():
        if device.name and device.name.lower() == name_lower:
            raise DuplicateDeviceName(f"Device name '{name}' is already in use")


def _validate_model(model: str) -> None:
    """Validate model is in SUPPORTED_DEVICES.

    Args:
        model: Device model to validate

    Raises:
        UnsupportedDevice: If the model is not supported
    """
    from govee_cli.devices import SUPPORTED_DEVICES
    from govee_cli.exceptions import UnsupportedDevice

    if model.upper() not in SUPPORTED_DEVICES:
        supported = ", ".join(SUPPORTED_DEVICES.keys())
        raise UnsupportedDevice(f"Unsupported device model: {model}. Supported: {supported}")


def get_device_by_mac(config: GoveeConfig, mac: str) -> DeviceConfig | None:
    """Get device config by MAC address.

    Args:
        config: GoveeConfig instance
        mac: MAC address to look up

    Returns:
        DeviceConfig if found, None otherwise
    """
    return config.devices.get(mac.upper())


def get_device_by_name(config: GoveeConfig, name: str) -> tuple[str, DeviceConfig] | None:
    """Get (mac, config) by device name. Case-insensitive.

    Args:
        config: GoveeConfig instance
        name: Device name to look up

    Returns:
        Tuple of (mac, DeviceConfig) if found, None otherwise
    """
    name_lower = name.lower()
    for mac, device in config.devices.items():
        if device.name and device.name.lower() == name_lower:
            return mac, device
    return None


def resolve_device_ref(config: GoveeConfig, ref: str) -> tuple[str, DeviceConfig]:
    """Resolve a device reference (name or MAC) to (mac, config).

    Args:
        config: GoveeConfig instance
        ref: Device reference - either a name or MAC address

    Returns:
        Tuple of (mac, DeviceConfig)

    Raises:
        DeviceNotConfigured: If the device is not found in config
        InvalidMACAddress: If ref looks like a MAC but is malformed
    """
    from govee_cli.exceptions import DeviceNotConfigured

    # Try as MAC first (exact match)
    if _MAC_PATTERN.match(ref):
        mac = ref.upper()
        device = get_device_by_mac(config, mac)
        if device:
            return mac, device
        raise DeviceNotConfigured(f"Device with MAC {ref} is not configured")

    # Try as name (case-insensitive)
    result = get_device_by_name(config, ref)
    if result:
        return result

    raise DeviceNotConfigured(f"Device '{ref}' not found in configuration")


def load_config() -> GoveeConfig:
    """Load config from ~/.config/govee-cli/config.json."""
    if not _CONFIG_PATH.exists():
        return GoveeConfig()

    with open(_CONFIG_PATH) as f:
        raw = json.load(f)

    # Migration: detect legacy format (no 'version' field)
    if "version" not in raw:
        raw = _migrate_v1_to_v2(raw)
        # Create config from migrated data and save immediately
        config = GoveeConfig(
            default_mac=raw.get("default_mac"),
            default_adapter=raw.get("default_adapter", _DEFAULT_ADAPTER),
            default_timeout=raw.get("default_timeout", 10.0),
            default_brightness=raw.get("default_brightness"),
            default_color=raw.get("default_color"),
            groups=raw.get("groups", {}),
            devices={
                mac.upper(): DeviceConfig(
                    model=device_data.get("model", ""),
                    name=device_data.get("name"),
                    static_mac=device_data.get("static_mac"),
                )
                for mac, device_data in raw.get("devices", {}).items()
            },
        )
        save_config(config)
        return config

    # Parse devices dict
    raw_devices = raw.get("devices", {})
    devices: dict[str, DeviceConfig] = {}
    for mac, device_data in raw_devices.items():
        model = device_data.get("model", "")
        if model:  # Only validate if model is provided
            _validate_model(model)
        devices[mac.upper()] = DeviceConfig(
            model=model,
            name=device_data.get("name"),
            static_mac=device_data.get("static_mac"),
        )

    return GoveeConfig(
        default_mac=raw.get("default_mac"),
        default_adapter=raw.get("default_adapter", _DEFAULT_ADAPTER),
        default_timeout=raw.get("default_timeout", 10.0),
        default_brightness=raw.get("default_brightness"),
        default_color=raw.get("default_color"),
        groups=raw.get("groups", {}),
        devices=devices,
    )


def save_config(config: GoveeConfig) -> None:
    """Save config to ~/.config/govee-cli/config.json."""
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Convert devices to serializable dict
    devices_data = {
        mac: {
            k: v
            for k, v in {
                "model": device.model,
                "name": device.name,
                "static_mac": device.static_mac,
            }.items()
            if v is not None and v != ""
        }
        for mac, device in config.devices.items()
    }

    data = {
        "version": CONFIG_VERSION,
        "default_mac": config.default_mac,
        "default_adapter": config.default_adapter,
        "default_timeout": config.default_timeout,
        "default_brightness": config.default_brightness,
        "default_color": config.default_color,
        "groups": config.groups,
        "devices": devices_data,
    }
    # Remove None values for cleanliness
    data = {k: v for k, v in data.items() if v is not None and v != ""}

    with open(_CONFIG_PATH, "w") as f:
        json.dump(data, f, indent=2)


def get_default_mac() -> str | None:
    """Return the default MAC from config, if set."""
    return load_config().default_mac
