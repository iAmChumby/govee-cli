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

    # Log all discovered devices for debugging
    for device in results:
        logger.debug("device_discovered", mac=device.mac, name=device.name, rssi=device.rssi)

    logger.info("scan_complete", count=len(results))
    return results


def is_govee_device(device: DiscoveredDevice) -> bool:
    """Return True if this looks like a Govee device."""
    if device.name:
        # Govee-branded devices (H6056, etc.)
        if "Govee" in device.name:
            return True
        # ihoment is Govee's OEM brand name (H6008, etc.)
        if "ihoment" in device.name.lower():
            return True
        # Some newer devices use GBK_ prefix
        if device.name.startswith("GBK_"):
            return True
        # H6008 and similar bulbs advertise as GVHxxxx (e.g., GVH60088F01)
        if device.name.upper().startswith("GVH"):
            return True

    # Govee manufacturer IDs
    # 0x8801 = 34817, 0x8802 = 34818, 0x8803 = 34819
    govee_manufacturer_ids = {34817, 34818, 34819}
    if any(manuf_id in govee_manufacturer_ids for manuf_id in device.manufacturer_data):
        return True

    return False
