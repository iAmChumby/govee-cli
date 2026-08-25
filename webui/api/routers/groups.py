"""Group routes: CRUD plus per-member state and broadcast commands.

``POST /groups/{name}/run`` reuses the CLI's ``_apply_v2_command`` /
``_apply_http_command`` verbatim, so the accepted verbs and their semantics are
exactly ``govee-cli group run``'s — one implementation, two frontends.

Ledger writes (WEBUI_V3_SPEC.md §3.3): a broadcast records one entry per member
it actually reached, with ``source="group"`` — a member that raised (offline,
rejected the verb) gets no ledger write, matching every other command path's
rule that the ledger only ever records what genuinely happened. The
verb-to-mode mapping mirrors ``devices.py``'s ``_record_ledger_mode`` exactly
(basic power/color/temp only; brightness-only never changes ``mode``, per
§3.5) — it is duplicated rather than imported because it needs a different
``source``, and ``devices.py`` belongs to another task.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

from fastapi import APIRouter, Request

from govee_cli import ledger
from govee_cli.commands.group import _apply_http_command, _apply_v2_command
from govee_cli.config import GoveeConfig, load_config, save_config
from govee_cli.http import GoveeHTTP
from govee_cli.transport import CLOUD_V1, CLOUD_V2

from ..deps import (
    Resolved,
    apply_echo,
    get_client_async,
    invalidate_state,
    normalize_state,
    overlay_active_mode,
    read_state,
    record_write,
    resolve_ref,
    run_blocking,
)
from ..errors import not_found
from ..schemas import GroupCreateRequest, GroupRunRequest

router = APIRouter()


async def _load_cfg() -> GoveeConfig:
    return cast(GoveeConfig, await run_blocking(load_config))


@router.get("/groups")
async def list_groups() -> dict[str, Any]:
    cfg = await _load_cfg()
    return {"groups": cfg.groups}


@router.post("/groups")
async def create_group(body: GroupCreateRequest) -> dict[str, Any]:
    """Create a group or replace an existing one with the given membership."""
    cfg = await _load_cfg()
    macs: list[str] = []
    for ref in body.devices:
        target = resolve_ref(cfg, ref)
        if target.device_id not in macs:
            macs.append(target.device_id)

    def save() -> None:
        fresh = load_config()
        fresh.groups[body.name] = macs
        save_config(fresh)

    await run_blocking(save)
    return {"name": body.name, "devices": macs}


@router.delete("/groups/{name}")
async def delete_group(name: str) -> dict[str, Any]:
    cfg = await _load_cfg()
    if name not in cfg.groups:
        raise not_found(f"Group '{name}' not found.")

    def save() -> None:
        fresh = load_config()
        del fresh.groups[name]
        save_config(fresh)

    await run_blocking(save)
    return {"deleted": name}


@router.get("/groups/{name}/state")
async def group_state(request: Request, name: str) -> dict[str, Any]:
    """Per-member normalised states; member failures land in errors[]."""
    cfg = await _load_cfg()
    refs = cfg.groups.get(name)
    if refs is None:
        raise not_found(f"Group '{name}' not found.")

    devices: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for ref in refs:
        try:
            target = resolve_ref(cfg, ref)
            raw = await read_state(request, target)
            # Same read pipeline the single-device route uses, overlay included:
            # a group view that omitted active mode would show a member running
            # a scene as plain warm white, which is the exact mismatch the
            # ledger exists to close.
            state = apply_echo(request, target, normalize_state(target, raw))
            devices.append(overlay_active_mode(target, state))
        except Exception as e:
            message = str(getattr(e, "message", e)) or e.__class__.__name__
            errors.append({"ref": ref, "message": message})
    return {"group": name, "devices": devices, "errors": errors}


@router.post("/groups/{name}/run")
async def run_group_command(request: Request, name: str,
                            body: GroupRunRequest) -> dict[str, Any]:
    """Broadcast one CLI-style command string to every member."""
    cfg = await _load_cfg()
    refs = cfg.groups.get(name)
    if refs is None:
        raise not_found(f"Group '{name}' not found.")

    results: list[dict[str, Any]] = []
    for ref in refs:
        try:
            target = resolve_ref(cfg, ref)
            await _apply_to_member(request, target, body.command)
            # Members' cached state must drop, or the next read reports the
            # pre-command value for the TTL window. The echo overlay keeps the
            # commanded values visible until the cloud's lagging reads catch up.
            record_write(request, target, _echo_fields_for(body.command))
            _record_ledger_mode_for_group(target, body.command)
            invalidate_state(request, target)
            results.append({"ref": target.label, "id": target.device_id, "ok": True})
        except Exception as e:
            message = str(getattr(e, "message", e)) or e.__class__.__name__
            results.append({"ref": ref, "id": ref, "ok": False, "error": message})

    ok_all = all(r["ok"] for r in results)
    return {"group": name, "command": body.command, "ok": ok_all, "results": results}


def _echo_fields_for(cmd: str) -> dict[str, Any]:
    """Normalised-state overlay for a CLI-style command string ("power on")."""
    from .devices import _echo_fields

    parts = cmd.split(None, 1)
    if len(parts) != 2:
        return {}
    return _echo_fields(parts[0], parts[1].strip())


def _record_ledger_mode_for_group(target: Resolved, cmd: str) -> None:
    """Same verb-to-mode mapping as ``devices.py``'s ``_record_ledger_mode``
    (§3.3), for one member of a broadcast — called only after that member's
    command has already succeeded, so every write here reflects something
    that genuinely happened. ``source="group"`` is the one difference from
    the single-device path, so the console can tell "I pressed this on one
    device" from "this ran because of a group broadcast" (§3.1's `source`
    field).
    """
    parts = cmd.split(None, 1)
    if len(parts) != 2:
        return
    verb, arg = parts[0].lower(), parts[1].strip()

    if verb == "power":
        if arg == "on":
            ledger.record_mode(target.device_id, "basic", None, None, source="group")
        else:
            ledger.record_mode(target.device_id, "off", None, None, source="group")
    elif verb == "color":
        digits = arg.upper().lstrip("#")
        rgb = [int(digits[i:i + 2], 16) for i in (0, 2, 4)]
        ledger.record_mode(
            target.device_id, "basic", None, {"color_rgb": rgb}, source="group"
        )
    elif verb == "temp":
        ledger.record_mode(
            target.device_id, "basic", None, {"color_temp_k": int(arg)}, source="group"
        )
    # brightness (and every non-basic verb: scene/diy/music/segments/toggle):
    # intentionally no ledger write. Brightness-only is a live modifier
    # compatible with a running scene (§3.5), same as the single-device path;
    # the other verbs fall outside devices.py's mapping, which is the one
    # this task mirrors.


async def _apply_to_member(request: Request, target: Resolved, cmd: str) -> None:
    if target.transport == CLOUD_V2:
        client = await get_client_async(request)
        await run_blocking(_apply_v2_command, client, target.device_id, target.sku, cmd)
    elif target.transport == CLOUD_V1:
        await run_blocking(_apply_v1, target, cmd)
    else:
        await run_blocking(_apply_ble, target, cmd)


def _apply_v1(target: Resolved, cmd: str) -> None:
    _apply_http_command(GoveeHTTP(), target.device_id, target.sku, cmd)


def _apply_ble(target: Resolved, cmd: str) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.commands._common import Target
    from govee_cli.commands.group import _parse_inline_command

    parsed = _parse_inline_command(cmd, device_model=target.model)
    if parsed is None:
        raise ValueError(f"Unknown command: {cmd}")
    ble_target = Target(target.device_id, target.model, target.transport, target.config)
    adapter = target.config.default_adapter or "hci0"

    async def execute() -> None:
        async with GoveeBLE(ble_target.ble_mac, adapter=adapter) as client:
            await client.execute(parsed)

    asyncio.run(execute())
