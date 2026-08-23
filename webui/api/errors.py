"""Error types and handlers mapping library failures to the spec's status codes.

The contract (WEBUI_SPEC.md §4) is: 400 bad input, 404 unknown ref, 409 device
rejected / unsupported feature, 502 cloud unreachable or rate-limited, with body
``{"error": {"code", "message"}}``. Library exception messages are surfaced
verbatim so the API says exactly what the CLI would have said.
"""

from __future__ import annotations

from typing import Any

import click
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from govee_cli.exceptions import GoveeError
from govee_cli.http import GoveeHTTPError
from govee_cli.http_v2 import GoveeV2Error, GoveeV2RateLimited

BAD_REQUEST = 400
NOT_FOUND = 404
CONFLICT = 409
BAD_GATEWAY = 502


class ApiError(Exception):
    """An error with a definite HTTP status, code and user-facing message."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def bad_request(message: str) -> ApiError:
    return ApiError(BAD_REQUEST, "bad_request", message)


def not_found(message: str) -> ApiError:
    return ApiError(NOT_FOUND, "not_found", message)


def conflict(message: str) -> ApiError:
    return ApiError(CONFLICT, "conflict", message)


def bad_gateway(message: str) -> ApiError:
    return ApiError(BAD_GATEWAY, "bad_gateway", message)


def _error_body(code: str, message: str) -> dict[str, Any]:
    return {"error": {"code": code, "message": message}}


def _error_response(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=_error_body(code, message))


def _map_v2_error(exc: GoveeV2Error) -> ApiError:
    """Split v2 failures into 'cloud unreachable' (502) vs 'device said no' (409).

    The client raises one exception type for both transport-level failure (the
    "Govee cloud unreachable after N attempts" path) and application-level
    rejection ("Govee API error 400: ..."), so the prefix is the discriminator.
    """
    if isinstance(exc, GoveeV2RateLimited):
        return bad_gateway(str(exc))
    if str(exc).startswith("Govee cloud unreachable"):
        return bad_gateway(str(exc))
    return conflict(str(exc))


def _map_v1_error(exc: GoveeHTTPError) -> ApiError:
    """Same split for the legacy client: "Control failed:" means the device answered."""
    if str(exc).startswith("Control failed:"):
        return conflict(str(exc))
    return bad_gateway(str(exc))


def install_error_handlers(app: FastAPI) -> None:
    """Register the handlers. Called once from the app factory."""

    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def handle_validation(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # Pydantic's default is 422; the spec pins bad input at 400.
        details = "; ".join(
            f"{'.'.join(str(loc) for loc in err.get('loc', ['?'])[1:])}: {err.get('msg', '')}"
            for err in exc.errors()
        )
        return _error_response(BAD_REQUEST, "bad_request", details or "Invalid request body.")

    @app.exception_handler(click.ClickException)
    async def handle_click(request: Request, exc: click.ClickException) -> JSONResponse:
        # Library helpers (parse_hex, parse_segments, ...) raise ClickException for
        # caller mistakes, which is bad input unless a call site already converted
        # it to something more specific.
        return _error_response(BAD_REQUEST, "bad_request", exc.format_message())

    @app.exception_handler(GoveeV2Error)
    async def handle_v2(request: Request, exc: GoveeV2Error) -> JSONResponse:
        mapped = _map_v2_error(exc)
        return _error_response(mapped.status, mapped.code, mapped.message)

    @app.exception_handler(GoveeHTTPError)
    async def handle_v1(request: Request, exc: GoveeHTTPError) -> JSONResponse:
        mapped = _map_v1_error(exc)
        return _error_response(mapped.status, mapped.code, mapped.message)

    @app.exception_handler(GoveeError)
    async def handle_govee(request: Request, exc: GoveeError) -> JSONResponse:
        # BLE-layer failures (connection, timeout, protocol): the device could not
        # be reached or obeyed, which lands on 502 like the other transport errors.
        return _error_response(BAD_GATEWAY, "bad_gateway", str(exc))
