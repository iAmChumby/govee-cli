"""Group routes: CRUD plus per-member state and broadcast commands.

``POST /groups/{name}/run`` reuses the CLI's ``_apply_v2_command`` /
``_apply_http_command`` verbatim, so the accepted verbs and their semantics are
exactly ``govee-cli group run``'s — one implementation, two frontends.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

from fastapi import APIRouter, Request

from govee_cli.commands.group import _apply_http_command, _apply_v2_command
from govee_cli.config import GoveeConfig, load_config, save_config
from govee_cli.http import GoveeHTTP
from govee_cli.transport import CLOUD_V1, CLOUD_V2

from ..deps import (
    Resolved,
    get_client,
    invalidate_state,
    normalize_state,
    read_state,
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
            devices.append(normalize_state(target, raw))
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
            # pre-command value for the TTL window.
            invalidate_state(request, target)
            results.append({"ref": target.label, "id": target.device_id, "ok": True})
        except Exception as e:
            message = str(getattr(e, "message", e)) or e.__class__.__name__
            results.append({"ref": ref, "id": ref, "ok": False, "error": message})

    ok_all = all(r["ok"] for r in results)
    return {"group": name, "command": body.command, "ok": ok_all, "results": results}


async def _apply_to_member(request: Request, target: Resolved, cmd: str) -> None:
    if target.transport == CLOUD_V2:
        client = get_client(request)
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
