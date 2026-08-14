"""Tests for the effect playback engine, especially the cloud path.

Cloud playback spends real API budget per frame, so the batching and
change-detection behaviour is worth pinning down.
"""

from unittest.mock import MagicMock, patch

import click
import pytest

from govee_cli.commands.effect import (
    CLOUD_DEFAULT_FPS,
    CLOUD_MAX_FPS,
    _color_at,
    _frames,
    _hex_to_rgb,
    _play_cloud,
)
from govee_cli.scenes.effects import ColorKeyframe, Effect


def _effect(**overrides) -> Effect:
    data = {
        "name": "t", "fps": 1, "loop": False,
        "segments": [{"id": 0, "keyframes": [
            {"t": 0, "color": "FF0000"},
            {"t": 2000, "color": "0000FF"},
        ]}],
    }
    data.update(overrides)
    return Effect.from_dict(data)


class TestColorInterpolation:
    def test_endpoints_are_exact(self) -> None:
        kfs = [ColorKeyframe(0, "FF0000"), ColorKeyframe(1000, "0000FF")]
        assert _color_at(kfs, 0) == (255, 0, 0)
        assert _color_at(kfs, 1000) == (0, 0, 255)

    def test_midpoint_is_interpolated(self) -> None:
        kfs = [ColorKeyframe(0, "FF0000"), ColorKeyframe(1000, "0000FF")]
        assert _color_at(kfs, 500) == (127, 0, 127)

    def test_before_and_after_clamp_to_endpoints(self) -> None:
        kfs = [ColorKeyframe(100, "FF0000"), ColorKeyframe(200, "0000FF")]
        assert _color_at(kfs, 0) == (255, 0, 0)
        assert _color_at(kfs, 9999) == (0, 0, 255)

    def test_empty_keyframes_fall_back_to_white(self) -> None:
        assert _color_at([], 0) == (255, 255, 255)

    def test_hex_parsing(self) -> None:
        assert _hex_to_rgb("#00FF88") == (0, 255, 136)


class TestFrames:
    def test_frame_count_follows_fps_and_duration(self) -> None:
        # 2000ms at 1fps → t = 0, 1000, 2000
        assert [t for t, _ in _frames(_effect())] == [0.0, 1000.0, 2000.0]

    def test_zero_duration_is_rejected(self) -> None:
        zero = _effect(segments=[{"id": 0, "keyframes": [{"t": 0, "color": "FF0000"}]}])
        with pytest.raises(click.ClickException, match="duration must be"):
            list(_frames(zero))

    def test_each_frame_covers_every_segment(self) -> None:
        multi = _effect(segments=[
            {"id": 0, "keyframes": [{"t": 0, "color": "FF0000"}, {"t": 1000, "color": "FF0000"}]},
            {"id": 5, "keyframes": [{"t": 0, "color": "00FF00"}, {"t": 1000, "color": "00FF00"}]},
        ])
        for _t, colors in _frames(multi):
            assert set(colors) == {0, 5}


class TestCloudPlayback:
    @staticmethod
    def _target() -> MagicMock:
        target = MagicMock()
        target.cloud_model = "H6022"
        target.device_id = "50:CE:E8:6E:80:C6:50:3F"
        return target

    def test_same_colored_segments_batch_into_one_request(self) -> None:
        # Three segments sharing a color must cost one request, not three —
        # this is the whole point of the segment array in the v2 API.
        effect = _effect(segments=[
            {"id": i, "keyframes": [
                {"t": 0, "color": "FF0000"}, {"t": 1000, "color": "FF0000"},
            ]} for i in (0, 1, 2)
        ])
        client = MagicMock()
        with patch("govee_cli.commands._common.v2_client", return_value=client):
            with patch("govee_cli.commands.effect.time.sleep"):
                _play_cloud(effect, self._target())

        assert client.set_segment_color.call_count == 1
        args = client.set_segment_color.call_args.args
        assert args[2] == [0, 1, 2]          # segments batched
        assert args[3:] == (255, 0, 0)

    def test_unchanged_segments_are_not_resent(self) -> None:
        # A hold (identical colour across frames) should cost one request total.
        effect = _effect(fps=4, segments=[{"id": 0, "keyframes": [
            {"t": 0, "color": "112233"}, {"t": 1000, "color": "112233"},
        ]}])
        client = MagicMock()
        with patch("govee_cli.commands._common.v2_client", return_value=client):
            with patch("govee_cli.commands.effect.time.sleep"):
                _play_cloud(effect, self._target())
        assert client.set_segment_color.call_count == 1

    def test_differing_colors_produce_one_request_each(self) -> None:
        effect = _effect(segments=[
            {"id": 0, "keyframes": [
                {"t": 0, "color": "FF0000"}, {"t": 1000, "color": "FF0000"}]},
            {"id": 1, "keyframes": [
                {"t": 0, "color": "00FF00"}, {"t": 1000, "color": "00FF00"}]},
        ])
        client = MagicMock()
        with patch("govee_cli.commands._common.v2_client", return_value=client):
            with patch("govee_cli.commands.effect.time.sleep"):
                _play_cloud(effect, self._target())
        assert client.set_segment_color.call_count == 2

    def test_rate_limit_stops_playback_instead_of_hammering(self) -> None:
        from govee_cli.http_v2 import GoveeV2RateLimited

        effect = _effect(fps=2, loop=True)
        client = MagicMock()
        client.set_segment_color.side_effect = GoveeV2RateLimited("slow down")
        with patch("govee_cli.commands._common.v2_client", return_value=client):
            with patch("govee_cli.commands.effect.time.sleep"):
                _play_cloud(effect, self._target())   # must return, not loop forever
        assert client.set_segment_color.call_count == 1

    def test_api_errors_surface_as_cli_errors(self) -> None:
        from govee_cli.http_v2 import GoveeV2Error

        client = MagicMock()
        client.set_segment_color.side_effect = GoveeV2Error("boom")
        with patch("govee_cli.commands._common.v2_client", return_value=client):
            with patch("govee_cli.commands.effect.time.sleep"):
                with pytest.raises(click.ClickException, match="boom"):
                    _play_cloud(_effect(), self._target())

    def test_cloud_fps_ceiling_is_below_the_measured_limit(self) -> None:
        # 2 req/s was measured safe; the default sits below it deliberately.
        assert CLOUD_DEFAULT_FPS <= CLOUD_MAX_FPS <= 2.0
