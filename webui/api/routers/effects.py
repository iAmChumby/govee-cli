"""Effect routes: library listing plus managed playback lifecycle.

Transport choice mirrors the CLI's ``effect`` command: BLE when the model prefers
it (full frame rate beats the cloud's 2fps budget ceiling), unless overridden by
``force``. In mock mode nothing touches hardware — frames tick against fixture
state so the UI can watch a playback move.
"""

from __future__ import annotations

import json
import re
from typing import Any, cast

from fastapi import APIRouter, Request

from govee_cli.commands._common import Target
from govee_cli.commands.effect import CLOUD_DEFAULT_FPS, CLOUD_MAX_FPS
from govee_cli.scenes.effects import SCENES_DIR, Effect
from govee_cli.transport import BLE

from ..deps import get_client_async, get_config, resolve_ref, run_blocking
from ..errors import ApiError, bad_request, not_found
from ..schemas import EffectCreateRequest, EffectPlayRequest

router = APIRouter()

# Semantic validation failures on POST /effects (a body Effect.from_dict or the
# segment-bounds check rejects) land here rather than at bad_request's 400 —
# distinguishing "malformed request envelope" from "well-formed effect this
# device can't actually play", while keeping the same {"error": {code,
# message}} body shape every other endpoint in this API uses.
_UNPROCESSABLE = 422


def _unprocessable(message: str) -> ApiError:
    return ApiError(_UNPROCESSABLE, "unprocessable_entity", message)


def _effect_metadata(file_stem: str, effect: Effect) -> dict[str, Any]:
    return {
        "file": file_stem,
        "name": effect.name,
        "fps": effect.fps,
        "loop": effect.loop,
        "segments": len(effect.segments),
        "segment_ids": sorted(seg.id for seg in effect.segments),
    }


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
            out.append(_effect_metadata(path.stem, effect))
        return out

    effects = await run_blocking(scan)
    return {"effects": effects}


_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "effect"


def _unique_slug(base: str) -> str:
    """``base``, or ``base-2``/``base-3``/... if that filename is already taken."""
    if not (SCENES_DIR / f"{base}.json").exists():
        return base
    n = 2
    while (SCENES_DIR / f"{base}-{n}.json").exists():
        n += 1
    return f"{base}-{n}"


@router.post("/effects")
async def create_effect(body: EffectCreateRequest) -> dict[str, Any]:
    """Save a studio-authored effect as a real, playable ``scenes/*.json`` file.

    Validated exactly the way the CLI validates an effect file: through
    ``Effect.from_dict`` itself, not a parallel or looser re-implementation
    — a body ``Effect.from_dict`` would reject is precisely a body
    ``govee-cli effect <file>`` would refuse to play, so the two paths must
    never diverge. Segment-bounds checking (against whichever transport this
    effect targets) reuses ``play_effect``'s own ``_check_segment_bounds``
    for the same reason.
    """
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, body.device)

    raw = {
        "name": body.name,
        "segments": body.segments,
        "loop": body.loop,
        "fps": body.fps,
    }
    try:
        effect = Effect.from_dict(raw)
    except Exception as e:
        raise _unprocessable(f"Invalid effect: {e}") from e
    if not any(seg.keyframes for seg in effect.segments):
        raise _unprocessable("Effect has no keyframes.")

    use_ble = _use_ble(target, body.force)
    try:
        _check_segment_bounds(target, effect, use_ble)
    except ApiError as e:
        # _check_segment_bounds raises bad_request (400) for play_effect's
        # sake; here the same failure is a 422 (well-formed effect, rejected
        # on its merits) rather than a malformed request.
        raise _unprocessable(e.message) from e

    def write() -> str:
        SCENES_DIR.mkdir(parents=True, exist_ok=True)
        slug = _unique_slug(_slugify(effect.name))
        with open(SCENES_DIR / f"{slug}.json", "w") as f:
            json.dump(raw, f, indent=2)
        return slug

    slug = await run_blocking(write)
    return _effect_metadata(slug, effect)


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


@router.get("/effects/{file}")
async def get_effect(file: str) -> dict[str, Any]:
    """The full keyframe body of one effect file.

    ``GET /effects`` above is metadata-only (name/fps/loop/segment count) —
    this is genuinely new capability: the raw JSON exactly as saved, segments
    and keyframes included, which the paint studio needs to re-load a saved
    effect back onto the canvas for editing. Declared after ``/effects/play``
    and ``/effects/playing`` so this path parameter can never shadow them.
    """

    def load() -> dict[str, Any] | None:
        for path in sorted(SCENES_DIR.glob("*.json")):
            if path.stem.lower() == file.lower():
                with open(path) as f:
                    return cast("dict[str, Any]", json.load(f))
        return None

    data = cast("dict[str, Any] | None", await run_blocking(load))
    if data is None:
        available = ", ".join(p.stem for p in SCENES_DIR.glob("*.json")) or "(none)"
        raise not_found(f"Unknown effect '{file}'. Available: {available}")
    return data


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
