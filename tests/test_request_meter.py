"""Tests for govee_cli.request_meter — the measured-traffic instrument.

Covers: counts landing in the right day/minute bucket, v1/v2 staying separate,
rate_limited/error incrementing independently of the api counter, the buffered
flush (holds below FLUSH_MAX/FLUSH_INTERVAL, then writes), the merge-by-addition
property across concurrent processes (the test that would catch a last-writer-wins
regression), 30-day/180-minute retention, missing/empty/corrupt files all reading
back as a zeroed snapshot, an OSError on the meter directory being swallowed,
snapshot() zero-filling gaps in the minute sparkline, and the atexit flush
delivering a sub-FLUSH_INTERVAL remainder.
"""

from __future__ import annotations

import json
import multiprocessing
from datetime import datetime, timedelta

import pytest

from govee_cli import request_meter


@pytest.fixture
def meter_paths(tmp_path, monkeypatch):
    """Point the meter at a temp location, mirroring test_ledger.py's pattern.
    reset() before and after also clears the module-level buffer, since that
    state (unlike LEDGER_PATH) persists across tests within one process."""
    path = tmp_path / "request-meter.json"
    lock_path = tmp_path / "request-meter.json.lock"
    monkeypatch.setattr(request_meter, "METER_PATH", path)
    monkeypatch.setattr(request_meter, "METER_LOCK_PATH", lock_path)
    request_meter.reset()
    yield path, lock_path
    request_meter.reset()


def _today() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


class TestBucketing:
    def test_counts_land_in_current_day_and_minute_bucket(self, meter_paths):
        request_meter.record("v2", status=200)
        snap = request_meter.snapshot()
        assert snap.day == _today()
        assert snap.v2_today == 1
        assert snap.v2_last_minute == 1
        assert snap.v2_last_hour == 1

    def test_v1_and_v2_counted_separately_never_summed(self, meter_paths):
        request_meter.record("v2", status=200)
        request_meter.record("v2", status=200)
        request_meter.record("v1", status=200)
        snap = request_meter.snapshot()
        assert snap.v2_today == 2
        assert snap.v1_today == 1

    def test_rate_limited_and_error_increment_independently_of_api_counter(
        self, meter_paths
    ):
        request_meter.record("v2", status=429, rate_limited=True)
        request_meter.record("v2", status=500, error=True)
        request_meter.record("v2", status=200)
        snap = request_meter.snapshot()
        assert snap.v2_today == 3  # every attempt still counts as a v2 request
        assert snap.rate_limited_today == 1
        assert snap.errors_today == 1

    def test_retry_attempts_each_count_separately(self, meter_paths):
        """§10.2: every retry is a real outbound request. Three record() calls
        for what was 'one logical call' at the http_v2 layer must still land as
        three on the meter — this module has no notion of a 'logical call' at
        all, only attempts, which is what makes that true by construction."""
        for _ in range(3):
            request_meter.record("v2", status=200)
        assert request_meter.snapshot().v2_today == 3


class TestBufferedFlush:
    def test_buffer_holds_below_flush_max_then_flushes_at_threshold(self, meter_paths):
        path, _ = meter_paths

        # First record() in this (fixture-reset) process flushes immediately —
        # _last_flush starts at 0.0 specifically so a short-lived process
        # doesn't lose its only request.
        request_meter.record("v2", status=200)
        with open(path) as f:
            assert json.load(f)["days"][_today()]["v2"] == 1

        # FLUSH_MAX - 1 more calls stay buffered: FLUSH_INTERVAL (2s) can't
        # plausibly have elapsed and the count hasn't reached FLUSH_MAX yet.
        for _ in range(request_meter.FLUSH_MAX - 1):
            request_meter.record("v2", status=200)
        with open(path) as f:
            assert json.load(f)["days"][_today()]["v2"] == 1  # unchanged

        # The call that pushes the buffer to FLUSH_MAX forces a flush.
        request_meter.record("v2", status=200)
        with open(path) as f:
            assert json.load(f)["days"][_today()]["v2"] == 1 + request_meter.FLUSH_MAX

    def test_snapshot_flushes_the_buffer_before_reading(self, meter_paths):
        path, _ = meter_paths
        request_meter.record("v2", status=200)  # flushed immediately (first call)
        for _ in range(5):
            request_meter.record("v2", status=200)  # buffered, not yet on disk
        with open(path) as f:
            assert json.load(f)["days"][_today()]["v2"] == 1

        snap = request_meter.snapshot()  # must flush before reading
        assert snap.v2_today == 6


def _mp_record(meter_path_str: str, lock_path_str: str, count: int) -> None:
    """Top-level so it's picklable for multiprocessing spawn/fork."""
    import pathlib

    from govee_cli import request_meter as rm

    rm.METER_PATH = pathlib.Path(meter_path_str)
    rm.METER_LOCK_PATH = pathlib.Path(lock_path_str)
    for _ in range(count):
        rm.record("v2", status=200)
    # Deliberately no explicit flush here — the atexit hook registered at
    # import time is what's under test for the trailing sub-threshold batch.


