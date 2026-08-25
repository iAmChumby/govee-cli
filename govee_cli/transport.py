"""Which transport reaches which model.

Before this module the routing rule was a literal ``["H6008", "H6183", "H6056"]``
copy-pasted into every command, which meant adding a model required editing each
command file and made the v1/v2 split impossible to express. Routing now lives
here and commands ask for it.

Three transports are in play:

``cloud-v1``
    Legacy ``developer-api.govee.com``. Fixed vocabulary: power, brightness,
    color, colorTem, state. Verified against the H6056 and H6008.

``cloud-v2``
    ``openapi.api.govee.com``. Capability-based, and the only cloud path to
    scenes, DIY scenes, per-segment colour and music mode. Required for the
    H6022, which the v1 device list omits entirely.

``ble``
    Direct GATT. The only transport for scenes/effects/segments on the H6056,
    and the fallback for anything not registered as a cloud model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from govee_cli.config import GoveeConfig

CLOUD_V1 = "cloud-v1"
CLOUD_V2 = "cloud-v2"
BLE = "ble"


@dataclass(frozen=True)
class ModelSpec:
    """Everything routing needs to know about a model.

    Every flag here records what the hardware *did*, not what the API
    advertised. Those differ: the H6056 advertises ``dreamViewToggle`` and then
    rejects it at control time with "The device does not has DreamView", so the
    advertised capability list is a starting point for probing, never a
    guarantee.

    Attributes:
        model: SKU as Govee reports it, uppercase.
        transport: Which transport carries power/brightness/color/temp/state.
        segment_count: Segments addressable over the cloud, 0 if none. This is
            the bound the API itself enforces, which is not always the number of
            physical zones — see ``ble_segment_count``.
        ble_segment_count: Segments addressable over BLE, which uses a different
            encoding and a different count on the same device.
        temp_min/temp_max: Colour-temperature bounds the device actually accepts.
        cloud_scenes: Firmware scenes reachable over the cloud.
        cloud_diy: User DIY scenes reachable over the cloud.
        cloud_segments: Per-segment colour reachable over the cloud.
        cloud_segment_brightness: Per-segment *brightness* reachable. Separate
            from cloud_segments — the H6056 has both, the H6022 only colour.
        cloud_music: Firmware music mode reachable over the cloud.
        toggles: Toggle instances verified to actually work on the hardware.
        prefer_ble_effects: Run keyframe effects over BLE even though the
            device's primary transport is cloud. Cloud playback is capped at
            2fps by the request budget; BLE runs at full speed, so for a device
            that can do both, BLE is strictly better for animation.
        matrix_rows: Number of rows in the device's matrix geometry, 0 if not
            a matrix device. Used by the paint studio to render per-cell
            addressability for devices like the H6022 (11×12 wrapped drum).
        matrix_cols: Number of columns in the device's matrix geometry, 0 if not
            a matrix device.
        matrix_wrap_col: Whether the matrix wraps around (columns wrap to form
            a cylinder, like the H6022 drum). False for linear bars (H6056) or
            devices without a matrix.
    """

    model: str
    transport: str
    segment_count: int = 0
    ble_segment_count: int = 0
    temp_min: int = 2700
    temp_max: int = 9000
    cloud_scenes: bool = False
    cloud_diy: bool = False
    cloud_segments: bool = False
    cloud_segment_brightness: bool = False
    cloud_music: bool = False
    toggles: tuple[str, ...] = field(default_factory=tuple)
    prefer_ble_effects: bool = False
    matrix_rows: int = 0
    matrix_cols: int = 0
    matrix_wrap_col: bool = False


# Verified against live hardware 2026-08-14. Capability flags reflect what the
# device actually did, not merely what the API advertised.
MODEL_SPECS: dict[str, ModelSpec] = {
    "H6056": ModelSpec(
        model="H6056",
        # Moved from v1 to v2: v1 could only carry power/brightness/color/temp,
        # which left 69 firmware scenes, DIY scenes, cloud segments, 8 music
        # modes and the gradient toggle unreachable. All four basic commands
        # were re-verified over v2 with state readback before this switch.
        transport=CLOUD_V2,
        # The v2 API accepts and enforces 0-14. The BLE path uses its own
        # 6-segment encoding, hence the two counts.
        segment_count=15,
        ble_segment_count=6,
        # The v1 API advertised colorTem 2000-9000 for this model, and the bars
        # report 2000K when set from the Govee app. The old CLI-side floor of
        # 2700 was stricter than the hardware.
        temp_min=2000,
        temp_max=9000,
        cloud_scenes=True,
        cloud_diy=True,
        cloud_segments=True,
        cloud_segment_brightness=True,
        cloud_music=True,
        # dreamViewToggle is advertised by the API but rejected by this unit,
        # so it is deliberately absent here.
        toggles=("gradientToggle",),
        # The bars are the one device that can do both, and BLE animates far
        # faster than the cloud's 2fps ceiling.
        prefer_ble_effects=True,
        # The H6056 is actually two bars (rows), with an authoring resolution
        # of 48 columns per bar for smooth gradients/motion (not a hardware fact
        # — the bars have no native pixel grid). No column wrapping (linear bars).
        matrix_rows=2,
        matrix_cols=48,
        matrix_wrap_col=False,
    ),
    "H6008": ModelSpec(
        model="H6008",
        # Also moved to v2, which unlocks 56 firmware scenes and DIY scenes on
        # a bulb that previously had no scene support over any transport.
        transport=CLOUD_V2,
        segment_count=0,
        temp_min=2700,
        temp_max=6500,
        cloud_scenes=True,
        cloud_diy=True,
        # Verified rejected by the hardware: segments and music both return
        # 400 "devices not support this instance".
        cloud_segments=False,
        cloud_music=False,
    ),
    "H6183": ModelSpec(
        model="H6183",
        # Left on v1: no hardware on hand to verify a v2 move against, and an
        # unverified switch is exactly the kind of change that breaks silently.
        transport=CLOUD_V1,
    ),
    "H6022": ModelSpec(
        model="H6022",
        transport=CLOUD_V2,
        segment_count=15,
        temp_min=2700,
        temp_max=6500,
        cloud_scenes=True,
        cloud_diy=True,
        cloud_segments=True,
        # Verified rejected: 400 "devices not support this instance".
        cloud_segment_brightness=False,
        cloud_music=True,
        # The H6022 is a 132-LED matrix arranged as 12 columns wrapped around
        # × 11 rows (led_index = row * 12 + col). The cloud API addresses it
        # through 15 linear segments, which the firmware interpolates onto the
        # matrix by an undocumented rule. Wrapping is true because the drum
        # cylinders, so columns wrap around.
        matrix_rows=11,
        matrix_cols=12,
        matrix_wrap_col=True,
    ),
}


def get_spec(model: str | None) -> ModelSpec | None:
    """Return the ModelSpec for a model name, or None if unregistered."""
    if not model:
        return None
    return MODEL_SPECS.get(model.upper())


def transport_for(model: str | None) -> str:
    """Return the transport carrying basic control for a model.

    Unregistered models fall back to BLE, preserving the previous behaviour for
    anything the cloud does not know about.
    """
    spec = get_spec(model)
    return spec.transport if spec else BLE


def is_cloud(model: str | None) -> bool:
    """Return True if basic control for this model goes over the cloud."""
    return transport_for(model) in (CLOUD_V1, CLOUD_V2)


def resolve_target(
    config: "GoveeConfig", ref: str | None
) -> tuple[str, str | None, str]:
    """Resolve a device reference to ``(device_id, model, transport)``.

    Args:
        config: A loaded :class:`~govee_cli.config.GoveeConfig`.
        ref: Device name or MAC/ID. Falls back to the configured default.

    Raises:
        click.ClickException: If no device can be determined.
    """
    import click

    from govee_cli.config import resolve_device_ref

    ref = ref or config.default_mac
    if not ref:
        raise click.ClickException(
            "No device specified. Use --device or set a default with `govee-cli config`."
        )

    try:
        device_id, device_cfg = resolve_device_ref(config, ref)
    except Exception:
        # An unregistered MAC is still usable over BLE, which is how the CLI
        # behaved before a device registry existed.
        return ref, None, BLE

    model = device_cfg.model
    transport = transport_for(model)

    # Both Govee cloud APIs address devices by an 8-octet id. A 6-octet BLE MAC
    # in the registry means the device was added by hand via `config
    # --device-mac` (the only way before these models had a cloud path), and
    # sending that id to the cloud gets a device Govee has never heard of. Fail
    # here with the fix rather than emitting a malformed request.
    if transport in (CLOUD_V1, CLOUD_V2) and len(device_id.split(":")) == 6:
        raise click.ClickException(
            f"'{ref}' is registered with a 6-octet Bluetooth MAC ({device_id}), "
            f"but {model} is controlled over the Govee cloud, which needs the "
            f"8-octet device id from your account.\n"
            f"Run `govee-cli scan-http` to re-register it."
        )

    return device_id, model, transport
