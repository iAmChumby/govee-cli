"""Govee CLI — root command group."""

import logging

import click
import structlog

from govee_cli import __version__


def setup_logging(verbose: bool = False) -> None:
    """Configure structured logging."""
    level = logging.DEBUG if verbose else logging.INFO
    structlog.configure(
        wrapper_class=structlog.make_filtering_bound_logger(level),
        processors=[
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=False,
    )


@click.group()
@click.version_option(version=__version__)
@click.option("-v", "--verbose", is_flag=True, help="Enable verbose output")
@click.pass_context
def main(ctx: click.Context, verbose: bool) -> None:
    """govee-cli — control Govee lights over Bluetooth BLE."""
    setup_logging(verbose)
    ctx.ensure_object(dict)


# Import command objects and register with explicit names to avoid
# collisions when multiple modules define a function named "command"
from govee_cli.commands.brightness import command as brightness_cmd
from govee_cli.commands.color import command as color_cmd
from govee_cli.commands.effect import command as effect_cmd
from govee_cli.commands.group import group as group_cmd
from govee_cli.commands.info import command as info_cmd
from govee_cli.commands.music import command as music_cmd
from govee_cli.commands.power import command as power_cmd
from govee_cli.commands.record import command as record_cmd
from govee_cli.commands.replay import command as replay_cmd
from govee_cli.commands.scan import command as scan_cmd
from govee_cli.commands.scene import command as scene_cmd
from govee_cli.commands.schedule import schedule as schedule_cmd
from govee_cli.commands.segments import command as segments_cmd
from govee_cli.commands.temp import command as temp_cmd

main.add_command(power_cmd, name="power")
main.add_command(brightness_cmd, name="brightness")
main.add_command(color_cmd, name="color")
main.add_command(temp_cmd, name="temp")
main.add_command(segments_cmd, name="segments")
main.add_command(scene_cmd, name="scene")
main.add_command(record_cmd, name="record")
main.add_command(replay_cmd, name="replay")
main.add_command(effect_cmd, name="effect")
main.add_command(music_cmd, name="music")
main.add_command(schedule_cmd, name="schedule")
main.add_command(group_cmd, name="group")
main.add_command(scan_cmd, name="scan")
main.add_command(info_cmd, name="info")


if __name__ == "__main__":
    main()
