"""Govee Open API v2 client (``openapi.api.govee.com``).

This is a distinct API from the legacy v1 ``developer-api.govee.com`` client in
:mod:`govee_cli.http`. The two are not interchangeable:

* v1 exposes a fixed four-command vocabulary (turn/brightness/color/colorTem) and
  only lists a subset of a user's devices. The H6022, for example, does not appear
  in the v1 device list at all.
* v2 is capability-based: each device advertises the capability instances it
  supports, and control calls name the capability explicitly. This is the only
  cloud path that reaches scenes, DIY scenes, per-segment color, and music mode.

Existing devices stay on v1 so their verified behaviour is untouched; models
declared ``cloud-v2`` in :mod:`govee_cli.transport` route through here.
"""

from __future__ import annotations

import json
import os
import pathlib
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import requests

from govee_cli import request_meter

GOVEE_V2_BASE = "https://openapi.api.govee.com/router/api/v1"

# Capability type strings used by the v2 API.
CAP_ON_OFF = "devices.capabilities.on_off"
CAP_RANGE = "devices.capabilities.range"
CAP_COLOR = "devices.capabilities.color_setting"
CAP_SEGMENT = "devices.capabilities.segment_color_setting"
CAP_DYNAMIC_SCENE = "devices.capabilities.dynamic_scene"
CAP_MUSIC = "devices.capabilities.music_setting"
CAP_TOGGLE = "devices.capabilities.toggle"

_SCENE_CACHE_PATH = pathlib.Path.home() / ".config" / "govee-cli" / "scene-cache.json"
_SCENE_CACHE_TTL = 7 * 24 * 3600  # scene libraries change only on firmware updates


class GoveeV2Error(Exception):
    """Raised when a v2 API call fails."""


class GoveeV2RateLimited(GoveeV2Error):
    """Raised when the v2 API returns 429 and retries are exhausted."""


@dataclass
class Capability:
    """A single capability instance advertised by a device."""

    type: str
    instance: str
    parameters: dict[str, Any] = field(default_factory=dict)


@dataclass
class V2Device:
    """A device as described by the v2 API."""

    sku: str
    device_id: str
    name: str | None
    type: str | None
    capabilities: list[Capability] = field(default_factory=list)

    def has(self, instance: str) -> bool:
        """Return True if the device advertises the named capability instance."""
        return any(c.instance == instance for c in self.capabilities)

    def capability(self, instance: str) -> Capability | None:
        """Return the named capability instance, or None."""
        for c in self.capabilities:
            if c.instance == instance:
                return c
        return None


@dataclass
class Scene:
    """A firmware ("light") scene. Selecting one needs both ids."""

    name: str
    param_id: int
    scene_id: int


@dataclass
class DIYScene:
    """A user-authored DIY scene from the Govee app. Selected by a single value."""

    name: str
    value: int


def _slug(name: str) -> str:
    """Normalise a scene name for lookup: 'Snow flake' -> 'snowflake'."""
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _meter(*, status: int | None, rate_limited: bool = False, error: bool = False) -> None:
    """Record one v2 request attempt, defensively. ``request_meter.record``
    already never raises on its own, but this chokepoint sits between the retry
    loop and a real device command — a future change to request_meter.py must
    not be able to turn a successful cloud call into a client-visible error just
    because it broke that contract."""
    try:
        request_meter.record("v2", status=status, rate_limited=rate_limited, error=error)
    except Exception:
        pass


