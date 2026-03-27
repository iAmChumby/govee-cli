"""group command — multi-device groups."""

import click


@click.command()
@click.argument("name", type=str)
@click.option("--create", "create", is_flag=True, help="Create a new group")
@click.option("--devices", help="Comma-separated MAC addresses")
@click.pass_context
def group(ctx: click.Context, name: str, create: bool, devices: str | None) -> None:
    """Manage and execute commands on device groups.

    Groups are defined in ~/.config/govee-cli/groups.json
    """
    raise click.ClickException(
        "Groups not yet implemented."
    )
