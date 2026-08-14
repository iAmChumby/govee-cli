"""effect command — play DIY keyframe animations on the device.

Two playback engines share one effect format:

BLE
    One packet per segment per frame, straight to the device. Fast enough for
    30fps animation because packets are local and free.

Cloud v2
    Each frame costs HTTP requests against a daily account budget, so the engine
    caps the frame rate and batches segments: every segment showing the same
    colour in a frame is sent as one request, because the v2 segment capability
    takes an array of segment indices. A 15-segment frame in a single colour
    costs one request, not fifteen.
"""

from __future__ import annotations

import asyncio
import pathlib
import time
from typing import TYPE_CHECKING

import click

from govee_cli.commands._common import resolve
from govee_cli.transport import CLOUD_V2

if TYPE_CHECKING:
    from collections.abc import Iterator

    from govee_cli.commands._common import Target
    from govee_cli.scenes.effects import ColorKeyframe, Effect

# Measured against the live API: 2 requests/second sustained produced no 429s.
# The binding constraint is the account's daily request budget, so cloud playback
# defaults well below the throughput ceiling.
CLOUD_MAX_FPS = 2.0
CLOUD_DEFAULT_FPS = 1.0


@click.command()
@click.argument("effect_file", type=click.Path(exists=True, path_type=pathlib.Path))
@click.option("--device", "mac", help="Device MAC address or name")
@click.option("--adapter", default="hci0", show_default=True, help="Bluetooth adapter")
@click.option("--fps", default=None, type=float, help="Override FPS from effect file")
@click.option("--no-loop", is_flag=True, help="Play once and exit (overrides the file)")
@click.pass_context
def command(
    ctx: click.Context,
    effect_file: pathlib.Path,
    mac: str | None,
    adapter: str,
    fps: float | None,
    no_loop: bool,
) -> None:
    """Play a DIY keyframe animation from a JSON file.

    Colors are linearly interpolated between keyframes and sent as per-segment
    commands. Press Ctrl+C to stop.

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
    target = resolve(ctx, mac)

    from govee_cli.scenes.effects import Effect

    effect = Effect.from_file(effect_file)
    if fps is not None:
        effect.fps = fps
    if no_loop:
        effect.loop = False

    if not effect.segments or not any(seg.keyframes for seg in effect.segments):
        raise click.ClickException("Effect has no keyframes.")

    spec = target.spec
    if spec and spec.segment_count:
        bad = sorted({s.id for s in effect.segments if s.id >= spec.segment_count})
        if bad:
            raise click.ClickException(
                f"Effect uses segment(s) {bad}, but {spec.model} has "
                f"{spec.segment_count} (0-{spec.segment_count - 1})."
            )

    if target.transport == CLOUD_V2:
        requested = effect.fps if fps is not None else min(effect.fps, CLOUD_DEFAULT_FPS)
        capped = min(requested, CLOUD_MAX_FPS)
        if capped < requested:
            click.echo(
                f"Note: {requested}fps exceeds the cloud limit; capping to {capped}fps."
            )
        elif fps is None and effect.fps > CLOUD_DEFAULT_FPS:
            click.echo(
                f"Note: this effect asks for {effect.fps}fps. Cloud playback runs at "
                f"{capped}fps to stay inside the daily request budget "
                f"(override with --fps, max {CLOUD_MAX_FPS})."
            )
        effect.fps = capped

        click.echo(
            f"Playing effect: {effect.name}  ({effect.fps} fps, loop={effect.loop}, "
            f"cloud)"
        )
        click.echo("Press Ctrl+C to stop.")
        try:
            _play_cloud(effect, target)
        except KeyboardInterrupt:
            click.echo("\nStopped.")
        return

    click.echo(f"Playing effect: {effect.name}  ({effect.fps} fps, loop={effect.loop})")
    click.echo("Press Ctrl+C to stop.")
    try:
        asyncio.run(
            _play(effect, target.device_id, adapter, ctx.obj.get("default_timeout", 10.0))
        )
    except KeyboardInterrupt:
        click.echo("\nStopped.")


def _frames(effect: "Effect") -> "Iterator[tuple[float, dict[int, tuple[int, int, int]]]]":
    """Yield ``(t_ms, {segment_id: (r, g, b)})`` for one pass of the effect."""
    total_ms = max(kf.t for seg in effect.segments for kf in seg.keyframes)
    if total_ms <= 0:
        raise click.ClickException("Effect duration must be > 0 ms.")
    frame_ms = 1000.0 / max(effect.fps, 0.01)
    t = 0.0
    while t <= total_ms:
        yield t, {seg.id: _color_at(seg.keyframes, t) for seg in effect.segments}
        t += frame_ms


def _play_cloud(effect: "Effect", target: "Target") -> None:
    """Play an effect over the v2 cloud API, batching segments by colour."""
    from govee_cli.commands._common import v2_client
    from govee_cli.http_v2 import GoveeV2Error, GoveeV2RateLimited

    client = v2_client()
    frame_ms = 1000.0 / max(effect.fps, 0.01)
    requests_sent = 0
    last_sent: dict[int, tuple[int, int, int]] = {}

    while True:
        for _t, colors in _frames(effect):
            frame_start = time.monotonic()

            # Only send segments whose colour actually changed since last frame.
            # Slow fades leave most segments identical between frames, so this
            # cuts request count sharply on exactly the effects most likely to
            # run long.
            changed = {
                seg: rgb for seg, rgb in colors.items() if last_sent.get(seg) != rgb
            }

            by_color: dict[tuple[int, int, int], list[int]] = {}
            for seg, rgb in changed.items():
                by_color.setdefault(rgb, []).append(seg)

            for (r, g, b), segs in by_color.items():
                try:
                    client.set_segment_color(
                        target.cloud_model, target.device_id, sorted(segs), r, g, b
                    )
                    requests_sent += 1
                except GoveeV2RateLimited:
                    click.echo(
                        f"Rate limited after {requests_sent} requests — "
                        f"stopping playback."
                    )
                    return
                except GoveeV2Error as e:
                    raise click.ClickException(str(e)) from e

            last_sent.update(changed)

            elapsed_ms = (time.monotonic() - frame_start) * 1000
            sleep_ms = frame_ms - elapsed_ms
            if sleep_ms > 0:
                time.sleep(sleep_ms / 1000)

        if not effect.loop:
            click.echo(f"Done ({requests_sent} cloud requests).")
            return


async def _play(effect: "Effect", mac: str, adapter: str, timeout: float) -> None:
    from govee_cli.ble import GoveeBLE
    from govee_cli.ble.protocol import encode_segment

    frame_ms = 1000.0 / max(effect.fps, 0.01)

    async with GoveeBLE(mac, adapter=adapter, timeout=timeout) as client:
        while True:
            for _t, colors in _frames(effect):
                frame_start = time.monotonic()
                for seg_id, (r, g, b) in colors.items():
                    await client.send(encode_segment(seg_id, r, g, b))
                elapsed_ms = (time.monotonic() - frame_start) * 1000
                sleep_ms = frame_ms - elapsed_ms
                if sleep_ms > 0:
                    await asyncio.sleep(sleep_ms / 1000)

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
