"""Config routes: redacted view, defaults patch, device registry CRUD.

Mirrors ``govee-cli config`` validation rule for rule — same validators, same
messages — so a registration accepted here behaves identically for the CLI.
The API key is never returned in clear text.
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter

from govee_cli.config import (
    DeviceConfig,
    _validate_device_id,
    _validate_device_name,
    _validate_mac,
    _validate_model,
    get_device_by_mac,
    load_config,
    save_config,
)
from govee_cli.exceptions import DuplicateDeviceName
from govee_cli.transport import is_cloud

from ..deps import run_blocking
from ..errors import bad_request, conflict, not_found
from ..schemas import ConfigPatchRequest, DeviceRegisterRequest

router = APIRouter()


def _redact(api_key: str | None) -> str | None:
    if not api_key:
        return None
    return "•••" + api_key[-4:]


def _config_out() -> dict[str, Any]:
    cfg = load_config()
    return {
        "api_key": _redact(cfg.api_key),
        "default_mac": cfg.default_mac,
        "default_adapter": cfg.default_adapter,
        "default_timeout": cfg.default_timeout,
        "default_brightness": cfg.default_brightness,
        "default_color": cfg.default_color,
        "groups": cfg.groups,
        "devices": {
            mac: {"model": d.model or None, "name": d.name, "static_mac": d.static_mac}
            for mac, d in sorted(cfg.devices.items())
        },
    }


@router.get("/config")
async def get_config() -> dict[str, Any]:
    """Current config with the API key redacted to its last four characters."""
    return cast("dict[str, Any]", await run_blocking(_config_out))


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
        save_config(cfg)
        return _config_out()

    return cast("dict[str, Any]", await run_blocking(apply))


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
