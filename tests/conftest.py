"""Suite-wide safety rails.

The ledger is a real file in the developer's own ``~/.config/govee-cli``, and the
CLI/sidecar write to it as a side effect of nearly every command. Without a guard,
a test that mocks the cloud client but forgets the ledger still writes — quietly,
to the real file, for the real bedroom devices. That happened: a full ``pytest``
run left "Shelf Lamp: music/rolling" in the live ledger, which the running console
then displayed as the truth about a lamp that was doing nothing of the kind.

Per-file fixtures are not enough because the failure is one of omission. This is
autouse and session-independent: every test gets ledger paths inside its own
tmp_path, whether it knows about the ledger or not. Tests that assert on ledger
contents keep their own fixtures — those simply repoint the same module globals
again, which is harmless.
"""

from __future__ import annotations

import pytest

from govee_cli import ledger


@pytest.fixture(autouse=True)
def _isolate_ledger(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")
