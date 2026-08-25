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

``request_meter`` (WEBUI_V3_SPEC.md §10, T17/T18) and ``room_scenes`` (T19) are
the same shape of hazard and got the same bug: T18 wired ``request_meter.record()``
directly into ``GoveeHTTPv2._request``/``GoveeHTTP``'s methods, so *any* pre-existing
test that mocks ``requests.request``/``requests.get``/``requests.put`` and exercises
those methods (``tests/test_http.py``, ``tests/test_http_v2.py``,
``tests/test_transport_routing.py``, ``tests/test_ledger_writethrough.py`` — none of
which know the meter exists) now writes real counts, including fabricated
``rate_limited`` counts, to the real ``~/.config/govee-cli/request-meter.json`` on
every full-suite run. Confirmed live: a full ``pytest`` run measurably changed that
file's on-disk content. Isolate both here for the same reason and by the same
mechanism as the ledger, rather than trusting every future test file to remember.
"""

from __future__ import annotations

import pytest

from govee_cli import ledger, request_meter, room_scenes


@pytest.fixture(autouse=True)
def _isolate_ledger(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "active-mode.json")
    monkeypatch.setattr(ledger, "LEDGER_LOCK_PATH", tmp_path / "active-mode.json.lock")
    monkeypatch.setattr(request_meter, "METER_PATH", tmp_path / "request-meter.json")
    monkeypatch.setattr(
        request_meter, "METER_LOCK_PATH", tmp_path / "request-meter.json.lock"
    )
    request_meter.reset()
    monkeypatch.setattr(room_scenes, "ROOM_SCENES_PATH", tmp_path / "room-scenes.json")
    monkeypatch.setattr(
        room_scenes, "ROOM_SCENES_LOCK_PATH", tmp_path / "room-scenes.json.lock"
    )