class TestMultiprocessConcurrency:
    def test_two_processes_each_recording_n_sum_to_2n_on_disk(self, meter_paths):
        """The merge-by-addition property: this is the test that would catch a
        last-writer-wins regression, since two processes racing to overwrite
        (rather than add to) the same day bucket would leave N, not 2N."""
        path, lock_path = meter_paths
        n = 37  # not a multiple of FLUSH_MAX — exercises both the count-triggered
        # flush mid-run and the atexit flush of the sub-threshold remainder.

        ctx = multiprocessing.get_context("spawn")
        procs = [
            ctx.Process(target=_mp_record, args=(str(path), str(lock_path), n))
            for _ in range(2)
        ]
        for p in procs:
            p.start()
        for p in procs:
            p.join(timeout=30)
            assert p.exitcode == 0

        with open(path) as f:
            data = json.load(f)
        assert data["days"][_today()]["v2"] == 2 * n

    def test_atexit_flush_delivers_subthreshold_remainder(self, meter_paths):
        path, lock_path = meter_paths
        ctx = multiprocessing.get_context("spawn")
        p = ctx.Process(target=_mp_record, args=(str(path), str(lock_path), 3))
        p.start()
        p.join(timeout=30)
        assert p.exitcode == 0

        with open(path) as f:
            data = json.load(f)
        # 1 lands via the first-call immediate flush; the other 2 are buffered
        # and would be lost without the atexit hook flushing them on exit.
        assert data["days"][_today()]["v2"] == 3


class TestRetention:
    def test_days_retention_prunes_to_30(self, meter_paths):
        path, _ = meter_paths
        seeded = {
            "version": 1,
            "days": {
                f"2026-01-{i:02d}": {"v2": 1, "v1": 0, "rate_limited": 0, "errors": 0}
                for i in range(1, 32)
            },
            "minutes": {},
        }
        path.write_text(json.dumps(seeded))

        request_meter.record("v2", status=200)  # triggers a flush + prune

        with open(path) as f:
            data = json.load(f)
        assert len(data["days"]) == 30
        assert _today() in data["days"]  # the newest entry always survives
        assert "2026-01-01" not in data["days"]  # oldest entries are what's dropped

    def test_minutes_retention_prunes_to_180(self, meter_paths):
        path, _ = meter_paths
        base = datetime(2026, 1, 1, 0, 0)
        seeded_minutes = {
            (base + timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M"): {"v2": 1, "v1": 0}
            for i in range(200)
        }
        path.write_text(json.dumps({"version": 1, "days": {}, "minutes": seeded_minutes}))

        request_meter.record("v2", status=200)

        with open(path) as f:
            data = json.load(f)
        assert len(data["minutes"]) == 180


class TestMissingEmptyCorruptFile:
    def test_missing_file_yields_zeroed_snapshot(self, meter_paths):
        snap = request_meter.snapshot()
        assert snap.v2_today == 0
        assert snap.v1_today == 0
        assert snap.rate_limited_today == 0
        assert snap.errors_today == 0
        assert snap.v2_last_minute == 0
        assert snap.v2_last_hour == 0
        assert all(count == 0 for _, count in snap.minutes)

    def test_empty_file_yields_zeroed_snapshot(self, meter_paths):
        path, _ = meter_paths
        path.write_text("")
        assert request_meter.snapshot().v2_today == 0

    def test_corrupt_json_yields_zeroed_snapshot(self, meter_paths):
        path, _ = meter_paths
        path.write_text("{not valid json at all")
        assert request_meter.snapshot().v2_today == 0


class TestOSErrorSwallowed:
    def test_oserror_on_meter_directory_is_swallowed(self, tmp_path, monkeypatch):
        """A plain *file* sitting where the meter's parent directory should be
        makes mkdir(parents=True) raise FileExistsError — a real OSError — on
        every write attempt, without needing root or chmod tricks that may not
        bind in a sandboxed test runner."""
        blocked = tmp_path / "not-a-directory"
        blocked.write_text("i am a file, not a directory")
        meter_path = blocked / "request-meter.json"
        monkeypatch.setattr(request_meter, "METER_PATH", meter_path)
        monkeypatch.setattr(
            request_meter, "METER_LOCK_PATH", meter_path.with_suffix(".json.lock")
        )
        request_meter.reset()  # must not raise even though unlink() can't reach it

        request_meter.record("v2", status=200)  # must not raise
        snap = request_meter.snapshot()  # must not raise
        assert snap.v2_today == 0  # the write silently failed, so nothing persisted


class TestZeroFilledSparkline:
    def test_snapshot_zero_fills_gaps_in_minutes(self, meter_paths):
        request_meter.record("v2", status=200)
        snap = request_meter.snapshot()

        assert len(snap.minutes) == 60
        nonzero = [count for _, count in snap.minutes if count != 0]
        assert nonzero == [1]  # only the current minute recorded anything
        assert snap.minutes[0][0] < snap.minutes[-1][0]  # oldest first
