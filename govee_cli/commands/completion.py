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
    if shell == "bash":
        sys.stdout.write(
            'eval "$(_GOVERCLI_BASH_COMPLETE=bash govee-cli 2>/dev/null)"\n'
        )
    elif shell == "zsh":
        sys.stdout.write(
            'eval "$(_GOVERCLI_ZSH_COMPLETE=zsh govee-cli 2>/dev/null)"\n'
        )
    elif shell == "fish":
        sys.stdout.write(
            'eval (env _GOVERCLI_FISH_COMPLETE=fish_source govee-cli)\n'
        )
    elif shell == "powershell":
        sys.stdout.write(
            'Invoke-Expression "$(_GOVERCLI_PS_COMPLETE=bash govee-cli 2>$null)"\n'
        )
