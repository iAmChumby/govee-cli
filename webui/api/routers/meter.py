"""The request meter route — measured Govee traffic counts, nothing invented.

WEBUI_V3_SPEC.md §10.2: the console must never render a percentage against a
rate limit we made up, because Govee v2 publishes none. This route is a thin
read of ``request_meter.snapshot()`` plus the one *opt-in* number config can
supply (``request_budget_per_day``) — when the user hasn't set one,
``budget_per_day`` comes back ``null`` and the client shows counts with no band.

No task in WEBUI_V3_SPEC.md's work breakdown wires this router into
``webui/api/main.py`` — T24 owns that ``include_router`` call, and T21's own
"Files:" line doesn't list ``main.py``. Per the hard "touch only your owned
files" rule, ``tests/test_meter_api.py`` mounts this router into a standalone
app rather than going through ``webui.api.main.create_app()`` (same pattern
``tests/test_calibration.py`` uses for ``calibration.router``, which has the
same problem).
"""

from __future__ import annotations

from typing import Any, cast

from fastapi import APIRouter

from govee_cli import request_meter
from govee_cli.config import load_config

from ..deps import run_blocking

router = APIRouter()


def _snapshot_out() -> dict[str, Any]:
    """Build the response off the event loop: ``snapshot()`` flushes the
    buffer and reads the meter file, both blocking I/O, and ``load_config()``
    is another disk read for ``budget_per_day`` — neither belongs on the loop.

    Reading the meter is itself never metered: this function makes zero
    Govee API calls, so nothing here can call ``request_meter.record()``.
    """
    snap = request_meter.snapshot()
    cfg = load_config()
    return {
        "day": snap.day,
        "v2_today": snap.v2_today,
        "v1_today": snap.v1_today,
        "rate_limited_today": snap.rate_limited_today,
        "errors_today": snap.errors_today,
        "v2_last_minute": snap.v2_last_minute,
        "v2_last_hour": snap.v2_last_hour,
        "minutes": [[minute, count] for minute, count in snap.minutes],
        "budget_per_day": cfg.request_budget_per_day,
    }


@router.get("/meter")
async def get_meter() -> dict[str, Any]:
    """Measured request counts for today/minute/hour, plus the user's opt-in
    daily budget (``null`` when unset). Cheap enough to poll every 15s: no
    lock beyond ``snapshot()``'s own, and no upstream Govee call at all."""
    return cast("dict[str, Any]", await run_blocking(_snapshot_out))
