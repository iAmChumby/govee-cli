"""Tests for govee_cli.envfile — the local .env loader.

These monkeypatch ``_candidates`` so a developer's real ``.env`` (repo root or
``~/.config/govee-cli/.env``) can never leak into the test run, and reset the
module-level ``_LOADED`` cache so each test reads fresh.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from govee_cli import envfile


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    candidates = [tmp_path / "repo.env", tmp_path / "home.env"]
    monkeypatch.setattr(envfile, "_candidates", lambda: candidates)
    monkeypatch.setattr(envfile, "_LOADED", set())
    # Clear any ambient value so tests assert what the file alone produced.
    monkeypatch.delenv("GOVEE_API_KEY", raising=False)
    return candidates


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def test_loads_key_from_first_candidate(_isolated):
    _write(_isolated[0], "GOVEE_API_KEY=abc123\n")
    envfile.load_env_file()
    assert os.environ["GOVEE_API_KEY"] == "abc123"


def test_falls_back_to_second_candidate(_isolated):
    _write(_isolated[1], "GOVEE_API_KEY=from-home\n")
    envfile.load_env_file()
    assert os.environ["GOVEE_API_KEY"] == "from-home"


def test_existing_environment_wins(_isolated, monkeypatch):
    monkeypatch.setenv("GOVEE_API_KEY", "from-shell")
    _write(_isolated[0], "GOVEE_API_KEY=from-file\n")
    envfile.load_env_file()
    assert os.environ["GOVEE_API_KEY"] == "from-shell"


def test_comments_blank_and_malformed_lines_skipped(_isolated):
    _write(
        _isolated[0],
        "\n# a comment\nGOODE=1\nNO_EQUALS_SIGN\n export  SPACED=2 \n"
        " =novalue\n",
    )
    envfile.load_env_file()
    assert os.environ["GOODE"] == "1"
    assert os.environ["SPACED"] == "2"
    assert "" not in os.environ


def test_export_prefix_and_quotes_handled(_isolated):
    _write(
        _isolated[0],
        'export QUOTED="double quoted"\n'
        "export SINGLE='single quoted'\n"
        "export PLAIN=raw\n",
    )
    envfile.load_env_file()
    assert os.environ["QUOTED"] == "double quoted"
    assert os.environ["SINGLE"] == "single quoted"
    assert os.environ["PLAIN"] == "raw"


def test_value_with_equals_sign_keeps_remainder(_isolated):
    _write(_isolated[0], "EQ=a=b=c\n")
    envfile.load_env_file()
    assert os.environ["EQ"] == "a=b=c"


def test_second_call_is_idempotent(_isolated):
    _write(_isolated[0], "IDEM=first\n")
    envfile.load_env_file()
    _write(_isolated[0], "IDEM=second\n")
    envfile.load_env_file()
    assert os.environ["IDEM"] == "first"


def test_missing_files_are_silent(_isolated):
    envfile.load_env_file()  # must not raise
    assert "GOVEE_API_KEY" not in os.environ


def test_http_v2_client_reads_key_via_envfile(monkeypatch):
    """GoveeHTTPv2's fallback chain must route through load_env_file()."""
    import govee_cli.config as config_mod
    from govee_cli.http_v2 import GoveeHTTPv2

    calls = []

    def fake_load():
        calls.append(True)
        # setenv, not raw assignment — monkeypatch must undo it or the key
        # leaks into every test file that runs after this one.
        monkeypatch.setenv("GOVEE_API_KEY", "from-envfile")

    monkeypatch.setattr(envfile, "load_env_file", fake_load)
    monkeypatch.setattr(
        config_mod, "load_config", lambda: config_mod.GoveeConfig(api_key=None)
    )
    monkeypatch.delenv("GOVEE_API_KEY", raising=False)

    client = GoveeHTTPv2()
    assert calls
    assert client.api_key == "from-envfile"


def test_http_v1_client_reads_key_via_envfile(monkeypatch):
    """The v1 client shares the same fallback chain and must stay in sync."""
    import govee_cli.config as config_mod
    from govee_cli.http import GoveeHTTP

    def fake_load():
        monkeypatch.setenv("GOVEE_API_KEY", "from-envfile")

    monkeypatch.setattr(envfile, "load_env_file", fake_load)
    monkeypatch.setattr(
        config_mod, "load_config", lambda: config_mod.GoveeConfig(api_key=None)
    )
    monkeypatch.delenv("GOVEE_API_KEY", raising=False)

    client = GoveeHTTP()
    assert client.api_key == "from-envfile"


def test_utf8_bom_does_not_mangle_the_first_key(_isolated):
    """Notepad's 'UTF-8 with BOM' default must not corrupt the first key name."""
    _isolated[0].write_bytes("\ufeffGOVEE_API_KEY=bommy\n".encode("utf-8"))
    envfile.load_env_file()
    assert os.environ["GOVEE_API_KEY"] == "bommy"


def test_non_utf8_bytes_are_skipped_silently(_isolated):
    """A UTF-16 file (PowerShell 5.1 Out-File default) is malformed UTF-8."""
    _isolated[0].write_bytes("GOVEE_API_KEY=utf16\n".encode("utf-16"))
    envfile.load_env_file()  # must not raise
    assert "GOVEE_API_KEY" not in os.environ


def test_force_utf8_stdio_reconfigures_legacy_consoles(monkeypatch):
    """A cp1252-encoded stdout must be switched to UTF-8, not crash on emoji."""
    import io

    from govee_cli.cli import _force_utf8_stdio

    out = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
    err = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
    monkeypatch.setattr("sys.stdout", out)
    monkeypatch.setattr("sys.stderr", err)
    _force_utf8_stdio()
    assert out.encoding.lower() == "utf-8"
    assert err.encoding.lower() == "utf-8"


def test_force_utf8_stdio_tolerates_unreconfigurable_streams(monkeypatch):
    """Streams without reconfigure (StringIO) are left alone, no raise."""
    import io

    from govee_cli.cli import _force_utf8_stdio

    monkeypatch.setattr("sys.stdout", io.StringIO())
    monkeypatch.setattr("sys.stderr", io.StringIO())
    _force_utf8_stdio()  # must not raise
