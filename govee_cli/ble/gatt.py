"""GATT client wrapper for Govee BLE devices."""

import asyncio
import sys
from typing import Any

import bleak
import structlog

from govee_cli.ble.protocol import (
    Command,
    GoveeCharacteristic,
    LightState,
    build_packet,
    build_query_packet,
    parse_state,
)
from govee_cli.exceptions import (
    ConnectionFailed,
    ProtocolError,
    TimeoutError,
)

logger = structlog.get_logger(__name__)

DEFAULT_TIMEOUT = 10.0


class GoveeBLE:
    """
    BLE client for a Govee device.

    Wraps bleak.BleakClient with Govee-specific command encoding
    and notification handling.
    """

    def __init__(
        self,
        mac: str,
        adapter: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.mac = mac
        self.adapter = adapter
        self.timeout = timeout
        self._client: bleak.BleakClient | None = None

    async def connect(self) -> None:
        """
        Connect to the device.

        Tries the configured MAC directly first. If not found (common on Linux
        when the device advertises under a random/resolvable address), falls back
        to scanning and connecting to the first matching Govee device.
        """
        logger.info("connecting", mac=self.mac, adapter=self.adapter)
        try:
            # Use a short probe timeout — if the static MAC isn't in BlueZ's
            # cache (common when the device uses a random advertising address),
            # we want to fall through to scan quickly rather than waiting the
            # full timeout.
            probe_timeout = min(3.0, self.timeout)
            use_adapter = sys.platform == "linux" and bool(self.adapter)
            self._client = bleak.BleakClient(
                self.mac,
                adapter=self.adapter if use_adapter else None,  # type: ignore[arg-type]
                timeout=probe_timeout,
            )
            await self._client.connect()
            logger.info("connected", mac=self.mac)
        except bleak.exc.BleakError as e:
            if "not found" not in str(e).lower():
                raise ConnectionFailed(f"Failed to connect to {self.mac}: {e}") from e
            logger.info("not_found_trying_scan", mac=self.mac)
            resolved = await self._resolve_via_scan()
            if resolved is None:
                raise ConnectionFailed(
                    f"Device {self.mac} not found directly or via scan."
                ) from e
            self._client = bleak.BleakClient(
                resolved,
                adapter=self.adapter if use_adapter else None,  # type: ignore[arg-type]
                timeout=self.timeout,
            )
            await self._client.connect()
            logger.info("connected_via_scan", static_mac=self.mac, resolved=resolved)

    async def _resolve_via_scan(self) -> str | None:
        """
        Scan for a Govee device when the static MAC isn't directly reachable.

        Matches by name prefix 'Govee' — works for single-device setups.
        If multiple Govee devices are found, prefers the one whose name suffix
        matches the last 4 hex digits of the configured MAC.
        """
        discovered = await bleak.BleakScanner.discover(
            timeout=5.0, return_adv=True
        )
        govee_devices = [
            (device, adv)
            for device, adv in discovered.values()
            if device.name and "Govee" in device.name
        ]
        if not govee_devices:
            return None
        if len(govee_devices) == 1:
            return govee_devices[0][0].address
        # Multiple Govee devices — prefer one whose name ends with last 4 of MAC
        suffix = self.mac.replace(":", "")[-4:].upper()
        for device, _ in govee_devices:
            if device.name and device.name.upper().endswith(suffix):
                return device.address
        # Fall back to first found
        return govee_devices[0][0].address

    async def disconnect(self) -> None:
        """Disconnect from the device."""
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            logger.info("disconnected", mac=self.mac)
        self._client = None

    async def execute(self, command: Command) -> bool:
        """
        Send a command to the device and wait for acknowledgment.

        All commands are written to GoveeCharacteristic.WRITE. Responses
        arrive as notifications on GoveeCharacteristic.NOTIFY.

        Returns True on success, raises an exception on failure.
        """
        if not self._client or not self._client.is_connected:
            raise ConnectionFailed("Not connected. Call connect() first.")

        packet = build_packet(command)
        logger.debug("executing", command=command.type.name, packet=packet.hex())

        try:
            response_future: asyncio.Future[bytes] = asyncio.Future()

            # bleak 3.0: callback is (BleakGATTCharacteristic, bytearray)
            async def notification_handler(
                char: bleak.BleakGATTCharacteristic, data: bytearray
            ) -> None:
                if not response_future.done():
                    response_future.set_result(bytes(data))

            notify_char = GoveeCharacteristic.NOTIFY
            subscribed = False
            if self._client.services.get_characteristic(notify_char) is not None:
                await self._client.start_notify(notify_char, notification_handler)
                subscribed = True

            await self._client.write_gatt_char(
                GoveeCharacteristic.WRITE, packet, response=True
            )

            try:
                response = await asyncio.wait_for(
                    response_future, timeout=self.timeout
                )
            except asyncio.TimeoutError:
                raise TimeoutError(
                    f"Device did not respond to {command.type.name} "
                    f"within {self.timeout}s"
                ) from None
            finally:
                if subscribed:
                    try:
                        await self._client.stop_notify(notify_char)
                    except Exception:
                        pass  # best effort

            if not self._verify_response(response, command):
                raise ProtocolError(f"Invalid response to {command.type.name}")

            return True

        except bleak.exc.BleakError as e:
            raise ConnectionFailed(f"BLE error during execute: {e}") from e

    async def read_state(self) -> LightState:
        """
        Read current state from the device.

        Subscribes to GoveeCharacteristic.NOTIFY and waits for the device
        to send its current state. A query command may be needed for devices
        that don't push state on connect — format TBD after btmon capture.
        """
        if not self._client or not self._client.is_connected:
            raise ConnectionFailed("Not connected. Call connect() first.")

        notify_char = GoveeCharacteristic.NOTIFY
        if self._client.services.get_characteristic(notify_char) is None:
            raise ProtocolError("Notify characteristic not found on this device.")

        state_future: asyncio.Future[bytes] = asyncio.Future()

        async def handler(
            char: bleak.BleakGATTCharacteristic, data: bytearray
        ) -> None:
            if not state_future.done():
                state_future.set_result(bytes(data))

        try:
            await self._client.start_notify(notify_char, handler)
            # Send query packet to prompt device to send its current state
            await self._client.write_gatt_char(
                GoveeCharacteristic.WRITE, build_query_packet(), response=True
            )
            data = await asyncio.wait_for(state_future, timeout=self.timeout)
            logger.debug("state_raw", hex=data.hex(" "), length=len(data))
            return parse_state(data)
        except asyncio.TimeoutError:
            raise TimeoutError("Device did not send state notification.") from None
        except bleak.exc.BleakError as e:
            raise ProtocolError(f"Failed to read state: {e}") from e
        finally:
            try:
                await self._client.stop_notify(notify_char)
            except Exception:
                pass

    async def send(self, command: Command) -> None:
        """
        Send a command without waiting for acknowledgment.

        Used for high-frequency updates like effect playback where waiting
        for a NOTIFY response on every packet would be too slow.
        """
        if not self._client or not self._client.is_connected:
            raise ConnectionFailed("Not connected. Call connect() first.")
        packet = build_packet(command)
        logger.debug("sending", command=command.type.name, packet=packet.hex())
        try:
            await self._client.write_gatt_char(
                GoveeCharacteristic.WRITE, packet, response=False
            )
        except bleak.exc.BleakError as e:
            raise ConnectionFailed(f"BLE error during send: {e}") from e

    def _verify_response(self, response: bytes, command: Command) -> bool:
        """Basic response verification — placeholder for now."""
        return len(response) > 0

    async def __aenter__(self) -> "GoveeBLE":
        await self.connect()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()
