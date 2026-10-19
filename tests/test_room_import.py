"""govee-cli room import-profiles: converter over the three real profile files."""

from __future__ import annotations

import json
import pathlib

import pytest
from click.testing import CliRunner

from govee_cli import config as config_mod
from govee_cli import ledger
from govee_cli import room_scenes
from govee_cli.commands import room as room_cmd
from govee_cli.config import DeviceConfig, GoveeConfig
from govee_cli.http_v2 import DIYScene

FIXTURES = pathlib.Path(__file__).parent / "fixtures" / "profiles"


class SendForbidden:
    """Any control method call fails the test; only the DIY list is readable."""

    def get_diy_scenes(self, sku, did):
        return [DIYScene("Dark-soho", 77)]

    def __getattr__(self, name):
        if name.startswith(("turn_", "set_")):
            raise AssertionError(f"import-profiles sent {name}")
        raise AttributeError(name)


def test_import_over_the_three_fixtures(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "6D:19:DD:6E:86:46:44:0C": DeviceConfig(model="H6056", name="Light Bars"),
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
        "82:1F:5C:E7:53:69:87:FA": DeviceConfig(model="H6008", name="Lamp Front"),
    }))  # no "Lamp Top" registered
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    out = CliRunner().invoke(room_cmd.room, ["import-profiles", "--dir", str(FIXTURES)])
    assert out.exit_code == 0, out.output
    text = out.output
    assert "no registered device named Lamp Top" in text
    assert "both colour and colour temperature set; pick one in the editor" in text
    assert "Nothing is sent to any device" in text

    scenes = room_scenes.list_scenes()
    assert set(scenes) == {"day", "relax", "sleep mode"}
    assert all(s.source == "authored" for s in scenes.values())
    assert "imported from profiles/relax.json" in (scenes["relax"].note or "")
    relax = {d.device_id: d for d in scenes["relax"].devices}
    shelf = relax["50:CE:E8:6E:80:C6:50:3F"]
    assert shelf.mode == "diy" and shelf.payload == {"diy_value": 77}
    sleep_ids = {d.device_id for d in scenes["sleep mode"].devices}
    assert "6D:19:DD:6E:86:46:44:0C" not in sleep_ids  # K + colour: skipped, not guessed

    # Second run: every scene exists, nothing is rewritten.
    again = CliRunner().invoke(room_cmd.room, ["import-profiles", "--dir", str(FIXTURES)])
    assert "scene 'day' already exists" in again.output


