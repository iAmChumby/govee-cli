"""Govee HTTP API client for H6008 and other WiFi devices."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import requests

from govee_cli import request_meter

_CONFIG_PATH = os.path.expanduser("~/.config/govee-cli/config.json")

GOVEE_API_BASE = "https://developer-api.govee.com/v1"


@dataclass
class HTTPDevice:
    """A device accessible via the Govee HTTP API."""

    device_id: str  # MAC address used by the API (colon-separated)
    model: str
    name: str | None = None
    supported_commands: tuple[str, ...] = ("turn", "brightness", "color", "colorTemperature")


class GoveeHTTP:
    """Client for the Govee HTTP API."""

    def __init__(self, api_key: str | None = None):
        if not api_key:
            from govee_cli.config import load_config
            cfg = load_config()
            api_key = cfg.api_key or os.environ.get("GOVEE_API_KEY")
            if not api_key:
                raise ValueError("No Govee API key. Run `govee-cli scan-http` to configure.")
        self.api_key = api_key
        self.headers = {
            "Govee-API-Key": api_key,
            "Content-Type": "application/json",
        }

    @staticmethod
    def _meter(*, status: int | None, rate_limited: bool = False, error: bool = False) -> None:
        """Record one v1 request attempt, defensively. v1 has no retry loop —
        every call site here is exactly one attempt, unlike v2's — so this fires
        once per method call, right after the response arrives (or the network
        failure is caught) and before raise_for_status() can turn a 4xx/5xx into
        an exception. Wrapped in its own try/except so a meter bug — even one
        that breaks request_meter.record's own never-raise contract — can never
        turn a successful cloud call into a client-visible error."""
        try:
            request_meter.record("v1", status=status, rate_limited=rate_limited, error=error)
        except Exception:
            pass

    def get_devices(self) -> list[HTTPDevice]:
        """Fetch all devices from the Govee API."""
        try:
            resp = requests.get(f"{GOVEE_API_BASE}/devices", headers=self.headers, timeout=10)
        except requests.RequestException:
            self._meter(status=None, error=True)
            raise
        self._meter(
            status=resp.status_code,
            rate_limited=resp.status_code == 429,
            error=resp.status_code >= 500,
        )
        resp.raise_for_status()
        data = resp.json()
        devices = []
        for d in data["data"]["devices"]:
            device = HTTPDevice(
                device_id=d["device"],
                model=d["model"],
                name=d.get("deviceName"),
                supported_commands=tuple(d.get("supportCmds", [])),
            )
            devices.append(device)
        return devices

    def control(self, device_id: str, model: str, command: str, value: int | str | dict) -> None:
        """Send a control command to a device.

        Args:
            device_id: The device MAC (colon-separated)
            model: Device model (e.g., "H6008")
            command: Command name (turn, brightness, color, colorTemperature)
            value: Command value (int for brightness, "on"/"off" for turn, dict for color)
        """
        payload: dict[str, Any] = {
            "device": device_id,
            "model": model,
            "cmd": {"name": command, "value": value},
        }
        try:
            resp = requests.put(
                f"{GOVEE_API_BASE}/devices/control",
                headers=self.headers,
                json=payload,
                timeout=10,
            )
        except requests.RequestException:
            self._meter(status=None, error=True)
            raise
        self._meter(
            status=resp.status_code,
            rate_limited=resp.status_code == 429,
            error=resp.status_code >= 500,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") != 200:
            raise GoveeHTTPError(f"Control failed: {result.get('message', result)}")

    def get_state(self, device_id: str, model: str) -> dict:
        """Get the current state of a device.

        Returns a dict with keys: powerState, brightness, colorTem, color (dict with r/g/b).
        """
        try:
            resp = requests.get(
                f"{GOVEE_API_BASE}/devices/state",
                headers=self.headers,
                params={"device": device_id, "model": model},
                timeout=10,
            )
        except requests.RequestException:
            self._meter(status=None, error=True)
            raise
        self._meter(
            status=resp.status_code,
            rate_limited=resp.status_code == 429,
            error=resp.status_code >= 500,
        )
        if resp.status_code == 404:
            raise GoveeHTTPError(f"Device {device_id} not found or offline")
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 200:
            raise GoveeHTTPError(f"State read failed: {data.get('message', data)}")
        # The v1 API returns properties as a list of single-key dicts
        # ([{"online": true}, {"powerState": "on"}, ...]) — flatten to one dict.
        flat: dict = {}
        for prop in data.get("data", {}).get("properties", []):
            flat.update(prop)
        return flat

    def turn_on(self, device_id: str, model: str) -> None:
        self.control(device_id, model, "turn", "on")

    def turn_off(self, device_id: str, model: str) -> None:
        self.control(device_id, model, "turn", "off")

    def set_brightness(self, device_id: str, model: str, value: int) -> None:
        self.control(device_id, model, "brightness", value)

    def set_color(self, device_id: str, model: str, r: int, g: int, b: int) -> None:
        self.control(device_id, model, "color", {"r": r, "g": g, "b": b})

    def set_color_temp(self, device_id: str, model: str, value: int) -> None:
        self.control(device_id, model, "colorTem", value)


class GoveeHTTPError(Exception):
    """Raised when an HTTP API call fails."""
    pass


def parse_hex_color(hex_color: str) -> tuple[int, int, int]:
    """Parse a hex color string to RGB tuple."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) == 6:
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
        return r, g, b
    raise ValueError(f"Invalid hex color: #{hex_color}")
