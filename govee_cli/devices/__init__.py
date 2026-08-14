"""Device handlers for supported Govee models."""

from typing import Type, Union

from govee_cli.devices.h6008 import H6008
from govee_cli.devices.h6022 import H6022
from govee_cli.devices.h6056 import H6056

DeviceHandler = Union[H6056, H6008, H6022]

# Registry of supported devices
SUPPORTED_DEVICES: dict[str, Type[DeviceHandler]] = {
    "H6056": H6056,
    "H6008": H6008,
    "H6022": H6022,
}


def get_device_handler(model: str) -> Type[DeviceHandler]:
    """Return the device handler class for a model name."""
    handler = SUPPORTED_DEVICES.get(model.upper())
    if handler is None:
        from govee_cli.exceptions import UnsupportedDevice

        supported = ", ".join(SUPPORTED_DEVICES.keys())
        raise UnsupportedDevice(f"Unsupported device: {model}. Supported: {supported}")
    return handler
