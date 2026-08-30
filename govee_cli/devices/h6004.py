"""Device handler for the Govee H6004 smart bulb."""

from govee_cli.scenes.effects import BuiltInScene


class H6004:
    """Device handler for the Govee H6004 smart bulb.

    The H6004 is a single-zone bulb of the same GVH-era generation as the
    H6008 (OUI 5C:E7:53) and advertises an identical capability set over the
    Govee cloud v2 API: power, brightness, colour, colour temperature
    (2700-6500K), firmware scenes and DIY scenes.

    Like the H6008, it advertises no segments, segment brightness, music mode
    or toggles — and the sibling H6008 hardware rejects those instances with
    400 "devices not support this instance", so they are not claimed here.

    The BLE path is unverified on this generation and the 0x33 protocol
    demonstrably does not work on the sibling H6008, so the cloud is the only
    supported transport.
    """

    MODEL = "H6004"
    SEGMENT_COUNT = 1  # Single bulb, no segments

    # Single segment represents the entire bulb
    SEGMENT_MAP = {
        0: "bulb",
    }

    # The BLE built-in scene table. The cloud path does not use this — it
    # fetches the bulb's real scene library from Govee at run time.
    SCENES = {s.id: s.name for s in BuiltInScene.get_available_scenes()}

    # This model exposes no firmware music mode over any transport.
    MUSIC_MODES: dict[str, int] = {}

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device.

        H6004 has only 1 segment (the whole bulb).
        """
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(f"Segment ID must be 0 for H6004 (single bulb), got {segment_id}")
