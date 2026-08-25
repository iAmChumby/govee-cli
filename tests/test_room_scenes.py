"""Tests for govee_cli.room_scenes — room-scene capture/restore planning.

Covers: write-then-read round trip, replace-by-name, missing/corrupt-JSON files
reading back as {} without raising, and plan_restore()'s mode dispatch table —
the honesty-critical part of T19: an `effect` or `unknown` captured mode must
never be restored to a guess.
"""

from __future__ import annotations

import pytest

from govee_cli import room_scenes
from govee_cli.room_scenes import CapturedDevice, RoomScene


@pytest.fixture
def scene_paths(tmp_path, monkeypatch):
    """Point the room-scenes store at a temp location, mirroring test_ledger.py."""
    path = tmp_path / "room-scenes.json"
    lock_path = tmp_path / "room-scenes.json.lock"
    monkeypatch.setattr(room_scenes, "ROOM_SCENES_PATH", path)
    monkeypatch.setattr(room_scenes, "ROOM_SCENES_LOCK_PATH", lock_path)
    return path, lock_path


def _device(
    device_id="dev-1",
    model="H6022",
    power=True,
    brightness=30,
    color=None,
    color_temp_k=None,
    mode="basic",
    label=None,
    payload=None,
):
    return CapturedDevice(
        device_id=device_id,
        model=model,
        power=power,
        brightness=brightness,
        color=color,
        color_temp_k=color_temp_k,
        mode=mode,
        label=label,
        payload=payload,
    )


class TestRoundTrip:
    def test_list_scenes_empty_when_no_file(self, scene_paths):
        assert room_scenes.list_scenes() == {}

    def test_save_then_read_scene(self, scene_paths):
        devices = [_device(color=[12, 8, 40])]
        room_scenes.save_scene("Sleep", devices)

        scene = room_scenes.read_scene("Sleep")
        assert scene is not None
        assert scene.created_at  # non-empty ISO timestamp
        assert scene.devices == devices

    def test_read_scene_missing_name_returns_none(self, scene_paths):
        assert room_scenes.read_scene("Nope") is None

    def test_save_then_list_scenes(self, scene_paths):
        room_scenes.save_scene("Sleep", [_device(device_id="dev-1")])
        room_scenes.save_scene("Party", [_device(device_id="dev-2")])

        scenes = room_scenes.list_scenes()
        assert set(scenes) == {"Sleep", "Party"}
        assert scenes["Sleep"].devices[0].device_id == "dev-1"
        assert scenes["Party"].devices[0].device_id == "dev-2"

    def test_save_replaces_by_name(self, scene_paths):
        room_scenes.save_scene("Sleep", [_device(device_id="dev-1")])
        room_scenes.save_scene("Sleep", [_device(device_id="dev-2")])

        scenes = room_scenes.list_scenes()
        assert len(scenes) == 1
        assert scenes["Sleep"].devices[0].device_id == "dev-2"

    def test_delete_scene_returns_true_and_removes(self, scene_paths):
        room_scenes.save_scene("Sleep", [_device()])
        assert room_scenes.delete_scene("Sleep") is True
        assert room_scenes.read_scene("Sleep") is None

    def test_delete_scene_returns_false_when_absent(self, scene_paths):
        assert room_scenes.delete_scene("Nope") is False


class TestCorruptAndMissingFile:
    def test_missing_file_yields_empty_dict(self, scene_paths):
        path, _ = scene_paths
        assert not path.exists()
        assert room_scenes.list_scenes() == {}

    def test_empty_file_yields_empty_dict(self, scene_paths):
        path, _ = scene_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        assert room_scenes.list_scenes() == {}

    def test_corrupt_json_yields_empty_dict(self, scene_paths):
        path, _ = scene_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not valid json")
        assert room_scenes.list_scenes() == {}

    def test_corrupt_json_does_not_raise_on_save(self, scene_paths):
        path, _ = scene_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not valid json")
        # save_scene reads-modifies-writes; a corrupt existing file must not
        # propagate as an exception out of the never-raise contract.
        room_scenes.save_scene("Sleep", [_device()])
        assert room_scenes.read_scene("Sleep") is not None

    def test_missing_directory_does_not_raise(self, tmp_path, monkeypatch):
        # A parent directory that doesn't exist yet (fresh install) must not
        # raise — save_scene creates it, list_scenes/read_scene just see "empty".
        nested = tmp_path / "nested" / "room-scenes.json"
        monkeypatch.setattr(room_scenes, "ROOM_SCENES_PATH", nested)
        monkeypatch.setattr(room_scenes, "ROOM_SCENES_LOCK_PATH", nested.with_suffix(".json.lock"))
        assert room_scenes.list_scenes() == {}


