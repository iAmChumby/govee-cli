"""The one room-scene executor (issue #2), shared by the sidecar, the CLI and the scheduler.

SPINE — signatures and shapes fixed by the main agent; the body is built by the
room area, lifted out of ``webui/api/routers/rooms.py``. Synchronous on purpose:
``govee-cli daemon`` and ``govee-cli room apply`` are synchronous, and the
sidecar calls it through ``run_blocking`` and invalidates its own state caches
afterwards from the returned refs.

Rules it must keep (CLAUDE.md + grill G5/G6/G8):
- ``target.device_cfg is None`` -> that device is skipped with
  ``device not registered``; never resolved to an ad-hoc BLE address.
- Ledger is written only after ALL of a device's steps succeed; a ledger
  failure never fails the step. Any failed step clears that device's ledger
  entry and adds the note ``ledger cleared: partial apply``.
- A DIY step sends the stored ``diy_value`` only after verifying it in the
  device's DIY list (live or disk-cached); otherwise it errors without sending.
- Every request goes through ``GoveeHTTPv2._request`` (metered); no new hooks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from govee_cli.config import GoveeConfig
    from govee_cli.http import GoveeHTTP
    from govee_cli.http_v2 import GoveeHTTPv2
    from govee_cli.ledger import Source
    from govee_cli.room_scenes import RoomScene


@dataclass
class DeviceResult:
    ref: str  # the device's display label when registered, else its id
    device_id: str
    ok: bool  # True for a full success AND for a skipped device
    skipped_reason: str | None = None
    error: str | None = None
    # Human-readable extras: "DIY 'old' is now named 'new'",
    # "verified against list cached 13:40", "ledger cleared: partial apply".
    notes: list[str] = field(default_factory=list)


@dataclass
class SceneResult:
    name: str
    ok: bool  # every non-skipped device succeeded
    results: list[DeviceResult]


@dataclass
class RestoreClients:
    """Clients the executor may use. ``v1`` is built per call if None and needed."""

    v2: GoveeHTTPv2 | None
    v1: GoveeHTTP | None = None


def restore_scene(name: str, scene: RoomScene, *, cfg: GoveeConfig,
                  clients: RestoreClients, source: Source) -> SceneResult:
    """Replay ``scene`` one device at a time; one failure never aborts the rest."""
    raise NotImplementedError
