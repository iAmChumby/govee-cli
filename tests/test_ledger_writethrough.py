"""Ledger write-through tests for the ten CLI command files T03 touches.

Each command's contract with the ledger is deliberately non-uniform (see
WEBUI_V3_SPEC.md §3.3): brightness never writes, power distinguishes off from
bare-on, color/temp always overwrite to "basic", music resolves the mode to its
per-model NAME (never the raw int), segments writes exactly one entry even
though it makes two client calls on this device, and the daemon writes with
source="schedule". One test class per command file, each asserting the ledger
state via ``ledger.read_one()`` after a mocked-successful invocation — mirroring
the fixture pattern in tests/test_transport_routing.py and tests/test_ledger.py.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from click.testing import CliRunner

from govee_cli import ledger
from govee_cli.cli import main
from govee_cli.config import DeviceConfig, GoveeConfig

BARS = "6D:19:DD:6E:86:46:44:0C"  # H6056, Light Bars
LAMP = "50:CE:E8:6E:80:C6:50:3F"  # H6022, Shelf Lamp


def _config() -> GoveeConfig:
    return GoveeConfig(
        api_key="test-key",
        devices={
            BARS: DeviceConfig(model="H6056", name="Light Bars"),
            LAMP: DeviceConfig(model="H6022", name="Shelf Lamp"),
        },
    )


@pytest.fixture
def ledger_paths(tmp_path, monkeypatch):
    """Point the ledger at a temp location — never touch the real file."""
    path = tmp_path / "active-mode.json"
    lock_path = tmp_path / "active-mode.json.lock"
    monkeypatch.setattr(ledger, "LEDGER_PATH", path)
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", lock_path)
    return path, lock_path


@pytest.fixture
def runner() -> CliRunner:
    return CliRunner()


@pytest.fixture
def clients():
    """Patch both cloud clients and yield (v1, v2) mocks."""
    v1, v2 = MagicMock(), MagicMock()
    with patch("govee_cli.commands._common.load_config", return_value=_config()), \
         patch("govee_cli.http.GoveeHTTP", return_value=v1), \
         patch("govee_cli.http_v2.GoveeHTTPv2", return_value=v2):
        yield v1, v2


class TestPowerWriteThrough:
    def test_on_writes_basic(self, runner, clients, ledger_paths) -> None:
        result = runner.invoke(main, ["power", "on", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.label is None
        assert entry.payload is None
        assert entry.source == "cli"

    def test_off_writes_off(self, runner, clients, ledger_paths) -> None:
        result = runner.invoke(main, ["power", "off", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "off"


class TestBrightnessNeverWrites:
    def test_brightness_does_not_touch_the_ledger(self, runner, clients, ledger_paths) -> None:
        # Pre-seed an entry so a bug that clears/overwrites it is visible too.
        ledger.record_mode(BARS, "diy", "sleep", {"diy_value": 4}, source="cli")
        result = runner.invoke(main, ["brightness", "40", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "diy"  # unchanged — brightness is a live modifier
        assert entry.label == "sleep"


class TestColorWriteThrough:
    def test_color_overwrites_to_basic(self, runner, clients, ledger_paths) -> None:
        ledger.record_mode(BARS, "scene", "sunset", {"scene_id": 1}, source="cli")
        result = runner.invoke(main, ["color", "FF5500", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.payload == {"color_rgb": [255, 85, 0]}


class TestTempWriteThrough:
    def test_temp_overwrites_to_basic(self, runner, clients, ledger_paths) -> None:
        ledger.record_mode(BARS, "music", "vivid", {"music_mode": 0}, source="cli")
        result = runner.invoke(main, ["temp", "3000", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.payload == {"color_temp_k": 3000}


class TestSceneWriteThrough:
    def test_scene_records_resolved_name_and_ids(self, runner, clients, ledger_paths) -> None:
        _, v2 = clients
        scene = MagicMock()
        scene.name = "Sunset"
        scene.scene_id = 42
        scene.param_id = 7
        v2.find_scene.return_value = scene
        result = runner.invoke(main, ["scene", "sunset", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "scene"
        assert entry.label == "Sunset"
        assert entry.payload == {"scene_id": 42, "param_id": 7}


class TestDiyWriteThrough:
    def test_diy_records_resolved_name(self, runner, clients, ledger_paths) -> None:
        _, v2 = clients
        diy = MagicMock()
        diy.name = "Sleep"
        diy.value = 9
        v2.find_diy_scene.return_value = diy
        result = runner.invoke(main, ["diy", "sleep", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "diy"
        assert entry.label == "Sleep"
        assert entry.payload == {"diy_value": 9}


class TestMusicWriteThrough:
    def test_music_label_is_the_mode_name_not_the_int(
        self, runner, clients, ledger_paths
    ) -> None:
        # "beat" is 4 on the H6056 and something else entirely on the H6022 —
        # the ledger must never store the bare integer.
        result = runner.invoke(main, ["music", "beat", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "music"
        assert entry.label == "beat"
        assert entry.payload is not None
        assert entry.payload["music_mode"] == 4
        assert isinstance(entry.payload["music_mode"], int)


class TestSnapshotWriteThrough:
    def test_snapshot_records_resolved_name(self, runner, clients, ledger_paths) -> None:
        _, v2 = clients
        device = MagicMock()
        cap = MagicMock()
        cap.parameters = {"options": [{"name": "Cozy", "value": 5}]}
        device.capability.return_value = cap
        v2.get_device.return_value = device
        result = runner.invoke(main, ["snapshot", "Cozy", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "snapshot"
        assert entry.label == "Cozy"
        assert entry.payload == {"snapshot_value": 5}

    def test_snapshot_falls_back_to_numbered_label(self, runner, clients, ledger_paths) -> None:
        _, v2 = clients
        device = MagicMock()
        cap = MagicMock()
        cap.parameters = {"options": []}
        device.capability.return_value = cap
        v2.get_device.return_value = device
        result = runner.invoke(main, ["snapshot", "12345", "--device", "Light Bars"])
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.label == "snapshot #12345"


class TestSegmentsWriteThrough:
    def test_segments_writes_exactly_one_entry_for_two_client_calls(
        self, runner, clients, ledger_paths
    ) -> None:
        _, v2 = clients
        result = runner.invoke(
            main, ["segments", "0-2", "FF0000", "--brightness", "30",
                   "--device", "Light Bars"],
        )
        assert result.exit_code == 0, result.output
        v2.set_segment_color.assert_called_once()
        v2.set_segment_brightness.assert_called_once()
        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "segments"
        assert entry.payload == {
            "segments": [0, 1, 2], "rgb": [255, 0, 0], "brightness": 30,
        }


class TestSegmentsBleWriteThrough:
    """Regression test: the BLE branch was silently skipping the ledger write,
    even though §3.3's "Rejected" reasoning explicitly names BLE segment paint
    as the reason command-layer (not transport-layer) hooking was chosen."""

    def test_ble_segments_writes_one_entry(self, runner, clients, ledger_paths) -> None:
        ble_client = MagicMock()
        ble_client.execute = AsyncMock(return_value=True)
        ble_conn = MagicMock()
        ble_conn.__aenter__ = AsyncMock(return_value=ble_client)
        ble_conn.__aexit__ = AsyncMock(return_value=False)

        # An unregistered raw MAC resolves to the BLE transport (see
        # transport.resolve_target) — no model in _config() maps there.
        device_id = "AA:BB:CC:DD:EE:FF"
        with patch("govee_cli.ble.GoveeBLE", return_value=ble_conn):
            result = runner.invoke(
                main, ["segments", "0-1", "FF0000", "--device", device_id],
            )
        assert result.exit_code == 0, result.output
        assert ble_client.execute.call_count == 2  # one packet per segment
        entry = ledger.read_one(device_id)
        assert entry is not None
        assert entry.mode == "segments"
        assert entry.payload == {
            "segments": [0, 1], "rgb": [255, 0, 0], "brightness": None,
        }
        assert entry.source == "cli"


class TestDaemonWriteThrough:
    """daemon.py's _execute_rule must record with source="schedule"."""

    def test_fired_scene_rule_records_schedule_source(self, ledger_paths) -> None:
        from govee_cli.commands.daemon import SchedulerDaemon
        from govee_cli.schedule.scheduler import ScheduleRule

        scene = MagicMock()
        scene.name = "Sunset"
        scene.scene_id = 42
        scene.param_id = 7
        v2 = MagicMock()
        v2.find_scene.return_value = scene

        rule = ScheduleRule(
            id="r1", name="Evening Scene", time="20:00", days=["Mon"],
            command="scene sunset", device="Light Bars",
        )

        with patch("govee_cli.commands.daemon.list_rules", return_value=[]), \
             patch("govee_cli.config.load_config", return_value=_config()), \
             patch("govee_cli.transport.resolve_target",
                   return_value=(BARS, "H6056", "cloud-v2")), \
             patch("govee_cli.http_v2.GoveeHTTPv2", return_value=v2):
            daemon = SchedulerDaemon(once=True)
            asyncio.run(daemon._execute_rule(rule))

        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "scene"
        assert entry.label == "Sunset"
        assert entry.source == "schedule"

    def test_fired_power_off_rule_records_schedule_source(self, ledger_paths) -> None:
        from govee_cli.commands.daemon import SchedulerDaemon
        from govee_cli.schedule.scheduler import ScheduleRule

        v2 = MagicMock()
        rule = ScheduleRule(
            id="r2", name="Bedtime", time="23:00", days=["Mon"],
            command="power off", device="Light Bars",
        )

        with patch("govee_cli.commands.daemon.list_rules", return_value=[]), \
             patch("govee_cli.config.load_config", return_value=_config()), \
             patch("govee_cli.transport.resolve_target",
                   return_value=(BARS, "H6056", "cloud-v2")), \
             patch("govee_cli.http_v2.GoveeHTTPv2", return_value=v2):
            daemon = SchedulerDaemon(once=True)
            asyncio.run(daemon._execute_rule(rule))

        entry = ledger.read_one(BARS)
        assert entry is not None
        assert entry.mode == "off"
        assert entry.source == "schedule"

    def test_rule_reports_success_even_if_ledger_lookup_raises(
        self, ledger_paths, capsys
    ) -> None:
        """Regression test: _record_schedule_ledger's scene/diy branches make a
        second cloud lookup (find_scene) that is independent of the device
        command's own success. Before the fix, an exception there (network
        blip, rate limit) was caught by _execute_rule's own outer
        except-Exception — which means it never escaped the function, but it
        DID mislabel an already-successful device command as "❌ Error"
        instead of "✅ Done". Asserting "doesn't raise" alone is not enough to
        catch this (that outer catch was already there); the real signal is
        which message gets echoed.
        """
        from govee_cli.commands.daemon import SchedulerDaemon
        from govee_cli.schedule.scheduler import ScheduleRule

        scene = MagicMock()
        scene.name = "Sunset"
        v2 = MagicMock()
        # The device command itself (find_scene inside _apply_v2_command)
        # succeeds; only the *ledger's own* second lookup blows up.
        v2.find_scene.side_effect = [scene, RuntimeError("blip")]

        rule = ScheduleRule(
            id="r3", name="Evening Scene", time="20:00", days=["Mon"],
            command="scene sunset", device="Light Bars",
        )

        with patch("govee_cli.commands.daemon.list_rules", return_value=[]), \
             patch("govee_cli.config.load_config", return_value=_config()), \
             patch("govee_cli.transport.resolve_target",
                   return_value=(BARS, "H6056", "cloud-v2")), \
             patch("govee_cli.http_v2.GoveeHTTPv2", return_value=v2):
            daemon = SchedulerDaemon(once=True)
            asyncio.run(daemon._execute_rule(rule))

        out = capsys.readouterr().out
        assert "✅ Done" in out, out
        assert "❌ Error" not in out, out
        # The ledger bookkeeping failure is swallowed rather than surfacing —
        # no entry is fine (the second lookup never completed), a mislabeled
        # rule failure is not.
        assert ledger.read_one(BARS) is None


