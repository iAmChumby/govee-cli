# Architecture

BLE only. No cloud, no WiFi, no persistent daemon for basic commands. Each command connects, sends, and disconnects.

```
CLI → Commands → BLE abstraction → Protocol → Device
```

## Modules

### `govee_cli/cli.py`

Click root group. Loads config on every invocation and injects `default_mac`, `default_adapter`, `default_timeout` into `ctx.obj`. All commands registered here via `main.add_command()`.

### `govee_cli/config.py`

`GoveeConfig` dataclass backed by `~/.config/govee-cli/config.json`. Holds default MAC, adapter, timeout, and device groups (`{name: [mac, ...]}`). Loaded once per invocation.

### `govee_cli/ble/protocol.py`

Core protocol layer. All GATT UUIDs and packet formats confirmed via hardware dump on H6056.

- `encode_*(...)` — return `Command` objects
- `build_packet(cmd)` — produces final 20-byte BLE packet: `[0x33][cmd_type][18-byte payload][XOR checksum]`
- `build_query_packet()` — 0xAA state query
- `parse_state(data)` — decodes 0xAA response (power only; H6056 returns zeros for brightness/color)

### `govee_cli/ble/gatt.py`

Wraps `bleak.BleakClient`.

- `connect()` — tries static MAC first; falls back to scan-and-resolve if not found (handles random BLE address)
- `execute(command)` — writes to WRITE char, subscribes to NOTIFY, awaits ACK
- `send(command)` — fire-and-forget write (no ACK wait; used by effect playback)
- `read_state()` — subscribes to NOTIFY, sends query packet, awaits notification
- `disconnect()` / async context manager

### `govee_cli/ble/scanner.py`

Wraps `bleak.BleakScanner`. Returns devices filtered by Govee name prefix, with RSSI from `AdvertisementData` (bleak 3.0 API).

### `govee_cli/devices/h6056.py`

H6056 constants: `SEGMENT_COUNT = 6`, `SEGMENT_MAP`, scene name → ID map.

### `govee_cli/commands/`

One file per CLI command. Each exports a `command` object registered in `cli.py`. Commands read `default_mac` from `ctx.obj` and accept `--device` to override.

### `govee_cli/scenes/effects.py`

- `Effect` / `SegmentKeyframes` / `ColorKeyframe` — dataclasses for the DIY effect format
- `BuiltInScene` — 27 H6056 scene codes sourced from Govee API

### `govee_cli/scenes/capture.py`

BLE packet sniffer (stub). Subscribes to NOTIFY and records packets for `replay`. Requires btmon capture session to be useful.

### `govee_cli/schedule/scheduler.py`

`ScheduleRule` dataclass persisted to `~/.config/govee-cli/schedule.json`. `SchedulerDaemon` runs an asyncio loop, wakes every 30s, fires rules matching the current `HH:MM` + day-of-week.

## Data Flow

```
govee-cli color FF5500
  → commands/color.py        parse + validate hex
  → ble/gatt.py execute()    build packet, write to WRITE char
  → ble/protocol.py          encode_color_hex() → Command → build_packet() → bytes
  → bleak                    write_gatt_char(WRITE, packet, response=True)
  → device notify             notification_handler sets response_future
  → return True
```

## Connection Strategy

Govee devices advertise under a random BLE address, not the static MAC on the sticker. BlueZ doesn't cache the mapping.

`GoveeBLE.connect()` tries the static MAC first with a 3s probe timeout. On "not found" it scans for any device with "Govee" in the name, preferring one whose name suffix matches the last 4 hex digits of the configured MAC.

## Effect Playback

Effects use `GoveeBLE.send()` (fire-and-forget, `response=False`) rather than `execute()` to avoid waiting for a NOTIFY ACK on every frame. The player interpolates colors between keyframes and sends one segment command per segment per frame, sleeping for `1000/fps - elapsed_ms` between frames. Practical throughput is ~10–15 fps for multi-segment effects due to BLE connection interval limits.

## bleak 3.0 API Notes

- `BLEDevice.rssi` / `.metadata` removed — RSSI and ManufacturerData now in `adv.rssi` / `adv.manufacturer_data` on `AdvertisementData`
- `BleakScanner.discover(return_adv=True)` returns `dict[str, tuple[BLEDevice, AdvertisementData]]`
- `start_notify` callback: `(char: BleakGATTCharacteristic, data: bytearray) → None`
- `services.get_characteristic(uuid)` on the client (not `client.get_characteristic`)

## Dependencies

| Package | Purpose |
|---------|---------|
| `bleak` | BLE GATT client |
| `click` | CLI framework |
| `structlog` | Structured logging |
| `APScheduler` | Schedule timing (used by daemon) |
