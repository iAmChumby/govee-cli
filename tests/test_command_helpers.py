"""Tests for the shared command helpers (segment/colour parsing)."""

import click
import pytest

from govee_cli.commands._common import parse_hex, parse_segments


class TestParseSegments:
    def test_single_index(self) -> None:
        assert parse_segments("3", 15) == [3]

    def test_comma_list(self) -> None:
        assert parse_segments("0,4,9", 15) == [0, 4, 9]

    def test_inclusive_range(self) -> None:
        assert parse_segments("2-6", 15) == [2, 3, 4, 5, 6]

    def test_mixed_list_and_ranges(self) -> None:
        assert parse_segments("0-2,8,11-14", 15) == [0, 1, 2, 8, 11, 12, 13, 14]

    def test_all_expands_to_every_segment(self) -> None:
        assert parse_segments("all", 15) == list(range(15))
        assert parse_segments("ALL", 6) == list(range(6))

    def test_duplicates_are_dropped_preserving_order(self) -> None:
        # Sending the same segment twice in one call is wasted API budget.
        assert parse_segments("0-2,1,0", 15) == [0, 1, 2]

    def test_whitespace_is_tolerated(self) -> None:
        assert parse_segments(" 0 , 2 ", 15) == [0, 2]

    def test_out_of_range_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="out of range"):
            parse_segments("15", 15)
        with pytest.raises(click.ClickException, match="out of range"):
            parse_segments("0-20", 15)

    def test_negative_rejected(self) -> None:
        with pytest.raises(click.ClickException):
            parse_segments("-1", 15)

    def test_backwards_range_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="greater than end"):
            parse_segments("6-2", 15)

    def test_garbage_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid segment"):
            parse_segments("abc", 15)

    def test_empty_selection_rejected(self) -> None:
        with pytest.raises(click.ClickException):
            parse_segments(",", 15)

    def test_range_honours_device_segment_count(self) -> None:
        # The same spec is valid on a 15-zone lamp and invalid on a 6-zone bar.
        assert parse_segments("all", 6) == list(range(6))
        with pytest.raises(click.ClickException):
            parse_segments("9", 6)


class TestParseHex:
    def test_plain_hex(self) -> None:
        assert parse_hex("FF5500") == (255, 85, 0)

    def test_leading_hash(self) -> None:
        assert parse_hex("#FF5500") == (255, 85, 0)

    def test_lowercase(self) -> None:
        assert parse_hex("ff5500") == (255, 85, 0)

    def test_black_and_white(self) -> None:
        assert parse_hex("000000") == (0, 0, 0)
        assert parse_hex("FFFFFF") == (255, 255, 255)

    def test_wrong_length_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            parse_hex("FFF")

    def test_non_hex_rejected(self) -> None:
        with pytest.raises(click.ClickException, match="Invalid hex color"):
            parse_hex("GGGGGG")
