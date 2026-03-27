"""Local config file for govee-cli.

Config lives at ~/.config/govee-cli/config.json
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field


@dataclass
class GoveeConfig:
    """govee-cli configuration."""

    default_mac: str | None = None
    default_adapter: str = "hci0"
    default_timeout: float = 10.0
    default_brightness: int | None = None
    default_color: str | None = None  # RRGGGGBB hex
    groups: dict[str, list[str]] = field(default_factory=dict)  # group_name -> [mac, ...]


_CONFIG_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "config.json"


def load_config() -> GoveeConfig:
    """Load config from ~/.config/govee-cli/config.json."""
    if not _CONFIG_PATH.exists():
        return GoveeConfig()

    with open(_CONFIG_PATH) as f:
        raw = json.load(f)

    return GoveeConfig(
        default_mac=raw.get("default_mac"),
        default_adapter=raw.get("default_adapter", "hci0"),
        default_timeout=raw.get("default_timeout", 10.0),
        default_brightness=raw.get("default_brightness"),
        default_color=raw.get("default_color"),
        groups=raw.get("groups", {}),
    )


def save_config(config: GoveeConfig) -> None:
    """Save config to ~/.config/govee-cli/config.json."""
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    data = {
        "default_mac": config.default_mac,
        "default_adapter": config.default_adapter,
        "default_timeout": config.default_timeout,
        "default_brightness": config.default_brightness,
        "default_color": config.default_color,
        "groups": config.groups,
    }
    # Remove None values for cleanliness
    data = {k: v for k, v in data.items() if v is not None}

    with open(_CONFIG_PATH, "w") as f:
        json.dump(data, f, indent=2)


def get_default_mac() -> str | None:
    """Return the default MAC from config, if set."""
    return load_config().default_mac
