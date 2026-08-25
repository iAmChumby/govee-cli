"""group command — multi-device groups with BLE + HTTP support."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import click

from govee_cli.ble import GoveeBLE
from govee_cli.ble.protocol import Command
from govee_cli.config import load_config, resolve_device_ref, save_config
from govee_cli.exceptions import DeviceNotConfigured, GoveeError
from govee_cli.http import GoveeHTTP, GoveeHTTPError
from govee_cli.transport import CLOUD_V1, CLOUD_V2, transport_for

if TYPE_CHECKING:
    from govee_cli.http_v2 import GoveeHTTPv2


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


@group.command(name="state")
@click.argument("name")
def group_state(name: str) -> None:
    """Read state of all devices in a group without sending commands."""
    cfg = load_config()
    group_refs = cfg.groups.get(name)
    if not group_refs:
        raise click.ClickException(f"Group '{name}' not found.")

    from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

    v1_client = GoveeHTTP()
    v2_client_instance = None
    all_ok = True

    for ref in group_refs:
        try:
            mac, dev_cfg = resolve_device_ref(cfg, ref)
        except DeviceNotConfigured:
            if ref.upper() in cfg.devices:
                mac = ref.upper()
                dev_cfg = cfg.devices[mac]
            else:
                click.echo(f"⚠️  '{ref}' — device not found, skipping")
                all_ok = False
                continue

        model = dev_cfg.model if dev_cfg else None
        label = dev_cfg.name if dev_cfg and dev_cfg.name else mac
        transport = transport_for(model)
        # transport_for(None) is BLE, so a cloud branch always has a model.
        cloud_model = model or ""

        if transport == CLOUD_V2:
            if v2_client_instance is None:
                v2_client_instance = GoveeHTTPv2()
            try:
                state = v2_client_instance.get_state(cloud_model, mac)
            except GoveeV2Error:
                click.echo(f"  ❌ {label} — offline or error")
                all_ok = False
                continue
            power = "on" if state.get("powerSwitch") == 1 else "off"
            click.echo(f"  {'✅' if power == 'on' else '⚪'} {label}")
            click.echo(
                f"     brightness={state.get('brightness', '?')}% "
                f"temp={state.get('colorTemperatureK', 0)}K"
            )
            rgb_int = state.get("colorRgb")
            if isinstance(rgb_int, int) and rgb_int > 0:
                click.echo(
                    f"     color=RGB({(rgb_int >> 16) & 0xFF},"
                    f"{(rgb_int >> 8) & 0xFF},{rgb_int & 0xFF})"
                )
            continue

        if transport == CLOUD_V1:
            try:
                state = v1_client.get_state(mac, cloud_model)
            except GoveeHTTPError:
                click.echo(f"  ❌ {label} — offline or error")
                all_ok = False
                continue
            power = state.get("powerState", "?")
            click.echo(f"  {'✅' if power == 'on' else '⚪'} {label}")
            click.echo(
                f"     brightness={state.get('brightness', '?')}% "
                f"temp={state.get('colorTem', 0)}K"
            )
            color_rgb = state.get("color", {})
            if color_rgb:
                click.echo(
                    f"     color=RGB({color_rgb.get('r', '?')},"
                    f"{color_rgb.get('g', '?')},{color_rgb.get('b', '?')})"
                )
            continue

        click.echo(f"  ⚠️  {label} [{model}] — no cloud state available, skipping")
        all_ok = False

    if not all_ok:
        raise SystemExit(1)


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

        transport = transport_for(model)
        cloud_model = model or ""

        if transport == CLOUD_V2:
            from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

            try:
                _apply_v2_command(GoveeHTTPv2(), mac, cloud_model, cmd_str)
                results.append((mac, True, "ok"))
            except (GoveeV2Error, click.ClickException) as e:
                results.append((mac, False, str(e)))
            continue

        if transport == CLOUD_V1:
            try:
                _apply_http_command(GoveeHTTP(), mac, cloud_model, cmd_str)
                results.append((mac, True, "ok"))
            except (GoveeHTTPError, click.ClickException) as e:
                results.append((mac, False, str(e)))
            continue

        # BLE fallback
        try:
            from govee_cli.commands._common import Target

            ble_mac = Target(mac, model, transport, cfg).ble_mac
            maybe_parsed = _parse_inline_command(cmd_str, device_model=model)
            if maybe_parsed is None:
                results.append((mac, False, f"Unknown command: {cmd_str}"))
                continue
            parsed: Command = maybe_parsed

            # Bind the loop variables as defaults: the closure is invoked in
            # this iteration today, but B023 is right that a later refactor
            # deferring the call would silently run against the last device.
            async def run_ble(addr: str = ble_mac, command: Command = parsed) -> None:
                async with GoveeBLE(addr, adapter=adapter) as client:
                    await client.execute(command)

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


def _int_arg(value: str, what: str) -> int:
    """Parse a numeric group-command argument into a clean CLI error.

    `group run <name> brightness abc` used to surface a raw ValueError traceback
    from int(); a group command is user input and deserves a message.
    """
    try:
        return int(value)
    except ValueError:
        raise click.ClickException(f"{what} must be a number, got '{value}'") from None


def _apply_v2_command(client: "GoveeHTTPv2", device_id: str, model: str,
                      cmd_str: str) -> None:
    """Apply a group command to a cloud v2 device.

    v2 devices accept more verbs than v1 does, so `group run` can drive scenes,
    DIY scenes, segments and music across a group — not just the basic four.
    """
    from govee_cli.commands._common import parse_hex, parse_segments
    from govee_cli.devices import SUPPORTED_DEVICES
    from govee_cli.transport import get_spec

    parts = cmd_str.strip().split()
    if not parts:
        raise click.ClickException("Empty command.")
    verb, args = parts[0].lower(), parts[1:]

    if verb == "power" and len(args) == 1:
        client.turn_on(model, device_id) if args[0] == "on" else client.turn_off(model, device_id)
        return

    if verb == "brightness" and len(args) == 1:
        client.set_brightness(model, device_id, _int_arg(args[0], "brightness"))
        return

    if verb == "color" and len(args) == 1:
        r, g, b = parse_hex(args[0])
        client.set_color(model, device_id, r, g, b)
        return

    if verb == "temp" and len(args) == 1:
        client.set_color_temp(model, device_id, _int_arg(args[0], "temp"))
        return

    if verb == "scene" and args:
        name = " ".join(args)
        scene = client.find_scene(model, device_id, name)
        if scene is None:
            raise click.ClickException(f"Unknown scene '{name}' for {model}")
        client.set_scene(model, device_id, scene)
        return

    if verb == "diy" and args:
        name = " ".join(args)
        diy = client.find_diy_scene(model, device_id, name)
        if diy is None:
            raise click.ClickException(f"Unknown DIY scene '{name}' for {model}")
        client.set_diy_scene(model, device_id, diy.value)
        return

    if verb == "segments" and len(args) == 2:
        spec = get_spec(model)
        count = spec.segment_count if spec else 15
        segments = parse_segments(args[0], count)
        r, g, b = parse_hex(args[1])
        client.set_segment_color(model, device_id, segments, r, g, b)
        return

    if verb == "toggle" and len(args) == 2:
        spec = get_spec(model)
        wanted = args[0].lower().removesuffix("toggle")
        known = list(spec.toggles) if spec else []
        instance = next(
            (t for t in known if t.lower() in (args[0].lower(), f"{wanted}toggle")),
            None,
        )
        if instance is None:
            raise click.ClickException(
                f"Unknown toggle '{args[0]}' for {model}. "
                f"Available: {', '.join(known) or '(none)'}"
            )
        client.set_toggle(model, device_id, instance, args[1].lower() == "on")
        return

    if verb == "music" and args:
        handler = SUPPORTED_DEVICES.get(model.upper())
        modes = dict(getattr(handler, "MUSIC_MODES", {}) or {})
        key = args[0].lower()
        if key not in modes:
            raise click.ClickException(
                f"Unknown music mode '{args[0]}' for {model}. Available: {', '.join(modes)}"
            )
        sensitivity = _int_arg(args[1], "sensitivity") if len(args) > 1 else 60
        client.set_music_mode(model, device_id, modes[key], sensitivity)
        return

    raise click.ClickException(f"Unsupported command for {model}: {cmd_str}")


def _apply_http_command(client: GoveeHTTP, mac: str, model: str, cmd_str: str) -> None:
    """Apply an HTTP command to a device."""
    parts = cmd_str.strip().split()
    verb = parts[0].lower()
    args = parts[1:]

    if verb == "power" and len(args) == 1:
        client.turn_on(mac, model) if args[0] == "on" else client.turn_off(mac, model)
        return

    if verb == "brightness" and len(args) == 1:
        client.set_brightness(mac, model, _int_arg(args[0], "brightness"))
        return

    if verb == "color" and len(args) == 1:
        from govee_cli.commands._common import parse_hex

        r, g, b = parse_hex(args[0])
        client.set_color(mac, model, r, g, b)
        return

    if verb == "temp" and len(args) == 1:
        client.set_color_temp(mac, model, _int_arg(args[0], "temp"))
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
