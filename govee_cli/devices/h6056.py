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
    """

    MODEL = "H6056"
    SEGMENT_COUNT = SegmentLayout.COUNT
    SEGMENT_MAP = SegmentLayout.SEGMENT_MAP
    SCENES = {s.id: s.name for s in BuiltInScene.get_available_scenes()}

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device."""
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(
                f"Segment ID must be 0-{self.SEGMENT_COUNT - 1}, "
                f"got {segment_id}"
            )
