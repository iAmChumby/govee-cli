"""Minimal .env file loading for local secrets.

The CLI resolves ``GOVEE_API_KEY`` from the config file or the process
environment. This module lets a local ``.env`` file serve as a third source so
the key never has to live in a committed file or be exported in every shell.

Search order: ``.env`` in the current working directory (the convention for a
repo checkout), then ``~/.config/govee-cli/.env`` (next to the config file it
complements). Variables already present in the environment always win, so an
explicit ``export`` on the command line overrides the file. Parsing is
deliberately narrow — ``KEY=VALUE`` lines, an optional ``export `` prefix,
matching surrounding quotes — because the only expected tenant is an API key.
Values are never logged.
"""

from __future__ import annotations

import os
import pathlib

_LOADED: set[pathlib.Path] = set()


def _candidates() -> list[pathlib.Path]:
    return [
        pathlib.Path.cwd() / ".env",
        pathlib.Path.home() / ".config" / "govee-cli" / ".env",
    ]


def _parse_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def load_env_file() -> None:
    """Export KEY=VALUE pairs from a local .env into os.environ.

    Idempotent: each candidate file is read at most once per process. A file
    that is missing, unreadable, or malformed is skipped silently — a broken
    .env must never turn a config-file-only setup into an error.
    """
    for path in _candidates():
        if path in _LOADED or not path.is_file():
            continue
        _LOADED.add(path)
        try:
            # "utf-8-sig" strips a leading BOM (a default Notepad option) that
            # would otherwise silently mangle the first key's name; plain
            # UTF-8 files read identically.
            text = path.read_text(encoding="utf-8-sig")
        except (OSError, ValueError):
            # OSError: unreadable. ValueError: UnicodeDecodeError on invalid
            # bytes (e.g. a UTF-16 file) — both are skipped silently.
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export "):]
            key, _, raw_value = line.partition("=")
            key = key.strip()
            if not key or " " in key:
                continue
            if key in os.environ:
                continue
            os.environ[key] = _parse_value(raw_value)
