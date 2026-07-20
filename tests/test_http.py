"""Tests for the Govee HTTP API client."""

from __future__ import annotations

from typing import Any

import pytest

from govee_cli.http import GOVEE_API_BASE, GoveeHTTP


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: dict[str, Any] | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise Exception(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._payload


class TestGetState:
    def test_uses_query_param_endpoint(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The v1 state endpoint is /devices/state?device=X&model=Y — the
        device ID must NOT be embedded in the URL path (that 404s)."""
        calls: dict[str, Any] = {}

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            calls["url"] = url
            calls["params"] = kwargs.get("params")
            return FakeResponse(
                payload={
                    "code": 200,
                    "data": {
                        "device": "AA:BB:CC:DD:EE:FF:00:11",
                        "model": "H6008",
                        # real v1 shape: list of single-key dicts
                        "properties": [
                            {"online": True},
                            {"powerState": "off"},
                            {"brightness": 42},
                        ],
                    },
                }
            )

        monkeypatch.setattr("govee_cli.http.requests.get", fake_get)

        client = GoveeHTTP(api_key="test-key")
        state = client.get_state("AA:BB:CC:DD:EE:FF:00:11", "H6008")

        assert calls["url"] == f"{GOVEE_API_BASE}/devices/state"
        assert calls["params"] == {"device": "AA:BB:CC:DD:EE:FF:00:11", "model": "H6008"}
        assert state == {"online": True, "powerState": "off", "brightness": 42}

    def test_device_id_not_in_url_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen: dict[str, str] = {}

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            seen["url"] = url
            return FakeResponse(payload={"code": 200, "data": {}})

        monkeypatch.setattr("govee_cli.http.requests.get", fake_get)

        GoveeHTTP(api_key="test-key").get_state("AA:BB:CC:DD:EE:FF:00:11", "H6056")

        assert "AA:BB" not in seen["url"]
