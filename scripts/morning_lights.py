#!/usr/bin/env python3
"""Morning light sunrise simulation for Govee H6008 floor lamps.

Usage:
  python3 morning_lights.py                  # full sequence (sunrise + 5min)
  python3 morning_lights.py --dry-run       # simulate without sending commands
  python3 morning_lights.py --steps 2        # test first 2 steps only
  python3 morning_lights.py --sunrise-offset 15  # start 15min after sunrise

Requires: requests, python-dotenv
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent

# Rochester coordinates
LAT = 43.1566
LON = -77.6088

# Warm white approximation of ~2500K candlelight
# H6008 colorTemperature min is 2700K, so we use RGB overlay for warmth
WARM_R = 255
WARM_G = 120
WARM_B = 30
COLOR_TEMP = 2700  # minimum supported by H6008 API

# Ramp parameters
START_BRIGHTNESS = 10
END_BRIGHTNESS = 50
STEP_BRIGHTNESS = 10
STEP_INTERVAL_SEC = 600  # 10 minutes

# Device groups
FLOOR_LAMPS = [
    ("82:1F:5C:E7:53:69:87:FA", "Lamp Front", "H6008"),
    ("FB:7E:5C:E7:53:63:8F:00", "Lamp Top",  "H6008"),
]
LIGHT_BARS = [
    ("6D:19:DD:6E:86:46:44:0C", "Light Bars", "H6056"),
]

# All groups combined
ALL_DEVICES = FLOOR_LAMPS + LIGHT_BARS

# ---------------------------------------------------------------------------
# Sunrise
# ---------------------------------------------------------------------------

def get_sunrise(date: datetime | None = None) -> datetime:
    """Get today's sunrise time for Rochester, NY via Open-Meteo API."""
    if date is None:
        date = datetime.now()
    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={LAT}&longitude={LON}"
        f"&daily=sunrise&timezone=America/New_York&time={date:%Y-%m-%d}"
    )
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    sunrise_str = data["daily"]["sunrise"][0]
    return datetime.fromisoformat(sunrise_str)


# ---------------------------------------------------------------------------
# Govee HTTP
# ---------------------------------------------------------------------------

def load_api_key() -> str:
    """Load API key from config."""
    import json
    config_path = Path.home() / ".config" / "govee-cli" / "config.json"
    if config_path.exists():
        with open(config_path) as f:
            cfg = json.load(f)
        if cfg.get("api_key"):
            return cfg["api_key"]
    return Path.home() / ".config" / "govee-cli" / "api_key.txt"

def get_state(mac: str, model: str, api_key: str) -> dict:
    """Read current device state."""
    headers = {"Govee-API-Key": api_key}
    resp = requests.get(
        f"https://developer-api.govee.com/v1/devices/{mac}/state",
        headers=headers,
        params={"model": model},
        timeout=10,
    )
    if resp.status_code == 200:
        return resp.json().get("data", {})
    return {}


