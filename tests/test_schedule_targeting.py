"""Tests for per-rule device targeting in schedules.

Before this existed, every rule ran over BLE against the single configured
`default_mac`, which made cloud-only models (the H6022 has no BLE path at all)
impossible to schedule.
"""

import json
from unittest.mock import patch

from govee_cli.schedule import scheduler
from govee_cli.schedule.scheduler import ScheduleRule


class TestScheduleRuleDevice:
    def test_device_defaults_to_none(self) -> None:
        rule = ScheduleRule(id="a", name="n", time="07:00", days=["Mon"],
                            command="power on")
        assert rule.device is None

    def test_device_round_trips_through_disk(self, tmp_path) -> None:
        path = tmp_path / "schedule.json"
        with patch.object(scheduler, "SCHEDULE_FILE", path), \
             patch.object(scheduler, "SCHEDULE_DIR", tmp_path):
            scheduler.add_rule(ScheduleRule(
                id="a", name="n", time="07:00", days=["Mon"],
                command="brightness 40", device="Shelf Lamp",
            ))
            loaded = scheduler.list_rules()
        assert len(loaded) == 1
        assert loaded[0].device == "Shelf Lamp"

    def test_rules_without_a_device_field_still_load(self, tmp_path) -> None:
        # Schedule files written before per-rule targeting must keep working.
        path = tmp_path / "schedule.json"
        path.write_text(json.dumps([{
            "id": "old", "name": "Morning", "time": "07:00",
            "days": ["Mon"], "command": "power on", "enabled": True,
        }]))
        with patch.object(scheduler, "SCHEDULE_FILE", path), \
             patch.object(scheduler, "SCHEDULE_DIR", tmp_path):
            loaded = scheduler.list_rules()
        assert len(loaded) == 1
        assert loaded[0].device is None
        assert loaded[0].command == "power on"

    def test_unknown_fields_are_ignored(self, tmp_path) -> None:
        # A file written by a newer version must not crash an older one.
        path = tmp_path / "schedule.json"
        path.write_text(json.dumps([{
            "id": "new", "name": "Future", "time": "07:00", "days": ["Mon"],
            "command": "power on", "enabled": True, "device": None,
            "some_future_field": {"nested": True},
        }]))
        with patch.object(scheduler, "SCHEDULE_FILE", path), \
             patch.object(scheduler, "SCHEDULE_DIR", tmp_path):
            loaded = scheduler.list_rules()
        assert len(loaded) == 1
        assert loaded[0].name == "Future"
