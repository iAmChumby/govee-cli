"""Segment calibration routes — the paint studio's honesty mechanism.

WEBUI_V3_SPEC.md §5.3: the studio's default segment-boundary algorithm
(equal-ish contiguous LED runs in raster order) is a defensible hypothesis
about how firmware interpolates 15 API segments onto a physical matrix — not
a verified fact, because that interpolation is undocumented. Until a human
runs the calibration wizard against the lit hardware and confirms what they
actually see, the studio must show an "approximate mapping" banner rather
than silently trust the guess.

This module is pure persistence: GET/PUT round-tripping
``DeviceConfig.segment_calibration`` (`govee_cli/config.py`). It has no
opinion on how the boundaries/permutation were derived — the wizard flow
that produces them is entirely client-side; this just remembers the result.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter

from govee_cli.config import SegmentCalibration, save_config

from ..deps import get_config, resolve_ref, run_blocking
from ..errors import conflict
from ..schemas import SegmentCalibrationRequest

router = APIRouter()


def _calibration_body(calibration: SegmentCalibration | None) -> dict[str, Any]:
    if calibration is None:
        return {
            "calibrated": False,
            "boundaries": None,
            "permutation": None,
            "calibrated_at": None,
        }
    return {
        "calibrated": True,
        "boundaries": calibration.boundaries,
        "permutation": calibration.permutation,
        "calibrated_at": calibration.calibrated_at,
    }


@router.get("/devices/{ref}/segment-calibration")
async def get_segment_calibration(ref: str) -> dict[str, Any]:
    """Never 404s for "uncalibrated" — that's a normal, expected state.

    Only an unresolvable device reference is an error; a resolved device
    that has simply never been calibrated reports ``calibrated: false``.
    """
    cfg = await run_blocking(get_config)
    target = resolve_ref(cfg, ref)
    calibration = target.device_cfg.segment_calibration if target.device_cfg else None
    return _calibration_body(calibration)


def _require_registered(ref: str, cfg: Any) -> None:
    target = resolve_ref(cfg, ref)
    if target.device_cfg is None:
        raise conflict(
            f"Device '{ref}' is not registered. Run `govee-cli scan-http` "
            f"to add it before calibrating."
        )


@router.put("/devices/{ref}/segment-calibration", status_code=204)
async def put_segment_calibration(ref: str, body: SegmentCalibrationRequest) -> None:
    """Persist a completed calibration run. The timestamp is server-set.

    Requires a registered device: an ad-hoc BLE address resolves to a
    ``Target`` with no backing ``DeviceConfig`` to attach the calibration
    to, so it is rejected rather than silently discarded on the next config
    load. Checked once up front to fail fast, and again against a freshly
    reloaded config inside the write itself, mirroring ``groups.py``'s
    load-validate-then-reload-and-save pattern for the same file.
    """
    cfg = await run_blocking(get_config)
    _require_registered(ref, cfg)

    def save() -> None:
        fresh = get_config()
        _require_registered(ref, fresh)
        target = resolve_ref(fresh, ref)
        assert target.device_cfg is not None  # just verified by _require_registered
        target.device_cfg.segment_calibration = SegmentCalibration(
            boundaries=body.boundaries,
            permutation=body.permutation,
            calibrated_at=datetime.now(timezone.utc).isoformat(),
        )
        save_config(fresh)

    await run_blocking(save)
