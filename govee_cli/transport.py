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

    Attributes:
        model: SKU as Govee reports it, uppercase.
        transport: Which transport carries power/brightness/color/temp/state.
        segment_count: Addressable segments, 0 if the model has none.
        temp_min/temp_max: Colour-temperature bounds the device actually accepts.
        cloud_scenes: Whether scenes are reachable over the cloud transport.
            False means scenes are BLE-only for this model.
        cloud_segments: Whether per-segment colour is reachable over the cloud.
        cloud_music: Whether firmware music mode is reachable over the cloud.
        toggles: Boolean toggle capability instances the model advertises.
    """

    model: str
    transport: str
    segment_count: int = 0
    temp_min: int = 2700
    temp_max: int = 9000
    cloud_scenes: bool = False
    cloud_segments: bool = False
    cloud_music: bool = False
    toggles: tuple[str, ...] = field(default_factory=tuple)


# Verified against live hardware. Capability flags reflect what the device
# actually did, not merely what the API advertised.
MODEL_SPECS: dict[str, ModelSpec] = {
    "H6056": ModelSpec(
        model="H6056",
        transport=CLOUD_V1,
        segment_count=6,
        # The v1 API advertises colorTem 2000-9000 for this model, and the bars
        # report 2000K when set from the Govee app. The old CLI-side floor of
        # 2700 was stricter than the hardware.
        temp_min=2000,
        temp_max=9000,
        # The v1 client has no scene/segment/music vocabulary, so these stay on
        # BLE for the light bars, matching long-verified behaviour.
        cloud_scenes=False,
        cloud_segments=False,
        cloud_music=False,
    ),
    "H6008": ModelSpec(
        model="H6008",
        transport=CLOUD_V1,
        segment_count=1,
        temp_min=2700,
        temp_max=6500,
    ),
    "H6183": ModelSpec(
        model="H6183",
        transport=CLOUD_V1,
    ),
    "H6022": ModelSpec(
        model="H6022",
        transport=CLOUD_V2,
        segment_count=15,
        temp_min=2700,
        temp_max=6500,
        cloud_scenes=True,
        cloud_segments=True,
        cloud_music=True,
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
    return device_id, model, transport_for(model)
