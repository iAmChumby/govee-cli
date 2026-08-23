"""FastAPI sidecar exposing the govee-cli library as the `/api/v1` REST surface.

Thin by design: routing knowledge stays in :mod:`govee_cli.transport`, command
semantics stay in the library, and this package only translates HTTP to library
calls and library errors to status codes.
"""
