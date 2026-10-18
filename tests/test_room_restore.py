"""govee_cli.room_restore: the shared room-scene executor. Fake clients only."""

from __future__ import annotations

from govee_cli import ledger, room_restore
from govee_cli.config import DeviceConfig, GoveeConfig
from govee_cli.http_v2 import DIYScene, GoveeV2Error, GoveeV2RateLimited
from govee_cli.room_restore import RestoreClients, restore_scene
from govee_cli.room_scenes import CapturedDevice, RoomScene

LAMP = "50:CE:E8:6E:80:C6:50:3F"  # H6022, cloud v2
STALE = "AA:BB:CC:DD:EE:FF:00:11"


class FakeV2:
    max_retries = 4

    def __init__(self, diy=None, diy_error=None, fail_on=None):
        self.calls: list[tuple] = []
        self._diy = diy if diy is not None else [DIYScene("sleep", 5)]
        self._diy_error = diy_error
        self._fail_on = fail_on

    def _rec(self, name, *args):
        self.calls.append((name, *args))
        if self._fail_on == name:
            raise GoveeV2RateLimited("Govee cloud rate limit hit and retries exhausted.")

    def turn_on(self, sku, did): self._rec("turn_on")
    def turn_off(self, sku, did): self._rec("turn_off")
    def set_brightness(self, sku, did, v): self._rec("set_brightness", v)
    def set_color(self, sku, did, r, g, b): self._rec("set_color", r, g, b)
    def set_color_temp(self, sku, did, k): self._rec("set_color_temp", k)
    def set_diy_scene(self, sku, did, v): self._rec("set_diy_scene", v)

    def get_diy_scenes(self, sku, did):
        if self._diy_error:
            raise self._diy_error
        return self._diy


def _cfg() -> GoveeConfig:
    return GoveeConfig(devices={LAMP: DeviceConfig(model="H6022", name="Shelf Lamp")})


def _diy(name="sleep", value=5) -> CapturedDevice:
    return CapturedDevice(LAMP, "H6022", True, 40, None, None, "diy", name,
                          {"diy_value": value})


def _run(devices, client, name="s"):
    scene = RoomScene(created_at="x", devices=devices, source="authored")
    return restore_scene(name, scene, cfg=_cfg(), clients=RestoreClients(v2=client),
                         source="cli")


def test_unregistered_device_is_skipped_and_never_goes_over_ble(monkeypatch):
    def boom(*a, **k):
        raise AssertionError("BLE must never be reached for a stale id")

    monkeypatch.setattr(room_restore, "_apply_ble", boom)
    dev = CapturedDevice(STALE, "H6022", True, 50, [1, 2, 3], None, "basic", None,
                         {"color_rgb": [1, 2, 3]})
    client = FakeV2()
    res = _run([dev], client)
    assert res.ok and res.results[0].skipped_reason == "device not registered"
    assert client.calls == [] and ledger.read_one(STALE) is None


def test_full_success_records_ledger_with_scene_mode_and_source():
    res = _run([_diy()], FakeV2())
    assert res.ok and res.results[0].notes == []
    entry = ledger.read_one(LAMP)
    assert entry is not None and entry.mode == "diy" and entry.source == "cli"
    assert entry.payload == {"diy_value": 5}


def test_ledger_failure_never_fails_the_step(monkeypatch):
    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(ledger, "record_mode", boom)
    assert _run([_diy()], FakeV2()).ok


def test_gone_diy_errors_sends_nothing_for_it_but_other_steps_run_and_ledger_cleared():
    ledger.record_mode(LAMP, "basic", None, None, source="cli")
    client = FakeV2()
    res = _run([_diy("old", 9)], client)
    r = res.results[0]
    assert not res.ok and r.error == "DIY scene 'old' no longer exists on Shelf Lamp"
    names = [c[0] for c in client.calls]
    assert "set_diy_scene" not in names and names == ["turn_on", "set_brightness"]
    assert "ledger cleared: partial apply" in r.notes
    assert ledger.read_one(LAMP) is None


def test_renamed_diy_is_sent_with_a_note():
    client = FakeV2(diy=[DIYScene("slumber", 5)])
    res = _run([_diy("sleep", 5)], client)
    assert res.ok and ("set_diy_scene", 5) in client.calls
    assert "DIY 'sleep' is now named 'slumber'" in res.results[0].notes


def test_diy_list_unavailable_without_cache_is_an_error_and_nothing_sent():
    client = FakeV2(diy_error=GoveeV2Error("boom"))
    res = _run([_diy()], client)
    assert not res.ok
    assert res.results[0].error.startswith("could not verify DIY scene 'sleep' on Shelf Lamp")
    assert not any(c[0] == "set_diy_scene" for c in client.calls)


def test_diy_list_unavailable_uses_cache_and_says_so():
    _run([_diy()], FakeV2())  # live success writes the cache
    client = FakeV2(diy_error=GoveeV2Error("boom"))
    res = _run([_diy()], client)
    assert res.ok and ("set_diy_scene", 5) in client.calls
    assert any(n.startswith("verified against list cached ") for n in res.results[0].notes)


def test_rate_limit_error_names_429_and_retry_count():
    res = _run([_diy()], FakeV2(fail_on="turn_on"))
    err = res.results[0].error
    assert "429" in err and "4 attempts" in err
