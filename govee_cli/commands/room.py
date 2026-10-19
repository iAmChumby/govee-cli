"""room command — list, apply and import room scenes.

A room scene restores several devices to several different modes at once. It is
stored in ``~/.config/govee-cli/room-scenes.json`` and replayed by
``govee_cli.room_restore`` (the same executor the web console and the scheduler
use). ``import-profiles`` is the exception to "apply sends things": it only
writes room-scenes.json and sends nothing to any device.
"""

from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable

import click

from govee_cli import ledger, room_restore, room_scenes
from govee_cli.config import GoveeConfig, load_config
from govee_cli.room_scenes import CapturedDevice
from govee_cli.transport import get_spec

if TYPE_CHECKING:
    from govee_cli.http_v2 import DIYScene


@click.group()
def room() -> None:
    """Room scenes: several devices, several different modes, one name."""


@room.command(name="list")
def list_cmd() -> None:
    """List room scenes (name, source, device count, unknown count)."""
    scenes = room_scenes.list_scenes()
    if not scenes:
        click.echo("No room scenes saved.")
        return
    for name, scene in sorted(scenes.items()):
        unknown = sum(1 for d in scene.devices if d.mode == "unknown")
        click.echo(
            f"{name}  source={scene.source}  devices={len(scene.devices)}  unknown={unknown}"
        )


@room.command()
@click.argument("name")
def apply(name: str) -> None:
    """Send a room scene to its devices (this DOES command the lights)."""
    scene = room_scenes.read_scene(name)
    if scene is None:
        raise click.ClickException(f"Room scene '{name}' not found.")
    cfg = load_config()

    from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

    try:
        v2: GoveeHTTPv2 | None = GoveeHTTPv2()
    except GoveeV2Error:
        v2 = None  # devices that need the cloud will report it

    result = room_restore.restore_scene(
        name, scene, cfg=cfg, clients=room_restore.RestoreClients(v2=v2), source="cli"
    )
    errored = False
    for r in result.results:
        if r.skipped_reason is not None:
            click.echo(f"{r.ref}: skipped: {r.skipped_reason}")
        elif r.ok:
            click.echo(f"{r.ref}: ok")
        else:
            errored = True
            click.echo(f"{r.ref}: error: {r.error}")
        for note in r.notes:
            click.echo(f"    note: {note}")
    if errored:
        raise SystemExit(1)


# ------------------------------------------------------------------ import-profiles


@dataclass
class DeviceOutcome:
    name: str
    imported: str | None = None  # e.g. "white 2700K, 50%"
    skipped: str | None = None  # the reason


@dataclass
class FileReport:
    file: str
    scene_name: str | None = None
    outcomes: list[DeviceOutcome] = field(default_factory=list)
    devices: list[CapturedDevice] = field(default_factory=list)
    note: str | None = None
    skipped_reason: str | None = None  # whole-file skip
    written: bool = False


DiyLookup = Callable[[str, str], "list[DIYScene]"]


def convert_profile(
    data: Any, file_name: str, cfg: GoveeConfig, diy_lookup: DiyLookup,
    existing_scenes: set[str],
) -> FileReport:
    """Convert one parsed profile into an authored scene. Pure apart from
    ``diy_lookup`` (a read-only list call); it never writes and never sends."""
    report = FileReport(file=file_name)
    if not isinstance(data, dict) or not isinstance(data.get("name"), str) or not data["name"]:
        report.skipped_reason = "no scene name"
        return report
    name = data["name"]
    report.scene_name = name
    if name in existing_scenes:
        report.skipped_reason = f"scene '{name}' already exists"
        return report
    raw_devices = data.get("devices")
    if not isinstance(raw_devices, dict):
        report.skipped_reason = "no devices"
        return report

    origin = f"imported from profiles/{file_name}"
    file_note = data.get("note")
    report.note = f"{file_note} ({origin})" if isinstance(file_note, str) and file_note else origin

    for dev_name, entry in raw_devices.items():
        outcome = DeviceOutcome(name=dev_name)
        report.outcomes.append(outcome)
        reason_or_device = _convert_device(dev_name, entry, cfg, diy_lookup)
        if isinstance(reason_or_device, str):
            outcome.skipped = reason_or_device
        else:
            device, summary = reason_or_device
            report.devices.append(device)
            outcome.imported = summary

    if not report.devices:
        report.skipped_reason = "no importable devices; nothing written"
    skipped = [f"{o.name} ({o.skipped})" for o in report.outcomes if o.skipped]
    if skipped:
        # Say so on the scene itself: a note that mentions a device the scene
        # does not contain otherwise reads as if that device were in it.
        report.note = f"{report.note} Skipped on import: {'; '.join(skipped)}."
    return report