class TestPlanRestoreOrdering:
    """power-before-mode-before-brightness, for every mode that restores."""

    def test_off_mode_is_power_off_only(self):
        scene = RoomScene(created_at="t", devices=[_device(mode="off")])
        steps = room_scenes.plan_restore(scene)
        assert len(steps) == 1
        assert steps[0].kind == "power"
        assert steps[0].args == {"on": False}
        assert steps[0].skipped_reason is None

    def test_basic_mode_color_orders_power_color_brightness(self):
        scene = RoomScene(
            created_at="t",
            devices=[_device(mode="basic", color=[255, 0, 0], brightness=50)],
        )
        steps = room_scenes.plan_restore(scene)
        kinds = [s.kind for s in steps]
        assert kinds == ["power", "color", "brightness"]
        assert steps[0].args == {"on": True}
        assert steps[1].args == {"rgb": [255, 0, 0]}
        assert steps[2].args == {"value": 50}
        assert all(s.skipped_reason is None for s in steps)

    def test_basic_mode_temp_orders_power_temp_brightness(self):
        scene = RoomScene(
            created_at="t",
            devices=[_device(mode="basic", color_temp_k=4000, brightness=50)],
        )
        steps = room_scenes.plan_restore(scene)
        kinds = [s.kind for s in steps]
        assert kinds == ["power", "temp", "brightness"]
        assert steps[1].args == {"kelvin": 4000}

    def test_basic_mode_never_emits_both_color_and_temp(self):
        # Captured mutually exclusively (same as the device itself), but guard
        # the dispatch table too: if both happened to be set, color wins and
        # temp must never also appear.
        scene = RoomScene(
            created_at="t",
            devices=[_device(mode="basic", color=[1, 2, 3], color_temp_k=4000)],
        )
        steps = room_scenes.plan_restore(scene)
        kinds = [s.kind for s in steps]
        assert "color" in kinds
        assert "temp" not in kinds

    @pytest.mark.parametrize("mode", ["scene", "diy", "music", "snapshot"])
    def test_label_modes_order_power_label_brightness(self, mode):
        scene = RoomScene(
            created_at="t",
            devices=[
                _device(mode=mode, label="sleep", payload={"x": 1}, brightness=20)
            ],
        )
        steps = room_scenes.plan_restore(scene)
        kinds = [s.kind for s in steps]
        assert kinds == ["power", mode, "brightness"]
        assert steps[1].args == {"label": "sleep", "payload": {"x": 1}}
        assert steps[2].args == {"value": 20}

    def test_segments_mode_orders_power_segments_brightness(self):
        payload = {"segments": [0, 1], "rgb": [1, 2, 3], "brightness": None}
        scene = RoomScene(
            created_at="t",
            devices=[_device(mode="segments", payload=payload, brightness=40)],
        )
        steps = room_scenes.plan_restore(scene)
        kinds = [s.kind for s in steps]
        assert kinds == ["power", "segments", "brightness"]
        assert steps[1].args == {"payload": payload}
        assert steps[2].args == {"value": 40}


class TestPlanRestoreSkips:
    """effect/unknown are the honesty-critical rows: no device call, ever."""

    def test_effect_mode_is_skipped_with_exact_reason(self):
        scene = RoomScene(created_at="t", devices=[_device(mode="effect", label="rain")])
        steps = room_scenes.plan_restore(scene)
        assert len(steps) == 1
        assert steps[0].skipped_reason == "effects are live playback, not a device state"
        assert steps[0].args == {}

    def test_unknown_mode_is_skipped_with_exact_reason(self):
        scene = RoomScene(created_at="t", devices=[_device(mode="unknown")])
        steps = room_scenes.plan_restore(scene)
        assert len(steps) == 1
        assert steps[0].skipped_reason == "mode was unknown when this room scene was captured"
        assert steps[0].args == {}

    def test_four_devices_two_unknown_plans_two_restores_two_skips(self):
        devices = [
            _device(device_id="d1", mode="basic", color=[1, 1, 1]),
            _device(device_id="d2", mode="unknown"),
            _device(device_id="d3", mode="diy", label="storm"),
            _device(device_id="d4", mode="effect", label="chase"),
        ]
        scene = RoomScene(created_at="t", devices=devices)
        steps = room_scenes.plan_restore(scene)

        by_device: dict[str, list] = {}
        for step in steps:
            by_device.setdefault(step.device_id, []).append(step)

        assert all(s.skipped_reason is None for s in by_device["d1"])
        assert all(s.skipped_reason is None for s in by_device["d3"])
        assert len(by_device["d2"]) == 1 and by_device["d2"][0].skipped_reason is not None
        assert len(by_device["d4"]) == 1 and by_device["d4"][0].skipped_reason is not None

    def test_plan_restore_is_pure(self, scene_paths):
        # No disk access: even with no file/dir present at all, planning must
        # work purely off the in-memory RoomScene value.
        scene = RoomScene(created_at="t", devices=[_device(mode="off")])
        steps = room_scenes.plan_restore(scene)
        assert steps  # produced output with zero I/O and no file on disk
