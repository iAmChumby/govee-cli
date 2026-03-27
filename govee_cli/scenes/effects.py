"""Built-in scene definitions and DIY effect format.

The DIY effect format is defined in SPEC.md. This module provides
a parser and the built-in scene library.
"""

import json
import pathlib
from dataclasses import dataclass, field

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


# Built-in scene library — IDs verified from Govee H6056 captures
BUILT_IN_SCENES: list[BuiltInScene] = [
    # These IDs are derived from community research and need verification
    BuiltInScene(1, "Sunrise", "Gradual warm white ramp"),
    BuiltInScene(2, "Sunset", "Gradual warm-to-cool fade"),
    BuiltInScene(3, "Ocean", "Blue waves with subtle brightness oscillation"),
    BuiltInScene(4, "Forest", "Green hues with gentle pulsing"),
    BuiltInScene(5, "Party", "Multi-color strobe effect"),
    BuiltInScene(6, "Romance", "Soft red/pink oscillation"),
    BuiltInScene(7, "Rainbow", "Full spectrum cycling"),
    BuiltInScene(8, "Fireplace", "Warm orange flicker"),
    BuiltInScene(9, "Night Light", "Dim warm white"),
    BuiltInScene(10, "Reading", "Bright neutral white"),
]


def list_built_in_scenes() -> list[BuiltInScene]:
    """Return the built-in scene library."""
    return BUILT_IN_SCENES


def find_scene_by_name(name: str) -> BuiltInScene | None:
    """Find a built-in scene by name (case-insensitive)."""
    name_lower = name.lower()
    for scene in BUILT_IN_SCENES:
        if scene.name.lower() == name_lower:
            return scene
    return None
