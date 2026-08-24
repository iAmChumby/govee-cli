"""Effect routes: library listing plus managed playback lifecycle.

Transport choice mirrors the CLI's ``effect`` command: BLE when the model prefers
it (full frame rate beats the cloud's 2fps budget ceiling), unless overridden by
``force``. In mock mode nothing touches hardware — frames tick against fixture
state so the UI can watch a playback move.
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter, Request

from govee_cli.commands._common import Target
from govee_cli.commands.effect import CLOUD_DEFAULT_FPS, CLOUD_MAX_FPS
from govee_cli.scenes.effects import SCENES_DIR, Effect
from govee_cli.transport import BLE

from ..deps import get_client_async, get_config, resolve_ref, run_blocking
from ..errors import bad_request, not_found
from ..schemas import EffectPlayRequest

router = APIRouter()


@router.get("/effects")
async def list_effects() -> dict[str, Any]:
    """Parsed metadata for every effect file in the repo's scenes/ directory."""

    def scan() -> list[dict[str, Any]]:
        out = []
        for path in sorted(SCENES_DIR.glob("*.json")):
            try:
                effect = Effect.from_file(path)
            except Exception:
                # A corrupt hand-edited file must not blank the library list.
                continue
            out.append({
                "file": path.stem,
                "name": effect.name,
                "fps": effect.fps,
                "loop": effect.loop,
                "segments": len(effect.segments),
                "segment_ids": sorted(seg.id for seg in effect.segments),
            })
        return out

    effects = await run_blocking(scan)
    return {"effects": effects}


@router.post("/effects/play")
async def play_effect(request: Request, body: EffectPlayRequest) -> dict[str, Any]:
    """Start managed playback. Any current playback on the device is stopped."""
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, body.device)

    effect, file_stem = await _load_effect(body.file)
    if body.fps is not None:
        effect.fps = body.fps
    if not any(seg.keyframes for seg in effect.segments):
        raise bad_request("Effect has no keyframes.")

    use_ble = _use_ble(target, body.force)
    _check_segment_bounds(target, effect, use_ble)

    manager = request.app.state.playback
    note: str | None = None

    if request.app.state.settings.mock:
        # Simulated: report the transport that would be used, animate fixtures.
        entry = await manager.start_mock(
            target.label, target.device_id, effect, request.app.state.mock_client,
            effect.fps, "ble" if use_ble else "cloud",
        )
        return {**manager.record(entry), "note": None}

    if use_ble:
        ble_mac = Target(target.device_id, target.model, target.transport, cfg).ble_mac
        entry = await manager.start_ble(
            target.label, target.device_id, effect, ble_mac,
            cfg.default_adapter or "hci0", cfg.default_timeout, effect.fps,
        )
        return {**manager.record(entry), "note": None}

    requested = (
        body.fps if body.fps is not None
        else min(effect.fps, CLOUD_DEFAULT_FPS)
    )
    capped = min(requested, CLOUD_MAX_FPS)
    if requested > capped:
        note = (
            f"{requested}fps exceeds the cloud limit; capping to {capped}fps."
        )
    elif body.fps is None and effect.fps > CLOUD_DEFAULT_FPS:
        note = (
            f"This effect asks for {effect.fps}fps. Cloud playback runs at "
            f"{capped}fps to stay inside the daily request budget "
            f"(override with fps, max {CLOUD_MAX_FPS})."
        )
    effect.fps = capped

    client = await get_client_async(request)
    entry = await manager.start_cloud(
        target.label, target.device_id, effect, client, target.sku, effect.fps
    )
    return {**manager.record(entry), "note": note}


async def _load_effect(file_ref: str) -> tuple[Effect, str]:
    def load() -> tuple[Effect, str] | None:
        for path in sorted(SCENES_DIR.glob("*.json")):
            if path.stem.lower() == file_ref.lower():
                return Effect.from_file(path), path.stem
        return None

    loaded = cast('tuple[Effect, str] | None', await run_blocking(load))
    if loaded is None:
        available = ", ".join(p.stem for p in SCENES_DIR.glob("*.json")) or "(none)"
        raise not_found(f"Unknown effect '{file_ref}'. Available: {available}")
    return loaded


def _use_ble(target: Any, force: str | None) -> bool:
    if force == "ble":
        return True
    if force == "cloud":
        return False
    if target.transport == BLE:
        return True
    return bool(target.spec and target.spec.prefer_ble_effects)


def _check_segment_bounds(target: Any, effect: Effect, use_ble: bool) -> None:
    spec = target.spec
    if not spec:
        return
    segment_limit = spec.ble_segment_count if use_ble else spec.segment_count
    if segment_limit:
        bad = sorted({s.id for s in effect.segments if s.id >= segment_limit})
        if bad:
            raise bad_request(
                f"Effect uses segment(s) {bad}, but {spec.model} addresses "
                f"{segment_limit} (0-{segment_limit - 1}) over "
                f"{'BLE' if use_ble else 'the cloud'}."
            )


@router.get("/effects/playing")
async def list_playing(request: Request) -> list[dict[str, Any]]:
    return cast("list[dict[str, Any]]", request.app.state.playback.list_playing())


@router.delete("/effects/playing/{ref}")
async def stop_effect(request: Request, ref: str) -> dict[str, Any]:
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    entry = await request.app.state.playback.stop(target.device_id)
    if entry is None:
        raise not_found(f"'{ref}' is not playing an effect.")
    return {
        "stopped": {"device": entry.ref, "file": entry.file},
    }
