"""BLE device scanner."""

from dataclasses import dataclass

import bleak
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class DiscoveredDevice:
    """A BLE device discovered via scan."""

    mac: str
    name: str | None
    rssi: int
    manufacturer_data: dict[int, bytes]


async def discover_devices(timeout: float = 5.0) -> list[DiscoveredDevice]:
    """
    Scan for nearby BLE devices.

    Returns all discovered devices (not filtered by Govee yet —
    filtering happens in the caller).
    """
    logger.info("scanning", timeout=timeout)

    # return_adv=True is required in bleak 3.0 to get RSSI and manufacturer_data.
    # Without it, BLEDevice objects carry no advertisement payload.
    discovered = await bleak.BleakScanner.discover(timeout=timeout, return_adv=True)

    results = [
        DiscoveredDevice(
            mac=device.address,
            name=device.name,
            rssi=adv.rssi,
            manufacturer_data=adv.manufacturer_data,
        )
        for device, adv in discovered.values()
    ]

    logger.info("scan_complete", count=len(results))
    return results


def is_govee_device(device: DiscoveredDevice) -> bool:
    """Return True if this looks like a Govee device."""
    if device.name and "Govee" in device.name:
        return True
    # Govee manufacturer ID is 34819 (0x8803)
    if 34819 in device.manufacturer_data:
        return True
    return False
