# Teyvat

Person-based AI agent framework. Each agent has persistent memory, identity, and biological metaphor architecture running on [pi-coding-agent](https://github.com/nicolo-ribaudo/pi-coding-agent).

## Requirements

- macOS or Linux
- [Node.js](https://nodejs.org/) >= 18
- [Bun](https://bun.sh/) (`curl -fsSL https://bun.sh/install | bash`)
- [GitHub CLI](https://cli.github.com/) (`brew install gh`)
- Anthropic API key (Claude)

## Install

### One-line install

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ApolloZhangOnGithub/teyvat-dev/main/Codebase/deploy/bootstrap.sh)
```

### Manual install

```bash
# 1. Clone
git clone https://github.com/ApolloZhangOnGithub/teyvat-dev.git ~/genshin-src
cd ~/genshin-src/Codebase/core && bun install

# 2. Install
bash ~/genshin-src/Codebase/deploy/install.sh

# 3. Login (requires gh auth login first)
genshin login
```

### npm install

```bash
npm install -g teyvat
genshin login
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
| `MemoryData/<id>/` | Agent memory (context, work memory, neocortex) |
| `SessionData/<id>/` | Conversation session logs |
| `IdentityData/<id>/` | Agent identity and rename history |
| `UserAccount/` | Login credentials and settings |

## Sync

Teyvat syncs agent data across devices via an SSH tunnel to the sync server.

The sync happens automatically:
- **On start**: pulls latest data
- **Every 5 minutes**: pushes changes
- **On exit**: final push

To set up sync on a new device, the bootstrap script handles it. Manual setup:

```bash
# Add your SSH key to the server
ssh-copy-id root@47.106.190.199

# The LaunchAgent (macOS) keeps the tunnel alive
# It's created automatically by bootstrap.sh
```

## Update

```bash
cd ~/genshin-src && git pull
bash Codebase/deploy/install.sh
```

Or if installed via npm:

```bash
npm update -g teyvat
```

## License

MIT