def set_light(mac: str, model: str, api_key: str, *, brightness: int | None = None,
              color_temp: int | None = None, color: tuple[int, int, int] | None = None) -> str:
    """Send a command to a device. Returns message from API."""
    headers = {"Govee-API-Key": api_key, "Content-Type": "application/json"}
    
    # Build commands in order: temp, color, brightness (order matters for H6008)
    cmds = []
    if color_temp is not None:
        cmds.append({"name": "colorTem", "value": color_temp})
    if color is not None:
        r, g, b = color
        cmds.append({"name": "color", "value": {"r": r, "g": g, "b": b}})
    if brightness is not None:
        cmds.append({"name": "brightness", "value": brightness})
    
    for cmd in cmds:
        payload = {"device": mac, "model": model, "cmd": cmd}
        resp = requests.put(
            "https://developer-api.govee.com/v1/devices/control",
            headers=headers, json=payload, timeout=10,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") != 200:
            return f"error: {result.get('message', result)}"
    return "ok"


def is_device_at_target(state: dict, target_brightness: int | None = None,
                         color_temp: int | None = None) -> bool:
    """Check if device is already at the target settings."""
    power = state.get("powerState", "off")
    brightness = state.get("brightness", 0)
    ct = state.get("colorTem", 0)
    
    if power.lower() == "off":
        return False
    if target_brightness is not None and abs(int(brightness) - target_brightness) > 2:
        return False
    if color_temp is not None and abs(int(ct or 0) - color_temp) > 50:
        return False
    return True


# ---------------------------------------------------------------------------
# Main sequence
# ---------------------------------------------------------------------------

def run_sequence(*, dry_run: bool = False, max_steps: int | None = None,
                sunrise_offset_minutes: int = 5,
                brightness_start: int = START_BRIGHTNESS,
                brightness_end: int = END_BRIGHTNESS,
                brightness_step: int = STEP_BRIGHTNESS,
                step_interval: int = STEP_INTERVAL_SEC,
                targets: list[tuple[str, str, str]] | None = None,
                log_file: Path | None = None) -> None:
    """Run the morning light sequence."""
    
    targets = targets or ALL_DEVICES
    
    # Setup logging
    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        handlers.append(logging.FileHandler(log_file))
    
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(message)s",
        datefmt="%H:%M:%S",
        handlers=handlers,
    )
    log = logging.getLogger("morning_lights")
    
    api_key = load_api_key()
    
    # Calculate start time
    try:
        sunrise = get_sunrise()
        start_time = sunrise + timedelta(minutes=sunrise_offset_minutes)
        log.info(f"Sunrise today: {sunrise:%H:%M}")
        log.info(f"Sequence starts: {start_time:%H:%M}")
    except Exception as e:
        log.warning(f"Could not fetch sunrise, using now: {e}")
        start_time = datetime.now()
    
    if dry_run:
        log.info("[DRY RUN] Would set all devices to warm white, brightness 10%")
        for mac, name, model in targets:
            log.info(f"  [DRY RUN] {name}: warm white at 10%")
        log.info(f"[DRY RUN] Sleeping {step_interval}s then ramping to 20%...")
        return
    
    # Wait until start time
    now = datetime.now()
    if start_time > now:
        wait_sec = (start_time - now).total_seconds()
        log.info(f"Waiting {wait_sec:.0f}s until {start_time:%H:%M}...")
        time.sleep(wait_sec)
    
    # Build brightness steps: [10, 20, 30, 40, 50]
    steps = []
    b = brightness_start
    while b <= brightness_end:
        steps.append(b)
        b += brightness_step
    if max_steps:
        steps = steps[:max_steps]
    
    prev_brightness = None
    for i, brightness in enumerate(steps):
        log.info(f"Step {i+1}/{len(steps)}: brightness {brightness}%")
        
        # Check state for each device
        for mac, name, model in targets:
            try:
                state = get_state(mac, model, api_key)
                
                if is_device_at_target(state, target_brightness=brightness,
                                       color_temp=COLOR_TEMP):
                    log.info(f"  {name}: already at target (brightness={brightness}%, temp={COLOR_TEMP}K) — skipping")
                    continue
                
                msg = set_light(
                    mac, model, api_key,
                    color_temp=COLOR_TEMP,
                    color=(WARM_R, WARM_G, WARM_B),
                    brightness=brightness,
                )
                log.info(f"  {name}: {msg} (brightness={brightness}%, temp={COLOR_TEMP}K)")
            except Exception as e:
                log.error(f"  {name}: ERROR — {e}")
        
        prev_brightness = brightness
        
        if i < len(steps) - 1:
            log.info(f"Sleeping {step_interval}s until next step...")
            time.sleep(step_interval)
    
    log.info("Sequence complete.")


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Morning light sunrise simulation")
    parser.add_argument("--dry-run", action="store_true",
                        help="Simulate without sending commands")
    parser.add_argument("--steps", type=int, default=None,
                        help="Limit to N steps (for testing)")
    parser.add_argument("--sunrise-offset", type=int, default=5,
                        help="Minutes after sunrise to start (default: 5)")
    parser.add_argument("--start-brightness", type=int, default=START_BRIGHTNESS,
                        help=f"Starting brightness (default: {START_BRIGHTNESS})")
    parser.add_argument("--end-brightness", type=int, default=END_BRIGHTNESS,
                        help=f"Final brightness (default: {END_BRIGHTNESS})")
    parser.add_argument("--step-brightness", type=int, default=STEP_BRIGHTNESS,
                        help=f"Brightness increment per step (default: {STEP_BRIGHTNESS})")
    parser.add_argument("--step-interval", type=int, default=STEP_INTERVAL_SEC,
                        help=f"Seconds between steps (default: {STEP_INTERVAL_SEC})")
    parser.add_argument("--log", type=str, default=None,
                        help="Log file path")
    parser.add_argument("--floor-only", action="store_true",
                        help="Only affect floor lamps (not light bars)")
    
    args = parser.parse_args()
    
    targets = FLOOR_LAMPS if args.floor_only else ALL_DEVICES
    
    run_sequence(
        dry_run=args.dry_run,
        max_steps=args.steps,
        sunrise_offset_minutes=args.sunrise_offset,
        brightness_start=args.start_brightness,
        brightness_end=args.end_brightness,
        brightness_step=args.step_brightness,
        step_interval=args.step_interval,
        log_file=Path(args.log) if args.log else None,
        targets=targets,
    )
