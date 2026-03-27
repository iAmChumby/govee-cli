"""Govee CLI — root command group."""

import logging
import sys

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


# Import commands here to register them with the CLI
from govee_cli.commands import (  # noqa: E402, F401
    power,
    brightness,
    color,
    temp,
    segments,
    scene,
    record,
    replay,
    effect,
    music,
    schedule,
    group,
    scan,
    info,
)

main.add_command(power.command)
main.add_command(brightness.command)
main.add_command(color.command)
main.add_command(temp.command)
main.add_command(segments.command)
main.add_command(scene.command)
main.add_command(record.command)
main.add_command(replay.command)
main.add_command(effect.command)
main.add_command(music.command)
main.add_command(schedule.command)
main.add_command(group.command)
main.add_command(scan.command)
main.add_command(info.command)


if __name__ == "__main__":
    main()
