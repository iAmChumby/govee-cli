"""GATT client wrapper for Govee BLE devices."""

import asyncio
import logging
from typing import Any

import bleak

from govee_cli.ble.protocol import (
    Command,
    GoveeCharacteristic,
    LightState,
    build_packet,
    parse_state,
)
from govee_cli.exceptions import (
    ConnectionFailed,
    ProtocolError,
    TimeoutError,
)

logger = logging.getLogger(__name__)

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
        adapter: str = "hci0",
        timeout: float = DEFAULT_TIMEOUT,
    ):
        self.mac = mac
        self.adapter = adapter
        self.timeout = timeout
        self._client: bleak.BleakClient | None = None

    async def connect(self) -> None:
        """Connect to the device."""
        logger.info("connecting", mac=self.mac, adapter=self.adapter)  # type: ignore[call-arg]
        try:
            self._client = bleak.BleakClient(
                self.mac,
                device=self.adapter,
                timeout=self.timeout,
            )
            await self._client.connect()
            logger.info("connected", mac=self.mac)  # type: ignore[call-arg]
        except bleak.exc.BleakError as e:
            raise ConnectionFailed(f"Failed to connect to {self.mac}: {e}") from e

    async def disconnect(self) -> None:
        """Disconnect from the device."""
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            logger.info("disconnected", mac=self.mac)
        self._client = None

    async def execute(self, command: Command) -> bool:
        """
        Send a command to the device and wait for acknowledgment.

        Returns True on success, raises an exception on failure.
        """
        if not self._client or not self._client.is_connected:
            raise ConnectionFailed("Not connected. Call connect() first.")

        packet = build_packet(command)
        char_uuid = self._characteristic_for(command.type)

        logger.debug("executing", command=command.type.name, char=char_uuid)

        try:
            # Set up a future to capture the notification response
            response_future: asyncio.Future[bytes] = asyncio.Future()

            # bleak 3.0: callback signature is (BleakGATTCharacteristic, bytearray)
            async def notification_handler(
                char: bleak.BleakGATTCharacteristic, data: bytearray
            ) -> None:
                if not response_future.done():
                    response_future.set_result(bytes(data))

            # Subscribe to the state characteristic for the response
            state_char = GoveeCharacteristic.STATE
            if state_char in self._client.services.characteristics:
                await self._client.start_notify(state_char, notification_handler)

            # Write the command
            await self._client.write_gatt_char(char_uuid, packet, response=True)

            # Wait for response with timeout
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
                try:
                    await self._client.stop_notify(state_char)
                except Exception:
                    pass  # best effort

            # Verify response (basic check for now)
            if not self._verify_response(response, command):
                raise ProtocolError(f"Invalid response to {command.type.name}")

            return True

        except bleak.exc.BleakError as e:
            raise ConnectionFailed(f"BLE error during execute: {e}") from e

    async def read_state(self) -> LightState:
        """Read current state from the device."""
        if not self._client or not self._client.is_connected:
            raise ConnectionFailed("Not connected. Call connect() first.")

        state_char = GoveeCharacteristic.STATE
        try:
            data = await self._client.read_gatt_char(state_char)
            return parse_state(data)
        except bleak.exc.BleakError as e:
            raise ProtocolError(f"Failed to read state: {e}") from e

    def _characteristic_for(self, cmd_type: Any) -> str:
        """Map a command type to its GATT characteristic UUID."""
        mapping = {
            0x01: GoveeCharacteristic.POWER,
            0x02: GoveeCharacteristic.BRIGHTNESS,
            0x03: GoveeCharacteristic.COLOR,
            0x04: GoveeCharacteristic.TEMP,
            0x05: GoveeCharacteristic.SCENE,
            0x06: GoveeCharacteristic.SEGMENT,
            0x07: GoveeCharacteristic.MUSIC,
            0x08: GoveeCharacteristic.EFFECT,
            0x09: GoveeCharacteristic.STATE,
        }
        return mapping.get(cmd_type.value, GoveeCharacteristic.POWER)

    def _verify_response(self, response: bytes, command: Command) -> bool:
        """Basic response verification — placeholder for now."""
        return len(response) > 0

    async def __aenter__(self) -> "GoveeBLE":
        await self.connect()
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.disconnect()
