"""Device handler for the Govee H6008 A19 RGBIC Light Bulb."""

from govee_cli.scenes.effects import BuiltInScene


class H6008:
    """Device handler for the Govee H6008 A19 RGBIC Light Bulb.

    The H6008 is a single-zone bulb (unlike the H6056, which is segmented).
    Driven over the Govee cloud v2 API, which carries power, brightness, colour,
    colour temperature, 56 firmware scenes and DIY scenes.

    Verified rejected by this hardware (400 "devices not support this
    instance"): per-segment colour, per-segment brightness, music mode, and the
    gradient toggle. It is a single-zone bulb, so there is nothing to segment.

    The BLE path remains unusable on the GVH-series revision Luke owns — see
    docs/H6008_PROTOCOL.md.
    """

    MODEL = "H6008"
    SEGMENT_COUNT = 1  # Single bulb, no segments

    # Single segment represents the entire bulb
    SEGMENT_MAP = {
        0: "bulb",
    }

    # The BLE built-in scene table. The cloud path does not use this — it
    # fetches the bulb's real 56-scene library from Govee at run time.
    SCENES = {s.id: s.name for s in BuiltInScene.get_available_scenes()}

    # This model exposes no firmware music mode over any transport.
    MUSIC_MODES: dict[str, int] = {}

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device.

        H6008 has only 1 segment (the whole bulb).
        """
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(f"Segment ID must be 0 for H6008 (single bulb), got {segment_id}")
