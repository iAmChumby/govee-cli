"""Device handlers for supported Govee models."""

from typing import Type, Union

from govee_cli.devices.h6008 import H6008
from govee_cli.devices.h6056 import H6056

# Registry of supported devices
SUPPORTED_DEVICES: dict[str, Type[Union[H6056, H6008]]] = {
    "H6056": H6056,
    "H6008": H6008,
}


def get_device_handler(model: str) -> Type[Union[H6056, H6008]]:
    """Return the device handler class for a model name."""
    handler = SUPPORTED_DEVICES.get(model.upper())
    if handler is None:
        from govee_cli.exceptions import UnsupportedDevice

        supported = ", ".join(SUPPORTED_DEVICES.keys())
        raise UnsupportedDevice(f"Unsupported device: {model}. Supported: {supported}")
    return handler
