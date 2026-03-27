"""BLE packet capture utility for reverse engineering.

This module provides utilities to capture BLE writes from the official
Govee app so we can replay effects and discover command encodings.

Usage:
1. Run: govee-cli record --output capture.json
2. Open Govee app on phone, trigger the effect you want to capture
3. Press Ctrl+C or send SIGINT — captured packets are saved
4. Review capture.json to identify the command format
"""

import asyncio
import json
import signal
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import bleak
import structlog

logger = structlog.get_logger(__name__)


@dataclass
class CapturedPacket:
    """A single BLE write captured during recording."""

    timestamp: float
    handle: int
    direction: str  # "write" or "notify"
    data: str  # hex string
    characteristic_uuid: str


class CaptureSession:
    """Records BLE writes and notifications to a file."""

    # Placeholder — must be verified with BLE sniffer
    STATE_CHAR = "0000fff7-0000-1000-8000-00805f9b34fb"

    def __init__(self, output_path: Path):
        self.output_path = output_path
        self.packets: list[CapturedPacket] = []
        self._running = False
        self._client: bleak.BleakClient | None = None

    async def start(self, mac: str, timeout: float = 60.0) -> None:
        """
        Start capturing BLE traffic to the target device.

        Keeps running until stop() is called or timeout expires.
        """
        self._running = True
        logger.info("capture_start", mac=mac, output=str(self.output_path))

        try:
            self._client = bleak.BleakClient(mac, timeout=timeout)

            async def on_notification(
                char: bleak.BleakGATTCharacteristic, data: bytearray
            ) -> None:
                self.packets.append(
                    CapturedPacket(
                        timestamp=time.time(),
                        handle=char.handle,
                        direction="notify",
                        data=data.hex(),
                        characteristic_uuid=str(char.uuid),
                    )
                )
                logger.debug("notification", handle=char.handle, data=data.hex())

            await self._client.connect()
            await self._client.start_notify(self.STATE_CHAR, on_notification)

            # Write packets to file periodically
            while self._running:
                await asyncio.sleep(1)
                self._flush()

        except asyncio.CancelledError:
            logger.info("capture_cancelled")
        finally:
            await self._stop_client()
            self._flush()

    async def _stop_client(self) -> None:
        """Stop BLE client cleanly."""
        if self._client and self._client.is_connected:
            try:
                await self._client.stop_notify(self.STATE_CHAR)
                await self._client.disconnect()
            except Exception as e:
                logger.warning("disconnect_error", error=str(e))

    def stop(self) -> None:
        """Request the capture session to stop."""
        self._running = False

    def _flush(self) -> None:
        """Write current packets to disk."""
        if not self.packets:
            return
        with open(self.output_path, "w") as f:
            json.dump([asdict(p) for p in self.packets], f, indent=2)
        logger.info("capture_flushed", packet_count=len(self.packets))


async def run_capture(mac: str, output_path: Path, timeout: float = 60.0) -> None:
    """Run a capture session with graceful Ctrl+C handling."""
    session = CaptureSession(output_path)

    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, session.stop)

    await session.start(mac, timeout)