def _convert_device(
    dev_name: str, entry: Any, cfg: GoveeConfig, diy_lookup: DiyLookup
) -> str | tuple[CapturedDevice, str]:
    matches = [
        (mac, dc) for mac, dc in cfg.devices.items()
        if dc.name and dc.name.casefold() == dev_name.casefold()
    ]
    if not matches:
        return f"no registered device named {dev_name}"
    if len(matches) > 1:
        return f"ambiguous device name {dev_name}"
    mac, dc = matches[0]
    model = dc.model
    spec = get_spec(model)
    if not isinstance(entry, dict):
        return "profile entry is not an object"

    power_raw = entry.get("power")
    if power_raw not in ("on", "off"):
        return f"power must be \"on\" or \"off\", got {power_raw!r}"
    brightness = entry.get("brightness")
    if isinstance(brightness, bool) or not isinstance(brightness, int):
        return "brightness is missing or not a whole number"
    if not 1 <= brightness <= 100:
        return f"brightness {brightness} is outside 1-100"

    if power_raw == "off":
        data = {"device_id": mac, "power": False, "brightness": brightness}
        return room_scenes.captured_from_authored(data, model), f"off, {brightness}%"

    kelvin, colour, diy = entry.get("color_temp_k"), entry.get("color"), entry.get("diy")
    chosen = [n for n, v in (("colour temperature", kelvin), ("colour", colour),
                             ("DIY scene", diy)) if v is not None]
    if kelvin is not None and colour is not None and diy is None:
        return "both colour and colour temperature set; pick one in the editor"
    if len(chosen) > 1:
        return "more than one of colour, colour temperature and DIY set; pick one in the editor"
    if not chosen:
        return "no colour, colour temperature or DIY scene set"

    explicit_mode = entry.get("mode")
    # A temperature read from /device/state is only trustworthy as a stored
    # white row when the device's mode is known to be basic: the profile entry
    # says so explicitly. A bare color_temp_k with no explicit mode is the
    # "captured from live state" shape, and state always reports a stale
    # colorTemperatureK for a lamp running a DIY/scene/effect -- it must not
    # be promoted to white.
    if kelvin is not None and explicit_mode not in ("white", "basic"):
        if explicit_mode is None:
            # Consult the ledger: a device whose recorded mode is basic may
            # legitimately carry a temperature, even without an explicit mode
            # in the profile entry.
            try:
                ledger_entry = ledger.read_one(mac)
            except Exception:
                ledger_entry = None
            if ledger_entry is not None and ledger_entry.mode == "basic":
                pass
            else:
                return ("temperature taken from state with no explicit mode; "
                        "not authored as white")
        else:
            return (f"mode {explicit_mode!r} does not match a white temperature")

    base: dict[str, Any] = {"device_id": mac, "power": True, "brightness": brightness}
    if kelvin is not None:
        if isinstance(kelvin, bool) or not isinstance(kelvin, int):
            return "color_temp_k is not a whole number"
        if spec is None:
            return f"model {model} is unknown, cannot check the white range"
        if not spec.temp_min <= kelvin <= spec.temp_max:
            return f"{kelvin}K is outside {spec.temp_min}-{spec.temp_max}K for {model}"
        base.update(mode="white", color_temp_k=kelvin)
        summary = f"white {kelvin}K, {brightness}%"
    elif colour is not None:
        base.update(mode="colour", color=colour)
        summary = f"colour {colour}, {brightness}%"
    else:
        if not (spec and spec.cloud_diy):
            return f"{model} cannot store DIY scenes"
        try:
            scenes = diy_lookup(mac, model)
        except Exception:
            return "could not verify DIY scene: list unavailable"
        if not scenes:  # an empty list is unverifiable, not authoritative
            return "could not verify DIY scene: list unavailable"
        slug = "".join(ch for ch in str(diy).lower() if ch.isalnum())
        found = [s for s in scenes if "".join(ch for ch in s.name.lower() if ch.isalnum()) == slug]
        if not found:
            return f"no DIY scene named '{diy}' on {dev_name}"
        if len(found) > 1:
            return f"ambiguous DIY name '{diy}'"
        base.update(mode="diy", diy_value=found[0].value, diy_name=found[0].name)
        summary = f"DIY '{found[0].name}', {brightness}%"

    try:
        return room_scenes.captured_from_authored(base, model), summary
    except ValueError as e:
        return str(e)


