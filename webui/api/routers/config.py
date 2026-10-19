"""Config routes: redacted view, defaults patch, device registry CRUD.

Mirrors ``govee-cli config`` validation rule for rule — same validators, same
messages — so a registration accepted here behaves identically for the CLI.
The API key is never returned in clear text.
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Query, Request

from govee_cli import geocode
from govee_cli.config import (
    DeviceConfig,
    GoveeConfig,
    _validate_device_id,
    _validate_device_name,
    _validate_mac,
    _validate_model,
    get_device_by_mac,
    load_config,
    save_config,
)
from govee_cli.exceptions import DuplicateDeviceName
from govee_cli.schedule import timespec
from govee_cli.transport import is_cloud

from ..deps import run_blocking
from ..errors import ApiError, bad_request, conflict, not_found
from ..schemas import CityMatchOut, CitySearchOut, ConfigPatchRequest, DeviceRegisterRequest

router = APIRouter()


def _redact(api_key: str | None) -> str | None:
    if not api_key:
        return None
    return "•••" + api_key[-4:]


def _config_out() -> dict[str, Any]:
    cfg = load_config()
    loc = timespec.resolve_location(cfg)
    return {
        "api_key": _redact(cfg.api_key),
        "default_mac": cfg.default_mac,
        "default_adapter": cfg.default_adapter,
        "default_timeout": cfg.default_timeout,
        "default_brightness": cfg.default_brightness,
        "default_color": cfg.default_color,
        "groups": cfg.groups,
        # Issue #2: the stored values (null when unset) and the zone sun times
        # are actually computed in, with where that zone came from.
        "latitude": cfg.latitude,
        "longitude": cfg.longitude,
        "timezone": cfg.timezone,
        "location_name": cfg.location_name,
        "timezone_effective": loc.timezone,
        "timezone_source": loc.timezone_source,
        "devices": {
            mac: {"model": d.model or None, "name": d.name, "static_mac": d.static_mac}
            for mac, d in sorted(cfg.devices.items())
        },
    }


@router.get("/config")
async def get_config() -> dict[str, Any]:
    """Current config with the API key redacted to its last four characters."""
    return cast("dict[str, Any]", await run_blocking(_config_out))


_MOCK_CITIES = [
    geocode.CityMatch("Rochester", "New York", "United States", 43.15478, -77.61556,
                      "America/New_York", 211328),
    geocode.CityMatch("Rochester", "Minnesota", "United States", 44.02163, -92.46985,
                      "America/Chicago", 121395),
    geocode.CityMatch("Rochester", "England", "United Kingdom", 51.38851, 0.50607,
                      "Europe/London", 27125),
    geocode.CityMatch("New York", "New York", "United States", 40.71427, -74.00597,
                      "America/New_York", 8175133),
]


def _mock_search(q: str, count: int) -> geocode.CitySearch:
    needle = q.strip().casefold()
    hits = [m for m in _MOCK_CITIES if m.name.casefold().startswith(needle)]
    return geocode.CitySearch(
        query=q.strip(), matches=hits[:count], source="open-meteo", error=None
    )


@router.get("/config/cities", response_model=CitySearchOut)
async def search_cities(
    request: Request, q: str = Query(""), count: int = Query(8, ge=1, le=20)
) -> CitySearchOut:
    """Candidates for a city name. Config-time only; the scheduler never calls this."""
    if not q.strip():
        raise ApiError(422, "unprocessable", "City name is empty.")
    if request.app.state.settings.mock:
        result = _mock_search(q, count)  # mock mode never touches the network
    else:
        result = await run_blocking(geocode.search_city, q, count)
    return CitySearchOut(
        query=result.query,
        matches=[
            CityMatchOut(
                name=m.name, region=m.region, country=m.country, label=m.label,
                latitude=m.latitude, longitude=m.longitude, timezone=m.timezone,
                population=m.population,
            )
            for m in result.matches
        ],
        source=result.source,
        error=result.error,
    )


@router.patch("/config")
async def patch_config(body: ConfigPatchRequest) -> dict[str, Any]:
    """Update any of the default_* fields; validation matches the CLI's."""

    def apply() -> dict[str, Any]:
        cfg = load_config()
        if body.default_mac is not None:
            try:
                _validate_device_id(body.default_mac)
            except Exception as e:
                raise bad_request(str(e)) from e
            cfg.default_mac = body.default_mac.upper()
        if body.default_timeout is not None:
            cfg.default_timeout = body.default_timeout
        if body.default_brightness is not None:
            cfg.default_brightness = body.default_brightness
        if body.default_color is not None:
            cfg.default_color = body.default_color.lstrip("#")
        _apply_location(cfg, body)
        save_config(cfg)
        return _config_out()

    return cast("dict[str, Any]", await run_blocking(apply))


