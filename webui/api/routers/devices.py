"""Device routes: discovery, info, state, and the four basic controls.

Basic control goes through ``_apply_v2_command`` / ``_apply_http_command`` — the
same functions ``group run`` uses — so an API command and a CLI command produce
byte-identical requests. Unregistered models fall back to the BLE path.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request

from govee_cli.commands.group import _apply_http_command, _apply_v2_command
from govee_cli.config import GoveeConfig
from govee_cli.http import GoveeHTTP
from govee_cli.transport import CLOUD_V1, CLOUD_V2

from ..deps import (
    Resolved,
    get_client_async,
    get_config,
    invalidate_state,
    normalize_state,
    read_state,
    resolve_ref,
    run_blocking,
)
from ..errors import bad_request
from ..schemas import (
    BrightnessRequest,
    ColorRequest,
    DiscoverRequest,
    PowerRequest,
    TemperatureRequest,
)

router = APIRouter()


@router.get("/devices")
async def list_devices(request: Request) -> dict[str, Any]:
    """Config registry entries with last-known state (TTL-cached, errors tolerated)."""
    cfg = await run_blocking(get_config)
    summaries = []
    for mac, dev_cfg in sorted(cfg.devices.items()):
        target = resolve_ref(cfg, mac)
        try:
            raw = await read_state(request, target)
            state = normalize_state(target, raw)
        except Exception:
            # One offline device must not blank the console's device grid.
            state = {}
        summaries.append({
            "ref": dev_cfg.name or mac,
            "id": mac,
            "model": dev_cfg.model or None,
            "name": dev_cfg.name,
            "transport": target.transport,
            "online": state.get("online"),
            "power": state.get("power"),
            "brightness": state.get("brightness"),
            "color": state.get("color"),
            "color_temp_k": state.get("color_temp_k"),
        })
    return {"devices": summaries}


@router.post("/devices/discover")
async def discover(request: Request, body: DiscoverRequest) -> dict[str, Any]:
    """Scan the v2 cloud for devices; ``sync=false`` serves the local registry."""
    cfg = await run_blocking(get_config)
    if not body.sync:
        return {"devices": [_registry_entry(cfg, mac) for mac in sorted(cfg.devices)]}

    client = await get_client_async(request)
    found = await run_blocking(client.get_devices)
    registered_ids = {mac.upper() for mac in cfg.devices}
    devices = []
    for dev in found:
        devices.append({
            "id": dev.device_id,
            "model": dev.sku,
            "name": dev.name,
            "transport": _transport_for_model(dev.sku),
            "registered": dev.device_id.upper() in registered_ids,
            "capabilities": [c.instance for c in dev.capabilities],
        })
    return {"devices": devices}


def _registry_entry(cfg: GoveeConfig, mac: str) -> dict[str, Any]:
    dev_cfg = cfg.devices[mac]
    return {
        "id": mac,
        "model": dev_cfg.model or None,
        "name": dev_cfg.name,
        "transport": _transport_for_model(dev_cfg.model),
        "registered": True,
        "capabilities": [],
    }


def _transport_for_model(model: str | None) -> str:
    from govee_cli.transport import transport_for

    return transport_for(model)


@router.get("/devices/{ref}")
async def get_device(request: Request, ref: str) -> dict[str, Any]:
    """Full device record: identity, normalised state and capability block."""
    return await _device_state(request, ref)


@router.get("/devices/{ref}/state")
async def get_device_state(request: Request, ref: str) -> dict[str, Any]:
    """Normalised state per WEBUI_SPEC.md §4."""
    return await _device_state(request, ref)


async def _device_state(request: Request, ref: str) -> dict[str, Any]:
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    raw = await read_state(request, target)
    return normalize_state(target, raw)


@router.put("/devices/{ref}/power")
async def set_power(request: Request, ref: str, body: PowerRequest) -> dict[str, Any]:
    return await _basic_control(request, ref, "power", "on" if body.on else "off")


@router.put("/devices/{ref}/brightness")
async def set_brightness(request: Request, ref: str,
                         body: BrightnessRequest) -> dict[str, Any]:
    return await _basic_control(request, ref, "brightness", str(body.value))


@router.put("/devices/{ref}/color")
async def set_color(request: Request, ref: str, body: ColorRequest) -> dict[str, Any]:
    return await _basic_control(request, ref, "color", body.hex)


@router.put("/devices/{ref}/temperature")
async def set_temperature(request: Request, ref: str,
                          body: TemperatureRequest) -> dict[str, Any]:
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    spec = target.spec
    if spec and not spec.temp_min <= body.kelvin <= spec.temp_max:
        raise bad_request(
            f"Kelvin must be {spec.temp_min}-{spec.temp_max} for {spec.model}, "
            f"got {body.kelvin}."
        )
    return await _basic_control(request, ref, "temp", str(body.kelvin))


async def _basic_control(request: Request, ref: str, verb: str,
                         arg: str) -> dict[str, Any]:
    """Apply one of the four basic verbs and return the post-change state."""
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    cmd = f"{verb} {arg}"

    if target.transport == CLOUD_V2:
        client = await get_client_async(request)
        await run_blocking(_apply_v2_command, client, target.device_id, target.sku, cmd)
    elif target.transport == CLOUD_V1:
        await run_blocking(_apply_v1_command, target, cmd)
    else:
        await run_blocking(_apply_ble_command, target, cmd)

    invalidate_state(request, target)
    raw = await read_state(request, target)
    return normalize_state(target, raw)


def _apply_v1_command(target: Resolved, cmd: str) -> None:
    _apply_http_command(GoveeHTTP(), target.device_id, target.sku, cmd)


def _apply_ble_command(target: Resolved, cmd: str) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.commands._common import Target
    from govee_cli.commands.group import _parse_inline_command

    parsed = _parse_inline_command(cmd, device_model=target.model)
    if parsed is None:
        raise bad_request(f"Unknown command: {cmd}")
    ble_target = Target(target.device_id, target.model, target.transport, target.config)
    adapter = target.config.default_adapter or "hci0"
    timeout = target.config.default_timeout

    async def execute() -> None:
        async with GoveeBLE(ble_target.ble_mac, adapter=adapter, timeout=timeout) as cl:
            await cl.execute(parsed)

    asyncio.run(execute())
