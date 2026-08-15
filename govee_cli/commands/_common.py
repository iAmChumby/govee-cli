"""Shared device-resolution helpers for commands.

Every command needs the same three things: figure out which device the user
meant, figure out which transport reaches it, and produce a clear error when the
requested feature does not exist on that transport. Centralising that here keeps
the per-command files down to their actual logic.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import click

if TYPE_CHECKING:
    from govee_cli.http_v2 import GoveeHTTPv2

from govee_cli.config import GoveeConfig, load_config
from govee_cli.transport import CLOUD_V2, ModelSpec, get_spec, resolve_target


class Target:
    """A resolved command target: which device, which model, which transport."""

    def __init__(self, device_id: str, model: str | None, transport: str,
                 config: GoveeConfig) -> None:
        self.device_id = device_id
        self.model = model
        self.transport = transport
        self.config = config

    @property
    def spec(self) -> ModelSpec | None:
        return get_spec(self.model)

    @property
    def ble_mac(self) -> str:
        """The address to hand to BLE, which is not the cloud device id.

        Govee's cloud identifies devices by an 8-octet id whose last 6 octets are
        the device's BLE address: the Light Bars are ``6D:19:DD:6E:86:46:44:0C``
        in the cloud and advertise as ``DD:6E:86:46:44:0C`` over Bluetooth
        (confirmed against ``bluetoothctl devices``: "DD:6E:86:46:44:0C
        Govee_H6056_440C"). Passing the 8-octet id straight to bleak can never
        connect, which is why a configured ``static_mac`` wins when present.
        """
        device = self.config.devices.get(self.device_id.upper())
        if device and device.static_mac:
            return device.static_mac
        octets = self.device_id.split(":")
        if len(octets) == 8:
            return ":".join(octets[2:])
        return self.device_id

    @property
    def cloud_model(self) -> str:
        """The model name, guaranteed non-None.

        A target only carries a cloud transport when a model was resolved, so on
        the cloud code paths this is always populated. It raises rather than
        returning None so a routing bug surfaces as a clear error instead of a
        malformed API request.
        """
        if not self.model:
            raise click.ClickException(
                f"Device '{self.device_id}' has no model recorded. "
                f"Run `govee-cli scan-http` to refresh the registry."
            )
        return self.model

    @property
    def label(self) -> str:
        """A human-readable identifier for messages."""
        device = self.config.devices.get(self.device_id.upper())
        if device and device.name:
            return device.name
        return self.device_id


def resolve(ctx: click.Context, device_ref: str | None) -> Target:
    """Resolve ``--device`` (or the configured default) to a :class:`Target`."""
    cfg = load_config()
    if device_ref is None and ctx.obj:
        device_ref = ctx.obj.get("default_mac")
    device_id, model, transport = resolve_target(cfg, device_ref)
    return Target(device_id, model, transport, cfg)


def v2_client() -> "GoveeHTTPv2":
    """Build a v2 client, converting configuration errors into CLI errors."""
    from govee_cli.http_v2 import GoveeHTTPv2, GoveeV2Error

    try:
        return GoveeHTTPv2()
    except GoveeV2Error as e:
        raise click.ClickException(str(e)) from e


def require_v2(target: Target, feature: str) -> "GoveeHTTPv2":
    """Ensure ``target`` is reachable over the v2 cloud API, and return a client.

    Raises a ClickException naming the feature and the model when it is not, so
    the user is told why rather than watching a command silently do nothing.
    """
    if target.transport != CLOUD_V2:
        raise click.ClickException(
            f"{feature} over the cloud requires a v2-capable model. "
            f"'{target.label}' is model '{target.model or 'unknown'}' "
            f"(transport: {target.transport})."
        )
    return v2_client()


def parse_hex(hex_color: str) -> tuple[int, int, int]:
    """Parse ``RRGGBB`` or ``#RRGGBB`` into an (r, g, b) tuple."""
    value = hex_color.lstrip("#").strip()
    if len(value) != 6:
        raise click.ClickException(
            f"Invalid hex color '{hex_color}'. Expected 6 hex digits, e.g. FF5500."
        )
    try:
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    except ValueError:
        raise click.ClickException(
            f"Invalid hex color '{hex_color}'. Expected 6 hex digits, e.g. FF5500."
        ) from None


def parse_segments(spec: str, segment_count: int) -> list[int]:
    """Parse a segment selector into a list of indices.

    Accepts ``all``, a comma-separated list, and inclusive ranges:
    ``all``, ``0``, ``0,3,7``, ``2-5``, ``0-2,8,11-14``.
    """
    spec = spec.strip().lower()
    if spec == "all":
        return list(range(segment_count))

    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            lo_s, _, hi_s = part.partition("-")
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError:
                raise click.ClickException(f"Invalid segment range: '{part}'") from None
            if lo > hi:
                raise click.ClickException(
                    f"Invalid segment range '{part}': start is greater than end."
                )
            out.extend(range(lo, hi + 1))
        else:
            try:
                out.append(int(part))
            except ValueError:
                raise click.ClickException(f"Invalid segment: '{part}'") from None

    if not out:
        raise click.ClickException(f"No segments selected from '{spec}'.")

    bad = [s for s in out if not 0 <= s < segment_count]
    if bad:
        raise click.ClickException(
            f"Segment(s) {bad} out of range. Valid range is 0-{segment_count - 1}."
        )

    # Preserve order but drop duplicates, so `0-2,1` doesn't send 1 twice.
    seen: set[int] = set()
    unique: list[int] = []
    for segment in out:
        if segment not in seen:
            seen.add(segment)
            unique.append(segment)
    return unique
