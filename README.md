# Claude Slack Bridge

A bridge service that lets you remotely control Claude Code sessions through Slack threads.

Send a DM or mention the bot, and Claude Code runs on your local machine with results streamed back to the Slack thread. Built on the [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk).

## Features

- **Thread = Session** — Each Slack thread maps 1:1 to a Claude Code session. Run multiple independent sessions across threads simultaneously
- **Session Management** — Start new sessions, switch between sessions, sync local CLI work to Slack
- **Working Directory** — Global and per-thread working directory settings with auto-detection on session switch
- **Live Progress** — Elapsed time, context usage (`ctx: 45k/200k`), and recent tool activity with emoji indicators
- **Thread Pause** — Freeze threads with `!pause`/`!resume`. Missed messages are automatically collected on resume
- **Cron Automation** — Schedule recurring tasks (e.g. daily morning scrum)
- **Question Relay** — Claude's `AskUserQuestion` presented as numbered choices in Slack, with answers forwarded back
- **Voice Input** — Auto STT transcription on audio/video file upload (OpenAI with Google fallback)
- **Security** — Slack request signature verification + user whitelist

## Requirements

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Slack Bot Token (Bot User OAuth Token)
- Tunneling for external access (ngrok, etc.)

## Installation

```bash
git clone https://github.com/lucidash/claude-slack-bridge.git
cd claude-slack-bridge
npm install
cp .env.example .env
# Edit .env with your tokens and settings
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | Slack Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | — | — | Slack app Signing Secret (signature verification disabled if unset) |
| `ALLOWED_USERS` | Yes | — | Allowed Slack user IDs (comma-separated) |
| `PORT` | — | `3005` | Server port |
| `CLAUDE_MODEL` | — | `sonnet` | Claude model (`opus`, `sonnet`, `haiku`) |
| `CLAUDE_ALLOWED_DIRS` | — | — | Directories Claude Code can access (comma-separated) |
| `CLAUDE_SKIP_PERMISSIONS` | — | `false` | Skip permission prompts when `true` |
| `OPENAI_API_KEY` | — | — | OpenAI API key for STT (falls back to Google if unset) |

## Usage

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Tunnel with ngrok:

```bash
ngrok http 3005
```

## Slack App Setup

1. Create an app at [Slack API](https://api.slack.com/apps)
2. **OAuth & Permissions** — Add Bot Token Scopes:
   - `chat:write`, `im:history`, `im:read`, `im:write`
   - `app_mentions:read`, `channels:history` (for channel mentions)
   - `files:read` (for voice input)
3. **Event Subscriptions** — Enable and configure:
   - Request URL: `https://<your-url>/slack/events`
   - Bot events: `message.im`, `app_mention`
4. **App Home** — Enable Messages Tab + "Allow users to send Slash commands and messages"
5. Install the app to your workspace

## Commands

### Session Management

| Command | Description |
|---------|-------------|
| `!new` / `!reset` | Clear session, start fresh |
| `!session` | Show current session ID |
| `!session <id>` | Switch to a specific session (auto-detects working directory) |
| `!sync <id>` | Sync local CLI session history to Slack thread |

### Working Directory

| Command | Description |
|---------|-------------|
| `!wd <path>` | Set thread working directory (resets session) |
| `!pwd` | Show current working directory |

### Execution Control

| Command | Description |
|---------|-------------|
| `!stop` | Abort running task + clear queue |
| `!status` | Show progress (elapsed time, tokens, recent tool activity) |
| `!queue` | List queued messages |
| `!pause` | Freeze thread (blocks incoming messages) |
| `!resume` | Unfreeze thread (auto-collects missed messages) |

### Cron Automation

| Command | Description |
|---------|-------------|
| `!cron add "<schedule>" <message> -- [desc]` | Register a scheduled job |
| `!cron list` | List all jobs |
| `!cron pause <id>` / `!cron resume <id>` | Toggle job |
| `!cron run <id>` | Execute immediately |
| `!cron remove <id>` | Delete job |
| `!cron history <id>` | Show recent execution history |

## Project Structure

```
src/
├── index.js       # Express server, event handler, Claude execution orchestration
├── claude.js      # Agent SDK query() wrapper, stream parsing, tool callbacks
├── commands.js    # Command handlers (!new, !session, !wd, !cron, etc.)
├── cron.js        # Cron job management and scheduled execution
├── slack.js       # Slack WebClient wrapper, thread history fetching
├── security.js    # Request signature verification, user whitelist
├── store.js       # JSON file-based persistence + session file decoding
└── stt.js         # Speech-to-text (OpenAI / Google fallback)
```

## Data Storage

Session and state data are stored as JSON files in `~/.claude/slack-bridge/`:

| File | Purpose |
|------|---------|
| `sessions.json` | Thread ↔ Claude session ID mapping |
| `threads.json` | Thread metadata (user, creation time, working directory) |
| `workdirs.json` | Per-user default working directories |
| `paused.json` | Paused threads |
| `crons.json` | Scheduled jobs + execution history |
| `sync-points.json` | Last sync point per session |
| `inbox.json` | Incoming message audit log |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/slack/events` | Slack event webhook |
| GET | `/health` | Health check |
| GET | `/sessions` | List active sessions |
| GET | `/inbox` | Incoming message log |
| DELETE | `/inbox` | Clear inbox |

## License

MIT
