"""Device handler for the Govee H6056 Flow Plus Light Bars."""


from govee_cli.scenes.effects import BuiltInScene


class SegmentLayout:
    """Physical segment layout for the H6056.

    The H6056 has 6 segments arranged as a pair of tri-zone bars.
    """

    COUNT = 6

    # Segment indices: 0-2 = left bar, 3-5 = right bar (approximate)
    SEGMENT_MAP = {
        0: "left_top",
        1: "left_middle",
        2: "left_bottom",
        3: "right_top",
        4: "right_middle",
        5: "right_bottom",
    }

    # Default segment order for multi-segment effects
    DEFAULT_ORDER = list(range(COUNT))


class H6056:
    """Device handler for the Govee H6056 Flow Plus Light Bars.

    MAC: D0:C9:07:FE:B6:F0

    Reachable over both BLE and the Govee cloud v2 API. The cloud path carries
    69 firmware scenes, DIY scenes, per-segment colour and brightness, eight
    music modes and the gradient toggle; BLE carries the 0x33 packet protocol
    and is kept for keyframe effects, which need more frames per second than the
    cloud request budget allows.
    """

    MODEL = "H6056"
    SEGMENT_COUNT = SegmentLayout.COUNT
    SEGMENT_MAP = SegmentLayout.SEGMENT_MAP
    SCENES = {s.id: s.name for s in BuiltInScene.get_available_scenes()}

    # Firmware music modes, from the device's advertised musicMode capability
    # and verified accepted by the hardware. These integers are specific to this
    # model — the H6022 uses a different, non-overlapping mapping, so they must
    # never be shared between models.
    MUSIC_MODES = {
        "vivid": 0,
        "strike": 1,
        "rhythm": 2,
        "vibrate": 3,
        "beat": 4,
        "torch": 5,
        "rainbowcircle": 6,
        "shiny": 7,
    }

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device."""
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(
                f"Segment ID must be 0-{self.SEGMENT_COUNT - 1}, "
                f"got {segment_id}"
            )
