# Development Guide

This project follows a structured development methodology. Read this before making significant changes.

---

## Required Skills for This Project

Load these from `~/.openclaw/workspace/skills/` before the corresponding phase:

| Phase | Skill | When to load |
|-------|-------|--------------|
| **All feature work** | **`subagent-driven-development`** | Golden standard — one implementer per task, two-stage review (spec → quality) after each |
| GUI work | **`frontend-design`** | Before touching UI components, styling, or visual layouts |
| Any bug / test failure | **`systematic-debugging`** | Before proposing any fix — investigate root cause first |
| Any new feature (TDD) | **`test-driven-development`** | Before writing production code — write test first |
| Before claiming done | **`verification-before-completion`** | Before committing or PRing — run full gate, evidence before claims |
| Feature complete | **`finishing-a-development-branch`** | When all tasks done — verify tests, present merge/PR/keep options |

> Skills live at `~/.openclaw/workspace/skills/<skill-name>/SKILL.md`. Read the full skill file before starting the phase.

---

## The Iron Rules

> **NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE**
> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST** (for new features)
> **NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST** (for bugs)

These are not guidelines. Violating them is the same as violating the task itself.

---

## Development Cycle

### 1. Pick Up Task
- Read the relevant spec section
- Identify what needs to change
- If changing BLE/GATT code: verify against real device captures first

### 2. Test-First (New Features)
For any new feature or command:
1. Write the test — watch it fail
2. Write minimal code — watch it pass
3. Refactor if needed — keep tests green
4. Commit

### 3. Verify Before Committing
Run the full suite — ALL tools, not just tests:

```bash
# The Gate — run ALL three before claiming anything is complete
pytest                          # 0 failures required
ruff check govee_cli            # 0 errors required
mypy govee_cli                  # 0 errors required
```

Evidence before claims. Previous runs don't count.

### 4. Scan (BLE/GATT code)
For any BLE command that affects the actual light:
```bash
python -m govee_cli scan  # verify device reachable before testing commands
```

---

## Project Toolchain

```bash
# Set up venv
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# Run all checks
pytest && ruff check govee_cli && mypy govee_cli

# Lint auto-fix
ruff check --fix govee_cli

# CLI smoke test
python -m govee_cli --help
python -m govee_cli scan --timeout 3
```

---

## BLE / GATT Reverse Engineering

The GATT characteristics and command encodings are **placeholders**. Real values must come from BLE captures.

### How to Capture
```bash
# 1. Start capture
govee-cli record --device D0:C9:07:FE:B6:F0 --output capture.json

# 2. Trigger the effect in Govee app on phone

# 3. Ctrl+C to stop

# 4. Inspect capture.json to find:
#    - The GATT characteristic UUID written to
#    - The exact bytes sent
```

### After Capturing
- Update `ble/protocol.py` with real UUIDs and packet formats
- Update `devices/h6056.py` with real scene IDs
- Add a test capturing the verified packet structure
- Update SPEC.md with verified command reference

### Device Info
- **H6056 MAC**: `D0:C9:07:FE:B6:F0`
- **USB BT Dongle**: F4:4E:FC:33:69:A4 (hci0)
- **Govee Manufacturer ID**: 34819 (0x8803)

---

## Debugging BLE Issues

**NEVER** guess at BLE fixes. BLE is finicky — wrong assumptions create silent failures.

### Systematic BLE Debug
1. **Is device reachable?** → `govee-cli scan`
2. **Can we connect?** → `python -c "import asyncio; from govee_cli.ble import GoveeBLE; ..."`
3. **Is the char UUID correct?** → Check with `bleak-terminal` or Wireshark
4. **Is the packet format right?** → Compare byte-by-byte with capture

### Common BLE Failure Modes
- Device went out of range
- Dongle in wrong USB port
- Wrong byte order (LE vs BE)
- Notification not subscribed before write
- Wrong MTU size

---

## Finishing a Feature Branch

1. Verify: `pytest && ruff check govee_cli && mypy govee_cli` — ALL must pass
2. Review: Read every changed file, check for off-by-ones, null handling, debug code
3. Commit with clear message: what changed, why, what was verified
4. Push

**Never merge or PR with failing checks.** Fix first.

---

## Architecture Conventions

### Module Responsibilities
```
govee_cli/
├── ble/
│   ├── protocol.py   — Command encoding/decoding (Govee proprietary)
│   ├── gatt.py      — BleakClient wrapper (connection, write, notify)
│   └── scanner.py   — BLE device discovery
├── devices/
│   └── h6056.py     — Device-specific: segments, scenes, model info
├── commands/        — One file per CLI command (Click)
├── scenes/
│   ├── effects.py   — DIY effect format + built-in scene library
│   └── capture.py   — BLE packet capture utility
└── schedule/
    └── scheduler.py — Local rule engine (APScheduler)
```

### BLE API (bleak 3.0)
- `BLEDevice` no longer has `.rssi` or `.metadata` — these live in `device.details['props']`
- `start_notify` callback: `(BleakGATTCharacteristic, bytearray) → None`
- Scanner: `await bleak.BleakScanner.discover(timeout)` → list of `BLEDevice`

### Error Hierarchy
```
GoveeError (base)
├── DeviceNotFound
├── ConnectionFailed
├── TimeoutError
├── ProtocolError
├── UnsupportedDevice
└── AuthenticationError
```

---

## Commit Message Format

```
<type>: <short description>

<optional body: what changed, why, what was verified>
```

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `ci`

Example:
```
fix: bleak 3.0 API — BLEDevice dropped .rssi/.metadata

Updated _parse_device() to read from details['props'] which is where
bleak 3.0 moved RSSI and ManufacturerData. Verified with real device
scan showing correct Govee manufacturer ID (34819).
```

---

## When Stuck

1. Reproduce the issue consistently
2. Gather evidence (logs, error output, packet captures)
3. Form a hypothesis
4. Make one minimal change
5. Test
6. Repeat

**Don't pile on fixes.** If 3+ fixes failed, the architecture is wrong — stop and discuss.