class GoveeHTTPv2:
    """Client for the Govee Open API v2.

    The cloud rate-limits aggressively (bursts across devices hit 429 within
    seconds), so every request retries with exponential backoff and callers are
    expected to leave a gap between commands.
    """

    def __init__(self, api_key: str | None = None, *, timeout: float = 15.0,
                 max_retries: int = 4) -> None:
        if not api_key:
            from govee_cli.config import load_config
            from govee_cli.envfile import load_env_file

            load_env_file()
            cfg = load_config()
            api_key = cfg.api_key or os.environ.get("GOVEE_API_KEY")
            if not api_key:
                raise GoveeV2Error(
                    "No Govee API key. Run `govee-cli scan-http` to configure."
                )
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self.headers = {
            "Govee-API-Key": api_key,
            "Content-Type": "application/json",
        }

    # ---------------------------------------------------------------- transport

    def _request(self, method: str, path: str, payload: dict | None = None) -> dict:
        """Issue a request, retrying on 429 and 5xx with exponential backoff."""
        url = f"{GOVEE_V2_BASE}{path}"
        body: dict[str, Any] | None = None
        if payload is not None:
            body = {"requestId": str(uuid.uuid4()), "payload": payload}

        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                resp = requests.request(
                    method, url, headers=self.headers, json=body, timeout=self.timeout
                )
            except requests.RequestException as e:  # network-level failure
                last_error = e
                # Meter every attempt, per §10.2/§10.3 — a 4-attempt call is 4
                # requests against whatever quota the cloud enforces, retries
                # included. This lives in the except clause, not the try, so a
                # meter bug can never masquerade as a network error.
                _meter(status=None, error=True)
                time.sleep(2 ** attempt)
                continue

            if resp.status_code == 429 or resp.status_code >= 500:
                last_error = GoveeV2Error(
                    f"{resp.status_code} from Govee cloud: {resp.text[:200]}"
                )
                _meter(
                    status=resp.status_code,
                    rate_limited=resp.status_code == 429,
                    error=resp.status_code >= 500,
                )
                time.sleep(2 ** attempt * 2)
                continue

            _meter(status=resp.status_code)

            try:
                data = resp.json()
            except ValueError as e:
                raise GoveeV2Error(
                    f"Non-JSON response from Govee cloud ({resp.status_code}): "
                    f"{resp.text[:200]}"
                ) from e

            # The v2 API reports application errors in the body with HTTP 200 or 400.
            code = data.get("code")
            if code != 200:
                raise GoveeV2Error(
                    f"Govee API error {code}: {data.get('msg') or data.get('message') or data}"
                )
            return dict(data)

        if isinstance(last_error, GoveeV2Error) and "429" in str(last_error):
            raise GoveeV2RateLimited(
                "Govee cloud rate limit hit and retries exhausted. "
                "Leave ~2s between commands and try again."
            ) from last_error
        raise GoveeV2Error(f"Govee cloud unreachable after {self.max_retries} attempts: "
                           f"{last_error}") from last_error

    # ------------------------------------------------------------------ queries

    def get_devices(self) -> list[V2Device]:
        """Fetch every device visible to this API key, with full capabilities."""
        data = self._request("GET", "/user/devices")
        devices = []
        for d in data.get("data", []):
            devices.append(
                V2Device(
                    sku=d.get("sku", ""),
                    device_id=d.get("device", ""),
                    name=d.get("deviceName"),
                    type=d.get("type"),
                    capabilities=[
                        Capability(
                            type=c.get("type", ""),
                            instance=c.get("instance", ""),
                            parameters=c.get("parameters", {}) or {},
                        )
                        for c in d.get("capabilities", []) or []
                    ],
                )
            )
        return devices

    def get_device(self, sku: str, device_id: str) -> V2Device | None:
        """Fetch a single device's capability description, or None if absent."""
        for d in self.get_devices():
            if d.device_id.upper() == device_id.upper():
                return d
        return None

    def get_state(self, sku: str, device_id: str) -> dict[str, Any]:
        """Return current state as ``{capability_instance: value}``.

        Note: the v2 state endpoint reports power, brightness, colorRgb,
        colorTemperatureK and online reliably. Scene/segment/music instances are
        present in the response but their values come back as empty strings — the
        device does not report them. A caller must not treat an empty scene value
        as evidence that a scene command failed.
        """
        data = self._request("POST", "/device/state", {"sku": sku, "device": device_id})
        out: dict[str, Any] = {}
        for c in data.get("payload", {}).get("capabilities", []) or []:
            out[c.get("instance", "")] = c.get("state", {}).get("value")
        return out

    # ------------------------------------------------------------------ control

    def control(self, sku: str, device_id: str, cap_type: str, instance: str,
                value: Any) -> dict:
        """Send one capability command.

        A 200 response means the cloud accepted the command, NOT that the device
        obeyed it. Confirm state-visible changes with :meth:`get_state`.
        """
        return self._request(
            "POST",
            "/device/control",
            {
                "sku": sku,
                "device": device_id,
                "capability": {"type": cap_type, "instance": instance, "value": value},
            },
        )

    def turn_on(self, sku: str, device_id: str) -> None:
        self.control(sku, device_id, CAP_ON_OFF, "powerSwitch", 1)

    def turn_off(self, sku: str, device_id: str) -> None:
        self.control(sku, device_id, CAP_ON_OFF, "powerSwitch", 0)

    def set_brightness(self, sku: str, device_id: str, value: int) -> None:
        self.control(sku, device_id, CAP_RANGE, "brightness", value)

    def set_color(self, sku: str, device_id: str, r: int, g: int, b: int) -> None:
        self.control(sku, device_id, CAP_COLOR, "colorRgb", (r << 16) | (g << 8) | b)

    def set_color_temp(self, sku: str, device_id: str, kelvin: int) -> None:
        self.control(sku, device_id, CAP_COLOR, "colorTemperatureK", kelvin)

    def set_segment_color(self, sku: str, device_id: str, segments: list[int],
                          r: int, g: int, b: int) -> None:
        """Set one or more segments to a single RGB colour."""
        self.control(
            sku, device_id, CAP_SEGMENT, "segmentedColorRgb",
            {"segment": list(segments), "rgb": (r << 16) | (g << 8) | b},
        )

    def set_segment_brightness(self, sku: str, device_id: str, segments: list[int],
                               brightness: int) -> None:
        """Set per-segment brightness. Not every RGBIC model supports this."""
        self.control(
            sku, device_id, CAP_SEGMENT, "segmentedBrightness",
            {"segment": list(segments), "brightness": brightness},
        )

    def set_scene(self, sku: str, device_id: str, scene: Scene) -> None:
        """Activate a firmware scene. Requires both paramId and id."""
        self.control(
            sku, device_id, CAP_DYNAMIC_SCENE, "lightScene",
            {"paramId": scene.param_id, "id": scene.scene_id},
        )

    def set_diy_scene(self, sku: str, device_id: str, value: int) -> None:
        """Activate a DIY scene.

        The value is passed bare, not wrapped in ``{"value": ...}`` — the wrapped
        form is rejected with "Missing relevant parameters: id".
        """
        self.control(sku, device_id, CAP_DYNAMIC_SCENE, "diyScene", value)

    def set_snapshot(self, sku: str, device_id: str, value: int) -> None:
        """Activate a saved snapshot from the Govee app."""
        self.control(sku, device_id, CAP_DYNAMIC_SCENE, "snapshot", value)

    def set_music_mode(self, sku: str, device_id: str, mode: int, sensitivity: int,
                       auto_color: bool | None = None,
                       rgb: int | None = None) -> None:
        """Put the device into a firmware music-reactive mode.

        The device does its own audio pickup — this only selects the mode, so no
        audio is streamed from this machine.
        """
        value: dict[str, Any] = {"musicMode": mode, "sensitivity": sensitivity}
        if auto_color is not None:
            value["autoColor"] = 1 if auto_color else 0
        if rgb is not None:
            value["rgb"] = rgb
        self.control(sku, device_id, CAP_MUSIC, "musicMode", value)

    def set_toggle(self, sku: str, device_id: str, instance: str, on: bool) -> None:
        """Set a boolean toggle capability (gradientToggle, dreamViewToggle, ...)."""
        self.control(sku, device_id, CAP_TOGGLE, instance, 1 if on else 0)

    # ------------------------------------------------------------------- scenes

    def _fetch_scene_options(self, path: str, sku: str, device_id: str,
                             instance: str) -> list[dict]:
        data = self._request("POST", path, {"sku": sku, "device": device_id})
        for cap in data.get("payload", {}).get("capabilities", []) or []:
            if cap.get("instance") == instance:
                return cap.get("parameters", {}).get("options", []) or []
        return []

    def get_scenes(self, sku: str, device_id: str, *, use_cache: bool = True) -> list[Scene]:
        """Return the device's firmware scene library.

        Cached on disk, because the library runs to 60+ entries and only changes
        with firmware updates — refetching on every invocation burns rate limit.
        """
        cached = _read_scene_cache(device_id, "lightScene") if use_cache else None
        if cached is not None:
            return [Scene(name=s["name"], param_id=s["paramId"], scene_id=s["id"])
                    for s in cached]

        options = self._fetch_scene_options("/device/scenes", sku, device_id, "lightScene")
        scenes = []
        raw = []
        for o in options:
            val = o.get("value") or {}
            if not isinstance(val, dict):
                continue
            param_id, scene_id = val.get("paramId"), val.get("id")
            if param_id is None or scene_id is None:
                continue
            scenes.append(Scene(name=o.get("name", ""), param_id=param_id, scene_id=scene_id))
            raw.append({"name": o.get("name", ""), "paramId": param_id, "id": scene_id})
        _write_scene_cache(device_id, "lightScene", raw)
        return scenes

    def get_diy_scenes(self, sku: str, device_id: str) -> list[DIYScene]:
        """Return the user's DIY scenes.

        Never cached — the user can add or edit these in the Govee app at any time.
        """
        options = self._fetch_scene_options(
            "/device/diy-scenes", sku, device_id, "diyScene"
        )
        out = []
        for o in options:
            val = o.get("value")
            if isinstance(val, dict):
                val = val.get("id", val.get("value"))
            if not isinstance(val, int):
                continue
            out.append(DIYScene(name=o.get("name", ""), value=val))
        return out

    def find_scene(self, sku: str, device_id: str, name: str) -> Scene | None:
        """Look up a firmware scene by name, ignoring case, spaces and punctuation."""
        target = _slug(name)
        served_from_cache = _read_scene_cache(device_id, "lightScene") is not None

        for s in self.get_scenes(sku, device_id):
            if _slug(s.name) == target:
                return s

        # Only refetch if the first lookup came from cache — the cache may predate
        # a firmware update that added the scene. If it was already a live fetch,
        # a second one would cost API budget to get the identical answer.
        if not served_from_cache:
            return None

        for s in self.get_scenes(sku, device_id, use_cache=False):
            if _slug(s.name) == target:
                return s
        return None

    def find_diy_scene(self, sku: str, device_id: str, name: str) -> DIYScene | None:
        """Look up a DIY scene by name, ignoring case, spaces and punctuation."""
        target = _slug(name)
        for s in self.get_diy_scenes(sku, device_id):
            if _slug(s.name) == target:
                return s
        return None


