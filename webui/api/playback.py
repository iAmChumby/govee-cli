"""Managed keyframe-effect playback: one active effect per device, start/stop/list.

Three engines share one bookkeeping structure:

* **BLE** reuses :func:`govee_cli.commands.effect._play`, the existing async
  engine, as an asyncio task.
* **Cloud** runs a stop-aware copy of the CLI's batching loop on a worker
  thread — the original ``_play_cloud`` is uncancellable by design (it targets
  Ctrl+C), so a managed variant checks a ``threading.Event`` per frame.
* **Mock** simulates frames against the fixture state so the UI can watch a
  playback actually move, with no hardware behind it.

Starting a new effect on a device stops its current one; finished or stopped
effects remove themselves from the registry.

Ledger integration (WEBUI_V3_SPEC.md §3.3/§3.5): starting playback always
records ``mode="effect"``. Ending it is where the two cases diverge — a
non-looping effect that reaches the end of its keyframes on its own is the one
case §3.5's table lets the ledger *guess* a resulting static colour (the last
frame it rendered); a user-initiated stop must leave ``mode="effect"`` exactly
as recorded, because nothing tells us what the light is actually showing once
a human interrupts it mid-animation. ``_finished`` (the task's done-callback)
is the only place that distinguishes the two: ``_stop_existing`` always pops
the entry out of ``_playing`` *before* cancelling the task, so by the time a
user-stopped task's callback runs, it is no longer the registered entry for
its device — "still current when the task ends" is a reliable proxy for
"ended on its own."
"""

from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

import anyio.to_thread
import structlog

from govee_cli import ledger
from govee_cli.commands.effect import CLOUD_MAX_FPS, _frames, last_frame_rgb
from govee_cli.http_v2 import GoveeV2Error, GoveeV2RateLimited

if TYPE_CHECKING:
    from .mock import MockV2

logger = structlog.get_logger(__name__)

# Mock playback ticks faster than real time so demos show motion without
# waiting on a 30fps clock; the recorded fps still reports the real value.
_MOCK_TICK_SECONDS = 0.05


class _PlaybackAborted(Exception):
    """Raised when a runner stops early (rate limit, transport error) instead
    of actually reaching the end of the effect. Distinguishes "task ended
    without the user stopping it" from "task ended *because it finished*" —
    only the latter is a natural finish per §3.5; the former must leave
    ``mode="effect"`` alone, since nobody knows what the device is actually
    showing after an aborted run."""


@dataclass
class PlayingEffect:
    """One active playback and everything /effects/playing reports about it."""

    ref: str
    device_id: str
    file: str
    fps: float
    transport: str  # "ble" or "cloud"
    started_at: str
    task: asyncio.Task[None] | None = None
    # Kept only so ``_finished`` can recompute the last frame's colour for the
    # natural-finish ledger downgrade (§3.5) — not exposed via ``record()``.
    effect: Any = None


