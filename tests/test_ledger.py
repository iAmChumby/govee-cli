"""Tests for govee_cli.ledger — the active-mode ledger.

Covers: write-then-read round trip, concurrent writers (threads and processes) never
corrupting the file, missing/empty/corrupt-JSON files all reading back as {}, and the
never-raise contract on record_mode/clear_mode.
"""

from __future__ import annotations

import json
import multiprocessing
from concurrent.futures import ThreadPoolExecutor

import pytest

from govee_cli import ledger


@pytest.fixture
def ledger_paths(tmp_path, monkeypatch):
    """Point the ledger at a temp location, mirroring test_config.py's pattern."""
    path = tmp_path / "active-mode.json"
    lock_path = tmp_path / "active-mode.json.lock"
    monkeypatch.setattr(ledger, "LEDGER_PATH", path)
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", lock_path)
    return path, lock_path


class TestRoundTrip:
    def test_read_all_empty_when_no_file(self, ledger_paths):
        assert ledger.read_all() == {}

    def test_write_then_read_one(self, ledger_paths):
        ledger.record_mode(
            "50:CE:E8:6E:80:C6:50:3F",
            mode="diy",
            label="sleep",
            payload={"diy_value": 4},
            source="cli",
        )
        entry = ledger.read_one("50:CE:E8:6E:80:C6:50:3F")
        assert entry is not None
        assert entry.mode == "diy"
        assert entry.label == "sleep"
        assert entry.payload == {"diy_value": 4}
        assert entry.source == "cli"
        assert entry.set_at  # non-empty ISO timestamp

    def test_read_one_missing_device_returns_none(self, ledger_paths):
        assert ledger.read_one("AA:BB:CC:DD:EE:FF") is None

    def test_write_then_read_all(self, ledger_paths):
        ledger.record_mode("dev-1", mode="off", label=None, payload=None, source="cli")
        ledger.record_mode(
            "dev-2", mode="scene", label="sunset", payload={"scene_id": 1}, source="webui"
        )
        all_entries = ledger.read_all()
        assert set(all_entries) == {"dev-1", "dev-2"}
        assert all_entries["dev-1"].mode == "off"
        assert all_entries["dev-2"].label == "sunset"

    def test_second_write_overwrites_first(self, ledger_paths):
        ledger.record_mode("dev-1", mode="diy", label="sleep", payload=None, source="cli")
        ledger.record_mode("dev-1", mode="basic", label=None, payload=None, source="cli")
        entry = ledger.read_one("dev-1")
        assert entry is not None
        assert entry.mode == "basic"
        assert entry.label is None

    def test_file_on_disk_matches_documented_shape(self, ledger_paths):
        path, _ = ledger_paths
        ledger.record_mode("dev-1", mode="off", label=None, payload=None, source="schedule")
        with open(path) as f:
            raw = json.load(f)
        assert raw["version"] == 1
        assert raw["devices"]["dev-1"]["mode"] == "off"
        assert raw["devices"]["dev-1"]["source"] == "schedule"

    def test_lock_file_never_contains_ledger_data(self, ledger_paths):
        path, lock_path = ledger_paths
        ledger.record_mode("dev-1", mode="basic", label=None, payload=None, source="cli")
        assert lock_path.exists()
        # The lock file is just an flock target — it must never hold ledger JSON.
        with open(lock_path) as f:
            contents = f.read()
        assert contents == ""


class TestClearMode:
    def test_clear_mode_removes_key(self, ledger_paths):
        ledger.record_mode("dev-1", mode="diy", label="sleep", payload=None, source="cli")
        ledger.clear_mode("dev-1")
        assert ledger.read_one("dev-1") is None
        assert "dev-1" not in ledger.read_all()

    def test_clear_mode_missing_key_is_a_noop(self, ledger_paths):
        # Must not raise even though the device was never recorded.
        ledger.clear_mode("never-seen")
        assert ledger.read_all() == {}

    def test_clear_mode_leaves_other_devices_alone(self, ledger_paths):
        ledger.record_mode("dev-1", mode="off", label=None, payload=None, source="cli")
        ledger.record_mode("dev-2", mode="off", label=None, payload=None, source="cli")
        ledger.clear_mode("dev-1")
        assert ledger.read_one("dev-1") is None
        assert ledger.read_one("dev-2") is not None


class TestCorruptOrMissingFile:
    def test_missing_file_returns_empty(self, ledger_paths):
        assert ledger.read_all() == {}

    def test_empty_file_returns_empty(self, ledger_paths):
        path, _ = ledger_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")
        assert ledger.read_all() == {}

    def test_corrupt_json_returns_empty(self, ledger_paths):
        path, _ = ledger_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not valid json")
        assert ledger.read_all() == {}

    def test_valid_json_wrong_shape_returns_empty(self, ledger_paths):
        path, _ = ledger_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([1, 2, 3]))
        assert ledger.read_all() == {}

    def test_record_mode_recovers_after_corrupt_file(self, ledger_paths):
        """A corrupt file must not wedge future writes — record_mode treats it as
        an empty document and proceeds normally."""
        path, _ = ledger_paths
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not valid json")
        ledger.record_mode("dev-1", mode="basic", label=None, payload=None, source="cli")
        entry = ledger.read_one("dev-1")
        assert entry is not None
        assert entry.mode == "basic"


