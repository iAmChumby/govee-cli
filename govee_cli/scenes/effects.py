"""Built-in scene definitions and DIY effect format.

The DIY effect format is defined in SPEC.md. This module provides
a parser and the built-in scene library.
"""

import json
import pathlib
from dataclasses import dataclass

import structlog

logger = structlog.get_logger(__name__)

SCENES_DIR = pathlib.Path(__file__).parent.parent.parent / "scenes"


@dataclass
class ColorKeyframe:
    """A single keyframe in a segment's animation."""

    t: int  # milliseconds from effect start
    color: str  # hex color e.g. "FF0000"


@dataclass
class SegmentKeyframes:
    """Animation keyframes for a single segment."""

    id: int
    keyframes: list[ColorKeyframe]


@dataclass
class Effect:
    """A DIY effect definition."""

    name: str
    segments: list[SegmentKeyframes]
    loop: bool = True
    fps: int = 30

    @classmethod
    def from_dict(cls, data: dict) -> "Effect":
        """Parse a dict into an Effect."""
        return cls(
            name=data["name"],
            segments=[
                SegmentKeyframes(
                    id=seg["id"],
                    keyframes=[
                        ColorKeyframe(t=kf["t"], color=kf["color"])
                        for kf in seg["keyframes"]
                    ],
                )
                for seg in data["segments"]
            ],
            loop=data.get("loop", True),
            fps=data.get("fps", 30),
        )

    @classmethod
    def from_file(cls, path: pathlib.Path) -> "Effect":
        """Load an effect from a JSON file."""
        logger.info("loading_effect", path=str(path))
        with open(path) as f:
            data = json.load(f)
        return cls.from_dict(data)


@dataclass
class BuiltInScene:
    """A named built-in scene with its scene ID."""

    id: int
    name: str
    description: str = ""

    @staticmethod
    def get_available_scenes() -> list["BuiltInScene"]:
        """
        Return the H6056 built-in scene library.

        Scene codes sourced from the Govee API (sku=H6056) and confirmed
        via egold555/Govee-Reverse-Engineering. Codes are 16-bit values
        encoded little-endian in the BLE packet.

        Scenes marked with * require the multi-packet 0xA3 protocol
        (hasSpecialEffect=YES) and are not yet supported.
        """
        return [
            # Natural
            BuiltInScene(0x18, "Aurora",        "Natural aurora effect"),
            BuiltInScene(0x0F, "Snowflake",      "Cool blue snowflake pattern"),
            BuiltInScene(0x1D, "Seasonal",       "Seasonal color cycling"),
            BuiltInScene(0x1E, "Stream",         "Flowing stream effect"),
            BuiltInScene(0x16, "Rainbow",        "Full spectrum cycling"),
            BuiltInScene(0x0989, "Bloom",        "Blooming color effect"),
            # Life
            BuiltInScene(0x0D, "Reading",        "Bright neutral white"),
            BuiltInScene(0x04, "Movie",          "Dim warm cinema mode"),
            BuiltInScene(0x09, "Candlelight",    "Warm orange flicker"),
            BuiltInScene(0x07, "Romantic",       "Soft red/pink oscillation"),
            BuiltInScene(0x0A, "Breathe",        "Slow breathing pulse"),
            BuiltInScene(0x10, "Energetic",      "Vibrant multi-color"),
            BuiltInScene(0x098A, "Party",        "Multi-color strobe"),
            BuiltInScene(0x098B, "Siren",        "Emergency siren flash"),
            BuiltInScene(0x098E, "Asleep",       "Gentle sleep fade"),
            # Funny
            BuiltInScene(0x15, "Crossing",       "Crossing color beams"),
            BuiltInScene(0x098F, "Glitter",      "Sparkling glitter effect"),
            BuiltInScene(0x0990, "Fright",       "Spooky flickering"),
            BuiltInScene(0x0991, "Drumbeat",     "Beat-synced pulse"),
            # Movie watching
            BuiltInScene(0x0A61, "Literary",     "Warm tone for reading"),
            BuiltInScene(0x0A62, "Sci-Fi",       "Cool blue sci-fi mode"),
            BuiltInScene(0x0A63, "Romance",      "Soft pink romance mode"),
            BuiltInScene(0x0A64, "War",          "Intense red/orange"),
            BuiltInScene(0x0A65, "Comedy",       "Bright cheerful colors"),
            BuiltInScene(0x0A66, "Documentary",  "Neutral daylight tone"),
            BuiltInScene(0x0A67, "Action",       "High-contrast fast flash"),
            BuiltInScene(0x0A68, "Suspense",     "Dark slow pulse"),
        ]

    @staticmethod
    def get_by_id(scene_id: int) -> "BuiltInScene | None":
        """Return a built-in scene by its ID."""
        for scene in BuiltInScene.get_available_scenes():
            if scene.id == scene_id:
                return scene
        return None

    @staticmethod
    def get_by_name(name: str) -> "BuiltInScene | None":
        """Find a built-in scene by name (case-insensitive)."""
        name_lower = name.lower()
        for scene in BuiltInScene.get_available_scenes():
            if scene.name.lower() == name_lower:
                return scene
        return None