class TestEffectWriteThrough:
    """`govee-cli effect` — the one CLI write site §3.3 describes that no task in
    §8's breakdown owned, found by the T03 review.

    Three outcomes, three different ledger results: an effect that runs to its
    end leaves the light on its final colour ("basic"), an effect the user
    interrupts stays "effect" because Ctrl+C says nothing about where the light
    landed, and an effect that fails to start puts back whatever was there
    before rather than claiming an animation is playing.
    """

    @staticmethod
    def _effect_file(tmp_path):
        import json

        path = tmp_path / "two-frame.json"
        path.write_text(json.dumps({
            "name": "two-frame",
            "fps": 2,
            "loop": False,
            "segments": [{"id": 0, "keyframes": [
                {"t": 0, "color": "FF0000"},
                {"t": 500, "color": "0000FF"},
            ]}],
        }))
        return path

    def test_natural_finish_downgrades_to_final_colour(
        self, runner, clients, ledger_paths, tmp_path
    ) -> None:
        path = self._effect_file(tmp_path)
        result = runner.invoke(
            main, ["effect", str(path), "--device", "Shelf Lamp", "--cloud", "--fps", "2"]
        )
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.payload == {"color_rgb": [0, 0, 255]}

    def test_final_colour_is_the_last_frame_actually_sent(
        self, runner, clients, ledger_paths, tmp_path
    ) -> None:
        """Not the last keyframe authored — the last frame the transport reached.

        Cloud playback defaults to 1fps to stay inside the request budget, so a
        500ms effect emits exactly one frame and never reaches its own final
        keyframe. The ledger records the red the device was actually left on,
        not the blue the file ends with.
        """
        path = self._effect_file(tmp_path)
        result = runner.invoke(
            main, ["effect", str(path), "--device", "Shelf Lamp", "--cloud"]
        )
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.payload == {"color_rgb": [255, 0, 0]}

    def test_interrupt_stays_on_effect(
        self, runner, clients, ledger_paths, tmp_path
    ) -> None:
        path = self._effect_file(tmp_path)
        with patch("govee_cli.commands.effect._play_cloud", side_effect=KeyboardInterrupt):
            result = runner.invoke(
                main, ["effect", str(path), "--device", "Shelf Lamp", "--cloud"]
            )
        assert result.exit_code == 0, result.output
        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "effect"
        assert entry.label == "two-frame"

    def test_failed_start_restores_the_previous_entry(
        self, runner, clients, ledger_paths, tmp_path
    ) -> None:
        ledger.record_mode(LAMP, "diy", "sleep", {"diy_value": 4}, source="cli")
        path = self._effect_file(tmp_path)
        with patch("govee_cli.commands.effect._play_cloud",
                   side_effect=RuntimeError("cloud refused")):
            runner.invoke(main, ["effect", str(path), "--device", "Shelf Lamp", "--cloud"])
        entry = ledger.read_one(LAMP)
        assert entry is not None
        assert entry.mode == "diy"
        assert entry.label == "sleep"
