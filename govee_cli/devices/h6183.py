"""Device handler for the Govee H6183 TV backlight strip.

No hardware on hand. This model was in the original hardcoded cloud list and is
kept on the v1 transport because a migration to v2 cannot be verified without a
device to test against — an unverified switch is exactly the kind of change that
breaks silently.

Its presence here is also what keeps the v1 code paths reachable: without a
registered v1 model, `load_config` would reject the model outright and the v1
branches in every command would be dead code.
"""


class H6183:
    """Device handler for the Govee H6183 TV backlight strip (unverified)."""

    MODEL = "H6183"
    # Unknown without hardware; treated as single-zone so segment commands
    # refuse cleanly rather than sending something unverified.
    SEGMENT_COUNT = 0
    SEGMENT_MAP: dict[int, str] = {}
    SCENES: dict[int, str] = {}
    MUSIC_MODES: dict[str, int] = {}

    def validate_segment_id(self, segment_id: int) -> None:
        """H6183 segment layout is unverified, so nothing is addressable."""
        raise ValueError("Segment addressing is unverified for the H6183.")
