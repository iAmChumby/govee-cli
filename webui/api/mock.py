"""Mock mode: deterministic fixtures with in-memory state, no hardware.

Enabled by ``GOVEE_WEBUI_MOCK=1``. Three jobs:

1. Redirect every on-disk path the library writes (user config, schedule file,
   scene cache, active-mode ledger, request meter, room scenes) to a temp dir
   *before first use*, so a demo run can never touch real
   ``~/.config/govee-cli`` files. This patches the module-level constants the
   library reads at call time — it must happen before the first
   ``load_config()`` / ``list_rules()`` / ``record_mode()`` /
   ``request_meter.record()`` / ``room_scenes.save_scene()``, which is why
   :func:`install` runs from the app factory rather than from request
   handlers. A verification run or a test that wrote to the real
   request-meter.json or room-scenes.json would corrupt the traffic counts and
   the saved scenes the running console displays — the same reason the ledger
   is redirected here. The schedule state file (``schedule-state.json``) and the
   scheduler owner record + lock (``scheduler-owner.json``) are redirected too.
2. Seed that temp dir with the three fixture devices, one group, a mock
   location (New York; ``GOVEE_WEBUI_MOCK_NO_LOCATION=1`` leaves it unset),
   five schedule rules (clock, sun, a missing room scene, a disabled one), room
   scenes (one authored, one captured with an unknown-mode device), per-rule
   firing state, and an owner record chosen by ``GOVEE_WEBUI_MOCK_OWNER``
   (``daemon``/``waiting`` live record, ``stale`` dead pid + old heartbeat,
   ``nobody`` none, unset: nothing seeded, the dry-run runner owns the lock),
   so config/group/schedule endpoints exercise the library's real load/save
   code paths against throwaway files.
3. Provide :class:`MockV2`, a drop-in for :class:`govee_cli.http_v2.GoveeHTTPv2`
   with the same method surface the routers use. Mutations update in-memory
   device state; each call sleeps 150-400 ms (override with
   ``GOVEE_WEBUI_MOCK_LATENCY``, e.g. ``0-0`` in tests) so the UI's loading
   states get exercised honestly.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import random
import shutil
import socket
import tempfile
import time
from typing import Any

from govee_cli import config as config_mod
from govee_cli import http_v2 as http_v2_mod
from govee_cli import ledger as ledger_mod
from govee_cli import request_meter as request_meter_mod
from govee_cli import room_scenes as room_scenes_mod
from govee_cli.http_v2 import Capability, DIYScene, Scene, V2Device
from govee_cli.schedule import owner as owner_mod
from govee_cli.schedule import scheduler as scheduler_mod
from govee_cli.transport import MODEL_SPECS

MOCK_DEVICES: list[dict[str, str]] = [
    {"id": "6D:19:DD:6E:86:46:44:0C", "model": "H6056", "name": "Light Bars"},
    {"id": "50:CE:E8:6E:80:C6:50:3F", "model": "H6022", "name": "Shelf Lamp"},
    {"id": "82:1F:5C:E7:53:69:87:FA", "model": "H6008", "name": "Bulb"},
]

# ~69-entry firmware libraries for the bars and the lamp, mirroring the shape of
# the real Govee scene list. The bulb gets its own smaller set.
BAR_LAMP_SCENES: list[str] = [
    "Rainbow", "Ocean", "Sunset", "Sunrise", "Aurora", "Snowflake", "Romantic",
    "Candlelight", "Movie", "Reading", "Breathe", "Energetic", "Party", "Siren",
    "Asleep", "Crossing", "Glitter", "Fright", "Drumbeat", "Literary", "Sci-Fi",
    "Romance", "War", "Comedy", "Documentary", "Action", "Suspense", "Christmas",
    "Halloween", "Valentine", "New Year", "Independence Day", "St Patricks Day",
    "Easter", "Thanksgiving", "Cherry Blossom", "Fireworks", "Meteor", "Waterfall",
    "Waves", "Forest", "Starlight", "Moonlight", "Campfire", "Ember", "Neon",
    "Cyberpunk", "Vaporwave", "Retro Arcade", "Matrix", "Northern Lights",
    "Galaxy", "Nebula", "Candy", "Bubblegum", "Cotton Candy", "Lava Lamp",
    "Fireplace", "Rainy Day", "Thunderstorm", "Wind Chimes", "Zen Garden",
    "Tea Time", "Coffee House", "Jazz Club", "Disco", "Karaoke Night",
    "Game Night", "Movie Night",
]

BULB_SCENES: list[str] = [
    "Reading", "Movie", "Candlelight", "Nightlight", "Sunrise", "Sunset",
    "Relax", "Focus", "Party", "Romantic", "Sleep", "Wake Up",
]

# DIY scenes are named by the user in the Govee app, so a real account's list is
# a mix of descriptive names and names that carry no colour signal whatsoever.
# The H6022's list mirrors that shape on purpose: "Sunrise Circuit" resolves
# through the appearance table, while "madisonnnn" and "FRoesy2k" (both real
# names off this project's own account) resolve to *indeterminate* and must
# render neutral grey with "colour unknown". A fixture made only of tidy
# descriptive names would let the fabricated-palette bug back in unseen — every
# mock entry would resolve, so `verify_ui.py` would never once render the
# unknown state that is the whole point of the honesty axis.
DIY_SCENES: dict[str, list[tuple[str, int]]] = {
    "H6056": [("Sunrise Circuit", 1), ("Rainbow Flow", 2), ("Ember Fade", 3),
              ("Ocean Pulse", 4)],
    "H6022": [("Sunrise Circuit", 1), ("Ember Fade", 2), ("madisonnnn", 3),
              ("FRoesy2k", 4), ("sleep", 5)],
    "H6008": [("Cozy Glow", 1), ("Deep Sleep", 2)],
}

SNAPSHOTS: dict[str, list[tuple[str, int]]] = {
    "H6056": [("Movie Time", 101), ("Focus", 102)],
    "H6022": [("Cozy", 201), ("Bright", 202)],
    "H6008": [("Night Light", 301)],
}

# Advertised-but-unverified toggles, per the CLAUDE.md hardware notes: the H6056
# advertises dreamViewToggle and then rejects it at control time.
UNVERIFIED_TOGGLES: dict[str, tuple[str, ...]] = {"H6056": ("dreamViewToggle",)}

# Initial fixture state per device id: powerSwitch, brightness, colorRgb,
# colorTemperatureK, online — the same keys the real v2 state endpoint returns.
_INITIAL_STATE: dict[str, dict[str, Any]] = {
    "6D:19:DD:6E:86:46:44:0C": {
        "powerSwitch": 1, "brightness": 60, "colorRgb": 0x33CCFF,
        "colorTemperatureK": 0, "online": True,
    },
    "50:CE:E8:6E:80:C6:50:3F": {
        "powerSwitch": 1, "brightness": 42, "colorRgb": 0xFF8800,
        "colorTemperatureK": 0, "online": True,
    },
    "82:1F:5C:E7:53:69:87:FA": {
        "powerSwitch": 0, "brightness": 100, "colorRgb": 0,
        "colorTemperatureK": 2700, "online": True,
    },
}

_MOCK_API_KEY = "mock-key-2233445566778899"

# Install bookkeeping so repeated create_app() calls (tests) reuse one temp dir.
_tmp_dir: pathlib.Path | None = None
_originals: dict[str, Any] = {}


def _latency_bounds() -> tuple[float, float]:
    raw = os.environ.get("GOVEE_WEBUI_MOCK_LATENCY", "0.15-0.40")
    try:
        lo, _, hi = raw.partition("-")
        return max(float(lo), 0.0), max(float(hi), float(lo))
    except ValueError:
        return 0.15, 0.40


def sleep_latency() -> None:
    """Simulate cloud round-trip time so UI loading states are exercised."""
    lo, hi = _latency_bounds()
    if hi > 0:
        time.sleep(random.uniform(lo, hi))


def _scene_table(model: str) -> list[Scene]:
    names = BAR_LAMP_SCENES if model in ("H6056", "H6022") else BULB_SCENES
    return [
        # Deterministic ids: paramId cycles 1..7 like the real API's groups,
        # sceneId is a stable per-name number.
        Scene(name=name, param_id=(i % 7) + 1, scene_id=0x1000 + i * 16)
        for i, name in enumerate(names)
    ]


class MockV2:
    """In-memory stand-in for GoveeHTTPv2 with the router-facing method surface.

    Music modes, segment counts and temperature bounds are read from the real
    ModelSpec / device handlers, so capability behaviour in mock mode stays
    structurally correct instead of hand-copied.
    """

    def __init__(self) -> None:
        self.state: dict[str, dict[str, Any]] = {
            dev["id"].upper(): dict(_INITIAL_STATE[dev["id"]]) for dev in MOCK_DEVICES
        }
        self.scene_cache: set[str] = set()

    # ------------------------------------------------------------------ lookups

    def _device(self, device_id: str) -> dict[str, Any]:
        return self.state[device_id.upper()]

    def _model(self, sku: str) -> str:
        return sku.upper()

    def get_devices(self) -> list[V2Device]:
        sleep_latency()
        out = []
        for dev in MOCK_DEVICES:
            out.append(self._describe(dev["model"], dev["id"], dev["name"]))
        return out

    def _describe(self, model: str, device_id: str, name: str | None) -> V2Device:
        spec = MODEL_SPECS[model]
        caps: list[Capability] = [
            Capability("devices.capabilities.on_off", "powerSwitch"),
            Capability("devices.capabilities.range", "brightness"),
            Capability("devices.capabilities.color_setting", "colorRgb"),
            Capability("devices.capabilities.color_setting", "colorTemperatureK"),
        ]
        if spec.cloud_segments:
            caps.append(Capability("devices.capabilities.segment_color_setting",
                                   "segmentedColorRgb"))
        if spec.cloud_segment_brightness:
            caps.append(Capability("devices.capabilities.segment_color_setting",
                                   "segmentedBrightness"))
        if spec.cloud_scenes:
            caps.append(Capability("devices.capabilities.dynamic_scene", "lightScene"))
        if spec.cloud_diy:
            caps.append(Capability("devices.capabilities.dynamic_scene", "diyScene"))
            snapshot_opts = [
                {"name": n, "value": v} for n, v in SNAPSHOTS.get(model, [])
            ]
            caps.append(Capability(
                "devices.capabilities.dynamic_scene", "snapshot",
                {"options": snapshot_opts},
            ))
        if spec.cloud_music:
            caps.append(Capability("devices.capabilities.music_setting", "musicMode"))
        for toggle in spec.toggles:
            caps.append(Capability("devices.capabilities.toggle", toggle))
        for toggle in UNVERIFIED_TOGGLES.get(model, ()):
            caps.append(Capability("devices.capabilities.toggle", toggle))
        return V2Device(sku=model, device_id=device_id, name=name, type=None,
                        capabilities=caps)

    def get_device(self, sku: str, device_id: str) -> V2Device | None:
        sleep_latency()
        for dev in MOCK_DEVICES:
            if dev["id"].upper() == device_id.upper():
                return self._describe(dev["model"], dev["id"], dev["name"])
        return None

    def get_state(self, sku: str, device_id: str) -> dict[str, Any]:
        sleep_latency()
        return dict(self._device(device_id))

    def apply_frame(self, device_id: str, r: int, g: int, b: int) -> None:
        """Mutate fixture state directly (no latency) — used by simulated playback."""
        state = self._device(device_id)
        state["powerSwitch"] = 1
        state["colorRgb"] = (r << 16) | (g << 8) | b
        state["colorTemperatureK"] = 0

    # ------------------------------------------------------------------ control

    def control(self, sku: str, device_id: str, cap_type: str, instance: str,
                value: Any) -> dict:
        sleep_latency()
        state = self._device(device_id)
        if instance == "powerSwitch":
            state["powerSwitch"] = 1 if value else 0
        elif instance == "brightness":
            state["brightness"] = int(value)
            state["colorTemperatureK"] = 0
        elif instance == "colorRgb":
            state["colorRgb"] = int(value)
            state["colorTemperatureK"] = 0
        elif instance == "colorTemperatureK":
            state["colorTemperatureK"] = int(value)
            state["colorRgb"] = 0
        elif instance == "segmentedColorRgb":
            pass
        elif instance == "segmentedBrightness":
            pass
        elif instance == "musicMode":
            pass
        elif instance == "toggle":
            pass
        # Scenes/DIY/snapshots change no readable state — same as the hardware,
        # where a 200 is the only acknowledgement.
        return {"code": 200, "message": "Success"}

    def turn_on(self, sku: str, device_id: str) -> None:
        self.control(sku, device_id, "devices.capabilities.on_off", "powerSwitch", 1)

    def turn_off(self, sku: str, device_id: str) -> None:
        self.control(sku, device_id, "devices.capabilities.on_off", "powerSwitch", 0)

    def set_brightness(self, sku: str, device_id: str, value: int) -> None:
        self.control(sku, device_id, "devices.capabilities.range", "brightness", value)

    def set_color(self, sku: str, device_id: str, r: int, g: int, b: int) -> None:
        self.control(sku, device_id, "devices.capabilities.color_setting", "colorRgb",
                     (r << 16) | (g << 8) | b)

    def set_color_temp(self, sku: str, device_id: str, kelvin: int) -> None:
        self.control(sku, device_id, "devices.capabilities.color_setting",
                     "colorTemperatureK", kelvin)

    def set_segment_color(self, sku: str, device_id: str, segments: list[int],
                          r: int, g: int, b: int) -> None:
        self.control(sku, device_id, "devices.capabilities.segment_color_setting",
                     "segmentedColorRgb", {"segment": segments,
                                           "rgb": (r << 16) | (g << 8) | b})

    def set_segment_brightness(self, sku: str, device_id: str, segments: list[int],
                               brightness: int) -> None:
        self.control(sku, device_id, "devices.capabilities.segment_color_setting",
                     "segmentedBrightness", {"segment": segments,
                                             "brightness": brightness})

    def set_scene(self, sku: str, device_id: str, scene: Scene) -> None:
        self.control(sku, device_id, "devices.capabilities.dynamic_scene",
                     "lightScene", {"paramId": scene.param_id, "id": scene.scene_id})

    def set_diy_scene(self, sku: str, device_id: str, value: int) -> None:
        self.control(sku, device_id, "devices.capabilities.dynamic_scene",
                     "diyScene", value)

    def set_snapshot(self, sku: str, device_id: str, value: int) -> None:
        self.control(sku, device_id, "devices.capabilities.dynamic_scene",
                     "snapshot", value)

    def set_music_mode(self, sku: str, device_id: str, mode: int, sensitivity: int,
                       auto_color: bool | None = None,
                       rgb: int | None = None) -> None:
        self.control(sku, device_id, "devices.capabilities.music_setting",
                     "musicMode", {"musicMode": mode, "sensitivity": sensitivity})

    def set_toggle(self, sku: str, device_id: str, instance: str, on: bool) -> None:
        # dreamViewToggle is advertised and then rejected — reproduce the exact
        # hardware wording so the UI surfaces what real devices say.
        if instance in UNVERIFIED_TOGGLES.get(self._model(sku), ()):
            raise http_v2_mod.GoveeV2Error(
                "Govee API error 400: The device does not has DreamView"
            )
        self.control(sku, device_id, "devices.capabilities.toggle", instance,
                     1 if on else 0)

    # ------------------------------------------------------------------- scenes

    def get_scenes(self, sku: str, device_id: str, *, use_cache: bool = True) -> list[Scene]:
        sleep_latency()
        self.scene_cache.add(device_id.upper())
        return _scene_table(self._model(sku))

    def get_diy_scenes(self, sku: str, device_id: str) -> list[DIYScene]:
        sleep_latency()
        table = DIY_SCENES.get(self._model(sku), [])
        return [DIYScene(name=name, value=value) for name, value in table]

    def find_scene(self, sku: str, device_id: str, name: str) -> Scene | None:
        target = "".join(ch for ch in name.lower() if ch.isalnum())
        for scene in self.get_scenes(sku, device_id):
            if "".join(ch for ch in scene.name.lower() if ch.isalnum()) == target:
                return scene
        return None

    def find_diy_scene(self, sku: str, device_id: str, name: str) -> DIYScene | None:
        target = "".join(ch for ch in name.lower() if ch.isalnum())
        for scene in self.get_diy_scenes(sku, device_id):
            if "".join(ch for ch in scene.name.lower() if ch.isalnum()) == target:
                return scene
        return None


def is_mock_enabled() -> bool:
    return os.environ.get("GOVEE_WEBUI_MOCK") == "1"


def install() -> pathlib.Path:
    """Redirect library write paths to a seeded temp dir. Idempotent.

    Returns the temp dir. Must run before the first ``load_config()`` — the
    patched constants are read at call time, so earlier is safer.
    """
    global _tmp_dir
    if _tmp_dir is not None:
        return _tmp_dir

    _tmp_dir = pathlib.Path(tempfile.mkdtemp(prefix="govee-webui-mock-"))
    _originals.update({
        "config_path": config_mod._CONFIG_PATH,
        "schedule_file": scheduler_mod.SCHEDULE_FILE,
        "schedule_dir": scheduler_mod.SCHEDULE_DIR,
        "scene_cache": http_v2_mod._SCENE_CACHE_PATH,
        "ledger_path": ledger_mod.LEDGER_PATH,
        "ledger_lock_path": ledger_mod.LEDGER_LOCK_PATH,
        "meter_path": request_meter_mod.METER_PATH,
        "meter_lock_path": request_meter_mod.METER_LOCK_PATH,
        "room_scenes_path": room_scenes_mod.ROOM_SCENES_PATH,
        "room_scenes_lock_path": room_scenes_mod.ROOM_SCENES_LOCK_PATH,
        "schedule_state_path": scheduler_mod.SCHEDULE_STATE_PATH,
        "owner_path": owner_mod.OWNER_PATH,
        "owner_lock_path": owner_mod.OWNER_LOCK_PATH,
    })
    config_mod._CONFIG_PATH = _tmp_dir / "config.json"
    scheduler_mod.SCHEDULE_DIR = _tmp_dir
    scheduler_mod.SCHEDULE_FILE = _tmp_dir / "schedule.json"
    http_v2_mod._SCENE_CACHE_PATH = _tmp_dir / "scene-cache.json"
    # Reassigned as a pair, same as LEDGER_PATH's own module contract requires
    # (LEDGER_LOCK_PATH is a plain module attr, not derived lazily from
    # LEDGER_PATH at call time) — see govee_cli/ledger.py.
    ledger_mod.LEDGER_PATH = _tmp_dir / "active-mode.json"
    ledger_mod.LEDGER_LOCK_PATH = _tmp_dir / "active-mode.json.lock"
    # Same pair-reassignment contract as the ledger above, for the two modules
    # T24 adds: request_meter (§10.1's traffic counts) and room_scenes (§10's
    # saved room presets) — both write via flock + atomic replace to a path
    # read from a module-level constant, not derived at call time.
    request_meter_mod.METER_PATH = _tmp_dir / "request-meter.json"
    request_meter_mod.METER_LOCK_PATH = _tmp_dir / "request-meter.json.lock"
    room_scenes_mod.ROOM_SCENES_PATH = _tmp_dir / "room-scenes.json"
    room_scenes_mod.ROOM_SCENES_LOCK_PATH = _tmp_dir / "room-scenes.json.lock"
    scheduler_mod.SCHEDULE_STATE_PATH = _tmp_dir / "schedule-state.json"
    owner_mod.OWNER_PATH = _tmp_dir / "scheduler-owner.json"
    owner_mod.OWNER_LOCK_PATH = _tmp_dir / "scheduler-owner.json.lock"

    _seed_config(config_mod._CONFIG_PATH)
    _seed_schedules(scheduler_mod.SCHEDULE_FILE)
    _seed_room_scenes()
    _seed_schedule_state(scheduler_mod.SCHEDULE_STATE_PATH)
    _seed_owner(owner_mod.OWNER_PATH)
    return _tmp_dir


def uninstall() -> None:
    """Restore original paths and delete the temp dir. Used by tests."""
    global _tmp_dir
    if _tmp_dir is None:
        return
    config_mod._CONFIG_PATH = _originals["config_path"]
    scheduler_mod.SCHEDULE_FILE = _originals["schedule_file"]
    scheduler_mod.SCHEDULE_DIR = _originals["schedule_dir"]
    http_v2_mod._SCENE_CACHE_PATH = _originals["scene_cache"]
    ledger_mod.LEDGER_PATH = _originals["ledger_path"]
    ledger_mod.LEDGER_LOCK_PATH = _originals["ledger_lock_path"]
    request_meter_mod.METER_PATH = _originals["meter_path"]
    request_meter_mod.METER_LOCK_PATH = _originals["meter_lock_path"]
    room_scenes_mod.ROOM_SCENES_PATH = _originals["room_scenes_path"]
    room_scenes_mod.ROOM_SCENES_LOCK_PATH = _originals["room_scenes_lock_path"]
    scheduler_mod.SCHEDULE_STATE_PATH = _originals["schedule_state_path"]
    owner_mod.OWNER_PATH = _originals["owner_path"]
    owner_mod.OWNER_LOCK_PATH = _originals["owner_lock_path"]
    shutil.rmtree(_tmp_dir, ignore_errors=True)
    _tmp_dir = None
    _originals.clear()


def _seed_config(path: pathlib.Path) -> None:
    devices = {
        dev["id"].upper(): {"model": dev["model"], "name": dev["name"]}
        for dev in MOCK_DEVICES
    }
    data = {
        "version": config_mod.CONFIG_VERSION,
        "api_key": _MOCK_API_KEY,
        "default_mac": MOCK_DEVICES[0]["id"],
        "default_timeout": 10.0,
        "groups": {"living-room": [MOCK_DEVICES[0]["id"], MOCK_DEVICES[1]["id"]]},
        "devices": devices,
    }
    if os.environ.get("GOVEE_WEBUI_MOCK_NO_LOCATION") != "1":
        # New York, timezone left unset so the UI shows "host: <zone>".
        data["latitude"] = 40.7128
        data["longitude"] = -74.0060
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


_ALL_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# a1b2c3d4 / e5f6a7b8 predate issue #2 and tests/test_webui_api.py asserts on
# them, so those ids stay; the other three are new.
_RULE_WAKE = "a1b2c3d4"
_RULE_LIGHTS_OUT = "e5f6a7b8"
_RULE_EVENING = "c3d4e5f6"
_RULE_LATE_NIGHT = "d4e5f6a7"
_RULE_GHOST = "f6a7b8c9"


def _seed_schedules(path: pathlib.Path) -> None:
    shelf, bulb = MOCK_DEVICES[1]["id"], MOCK_DEVICES[2]["id"]
    rules = [
        {
            "id": _RULE_WAKE, "name": "weekday wake", "time": "06:30",
            "days": ["Mon", "Tue", "Wed", "Thu", "Fri"],
            "command": "power on", "enabled": True, "device": shelf,
        },
        {
            # The disabled rule.
            "id": _RULE_LIGHTS_OUT, "name": "Lights out", "time": "23:30",
            "days": list(_ALL_DAYS), "command": "power off", "enabled": False,
            "device": shelf,
        },
        {
            "id": _RULE_EVENING, "name": "Evening", "time": "sunset-1h",
            "days": list(_ALL_DAYS), "command": "", "enabled": True,
            "device": None, "room_scene": "Evening",
        },
        {
            "id": _RULE_LATE_NIGHT, "name": "Late night", "time": "sunset+3h30m",
            "days": ["Fri", "Sat"], "command": "brightness 20", "enabled": True,
            "device": bulb,
        },
        {
            # Targets a room scene that does not exist: the missing-scene state.
            "id": _RULE_GHOST, "name": "Ghost", "time": "sunrise+15m",
            "days": list(_ALL_DAYS), "command": "", "enabled": True,
            "device": None, "room_scene": "Deleted scene",
        },
    ]
    path.write_text(json.dumps(rules, indent=2))


def _seed_room_scenes() -> None:
    """Seed room-scenes.json through the library's own writers.

    "Evening" is authored (white 2700K, colour FF7A2F, and a DIY the mock's DIY
    list really contains). "Movie night" is captured and holds one device whose
    ledger mode was ``unknown`` (the skipped-with-a-reason case). The mock never
    sends to hardware, so naming the mock Light Bars here is safe.
    """
    bars, shelf, bulb = (d["id"] for d in MOCK_DEVICES)
    diy_name, diy_value = next(
        (n, v) for n, v in DIY_SCENES["H6056"] if n == "Ember Fade"
    )
    authored = [
        {"device_id": bulb, "mode": "white", "power": True, "brightness": 60,
         "color_temp_k": 2700},
        {"device_id": shelf, "mode": "colour", "power": True, "brightness": 40,
         "color": "FF7A2F"},
        {"device_id": bars, "mode": "diy", "power": True, "brightness": 50,
         "diy_value": diy_value, "diy_name": diy_name},
    ]
    models = {d["id"]: d["model"] for d in MOCK_DEVICES}
    room_scenes_mod.save_authored_scene(
        "Evening",
        [room_scenes_mod.captured_from_authored(d, models[d["device_id"]])
         for d in authored],
    )
    room_scenes_mod.save_scene("Movie night", [
        room_scenes_mod.CapturedDevice(
            device_id=bulb, model="H6008", power=True, brightness=30, color=None,
            color_temp_k=2700, mode="basic", label=None,
            payload={"color_temp_k": 2700},
        ),
        room_scenes_mod.CapturedDevice(
            device_id=bars, model="H6056", power=True, brightness=60,
            color=[51, 204, 255], color_temp_k=None, mode="unknown", label=None,
            payload=None,
        ),
    ])


def _utc_iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat()


def _seed_schedule_state(path: pathlib.Path) -> None:
    """A last fire ("weekday wake" ok) and a missed state ("Late night")."""
    now = dt.datetime.now(dt.timezone.utc).replace(second=0, microsecond=0)
    woke = now - dt.timedelta(minutes=90)
    missed = now - dt.timedelta(hours=20)
    state = {
        _RULE_WAKE: {
            "last_fired_minute": _utc_iso(woke), "last_result": "ok",
            "last_detail": None, "last_at": _utc_iso(woke), "missed_minute": None,
        },
        _RULE_LATE_NIGHT: {
            "last_fired_minute": None, "last_result": "missed",
            "last_detail": "scheduler was not running at the time",
            "last_at": _utc_iso(missed + dt.timedelta(minutes=1)),
            "missed_minute": _utc_iso(missed),
        },
    }
    path.write_text(json.dumps(state, indent=2))


def _seed_owner(path: pathlib.Path) -> None:
    """Seed the owner record per GOVEE_WEBUI_MOCK_OWNER (read only in mock mode).

    unset or ``nobody``: nothing (unset leaves the dry-run runner to own the lock
    and write its own record). ``daemon``/``waiting``: a live record; this pid is
    alive, so it reads running. ``stale``: a dead pid and a two-hour-old heartbeat.
    """
    mode = os.environ.get("GOVEE_WEBUI_MOCK_OWNER", "").strip().lower()
    if mode not in ("daemon", "waiting", "stale"):
        return
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    if mode == "stale":
        pid, started, cycle = 999999, now - dt.timedelta(hours=5), now - dt.timedelta(hours=2)
    else:
        pid, started, cycle = os.getpid(), now - dt.timedelta(minutes=5), now - dt.timedelta(seconds=10)
    record = {
        "kind": "daemon", "dry_run": False, "pid": pid,
        "host": socket.gethostname(),
        "started_at": _utc_iso(started), "last_cycle_at": _utc_iso(cycle),
        "poll_seconds": 30,
    }
    path.write_text(json.dumps(record, indent=2))
