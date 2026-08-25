"""Tests for the meter instrumentation at the two transport chokepoints (T18).

Per WEBUI_V3_SPEC.md §10.3: `GoveeHTTPv2._request` is the single funnel every v2
call routes through, and `GoveeHTTP`'s per-method `requests.get`/`requests.put`
calls are v1's equivalent. Both must record once per outbound attempt, and a
meter that raises internally must never turn a successful API call into an error.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import requests

from govee_cli import request_meter
from govee_cli.http import GoveeHTTP
from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

SKU = "H6022"
DEVICE = "50:CE:E8:6E:80:C6:50:3F"


@pytest.fixture
def meter_paths(tmp_path, monkeypatch):
    """Same pattern as test_request_meter.py's fixture — point the meter at a
    temp location and reset the module-level buffer before and after."""
    path = tmp_path / "request-meter.json"
    lock_path = tmp_path / "request-meter.json.lock"
    monkeypatch.setattr(request_meter, "METER_PATH", path)
    monkeypatch.setattr(request_meter, "METER_LOCK_PATH", lock_path)
    request_meter.reset()
    yield path, lock_path
    request_meter.reset()


def _ok(payload: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"code": 200, "msg": "success", **(payload or {})}
    return resp


class FakeResponse:
    """Mirrors test_http.py's fake — v1's client only calls .status_code,
    .raise_for_status() and .json() on what requests.get/put return."""

    def __init__(self, status_code: int = 200, payload: dict[str, Any] | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self) -> None:
        # requests raises HTTPError here, so the fake must too: a bare
        # Exception would let a test pass while the real client propagated
        # something the caller never catches.
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class TestV2Wiring:
    def test_single_200_records_one_v2_request(self, meter_paths) -> None:
        client = GoveeHTTPv2(api_key="test-key")
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()):
            client.turn_on(SKU, DEVICE)
        snap = request_meter.snapshot()
        assert snap.v2_today == 1
        assert snap.v1_today == 0
        assert snap.rate_limited_today == 0

    def test_429_then_200_records_two_attempts_and_one_rate_limit(
        self, meter_paths
    ) -> None:
        limited = MagicMock()
        limited.status_code = 429
        limited.text = "rate limited"
        client = GoveeHTTPv2(api_key="test-key")
        with patch(
            "govee_cli.http_v2.requests.request", side_effect=[limited, _ok()]
        ):
            with patch("govee_cli.http_v2.time.sleep"):
                client.turn_on(SKU, DEVICE)
        snap = request_meter.snapshot()
        assert snap.v2_today == 2  # every attempt counts, per §10.2
        assert snap.rate_limited_today == 1
        assert snap.errors_today == 0

    def test_5xx_counts_as_error_not_rate_limited(self, meter_paths) -> None:
        broken = MagicMock()
        broken.status_code = 503
        broken.text = "unavailable"
        client = GoveeHTTPv2(api_key="test-key")
        with patch(
            "govee_cli.http_v2.requests.request", side_effect=[broken, _ok()]
        ):
            with patch("govee_cli.http_v2.time.sleep"):
                client.turn_on(SKU, DEVICE)
        snap = request_meter.snapshot()
        assert snap.v2_today == 2
        assert snap.errors_today == 1
        assert snap.rate_limited_today == 0

    def test_network_exception_records_error_and_reraises_as_usual(
        self, meter_paths
    ) -> None:
        import requests as requests_module

        client = GoveeHTTPv2(api_key="test-key", max_retries=1)
        with patch(
            "govee_cli.http_v2.requests.request",
            side_effect=requests_module.ConnectionError("dns failed"),
        ):
            with patch("govee_cli.http_v2.time.sleep"):
                # The concrete type matters: a blind `Exception` here would
                # also pass if the meter wiring itself raised, which is the
                # one thing these tests are meant to rule out.
                with pytest.raises(GoveeV2Error):
                    client.turn_on(SKU, DEVICE)
        snap = request_meter.snapshot()
        assert snap.v2_today == 1
        assert snap.errors_today == 1

    def test_meter_failure_does_not_break_the_api_call(self, meter_paths) -> None:
        client = GoveeHTTPv2(api_key="test-key")
        with patch("govee_cli.http_v2.requests.request", return_value=_ok()):
            with patch(
                "govee_cli.http_v2.request_meter.record",
                side_effect=RuntimeError("meter exploded"),
            ):
                # Must not raise — record()'s never-raise contract, plus the
                # call site sitting outside http_v2's own error classification.
                client.turn_on(SKU, DEVICE)


class TestV1Wiring:
    def test_v1_call_lands_only_in_v1_bucket(self, meter_paths, monkeypatch) -> None:
        monkeypatch.setattr(
            "govee_cli.http.requests.put",
            lambda *a, **kw: FakeResponse(payload={"code": 200}),
        )
        client = GoveeHTTP(api_key="test-key")
        client.turn_on("AA:BB:CC:DD:EE:FF:00:11", "H6008")
        snap = request_meter.snapshot()
        assert snap.v1_today == 1
        assert snap.v2_today == 0

    def test_v1_429_marks_rate_limited(self, meter_paths, monkeypatch) -> None:
        monkeypatch.setattr(
            "govee_cli.http.requests.get",
            lambda *a, **kw: FakeResponse(status_code=429),
        )
        client = GoveeHTTP(api_key="test-key")
        with pytest.raises(requests.HTTPError):
            client.get_devices()
        snap = request_meter.snapshot()
        assert snap.v1_today == 1
        assert snap.rate_limited_today == 1

    def test_v1_meter_failure_does_not_break_the_api_call(
        self, meter_paths, monkeypatch
    ) -> None:
        monkeypatch.setattr(
            "govee_cli.http.requests.put",
            lambda *a, **kw: FakeResponse(payload={"code": 200}),
        )
        monkeypatch.setattr(
            "govee_cli.http.request_meter.record",
            lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("meter exploded")),
        )
        client = GoveeHTTP(api_key="test-key")
        # Must not raise.
        client.turn_on("AA:BB:CC:DD:EE:FF:00:11", "H6008")
