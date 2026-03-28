"""completion command — install shell completions for govee-cli."""

import sys

import click


@click.command()
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish", "powershell"]))
def completion(shell: str) -> None:
    """Print shell completion script for the current shell.

    Usage:
        bash:  eval "$(govee-cli completion bash)"
        zsh:   eval "$(govee-cli completion zsh)"
        fish:  govee-cli completion fish | source
    """
    # Click 8 completion: _GOVEE_CLI_COMPLETE=<shell>_source govee-cli
    if shell == "bash":
        sys.stdout.write(
            'eval "$(_GOVEE_CLI_COMPLETE=bash_source govee-cli)"\n'
        )
    elif shell == "zsh":
        sys.stdout.write(
            'eval "$(_GOVEE_CLI_COMPLETE=zsh_source govee-cli)"\n'
        )
    elif shell == "fish":
        sys.stdout.write(
            '_GOVEE_CLI_COMPLETE=fish_source govee-cli | source\n'
        )
    elif shell == "powershell":
        sys.stdout.write(
            '$env:_GOVEE_CLI_COMPLETE="powershell_source"; govee-cli | Invoke-Expression\n'
        )
