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

from .deps import Settings, TTLCache
from .errors import install_error_handlers
from .mock import MockV2
from .mock import install as install_mock
from .playback import PlaybackManager
from .routers import config, devices, effects, groups, scenes, schedules
from .scheduler_runner import SchedulerRunner

logger = structlog.get_logger(__name__)


def _version() -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version("govee-cli")
    except PackageNotFoundError:
        return "0.0.0.dev0"


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
    ):
        app.include_router(router, prefix="/api/v1")

    install_error_handlers(app)

    @app.get("/api/v1/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "version": _version(),
            "mock": resolved.mock,
            "scheduler": app.state.scheduler_runner is not None,
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
