"""Device routes: discovery, info, state, and the four basic controls.

Basic control goes through ``_apply_v2_command`` / ``_apply_http_command`` — the
same functions ``group run`` uses — so an API command and a CLI command produce
byte-identical requests. Unregistered models fall back to the BLE path.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request

from govee_cli import ledger
from govee_cli.commands.group import _apply_http_command, _apply_v2_command
from govee_cli.config import GoveeConfig
from govee_cli.http import GoveeHTTP
from govee_cli.transport import CLOUD_V1, CLOUD_V2

from ..deps import (
    Resolved,
    apply_echo,
    get_client_async,
    get_config,
    invalidate_state,
    normalize_state,
    overlay_active_mode,
    read_state,
    record_write,
    resolve_ref,
    run_blocking,
)
from ..errors import bad_request
from ..schemas import (
    ActiveModeSetRequest,
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
            state = apply_echo(request, target, normalize_state(target, raw))
            state = overlay_active_mode(target, state)
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
            "active": state.get("active"),
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


@router.delete("/devices/{ref}/active-mode", status_code=204)
async def delete_active_mode(request: Request, ref: str) -> None:
    """The manual "that is not what I see" reset — clears the ledger entry.

    No replacement write happens: the next read reports mode=unknown (§3.6
    rule 5) rather than a guessed "basic", per the never-claim-what-you-don't-
    know rule the whole ledger is built on.
    """
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    await run_blocking(ledger.clear_mode, target.device_id)


@router.put("/devices/{ref}/active-mode")
async def set_active_mode(
    request: Request, ref: str, body: ActiveModeSetRequest
) -> dict[str, Any]:
    """Correct the ledger's record of what a device is doing — see §3.6/§10.2.

    Unlike every other write route in this file, this one sends **no** device
    command. The ledger can be wrong (stale after phone-app interference, or
    honestly "unknown" because nothing was ever recorded) and the fix for
    that is a bookkeeping correction, not a light command — a route that
    quietly commanded the device here would make the ledger lie in the other
    direction, which is the exact bug it exists to prevent. The state read
    below is only to build the merged response the caller asked for so it
    doesn't need a second round trip; it is not a verification step.
    """
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    raw = await read_state(request, target)
    state = apply_echo(request, target, normalize_state(target, raw))

    payload = body.payload
    if body.mode == "basic" and not payload:
        # Snapshot the colour the cloud currently reports, so this correction
        # can later be *dis*proved.
        #
        # `_basic_confidence` reads an empty payload as "nothing to diverge
        # from, confirmed by default", which is right for a bare power-on we
        # issued ourselves — we set nothing else, so there is nothing to check.
        # It is wrong for a correction, where the claim is the user's, not
        # ours: with no payload the entry would read "confirmed" forever and
        # could never notice the light being changed from the Govee app
        # afterwards. Recording the live colour means it still reads
        # "confirmed" now and flips to "external" the moment reality moves,
        # which is the whole point of computing confidence at read time.
        #
        # Colour and temp are mutually exclusive on these models, and the
        # cloud reports both honestly, so whichever one is live is the right
        # thing to store.
        live_rgb = (state.get("color") or {}).get("rgb")
        if live_rgb:
            payload = {"color_rgb": list(live_rgb)}
        elif state.get("color_temp_k"):
            payload = {"color_temp_k": state["color_temp_k"]}

    await run_blocking(
        ledger.record_mode, target.device_id, body.mode, body.label, payload, "webui"
    )
    return overlay_active_mode(target, state)


async def _device_state(request: Request, ref: str) -> dict[str, Any]:
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    raw = await read_state(request, target)
    state = apply_echo(request, target, normalize_state(target, raw))
    return overlay_active_mode(target, state)


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

    # The cloud's state read lags behind its write endpoint; remember what we
    # commanded so reads (including this one) report intent until it catches up.
    record_write(request, target, _echo_fields(verb, arg))
    # Same mode-selection rules as the CLI's power/color/temp/brightness
    # commands (§3.3) — a basic control always ends any running scene/DIY/
    # music the device might have been showing, except brightness alone,
    # which is a live modifier compatible with a running scene (§3.5).
    _record_ledger_mode(target, verb, arg)
    invalidate_state(request, target)
    raw = await read_state(request, target)
    state = apply_echo(request, target, normalize_state(target, raw))
    return overlay_active_mode(target, state)


def _record_ledger_mode(target: Resolved, verb: str, arg: str) -> None:
    if verb == "power":
        if arg == "on":
            ledger.record_mode(target.device_id, "basic", None, None, source="webui")
        else:
            ledger.record_mode(target.device_id, "off", None, None, source="webui")
    elif verb == "color":
        digits = arg.upper().lstrip("#")
        rgb = [int(digits[i:i + 2], 16) for i in (0, 2, 4)]
        ledger.record_mode(
            target.device_id, "basic", None, {"color_rgb": rgb}, source="webui"
        )
    elif verb == "temp":
        ledger.record_mode(
            target.device_id, "basic", None, {"color_temp_k": int(arg)}, source="webui"
        )
    # brightness: intentionally no ledger write — §3.5 treats a brightness-only
    # change as a live modifier compatible with a running scene, not a mode-
    # ending action.


def _echo_fields(verb: str, arg: str) -> dict[str, Any]:
    """Commanded state as a normalised-state overlay for :class:`WriteEcho`.

    colorRgb and colorTemperatureK are mutually exclusive on the hardware —
    setting one zeroes the other — so each command clears its counterpart.
    """
    if verb == "power":
        return {"power": arg == "on"}
    if verb == "brightness":
        return {"brightness": int(arg)}
    if verb == "color":
        digits = arg.upper().lstrip("#")
        hex_value = f"#{digits}"
        rgb = [int(digits[i:i + 2], 16) for i in (0, 2, 4)]
        return {"color": {"hex": hex_value, "rgb": rgb}, "color_temp_k": None}
    if verb == "temp":
        return {"color_temp_k": int(arg), "color": None}
    return {}


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