def _apply_location(cfg: GoveeConfig, body: ConfigPatchRequest) -> None:
    """Issue #2: set the sun-time location, or clear it. Omitted fields stay unchanged.

    Latitude and longitude are a pair; a timezone may be set on its own (it
    applies to the location, whenever one is set). ``clear_location`` removes
    all three and refuses to be combined with any of them, because "clear and
    also set" has no single honest reading.
    """
    provided = (
        body.latitude is not None or body.longitude is not None or body.timezone is not None
    )
    if body.clear_location:
        if provided:
            raise ApiError(
                422, "unprocessable",
                "clear_location cannot be combined with latitude, longitude or timezone.",
            )
        cfg.latitude = None
        cfg.longitude = None
        cfg.timezone = None
        cfg.location_name = None
        return
    if (body.latitude is None) != (body.longitude is None):
        raise ApiError(422, "unprocessable", "Set latitude and longitude together.")
    if body.latitude is not None and body.longitude is not None:
        cfg.latitude = body.latitude
        cfg.longitude = body.longitude
        # A label only describes the coordinates it was picked with; raw
        # coordinates arriving without one drop any old label.
        cfg.location_name = (body.location_name or "").strip() or None
    elif body.location_name is not None:
        raise ApiError(
            422, "unprocessable", "location_name needs latitude and longitude with it."
        )
    if body.timezone is not None:
        cfg.timezone = body.timezone


@router.post("/config/devices")
async def register_device(body: DeviceRegisterRequest) -> dict[str, Any]:
    """Register or edit a device entry, applying the CLI's exact validations."""

    def apply() -> dict[str, Any]:
        try:
            _validate_device_id(body.mac)
        except Exception as e:
            raise bad_request(str(e)) from e
        mac = body.mac.upper()

        static_mac = body.static_mac
        if static_mac:
            try:
                _validate_mac(static_mac)
            except Exception as e:
                raise bad_request(str(e)) from e
            static_mac = static_mac.upper()

        model = body.model.upper()
        try:
            _validate_model(model)
        except Exception as e:
            raise bad_request(str(e)) from e

        # A cloud model under a 6-octet BLE MAC is a device the cloud can never
        # address; refuse now rather than at the first command.
        if is_cloud(model) and len(mac.split(":")) == 6:
            raise bad_request(
                f"{model} is controlled over the Govee cloud, which needs the "
                f"8-octet device id from your account, not a Bluetooth MAC. "
                f"Run `govee-cli scan-http` to register it."
            )

        cfg = load_config()
        if body.name:
            existing = get_device_by_mac(cfg, mac)
            if not existing or existing.name != body.name:
                try:
                    _validate_device_name(body.name, cfg.devices)
                except DuplicateDeviceName as e:
                    raise conflict(str(e)) from e

        cfg.devices[mac] = DeviceConfig(
            model=model, name=body.name, static_mac=static_mac
        )
        first_device = len(cfg.devices) == 1 and cfg.default_mac is None
        if first_device:
            cfg.default_mac = mac
        save_config(cfg)
        entry: dict[str, Any] = {
            "mac": mac, "model": model, "name": body.name, "static_mac": static_mac,
        }
        if first_device:
            entry["default"] = True
        return entry

    return cast("dict[str, Any]", await run_blocking(apply))


@router.delete("/config/devices/{mac}")
async def delete_device(mac: str) -> dict[str, Any]:
    """Remove a device, cascading to groups and the default pointer like the CLI."""

    def apply() -> dict[str, Any]:
        try:
            _validate_device_id(mac)
        except Exception as e:
            raise bad_request(str(e)) from e
        target = mac.upper()

        cfg = load_config()
        if target not in cfg.devices:
            raise not_found(f"Device {target} not found.")

        removed_name = cfg.devices[target].name or target
        del cfg.devices[target]
        for group_name, group_macs in list(cfg.groups.items()):
            if target in group_macs:
                group_macs.remove(target)
                if not group_macs:
                    del cfg.groups[group_name]
        cleared_default = cfg.default_mac == target
        if cleared_default:
            cfg.default_mac = None
        save_config(cfg)
        return {"removed": removed_name, "mac": target, "cleared_default": cleared_default}

    return cast("dict[str, Any]", await run_blocking(apply))
