"""Custom exceptions for govee-cli."""


class GoveeError(Exception):
    """Base exception for all govee-cli errors."""

    pass


class DeviceNotFound(GoveeError):
    """Raised when a BLE scan finds no Govee devices."""

    pass


class ConnectionFailed(GoveeError):
    """Raised when a connection to the device cannot be established."""

    pass


class TimeoutError(GoveeError):
    """Raised when a BLE operation times out."""

    pass


class ProtocolError(GoveeError):
    """Raised when the device returns an unexpected response."""

    pass


class UnsupportedDevice(GoveeError):
    """Raised when the device model is not supported."""

    pass


class AuthenticationError(GoveeError):
    """Raised when device authentication fails."""

    pass
