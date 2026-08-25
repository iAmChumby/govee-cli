"""Pydantic request/response models for the sidecar.

Request models carry the validation the spec pins at 400. Hex colours are
validated here (not in handlers) so every colour-taking endpoint rejects garbage
with the library's own message.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from govee_cli.commands._common import parse_hex


class PowerRequest(BaseModel):
    on: bool


class BrightnessRequest(BaseModel):
    value: int = Field(ge=1, le=100)


class ColorRequest(BaseModel):
    hex: str

    @field_validator("hex")
    @classmethod
    def _valid_hex(cls, v: str) -> str:
        try:
            parse_hex(v)
        except Exception as e:
            raise ValueError(str(getattr(e, "message", e))) from e
        return v


class TemperatureRequest(BaseModel):
    kelvin: int


class SegmentsRequest(BaseModel):
    segments: str | list[int]
    hex: str | None = None
    brightness: int | None = Field(default=None, ge=0, le=100)

    @field_validator("hex")
    @classmethod
    def _valid_hex(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            parse_hex(v)
        except Exception as e:
            raise ValueError(str(getattr(e, "message", e))) from e
        return v


class SceneApplyRequest(BaseModel):
    name: str


class DiyApplyRequest(BaseModel):
    name: str


class SnapshotApplyRequest(BaseModel):
    name_or_id: str


class MusicApplyRequest(BaseModel):
    mode: str
    sensitivity: int = Field(default=60, ge=0, le=100)
    auto_color: bool | None = None
    hex: str | None = None

    @field_validator("hex")
    @classmethod
    def _valid_hex(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            parse_hex(v)
        except Exception as e:
            raise ValueError(str(getattr(e, "message", e))) from e
        return v


class ToggleApplyRequest(BaseModel):
    instance: str
    on: bool


class DiscoverRequest(BaseModel):
    sync: bool = True


class GroupCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    devices: list[str] = Field(min_length=1)


class GroupRunRequest(BaseModel):
    command: str = Field(min_length=1)


class ScheduleCreateRequest(BaseModel):
    name: str = Field(min_length=1)
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    days: list[str] = Field(min_length=1)
    command: str = Field(min_length=1)
    device: str | None = None

    @field_validator("days")
    @classmethod
    def _valid_days(cls, v: list[str]) -> list[str]:
        allowed = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
        normalised = [day.title()[:3] for day in v]
        bad = [day for day in normalised if day not in allowed]
        if bad:
            raise ValueError(
                f"Invalid day(s) {bad}. Expected any of Mon Tue Wed Thu Fri Sat Sun."
            )
        return normalised


class SchedulePatchRequest(BaseModel):
    enabled: bool


class ConfigPatchRequest(BaseModel):
    default_mac: str | None = None
    default_timeout: float | None = Field(default=None, gt=0)
    default_brightness: int | None = Field(default=None, ge=0, le=100)
    default_color: str | None = None


class DeviceRegisterRequest(BaseModel):
    mac: str
    model: str
    name: str | None = None
    static_mac: str | None = None


class EffectPlayRequest(BaseModel):
    device: str
    file: str
    fps: float | None = Field(default=None, gt=0)
    force: Literal["ble", "cloud"] | None = None


class EffectCreateRequest(BaseModel):
    """A studio-authored effect, ready to be validated and saved as a file.

    Segments/keyframes are deliberately typed loosely (``dict[str, Any]``)
    rather than modeled field-by-field: ``govee_cli.scenes.effects.Effect
    .from_dict`` is the one real validator (the same one the CLI parses
    effect files with), and duplicating its rules here in stricter or looser
    form would let this endpoint diverge from what ``effect <file>`` actually
    accepts.
    """

    device: str
    name: str
    segments: list[dict[str, Any]]
    loop: bool = True
    fps: float = Field(default=30, gt=0)
    force: Literal["ble", "cloud"] | None = None


class SegmentCalibrationRequest(BaseModel):
    """Body for ``PUT /devices/{ref}/segment-calibration`` — see §5.3.

    ``calibrated_at`` is not accepted from the client; the server stamps it
    at write time so the timestamp always reflects when this record was
    actually persisted, not whatever the calling browser's clock says.
    """

    boundaries: list[int] = Field(min_length=1)
    permutation: list[int] = Field(min_length=1)
