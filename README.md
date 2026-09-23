# Teyvat

Person-based AI agent framework. Each agent has persistent memory, identity, and biological metaphor architecture running on [pi-coding-agent](https://github.com/nicolo-ribaudo/pi-coding-agent).

## Requirements

- macOS / Linux / WSL
- DeepSeek API key，或任意 OpenAI-compatible API key

## Install

```bash
curl -fsSL paimon.beer/install-prerelease | bash
```

## Usage

```bash
genshin                    # List all agents
genshin <name>             # Start / enter an agent (creates if new)
genshin doctor             # Health check
genshin whoami             # Show current login
genshin sync               # Show sync status
genshin sync push          # Push data to cloud
genshin sync pull          # Pull data from cloud
```

### Agent management

```bash
genshin archive <name>     # Archive an agent
genshin unarchive <name>   # Restore archived agent
genshin archived           # List archived agents
genshin rename <old> <new> # Rename an agent
genshin kill <name>        # Kill a running agent
```

### Agent naming rules

- Must start with a letter (a-z, A-Z)
- Only letters, digits, and underscore allowed
- Examples: `alice`, `test_01`, `Dev_Agent`
- Invalid: `123bot`, `my-agent`, `agent!`

## Data

All agent data lives in `~/.teyvat/`:

| Directory | Content |
|-----------|---------|
| `MemoryData/<id>/` | Agent memory (context) |
| `SessionData/<id>/` | Conversation session logs |
| `IdentityData/<id>/` | Agent identity and rename history |
| `UserAccount/` | Login credentials and settings |

## Update

```bash
genshin update
```

## License

License not decided.
