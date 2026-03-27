"""config command — view and edit govee-cli configuration."""

import json

import click

from govee_cli.config import GoveeConfig, load_config, save_config


@click.command()
@click.option("--mac", "default_mac", help="Default device MAC address")
@click.option("--adapter", help="Default Bluetooth adapter (e.g. hci0)")
@click.option("--timeout", type=float, help="Default BLE timeout in seconds")
@click.option("--brightness", type=int, help="Default brightness 0-100")
@click.option("--color", help="Default color as RRGGBB hex")
@click.option("--show", "show_only", is_flag=True, help="Show current config and exit")
def command(
    default_mac: str | None,
    default_adapter: str | None,
    default_timeout: float | None,
    default_brightness: int | None,
    default_color: str | None,
    show_only: bool,
) -> None:
    """View or edit govee-cli configuration.

    Calling with no options shows the current config.
    Any option provided updates the config.
    """
    cfg = load_config()

    if show_only or all(
        v is None
        for v in [default_mac, default_adapter, default_timeout, default_brightness, default_color]
    ):
        _print_config(cfg)
        return

    # Update provided fields
    if default_mac is not None:
        cfg.default_mac = default_mac
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


def _print_config(cfg: GoveeConfig) -> None:
    """Print a human-readable config."""
    print(json.dumps({
        "default_mac": cfg.default_mac,
        "default_adapter": cfg.default_adapter,
        "default_timeout": cfg.default_timeout,
        "default_brightness": cfg.default_brightness,
        "default_color": cfg.default_color,
        "groups": cfg.groups,
    }, indent=2))