@room.command(name="import-profiles")
@click.option("--dir", "directory", type=click.Path(path_type=pathlib.Path), default=None,
              help="Profile directory (default: ~/.config/govee-cli/profiles).")
@click.option("--dry-run", is_flag=True, help="Show what would be imported; write nothing.")
def import_profiles(directory: pathlib.Path | None, dry_run: bool) -> None:
    """Convert profile JSON files into authored room scenes.

    Writes ONLY room-scenes.json. Sends nothing to any device, and never
    modifies the profile files.
    """
    folder = directory or (pathlib.Path.home() / ".config" / "govee-cli" / "profiles")
    if not folder.is_dir():
        raise click.ClickException(f"Profile directory not found: {folder}")
    files = sorted(folder.glob("*.json"))
    if not files:
        click.echo(f"No *.json profiles in {folder}. Nothing sent, nothing written.")
        return

    cfg = load_config()
    diy_cache: dict[str, list[DIYScene]] = {}
    client_holder: list[Any] = []

    def diy_lookup(mac: str, model: str) -> list[DIYScene]:
        if mac not in diy_cache:
            if not client_holder:
                from govee_cli.http_v2 import GoveeHTTPv2

                client_holder.append(GoveeHTTPv2())
            diy_cache[mac] = client_holder[0].get_diy_scenes(model, mac)
        return diy_cache[mac]

    existing = set(room_scenes.list_scenes())
    click.echo(
        "Importing profiles into room-scenes.json only. "
        "Nothing is sent to any device." + (" (dry run: nothing written)" if dry_run else "")
    )
    imported_scenes = skipped_files = imported_devices = skipped_devices = 0
    bad_files = 0
    for path in files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            click.echo(f"{path.name}: unreadable ({e})")
            bad_files += 1
            continue
        report = convert_profile(data, path.name, cfg, diy_lookup, existing)
        click.echo(f"{path.name} -> scene '{report.scene_name or '?'}'")
        for o in report.outcomes:
            if o.imported:
                click.echo(f"  imported  {o.name}: {o.imported}")
            else:
                click.echo(f"  skipped   {o.name}: {o.skipped}")
        skipped_devices += sum(1 for o in report.outcomes if o.skipped)
        if report.skipped_reason:
            click.echo(f"  file skipped: {report.skipped_reason}")
            skipped_files += 1
            continue
        imported_devices += len(report.devices)
        if not dry_run:
            try:
                room_scenes.save_authored_scene(
                    report.scene_name or "", report.devices, note=report.note
                )
            except room_scenes.SceneExistsError:
                click.echo(f"  file skipped: scene '{report.scene_name}' already exists")
                skipped_files += 1
                imported_devices -= len(report.devices)
                continue
            existing.add(report.scene_name or "")
        imported_scenes += 1
        click.echo("  " + ("would write" if dry_run else "written"))
    click.echo(
        f"{imported_scenes} scene(s) {'would be ' if dry_run else ''}imported "
        f"({imported_devices} devices imported, {skipped_devices} skipped), "
        f"{skipped_files} file(s) skipped, {bad_files} unreadable. Nothing sent to any device."
    )
    if bad_files:
        raise SystemExit(1)
