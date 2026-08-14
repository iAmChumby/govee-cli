"""Device handler for the Govee H6022 RGBIC Table Lamp 2.

Unlike the H6056 (BLE-only light bars) and the H6008 (single-zone bulb), the
H6022 is a WiFi + Bluetooth hybrid. No published reverse engineering of its BLE
command set exists, and the classic ``0x33`` packet protocol has not been shown
to apply to it — so this model is driven entirely over the Govee Open API v2.
That path is not a limitation in practice: it reaches the full feature set,
including all 15 segments, the firmware scene library, DIY scenes and music mode.

Verified against hardware 2026-08-14:

* Segments 0-14 are individually addressable; index 15 is rejected by the API
  with "Parameter value out of range".
* Colour temperature is accepted across 2700-6500K and reads back correctly.
* Setting ``colorTemperatureK`` zeroes the reported ``colorRgb`` (mode switch),
  and vice versa — the two are mutually exclusive on this device.
"""


class SegmentLayout:
    """Physical segment layout for the H6022.

    The lamp exposes a single strip of 15 addressable zones running the length of
    the fixture. Govee does not publish a physical mapping, so segments are named
    positionally: 0 is one end, 14 the other.
    """

    COUNT = 15

    SEGMENT_MAP = {i: f"zone_{i}" for i in range(COUNT)}

    DEFAULT_ORDER = list(range(COUNT))


class H6022:
    """Device handler for the Govee H6022 RGBIC Table Lamp 2."""

    MODEL = "H6022"
    SEGMENT_COUNT = SegmentLayout.COUNT
    SEGMENT_MAP = SegmentLayout.SEGMENT_MAP

    # Bounds the device itself enforces, per its advertised v2 capabilities.
    TEMP_MIN = 2700
    TEMP_MAX = 6500

    # Firmware music modes, from the device's advertised musicMode capability.
    # These names and values are specific to this model — the H6056 advertises a
    # different set (Vivid/Strike/Rhythm/...), so they must not be shared.
    MUSIC_MODES = {
        "rhythm": 3,
        "rolling": 4,
        "energic": 5,
        "spectrum": 6,
    }

    # Scenes are fetched live from the cloud rather than hardcoded: the H6022's
    # library runs to 60+ entries and changes with firmware updates.
    SCENES: dict[int, str] = {}

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device."""
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(
                f"Segment ID must be 0-{self.SEGMENT_COUNT - 1}, got {segment_id}"
            )