def test_hand_authored_white_rows_in_fixtures_import_as_white(monkeypatch):
    """The day/relax fixtures' white rows are intent, not state captures.

    They therefore carry an explicit "mode": "white", and must import as a
    real white row rather than being skipped as state-derived. This test exists
    so the fixture keeps declaring its intent: dropping the mode would silently
    drop the devices from the scene.
    """
    for name in ("day", "relax"):
        entry = json.loads((FIXTURES / f"{name}.json").read_text())["devices"]["Light Bars"]
        assert entry["mode"] == "white", f"{name}.json Light Bars must declare mode: white"
        assert entry["color_temp_k"] == 2700

    config_mod.save_config(GoveeConfig(devices={
        "6D:19:DD:6E:86:46:44:0C": DeviceConfig(model="H6056", name="Light Bars"),
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
        "82:1F:5C:E7:53:69:87:FA": DeviceConfig(model="H6008", name="Lamp Front"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    out = CliRunner().invoke(room_cmd.room, ["import-profiles", "--dir", str(FIXTURES)])
    assert out.exit_code == 0, out.output

    scenes = room_scenes.list_scenes()
    for name in ("day", "relax"):
        rows = {d.device_id: d for d in scenes[name].devices}
        bars = rows["6D:19:DD:6E:86:46:44:0C"]
        assert bars.mode == "basic" and bars.color_temp_k == 2700, name
        assert bars.brightness == 50, name
    day_rows = {d.device_id: d for d in scenes["day"].devices}
    shelf = day_rows["50:CE:E8:6E:80:C6:50:3F"]
    assert shelf.mode == "basic" and shelf.color_temp_k == 2700
    assert shelf.brightness == 60


def test_empty_diy_list_skips_as_unverifiable(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    entry = {"power": "on", "brightness": 60, "diy": "Dark-soho"}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped == "could not verify DIY scene: list unavailable"


def test_state_derived_colour_without_explicit_mode_is_not_authored(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color": "#FF8800"}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is not None
    assert "not authored as colour" in out.outcomes[0].skipped
    assert out.devices == []


def test_explicit_colour_mode_authors_state_colour(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color": "#FF8800", "mode": "colour"}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is None
    assert out.devices[0].mode == "basic"
    assert out.devices[0].color == [255, 136, 0]


def test_state_derived_temperature_without_explicit_mode_is_not_authored(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color_temp_k": 2700}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is not None
    assert "not authored as white" in out.outcomes[0].skipped
    assert out.devices == []


def test_explicit_white_mode_authors_state_temperature(monkeypatch):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color_temp_k": 2700, "mode": "white"}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is None
    assert out.devices[0].mode == "basic"
    assert out.devices[0].color_temp_k == 2700


@pytest.mark.parametrize(
    "field,value,mode",
    [
        ("color_temp_k", 2700, "basic"),
        ("color_temp_k", 2700, "white"),
        ("color", "#FF8800", "basic"),
        ("color", "#FF8800", "colour"),
        ("color", "#FF8800", "color"),  # the American spelling is accepted too
    ],
)
def test_every_keep_mode_spelling_authors_the_row(monkeypatch, field, value, mode):
    """Each documented keep-mode must author, not skip.

    `mode: "basic"` is a first-class keep-mode in its own right (the CLAUDE.md
    note and the skip hints name it), and the American "color" spelling is
    accepted, so both are pinned here rather than left to a refactor's mercy.
    """
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, field: value, "mode": mode}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is None, out.outcomes[0].skipped
    assert out.devices[0].mode == "basic"
    if field == "color_temp_k":
        assert out.devices[0].color_temp_k == 2700
        assert out.devices[0].color is None
    else:
        assert out.devices[0].color == [255, 136, 0]
        assert out.devices[0].color_temp_k is None


@pytest.mark.parametrize(
    "entry,expected",
    [
        ({"color": "#FF8800", "mode": "white"}, "does not match a colour"),
        ({"color_temp_k": 2700, "mode": "colour"}, "does not match a white temperature"),
    ],
)
def test_mismatched_explicit_mode_is_rejected_with_a_reason(monkeypatch, entry, expected):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    full = {"power": "on", "brightness": 60, **entry}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": full}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is not None
    assert expected in out.outcomes[0].skipped
    assert out.devices == []


def test_state_derived_temperature_rejected_even_with_basic_ledger(monkeypatch, tmp_path):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")
    ledger.record_mode("50:CE:E8:6E:80:C6:50:3F", "basic", None,
                      {"color_temp_k": 2700}, source="cli")

    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color_temp_k": 2700}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is not None
    assert "not authored as white" in out.outcomes[0].skipped
    assert out.devices == []


def test_state_derived_temperature_rejected_with_diy_ledger(monkeypatch, tmp_path):
    config_mod.save_config(GoveeConfig(devices={
        "50:CE:E8:6E:80:C6:50:3F": DeviceConfig(model="H6022", name="Shelf Lamp"),
    }))
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")
    ledger.record_mode("50:CE:E8:6E:80:C6:50:3F", "diy", "Dark-soho",
                      {"diy_value": 24136890}, source="cli")

    import govee_cli.http_v2 as http_v2

    monkeypatch.setattr(http_v2, "GoveeHTTPv2", lambda: SendForbidden())

    entry = {"power": "on", "brightness": 60, "color_temp_k": 2700}
    out = room_cmd.convert_profile(
        {"name": "x", "devices": {"Shelf Lamp": entry}}, "x.json",
        config_mod.load_config(), lambda mac, model: [], set(),
    )
    assert out.outcomes[0].skipped is not None
    assert "not authored as white" in out.outcomes[0].skipped
    assert out.devices == []