class TestNeverRaise:
    def test_record_mode_swallows_oserror_from_unwritable_parent(
        self, tmp_path, monkeypatch
    ):
        """Point LEDGER_PATH.parent at a location that cannot possibly be created —
        a regular file standing in the way of a directory — and confirm record_mode
        logs and returns instead of raising. This is the never-raise contract: a
        ledger failure must never look like the device command itself failed."""
        blocker = tmp_path / "blocker"
        blocker.write_text("i am a file, not a directory")
        bogus_path = blocker / "nested" / "active-mode.json"
        monkeypatch.setattr(ledger, "LEDGER_PATH", bogus_path)
        monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", bogus_path.with_suffix(".json.lock"))

        # Must not raise.
        ledger.record_mode("dev-1", mode="basic", label=None, payload=None, source="cli")

        # And the ledger is still legitimately empty from the caller's point of view.
        assert ledger.read_one("dev-1") is None

    def test_clear_mode_swallows_oserror_from_unwritable_parent(self, tmp_path, monkeypatch):
        blocker = tmp_path / "blocker"
        blocker.write_text("i am a file, not a directory")
        bogus_path = blocker / "nested" / "active-mode.json"
        monkeypatch.setattr(ledger, "LEDGER_PATH", bogus_path)
        monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", bogus_path.with_suffix(".json.lock"))

        # Must not raise even though there's nothing to clear and nowhere to write.
        ledger.clear_mode("dev-1")

    def test_record_mode_swallows_error_raised_mid_write(self, ledger_paths, monkeypatch):
        """Simulate a failure partway through the write (e.g. disk full during
        json.dump) and confirm it's caught rather than propagated."""

        def _boom(*args, **kwargs):
            raise OSError("simulated disk full")

        monkeypatch.setattr(json, "dump", _boom)
        ledger.record_mode("dev-1", mode="basic", label=None, payload=None, source="cli")
        # No exception reached the caller — that's the entire assertion.


class TestConcurrency:
    def test_concurrent_writers_distinct_devices_all_present(self, ledger_paths):
        """N threads each record a distinct device id; the final file must be valid
        JSON containing every one of them — flock serializes the writes so none are
        lost to a lost-update race."""
        device_ids = [f"dev-{i}" for i in range(20)]

        def _write(device_id: str) -> None:
            ledger.record_mode(
                device_id, mode="basic", label=None, payload={"n": device_id}, source="cli"
            )

        with ThreadPoolExecutor(max_workers=20) as pool:
            list(pool.map(_write, device_ids))

        all_entries = ledger.read_all()
        assert set(all_entries) == set(device_ids)

        path, _ = ledger_paths
        with open(path) as f:
            raw = json.load(f)  # must parse cleanly — no torn/truncated write
        assert len(raw["devices"]) == 20

    def test_concurrent_writers_same_device_last_writer_wins_cleanly(self, ledger_paths):
        """N threads race to record the same device id. flock serializes them, so the
        file always ends up valid JSON holding exactly one (some writer's) value —
        never truncated, never merged garbage."""

        def _write(i: int) -> None:
            ledger.record_mode(
                "shared-dev", mode="basic", label=None, payload={"i": i}, source="cli"
            )

        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(_write, range(16)))

        path, _ = ledger_paths
        with open(path) as f:
            raw = json.load(f)  # must be valid, complete JSON
        assert list(raw["devices"].keys()) == ["shared-dev"]
        winner = raw["devices"]["shared-dev"]["payload"]["i"]
        assert winner in range(16)


def _mp_record(ledger_path_str: str, lock_path_str: str, device_id: str) -> None:
    """Top-level so it's picklable for multiprocessing spawn/fork."""
    import pathlib

    from govee_cli import ledger as ledger_mod

    ledger_mod.LEDGER_PATH = pathlib.Path(ledger_path_str)
    ledger_mod.LEDGER_LOCK_PATH = pathlib.Path(lock_path_str)
    ledger_mod.record_mode(
        device_id, mode="basic", label=None, payload=None, source="cli"
    )


class TestMultiprocessConcurrency:
    def test_concurrent_processes_do_not_corrupt_file(self, ledger_paths):
        """flock also serializes across real OS processes, not just threads within
        one process — spawn N separate processes each writing a distinct device id
        and confirm the resulting file is valid JSON with every key present."""
        path, lock_path = ledger_paths
        device_ids = [f"proc-dev-{i}" for i in range(8)]

        ctx = multiprocessing.get_context("spawn")
        procs = [
            ctx.Process(target=_mp_record, args=(str(path), str(lock_path), device_id))
            for device_id in device_ids
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=30)
            assert p.exitcode == 0

        with open(path) as f:
            raw = json.load(f)  # never truncated
        assert set(raw["devices"].keys()) == set(device_ids)
