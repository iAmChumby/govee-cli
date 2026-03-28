"""effect command — play DIY keyframe animations on the device."""

from __future__ import annotations

import asyncio
import pathlib
import time
from typing import TYPE_CHECKING

import click

if TYPE_CHECKING:
    from govee_cli.scenes.effects import ColorKeyframe, Effect


@click.command()
@click.argument("effect_file", type=click.Path(exists=True, path_type=pathlib.Path))
@click.option("--device", "mac", help="Device MAC address")
@click.option("--adapter", default="hci0", show_default=True, help="Bluetooth adapter")
@click.option("--fps", default=None, type=int, help="Override FPS from effect file")
@click.option("--no-loop", is_flag=True, help="Play once and exit (overrides loop setting in file)")
@click.pass_context
def command(
    ctx: click.Context,
    effect_file: pathlib.Path,
    mac: str | None,
    adapter: str,
    fps: int | None,
    no_loop: bool,
) -> None:
    """Play a DIY keyframe animation from a JSON file.

    Colors are linearly interpolated between keyframes and sent as
    per-segment BLE commands. Press Ctrl+C to stop.

    Example effect file (scenes/demo.json):

    \b
    {
      "name": "Demo",
      "fps": 5,
      "loop": true,
      "segments": [
        {"id": 0, "keyframes": [
          {"t": 0,    "color": "FF0000"},
          {"t": 2000, "color": "0000FF"}
        ]}
      ]
    }
    """
    mac = mac or ctx.obj.get("default_mac")
    if not mac:
        raise click.ClickException("No device MAC specified. Use --device or set default.")

    from govee_cli.scenes.effects import Effect

    effect = Effect.from_file(effect_file)
    if fps is not None:
        effect.fps = fps
    if no_loop:
        effect.loop = False

    click.echo(f"Playing effect: {effect.name}  ({effect.fps} fps, loop={effect.loop})")
    click.echo("Press Ctrl+C to stop.")

    try:
        asyncio.run(_play(effect, mac, adapter, ctx.obj.get("default_timeout", 10.0)))
    except KeyboardInterrupt:
        click.echo("\nStopped.")


async def _play(effect: "Effect", mac: str, adapter: str, timeout: float) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_segment

    if not effect.segments or not any(seg.keyframes for seg in effect.segments):
        raise click.ClickException("Effect has no keyframes.")

    total_ms = max(kf.t for seg in effect.segments for kf in seg.keyframes)
    if total_ms <= 0:
        raise click.ClickException("Effect duration must be > 0 ms.")

    frame_ms = 1000.0 / max(effect.fps, 1)

    async with GoveeBLE(mac, adapter=adapter, timeout=timeout) as client:
        while True:
            t = 0.0
            while t <= total_ms:
                frame_start = time.monotonic()
                for seg in effect.segments:
                    r, g, b = _color_at(seg.keyframes, t)
                    await client.send(encode_segment(seg.id, r, g, b))
                elapsed_ms = (time.monotonic() - frame_start) * 1000
                sleep_ms = frame_ms - elapsed_ms
                if sleep_ms > 0:
                    await asyncio.sleep(sleep_ms / 1000)
                t += frame_ms

            if not effect.loop:
                break


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _color_at(keyframes: "list[ColorKeyframe]", t: float) -> tuple[int, int, int]:
    """Return the interpolated RGB color at time t (ms)."""
    if not keyframes:
        return (255, 255, 255)
    if t <= keyframes[0].t:
        return _hex_to_rgb(keyframes[0].color)
    if t >= keyframes[-1].t:
        return _hex_to_rgb(keyframes[-1].color)
    for i in range(len(keyframes) - 1):
        kf0, kf1 = keyframes[i], keyframes[i + 1]
        if kf0.t <= t <= kf1.t:
            frac = (t - kf0.t) / (kf1.t - kf0.t) if kf1.t > kf0.t else 0.0
            c0, c1 = _hex_to_rgb(kf0.color), _hex_to_rgb(kf1.color)
            return (
                int(c0[0] + (c1[0] - c0[0]) * frac),
                int(c0[1] + (c1[1] - c0[1]) * frac),
                int(c0[2] + (c1[2] - c0[2]) * frac),
            )
    return _hex_to_rgb(keyframes[-1].color)
