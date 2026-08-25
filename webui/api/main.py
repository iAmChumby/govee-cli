"""FastAPI application factory for the govee-cli sidecar.

The sidecar is the only bridge between the web console and the library: it
serves the spec's REST surface on 127.0.0.1 (never exposed directly), embeds
the schedule engine so the web stack can run without a second daemon, and
degrades into a fully simulated fixture service under ``GOVEE_WEBUI_MOCK=1``.

Routers are mounted under ``/api/v1`` so the same paths work whether a client
arrives through the Next.js rewrite, nginx, or straight at this port.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import FastAPI

from . import external_schedule
from .deps import Settings, TTLCache, WriteEcho, run_blocking
from .errors import install_error_handlers
from .mock import MockV2
from .mock import install as install_mock
from .playback import PlaybackManager
from .routers import (
    calibration,
    config,
    devices,
    effects,
    groups,
    meter,
    rooms,
    scenes,
    schedules,
)
from .scheduler_runner import SchedulerRunner

logger = structlog.get_logger(__name__)


def _version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("govee-cli")
    except PackageNotFoundError:
        return "0.0.0.dev0"


async def _scheduler_health(app: FastAPI) -> dict[str, Any]:
    """Both halves of the schedule story, for the console's health readout.

    ``native`` is this process's embedded runner. ``external`` summarises the
    automation the runner knows nothing about — a crontab line firing
    ``wake-ramp`` reaches the same bulbs, and a console that reported only the
    native half was the reason the Schedules page could honestly say "0 rules"
    while a light came on every weekday morning.

    Crontab discovery shells out, so it runs off the event loop. It is also
    allowed to fail without taking health down: an unreadable crontab is
    reported as ``crontab_readable: false``, never silently as "nothing
    scheduled" — the distinction is the whole point (§6.6).

    Mock mode reports an empty external half rather than probing. ``install_mock``
    redirects the library's on-disk paths, but the crontab is the *machine's*,
    not the library's — probing it would leak the real host's automation into a
    run whose entire promise is that nothing it shows is real.
    """
    runner: SchedulerRunner | None = app.state.scheduler_runner
    native: dict[str, Any] = (
        runner.snapshot() if runner is not None
        else {"alive": False, "poll_seconds": None, "last_cycle_at": None, "last_fire": None}
    )

    if app.state.settings.mock:
        return {
            "native": native,
            "external": {
                "crontab_readable": False,
                "error": "mock mode — the host crontab is not read",
                "wake_ramp_armed": None,
                "entry_count": 0,
            },
        }

    try:
        payload = await run_blocking(external_schedule.build_external_schedule)
        entries = payload["entries"]
        wake_ramp = next((e for e in entries if e.get("kind") == "wake-ramp"), None)
        # Armed state lives at wake_ramp_status.armed_date — a date string when
        # armed, null when not. Distinguish "not armed" (False) from "the script
        # could not be read" (None): a weekend that will not fire and a weekend
        # whose state is unknown are not the same answer.
        status = wake_ramp.get("wake_ramp_status") if wake_ramp else None
        armed: bool | None = None
        if status is not None:
            armed = status.get("armed_date") is not None
        external: dict[str, Any] = {
            "crontab_readable": payload["crontab"]["readable"],
            "error": payload["crontab"]["error"],
            "wake_ramp_armed": armed,
            "entry_count": len(entries),
        }
    except Exception as e:  # never let a crontab hiccup fail the health probe
        logger.warning("health_external_schedule_failed", error=str(e))
        external = {
            "crontab_readable": False,
            "error": f"external schedule probe failed: {e}",
            "wake_ramp_armed": None,
            "entry_count": 0,
        }

    return {"native": native, "external": external}


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. ``settings=None`` reads the environment."""
    resolved = settings or Settings.from_env()
    if resolved.mock:
        # Before anything touches load_config()/list_rules(): patch every on-disk
        # path the library writes to a throwaway dir seeded with fixtures.
        install_mock()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runner: SchedulerRunner | None = app.state.scheduler_runner
        if runner is not None:
            runner.start()
        logger.info("sidecar_started", mock=app.state.settings.mock,
                    scheduler=bool(runner))
        yield
        if runner is not None:
            runner.stop()
        await app.state.playback.stop_all()

    app = FastAPI(
        title="govee-cli web console API",
        version=_version(),
        lifespan=lifespan,
        docs_url="/api/v1/docs",
        openapi_url="/api/v1/openapi.json",
    )

    app.state.settings = resolved
    app.state.state_cache = TTLCache()
    app.state.write_echo = WriteEcho()
    app.state.playback = PlaybackManager()
    app.state.mock_client = MockV2() if resolved.mock else None
    app.state.v2_client = None
    # The embedded scheduler never runs in mock mode: firing real commands while
    # someone believes they are watching fixtures would be a nasty surprise.
    app.state.scheduler_runner = (
        SchedulerRunner() if resolved.scheduler_enabled else None
    )

    for router in (
        devices.router, scenes.router, groups.router,
        schedules.router, config.router, effects.router,
        calibration.router, meter.router, rooms.router,
    ):
        app.include_router(router, prefix="/api/v1")

    install_error_handlers(app)

    @app.get("/api/v1/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": _version(),
            "mock": resolved.mock,
            "scheduler": await _scheduler_health(app),
        }

    return app


def main() -> None:
    """Run uvicorn bound to loopback only — nginx/Next own the public surface."""
    import os

    import uvicorn

    settings = Settings.from_env()
    app = create_app(settings)
    host = os.environ.get("GOVEE_WEBUI_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
