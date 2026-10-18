"""Pydantic request/response models for the sidecar.

Request models carry the validation the spec pins at 400. Hex colours are
validated here (not in handlers) so every colour-taking endpoint rejects garbage
with the library's own message.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from govee_cli.commands._common import parse_hex
from govee_cli.ledger import Mode


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


_DAY_NAMES = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _normalise_days(v: list[str]) -> list[str]:
    normalised = [day.title()[:3] for day in v]
    bad = [day for day in normalised if day not in _DAY_NAMES]
    if bad:
        raise ValueError(
            f"Invalid day(s) {bad}. Expected any of Mon Tue Wed Thu Fri Sat Sun."
        )
    return normalised


class ScheduleWriteRequest(BaseModel):
    """Body for ``POST /schedules`` and ``PUT /schedules/{id}`` (issue #2).

    ``time`` is validated and stored in canonical form by
    ``govee_cli.schedule.timespec.normalise_time``. Exactly one target:
    ``command`` (with optional ``device``) XOR ``room_scene``.
    """

    name: str = Field(min_length=1)
    time: str = Field(min_length=1)
    days: list[str] = Field(min_length=1)
    command: str = ""
    device: str | None = None
    room_scene: str | None = None
    enabled: bool = True

    @field_validator("time")
    @classmethod
    def _valid_time(cls, v: str) -> str:
        from govee_cli.schedule.timespec import TimeSpecError, normalise_time

        try:
            return normalise_time(v)
        except TimeSpecError as e:
            raise ValueError(str(e)) from e

    @field_validator("days")
    @classmethod
    def _valid_days(cls, v: list[str]) -> list[str]:
        return _normalise_days(v)

    @model_validator(mode="after")
    def _one_target(self) -> ScheduleWriteRequest:
        has_command = bool(self.command.strip())
        has_scene = bool(self.room_scene and self.room_scene.strip())
        if has_command == has_scene:
            raise ValueError(
                "A rule needs exactly one target: a command (with an optional "
                "device) or a room scene."
            )
        if has_scene and self.device:
            raise ValueError("A room-scene rule targets the scene's devices; drop 'device'.")
        return self


# Kept so existing imports keep working; create and edit share one body.
ScheduleCreateRequest = ScheduleWriteRequest


class SchedulePatchRequest(BaseModel):
    enabled: bool


class SchedulePreviewRequest(BaseModel):
    """Body for ``POST /schedules/preview``: the rule dialog's resolved line."""

    time: str
    days: list[str] = Field(default_factory=lambda: list(_DAY_NAMES))


class ScheduleRuleOut(BaseModel):
    """One rule in ``GET /schedules``. Datetimes are ISO-8601 carrying the offset
    of the schedule's zone, floored to the minute; the UI shows ``HH:MM`` only."""

    id: str
    name: str
    time: str  # canonical
    days: list[str]
    command: str
    enabled: bool
    device: str | None
    room_scene: str | None
    next_run: str | None
    next_run_reason: str | None
    today_fire: str | None
    today_reason: str | None
    target_problem: str | None
    last_result: str | None  # ok|error|missed|skipped|would_fire
    last_detail: str | None
    last_at: str | None
    missed_minute: str | None


class SchedulerOwnerOut(BaseModel):
    """Who owns the schedule, read from the heartbeat + lock (G1, G4)."""

    state: Literal["running", "stale", "nobody", "unknown"]
    kind: Literal["sidecar", "daemon"] | None
    dry_run: bool
    pid: int | None
    host: str | None
    started_at: str | None
    last_cycle_at: str | None
    poll_seconds: float | None
    stale_since: str | None
    detail: str | None
    # Seconds since the last heartbeat, measured at request time. The ISO
    # timestamps above are floored to the minute, so an age derived from them
    # could only ever read "0s" or "1m".
    last_cycle_age_seconds: int | None = None
    # This sidecar process's own relation to the lock.
    this_process: Literal["owner", "waiting", "disabled"]


class ScheduleLocationOut(BaseModel):
    latitude: float | None
    longitude: float | None
    timezone: str
    timezone_source: Literal["config", "host"]


class ScheduleLastFireOut(BaseModel):
    rule_id: str
    rule_name: str
    at: str
    result: str


class ScheduleListOut(BaseModel):
    schedules: list[ScheduleRuleOut]
    owner: SchedulerOwnerOut
    location: ScheduleLocationOut
    now: str  # server "now" in the schedule's zone, ISO; drives Today/Tomorrow labels
    last_fire: ScheduleLastFireOut | None
    state_readable: bool  # False -> last results render "unknown", never "none yet"


class SchedulePreviewOut(BaseModel):
    canonical_time: str | None
    error: str | None
    event_time: str | None
    today_fire: str | None
    next_run: str | None
    reason: str | None
    location: ScheduleLocationOut


class ConfigPatchRequest(BaseModel):
    default_mac: str | None = None
    default_timeout: float | None = Field(default=None, gt=0)
    default_brightness: int | None = Field(default=None, ge=0, le=100)
    default_color: str | None = None
    # Issue #2. Omitted fields stay unchanged; `clear_location` removes all three.
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    timezone: str | None = None
    clear_location: bool = False

    @field_validator("timezone")
    @classmethod
    def _valid_timezone(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as e:
            raise ValueError(
                f"Unknown timezone '{v}'. Use an IANA name like America/New_York."
            ) from e
        return v


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


class ActiveModeSetRequest(BaseModel):
    """Body for ``PUT /devices/{ref}/active-mode`` — see §3.6.

    Corrects the ledger's record of what mode the device is in without
    commanding the device itself. Used for the manual "unknown" mode reset
    and for correcting transient ledger mismatches (phone-app interference,
    etc.).
    """

    mode: Mode
    label: str | None = None
    payload: dict[str, Any] | None = None


class RoomSceneCaptureRequest(BaseModel):
    """Body for ``POST /rooms`` — captures a room scene.

    The scene name is the user-supplied label for this room-state snapshot.
    """

    name: str = Field(min_length=1)


class RoomSceneRestoreRequest(BaseModel):
    """Body for ``POST /rooms/{name}/restore`` — placeholder for future use.

    An empty body today ensures the route signature is versioned separately
    from the request payload, so restoration options can be added later
    without a breaking change.
    """

    pass


class AuthoredDeviceIn(BaseModel):
    """One device in a hand-authored room scene (issue #2, G7).

    ``power=False`` stores mode ``off``. Otherwise ``mode`` picks exactly one of
    colour (``color`` hex), white (``color_temp_k``, within the model's
    temp_min..temp_max; the route checks against MODEL_SPECS), or DIY
    (``diy_value`` + ``diy_name``; the route checks the model has cloud_diy).
    """

    device_id: str = Field(min_length=1)
    power: bool = True
    brightness: int = Field(default=50, ge=1, le=100)
    mode: Literal["colour", "white", "diy"] | None = "white"
    color: str | None = None  # RRGGBB, '#' optional
    color_temp_k: int | None = None
    diy_value: int | None = None
    diy_name: str | None = None

    @model_validator(mode="after")
    def _mode_fields(self) -> AuthoredDeviceIn:
        if not self.power:
            return self
        if self.mode is None:
            raise ValueError(f"{self.device_id}: a powered-on device needs a mode.")
        if self.mode == "colour" and not self.color:
            raise ValueError(f"{self.device_id}: colour mode needs a colour.")
        if self.mode == "white" and self.color_temp_k is None:
            raise ValueError(f"{self.device_id}: white mode needs a colour temperature.")
        if self.mode == "diy" and (self.diy_value is None or not self.diy_name):
            raise ValueError(f"{self.device_id}: DIY mode needs a DIY scene.")
        return self


class RoomSceneAuthorRequest(BaseModel):
    """Body for ``POST /rooms/authored``."""

    name: str = Field(min_length=1)
    devices: list[AuthoredDeviceIn] = Field(min_length=1)


class RoomSceneUpdateRequest(BaseModel):
    """Body for ``PUT /rooms/{name}`` (authored scenes only; 409 for captured)."""

    devices: list[AuthoredDeviceIn] = Field(min_length=1)