# ------------------------------------------------------------------ scene cache


def _read_scene_cache(device_id: str, instance: str) -> list[dict] | None:
    """Return cached scene options, or None if missing/stale/corrupt."""
    try:
        with open(_SCENE_CACHE_PATH) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(cache, dict):
        # Symmetric with _write_scene_cache: a hand-edited or truncated file
        # must degrade to a refetch, never raise out of a light command.
        return None
    entry = cache.get(f"{device_id.upper()}:{instance}")
    if not isinstance(entry, dict):
        return None
    if not entry:
        return None
    if time.time() - entry.get("fetched_at", 0) > _SCENE_CACHE_TTL:
        return None
    scenes = entry.get("scenes")
    return scenes if isinstance(scenes, list) else None


def _write_scene_cache(device_id: str, instance: str, scenes: list[dict]) -> None:
    """Persist scene options. A cache write failure must never break a command."""
    try:
        _SCENE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(_SCENE_CACHE_PATH) as f:
                cache = json.load(f)
            if not isinstance(cache, dict):
                cache = {}
        except (OSError, ValueError):
            cache = {}
        cache[f"{device_id.upper()}:{instance}"] = {
            "fetched_at": time.time(),
            "scenes": scenes,
        }
        with open(_SCENE_CACHE_PATH, "w") as f:
            json.dump(cache, f, indent=2)
    except OSError:
        pass
