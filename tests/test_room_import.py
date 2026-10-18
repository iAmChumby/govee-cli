"""govee-cli room import-profiles: converter over the three real profile files."""

from __future__ import annotations

import pathlib

from click.testing import CliRunner

from govee_cli import config as config_mod
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
