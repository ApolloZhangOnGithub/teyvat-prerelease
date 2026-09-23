# Teyvat

Person-based AI agent framework. Each agent has persistent memory, identity, and biological metaphor architecture running on [pi-coding-agent](https://github.com/nicolo-ribaudo/pi-coding-agent).

## Requirements

- macOS / Linux / WSL
- DeepSeek API key, or any compatible API key

## Install

```bash
curl -fsSL paimon.beer/install-prerelease | bash
```

## Usage

```bash
genshin                                    # Create / start an agent
genshin kill, k <agent>                    # Kill a running agent
genshin archive, a <agent>                 # Archive an agent
genshin unarchive, ua <agent>              # Restore an archived agent
genshin archived, A                        # List archived agents
genshin rename <old> <new>                 # Rename an agent
genshin clone, c <agent>                   # Clone an agent
genshin note, n <agent> [note]             # View / append agent note
genshin org, o [name|id|index]             # Organization management
genshin doctor                             # System diagnostics
genshin backup, b [config|init|now|status] # Cloud backup
genshin login / logout / unbind / whoami   # Account
genshin settings, s                        # Interactive settings
genshin config provider <name> --base-url <url>  # Configure provider
genshin update                             # Update
```

See `genshin help` for more commands.

## Data

All agent data lives in `~/.teyvat/`:

| Directory | Content |
|-----------|---------|
| `MemoryData/<id>/` | Agent memory (context) |
| `SessionData/<id>/` | Conversation session logs |
| `IdentityData/<id>/` | Agent identity and rename history |
| `config/` | Settings and credentials |

## Update

```bash
genshin update
```

## License

License not decided.
