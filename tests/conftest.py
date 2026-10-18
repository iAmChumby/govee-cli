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

Issue #2 added the schedule state file, the scheduler owner record and its lock,
and made the user config (latitude/longitude/timezone) something a schedule test
writes. Those are redirected here too, together with every other path under
``~/.config/govee-cli/`` that code can reach: the user config, the v2 scene cache,
the legacy v1 client's config path, the crontab snapshot the sidecar reads, and the
``.env`` lookup. HOME/USERPROFILE point at tmp_path as a backstop, so a path that a
future module computes from ``Path.home()`` at call time lands in tmp as well.
Inventory of state paths and where each is redirected:

    config.json            config._CONFIG_PATH (and http._CONFIG_PATH, read-only legacy)
    schedule.json          scheduler.SCHEDULE_DIR / SCHEDULE_FILE
    schedule-state.json    scheduler.SCHEDULE_STATE_PATH
    scheduler-owner.json   owner.OWNER_PATH / OWNER_LOCK_PATH
    scene-cache.json       http_v2._SCENE_CACHE_PATH
    active-mode.json       ledger.LEDGER_PATH / LEDGER_LOCK_PATH
    request-meter.json     request_meter.METER_PATH / METER_LOCK_PATH
    room-scenes.json       room_scenes.ROOM_SCENES_PATH / ROOM_SCENES_LOCK_PATH
    crontab.snapshot       external_schedule.SNAPSHOT_PATH (read-only)
    .env                   envfile._candidates (read-only)

Add a new state file and you must add it here AND to webui/api/mock.py install().
"""

from __future__ import annotations

import pytest

from govee_cli import config as config_mod
from govee_cli import envfile, http, http_v2, ledger, request_meter, room_scenes
from govee_cli.schedule import owner, scheduler
from webui.api import external_schedule
from webui.api import mock as mock_mod


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
    # --- issue #2: schedule state, scheduler owner, config, caches ---
    # Backstop for any path computed from Path.home() at call time.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setattr(envfile, "_candidates", lambda: [tmp_path / ".env"])
    monkeypatch.setattr(external_schedule, "SNAPSHOT_PATH", tmp_path / "crontab.snapshot")
    if mock_mod._tmp_dir is not None:
        # tests/test_webui_api.py builds the sidecar once per module, and
        # mock.install() has already redirected the paths below into its own
        # seeded temp dir (devices, schedules). Repointing them per test would
        # hide that seed, so leave them: they are already off the real dir.
        return
    monkeypatch.setattr(scheduler, "SCHEDULE_DIR", tmp_path)
    monkeypatch.setattr(scheduler, "SCHEDULE_FILE", tmp_path / "schedule.json")
    monkeypatch.setattr(scheduler, "SCHEDULE_STATE_PATH", tmp_path / "schedule-state.json")
    monkeypatch.setattr(owner, "OWNER_PATH", tmp_path / "scheduler-owner.json")
    monkeypatch.setattr(owner, "OWNER_LOCK_PATH", tmp_path / "scheduler-owner.json.lock")
    monkeypatch.setattr(config_mod, "_CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(http, "_CONFIG_PATH", str(tmp_path / "config.json"))
    monkeypatch.setattr(http_v2, "_SCENE_CACHE_PATH", tmp_path / "scene-cache.json")
