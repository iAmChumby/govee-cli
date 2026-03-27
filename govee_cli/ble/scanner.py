"""BLE device scanner."""

import logging
from dataclasses import dataclass

import bleak

logger = logging.getLogger(__name__)


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

    devices = await bleak.BleakScanner.discover(timeout=timeout)
    results: list[DiscoveredDevice] = []

    for device in devices:
        results.append(
            DiscoveredDevice(
                mac=device.address,
                name=device.name,
                rssi=device.rssi,
                manufacturer_data=device.metadata.get("manufacturer_data", {}),
            )
        )

    logger.info("scan_complete", count=len(results))
    return results


def is_govee_device(device: DiscoveredDevice) -> bool:
    """Return True if this looks like a Govee device."""
    if device.name and "Govee" in device.name:
        return True
    # Govee manufacturer ID is 6144 (0x1800) — verified from existing devices
    if 6144 in device.manufacturer_data:
        return True
    return False
