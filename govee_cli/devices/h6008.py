"""Device handler for the Govee H6008 A19 RGBIC Light Bulb."""

from govee_cli.scenes.effects import BuiltInScene


class H6008:
    """Device handler for the Govee H6008 A19 RGBIC Light Bulb.

    The H6008 is a single-segment RGBIC bulb (unlike the H6056 which has 6 segments).
    It supports basic controls (power, brightness, color) and scenes, but segment
    commands only apply to segment 0 (the whole bulb).
    """

    MODEL = "H6008"
    SEGMENT_COUNT = 1  # Single bulb, no segments

    # Single segment represents the entire bulb
    SEGMENT_MAP = {
        0: "bulb",
    }

    # Scenes available for H6008 (may differ from H6056)
    SCENES = {s.id: s.name for s in BuiltInScene.get_available_scenes()}

    def validate_segment_id(self, segment_id: int) -> None:
        """Raise ValueError if segment_id is invalid for this device.

        H6008 has only 1 segment (the whole bulb).
        """
        if not 0 <= segment_id < self.SEGMENT_COUNT:
            raise ValueError(f"Segment ID must be 0 for H6008 (single bulb), got {segment_id}")