class PlaybackManager:
    """Registry of running effect tasks, keyed by device id.

    A per-device asyncio lock serialises stop+register so two overlapping
    starts cannot both pass the "stop existing" phase and orphan a task.
    """

    def __init__(self) -> None:
        self._playing: dict[str, PlayingEffect] = {}
        self._lock = threading.Lock()
        self._stop_flags: dict[str, threading.Event] = {}
        self._mock_stops: dict[str, asyncio.Event] = {}
        self._device_locks: dict[str, asyncio.Lock] = {}

    def _device_lock(self, device_id: str) -> asyncio.Lock:
        key = device_id.upper()
        lock = self._device_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._device_locks[key] = lock
        return lock

    # ------------------------------------------------------------------ queries

    def get(self, device_id: str) -> PlayingEffect | None:
        with self._lock:
            return self._playing.get(device_id.upper())

    def list_playing(self) -> list[dict[str, Any]]:
        with self._lock:
            entries = list(self._playing.values())
        return [self.record(e) for e in sorted(entries, key=lambda e: e.started_at)]

    @staticmethod
    def record(entry: PlayingEffect) -> dict[str, Any]:
        return {
            "device": entry.ref,
            "file": entry.file,
            "fps": entry.fps,
            "transport": entry.transport,
            "started_at": entry.started_at,
        }

    # ------------------------------------------------------------------ control

    async def start_ble(self, target_ref: str, device_id: str, effect: Any,
                        mac: str, adapter: str, timeout: float,
                        fps: float) -> PlayingEffect:
        """Play over BLE using the CLI's async engine, as a cancellable task."""
        from govee_cli.commands.effect import _play

        async with self._device_lock(device_id):
            await self._stop_existing(device_id)
            entry = PlayingEffect(
                ref=target_ref, device_id=device_id.upper(), file=str(effect.name),
                fps=fps, transport="ble",
                started_at=datetime.now().isoformat(timespec="seconds"),
                effect=effect,
            )
            entry.task = asyncio.create_task(
                _play(effect, mac, adapter, timeout), name=f"effect-ble-{device_id}"
            )
            entry.task.add_done_callback(lambda _t: self._finished(entry))
            self._register(entry)
            self._record_start(entry)
        return entry

    async def start_cloud(self, target_ref: str, device_id: str, effect: Any,
                          client: Any, sku: str, fps: float) -> PlayingEffect:
        """Play over the cloud on a worker thread with a cooperative stop flag."""
        async with self._device_lock(device_id):
            await self._stop_existing(device_id)
            entry = PlayingEffect(
                ref=target_ref, device_id=device_id.upper(), file=str(effect.name),
                fps=fps, transport="cloud",
                started_at=datetime.now().isoformat(timespec="seconds"),
                effect=effect,
            )
            stop = threading.Event()
            entry.task = asyncio.create_task(
                self._cloud_runner(client, sku, device_id, effect, stop),
                name=f"effect-cloud-{device_id}",
            )
            entry.task.add_done_callback(lambda _t: self._finished(entry))
            # The stop flag rides on the task object via a closure-free side table so
            # stop() can reach it without changing the record shape.
            self._stop_flags[entry.device_id] = stop
            self._register(entry)
            self._record_start(entry)
        return entry

    async def start_mock(self, target_ref: str, device_id: str, effect: Any,
                         mock_client: "MockV2", fps: float,
                         transport_label: str) -> PlayingEffect:
        """Simulate playback: tick frames against fixture state, no hardware."""
        async with self._device_lock(device_id):
            await self._stop_existing(device_id)
            entry = PlayingEffect(
                ref=target_ref, device_id=device_id.upper(), file=str(effect.name),
                fps=fps, transport=transport_label,
                started_at=datetime.now().isoformat(timespec="seconds"),
                effect=effect,
            )
            stop = asyncio.Event()
            entry.task = asyncio.create_task(
                self._mock_runner(mock_client, device_id, effect, stop),
                name=f"effect-mock-{device_id}",
            )
            entry.task.add_done_callback(lambda _t: self._finished(entry))
            self._mock_stops[entry.device_id] = stop
            self._register(entry)
            self._record_start(entry)
        return entry

    async def stop(self, device_id: str) -> PlayingEffect | None:
        """Stop one device's playback. Returns the stopped entry, or None."""
        entry = await self._stop_existing(device_id)
        if entry is not None:
            logger.info("effect_stopped", device=entry.device_id, file=entry.file)
        return entry

    async def stop_all(self) -> None:
        """Stop every active playback. Used at app shutdown."""
        with self._lock:
            keys = list(self._playing)
        for key in keys:
            await self.stop(key)

    # ------------------------------------------------------------------ internals

    def _register(self, entry: PlayingEffect) -> None:
        with self._lock:
            self._playing[entry.device_id] = entry

    @staticmethod
    def _record_start(entry: PlayingEffect) -> None:
        """§3.3: playback start always records ``mode="effect"``."""
        ledger.record_mode(
            entry.device_id, "effect", entry.file,
            {"effect_file": entry.file, "transport": entry.transport},
            source="webui",
        )

    async def _stop_existing(self, device_id: str) -> PlayingEffect | None:
        key = device_id.upper()
        with self._lock:
            entry = self._playing.pop(key, None)
        if entry is None:
            return None
        stop_flag = self._stop_flags.pop(key, None)
        if stop_flag is not None:
            stop_flag.set()
        mock_stop = self._mock_stops.pop(key, None)
        if mock_stop is not None:
            mock_stop.set()
        if entry.task is not None and not entry.task.done():
            entry.task.cancel()
            try:
                await entry.task
            except asyncio.CancelledError:
                pass
            except Exception:
                # A playback that dies as it is stopped reports to nobody.
                pass
        return entry

    def _finished(self, entry: PlayingEffect) -> None:
        """Remove the entry when its task ends on its own (effect ran to completion).

        ``current is entry`` is true only when nothing has already popped this
        entry out of ``_playing`` — i.e. a user-initiated ``stop()`` never
        reaches here (see the module docstring), so this branch *narrows* to
        §3.5's "natural finish" row only when the task also ended without
        error — a runner that aborted mid-effect (BLE disconnect, cloud rate
        limit/API error — see ``_PlaybackAborted``) is not "the effect
        finished," and recording the last keyframe's colour for it would
        assert the device reached a state it may never have shown. A looping
        effect never takes the natural-finish path at all — its runner only
        exits via cancellation.
        """
        with self._lock:
            current = self._playing.get(entry.device_id)
            if current is entry:
                del self._playing[entry.device_id]
        if current is entry:
            error = self._task_error(entry.task)
            if error is None:
                self._record_natural_finish(entry)
            else:
                logger.warning(
                    "effect_ended_without_ledger_downgrade",
                    device=entry.device_id, file=entry.file, error=str(error),
                )
        self._stop_flags.pop(entry.device_id, None)
        self._mock_stops.pop(entry.device_id, None)

    @staticmethod
    def _task_error(task: "asyncio.Task[None] | None") -> BaseException | None:
        """The task's exception, if it ended with one — retrieving it here
        also prevents asyncio's "Task exception was never retrieved" warning
        for runs nobody else awaits (e.g. a BLE disconnect mid-effect)."""
        if task is None or task.cancelled():
            return None
        return task.exception()

    @staticmethod
    def _record_natural_finish(entry: PlayingEffect) -> None:
        rgb = _last_frame_rgb(entry.effect) if entry.effect is not None else None
        if rgb is None:
            # No frames to derive a colour from (shouldn't happen for a
            # playback that actually started) — leave mode=effect rather
            # than record a fabricated colour.
            return
        ledger.record_mode(
            entry.device_id, "basic", None, {"color_rgb": rgb}, source="webui"
        )

    async def _cloud_runner(self, client: Any, sku: str, device_id: str,
                            effect: Any, stop: threading.Event) -> None:
        await anyio.to_thread.run_sync(
            self._play_cloud_blocking, client, sku, device_id, effect, stop
        )

    def _play_cloud_blocking(self, client: Any, sku: str, device_id: str,
                             effect: Any, stop: threading.Event) -> None:
        """The CLI's cloud loop (batch segments by colour, skip unchanged ones)
        with a per-frame stop check so the API can halt it mid-animation."""
        frame_ms = 1000.0 / max(effect.fps, 0.01)
        last_sent: dict[int, tuple[int, int, int]] = {}
        requests_sent = 0
        playing = True
        while playing and not stop.is_set():
            for _t, colors in _frames(effect):
                if stop.is_set():
                    return
                frame_start = time.monotonic()
                changed = {
                    seg: rgb for seg, rgb in colors.items() if last_sent.get(seg) != rgb
                }
                by_color: dict[tuple[int, int, int], list[int]] = {}
                for seg, rgb in changed.items():
                    by_color.setdefault(rgb, []).append(seg)
                try:
                    for (r, g, b), segs in by_color.items():
                        client.set_segment_color(sku, device_id, sorted(segs), r, g, b)
                        requests_sent += 1
                except GoveeV2RateLimited as e:
                    logger.warning("effect_rate_limited", device=device_id,
                                   requests=requests_sent)
                    raise _PlaybackAborted("rate limited") from e
                except GoveeV2Error as e:
                    logger.error("effect_cloud_error", device=device_id, error=str(e))
                    raise _PlaybackAborted(str(e)) from e
                last_sent.update(changed)
                sleep_ms = frame_ms - (time.monotonic() - frame_start) * 1000
                if sleep_ms > 0:
                    # Event.wait wakes early on stop, so halting is responsive.
                    stop.wait(sleep_ms / 1000)
            playing = bool(effect.loop)
        logger.info("effect_finished", device=device_id, requests=requests_sent)

    async def _mock_runner(self, mock_client: "MockV2", device_id: str,
                           effect: Any, stop: asyncio.Event) -> None:
        """Drive fixture state through the effect's frames so previews animate."""
        while not stop.is_set():
            for _t, colors in _frames(effect):
                if stop.is_set():
                    return
                rgb = next(iter(colors.values()), None)
                if rgb is not None:
                    mock_client.apply_frame(device_id, *rgb)
                try:
                    await asyncio.wait_for(stop.wait(), timeout=_MOCK_TICK_SECONDS)
                    return  # stop set during wait
                except asyncio.TimeoutError:
                    pass
            if not effect.loop:
                return


def _last_frame_rgb(effect: Any) -> list[int] | None:
    """Delegates to the CLI's helper so both playback paths agree exactly."""
    return last_frame_rgb(effect)


def cap_fps_for_cloud(requested: float) -> float:
    """Clamp to the cloud throughput ceiling, mirroring the CLI's behaviour."""
    return min(requested, CLOUD_MAX_FPS)
