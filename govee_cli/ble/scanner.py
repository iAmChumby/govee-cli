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


def _parse_device(device: bleak.BLEDevice) -> DiscoveredDevice:
    """Parse a bleak BLEDevice (v3.0 API) into a DiscoveredDevice."""
    # In bleak 3.0, RSSI and ManufacturerData live in details['props']
    props = device.details.get("props", {})
    rssi = props.get("RSSI", 0)
    mfg_data: dict[int, bytes] = props.get("ManufacturerData", {})

    return DiscoveredDevice(
        mac=device.address,
        name=device.name,
        rssi=rssi,
        manufacturer_data=mfg_data,
    )


async def discover_devices(timeout: float = 5.0) -> list[DiscoveredDevice]:
    """
    Scan for nearby BLE devices.

    Returns all discovered devices (not filtered by Govee yet —
    filtering happens in the caller).
    """
    logger.info("scanning", timeout=timeout)

    devices = await bleak.BleakScanner.discover(timeout=timeout)
    results = [_parse_device(d) for d in devices]

    logger.info("scan_complete", count=len(results))
    return results


def is_govee_device(device: DiscoveredDevice) -> bool:
    """Return True if this looks like a Govee device."""
    if device.name and "Govee" in device.name:
        return True
    # Govee manufacturer ID is 34819 (0x8803) based on capture above
    if 34819 in device.manufacturer_data:
        return True
    return False
