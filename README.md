# Claude Slack Bridge

A bridge service that lets you remotely control Claude Code sessions through Slack threads.

Send a DM or mention the bot, and Claude Code runs on your local machine with results streamed back to the Slack thread. Built on the [Anthropic Agent SDK](https://docs.anthropic.com/en/docs/claude-code/agent-sdk).

## Features

- **Thread = Session** — Each Slack thread maps 1:1 to a Claude Code session. Run multiple independent sessions across threads simultaneously
- **HTTP or Socket Mode** — Receive Slack events via Events API webhook *or* WebSocket Socket Mode (no public URL/tunnel required)
- **Session Management** — Start new sessions, switch between sessions, sync local CLI work to Slack, split long threads
- **Working Directory** — Global, per-thread, and per-cron working directory settings with auto-detection on session switch
- **Per-thread Model / Effort** — Override Claude model (`opus`/`sonnet`/`haiku`) and reasoning effort per thread
- **Live Turn View** — Each turn streams into one Slack message: Claude's narration plus a task timeline (tool calls as cards going in progress → done/failed, parallel calls grouped, subagent progress summaries), ending with elapsed time, context usage (`ctx: 45k/200k`) and 5h rate-limit %
- **Background Work** — Background shells and subagents keep running after the turn ends; a self-updating status card tracks them, completion notifications continue the session, and messages sent in the meantime go straight into the running session
- **Thread Pause** — Freeze threads with `!pause`/`!resume`. Missed messages are automatically collected on resume
- **Silent Mode** — Run a request quietly (`!silent <msg>`); progress is shadowed to DM, only the final result lands in the original thread
- **Cron Automation** — Schedule recurring tasks with cron expressions, optionally with a per-job working directory
- **Channel Watch** — Triage messages in any channel with Haiku and auto-respond to matching ones (`!watch`)
- **Account Switching** — Register multiple Claude OAuth tokens and hot-swap between them (`!account switch`)
- **Question Relay** — Claude's `AskUserQuestion` presented as numbered choices in Slack, with answers forwarded back
- **Voice Input** — Auto STT transcription on audio/video file upload (OpenAI with Google fallback)
- **Security** — Slack request signature verification + user whitelist

## Requirements

- Node.js >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Slack Bot Token (Bot User OAuth Token)
- For HTTP mode only: tunneling for external access (ngrok, Cloudflare Tunnel, etc.)

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
| `SLACK_MODE` | — | `http` | `http` (Events API webhook) or `socket` (Socket Mode WebSocket) |
| `SLACK_SIGNING_SECRET` | HTTP mode | — | Signing Secret for request verification (verification disabled if unset) |
| `SLACK_APP_TOKEN` | Socket mode | — | App-Level Token (`xapp-...`, scope: `connections:write`) |
| `ALLOWED_USERS` | Yes | — | Allowed Slack user IDs (comma-separated) |
| `PORT` | — | `3005` | Server port (HTTP webhook + debug endpoints) |
| `CLAUDE_MODEL` | — | `sonnet` | Default Claude model (`opus`, `sonnet`, `haiku`) |
| `CLAUDE_ALLOWED_DIRS` | — | — | Directories Claude Code can access (comma-separated) |
| `CLAUDE_SKIP_PERMISSIONS` | — | `false` | Skip permission prompts when `true` |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` | — | `3600000` | Max time to keep waiting for background tasks (background shells, subagents) once the main turn goes idle; `0` waits indefinitely. Past this limit the bridge stops the remaining tasks |
| `SLACK_BRIDGE_DATA_DIR` | — | `~/.claude/slack-bridge` | State directory — override to run an isolated test instance |
| `OPENAI_API_KEY` | — | — | OpenAI API key for STT (falls back to Google if unset) |

## Usage

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

For HTTP mode, expose the port with a tunnel:

```bash
ngrok http 3005
```

Socket mode requires no tunnel — the server initiates the WebSocket outbound.

## Slack App Setup

1. Create an app at [Slack API](https://api.slack.com/apps)
2. **OAuth & Permissions** — Add Bot Token Scopes:
   - `chat:write`, `im:history`, `im:read`, `im:write`
   - `app_mentions:read`, `channels:history` (for channel mentions / watch)
   - `reactions:read`, `reactions:write` (for progress reactions)
   - `files:read` (for voice input)
3. Pick one connection mode:
   - **HTTP (Events API)** — *Event Subscriptions* → enable, set Request URL to `https://<your-tunnel>/slack/events`
   - **Socket Mode** — *Socket Mode* → enable; generate an App-Level Token with `connections:write` scope; *Event Subscriptions* → enable (Request URL not required)
4. **Subscribe to bot events**: `message.im`, `app_mention`, `message.channels` (for channel watch)
5. **App Home** — Enable Messages Tab + "Allow users to send Slash commands and messages"
6. **Interactivity & Shortcuts** — enable (for the `!wd` / `!skills` pickers). Socket Mode needs no Request URL; HTTP mode uses `https://<your-tunnel>/slack/interactive`
7. Install the app to your workspace

## Commands

`!help` shows the full in-app reference. Highlights below.

### Session Management

| Command | Description |
|---------|-------------|
| `!new` / `!reset` | Clear session, start fresh |
| `!session` | Show current session ID |
| `!session <id>` | Switch to a specific session (auto-detects working directory) |
| `!sync <id>` | Sync local CLI session history to Slack thread |
| `!sync-all [<duration>]` | Sync all sessions changed within window (default 24h, e.g. `6h`, `30m`) |
| `!split` | Archive current thread and continue in a fresh thread (long-context relief) |

### Working Directory / Model / Effort

| Command | Description |
|---------|-------------|
| `!wd` | Repo picker — buttons for frequently used repos, a searchable list for the rest; picking one shows the skill picker |
| `!wd <path>` | Set thread working directory (resets session) |
| `!pwd` | Show current working directory |
| `!skills` / `!sk` | Skill picker for the thread's working directory. After picking a skill, the next message is sent as `/<skill> <message>`; the *입력창 열기* (open input) button takes the arguments in a modal, where picking another skill appends ` /<skill> ` to the input (e.g. `/open-pr on /wt 해줘`) |
| `!model [<opus\|sonnet\|haiku>]` | Show or override Claude model for this thread (`!model reset` to clear) |
| `!effort [<low\|medium\|high\|xhigh\|max>]` | Show or override reasoning effort for this thread (default `xhigh` on the SDK engine; `!effort reset` to clear) |

### Execution Control

| Command | Description |
|---------|-------------|
| `!status` | Show progress (elapsed time, tokens, recent tool activity, background tasks) |
| `!stop` | Abort current task including its background tasks (queue continues) |
| `!stop all` | Abort current task **and** clear queue |
| `!queue` | List queued messages |
| `!queue clear` | Clear queue (running task untouched) |
| `!queue remove <N>` | Drop the Nth queued message |
| `!pause` | Freeze thread (blocks incoming messages) |
| `!resume` | Unfreeze thread (auto-collects missed messages) |
| `!silent <message>` | Run quietly — only the final result is posted to the original thread |

### Cron Automation

| Command | Description |
|---------|-------------|
| `!cron` / `!cron list` | List all jobs |
| `!cron add "<schedule>" <message> [--workdir <path>] [--engine <claude\|pty-claude>] [--model <sonnet\|opus\|haiku>] [--effort <low\|medium\|high\|xhigh\|max>] [-- <desc>]` | Register a scheduled job (optional workdir / engine / model / effort + description; without `--effort` the default applies) |
| `!cron pause <id>` / `!cron resume <id>` | Toggle job |
| `!cron run <id>` | Execute immediately |
| `!cron remove <id>` | Delete job |
| `!cron history <id>` | Show recent execution history |

### Channel Watch

| Command | Description |
|---------|-------------|
| `!watch <channel_id>` | Register a channel watch (multi-line `sender:` / `trigger:` / `action:` body) |
| `!watch-set <channel_id> <field> <value>` | Edit a single field (`sender`, `trigger`, `action`, `enabled`, `channelName`, `anchorChannel`, `engine`, `triageModel`, `triageEffort`) |
| `!watch-set <channel_id> triageModel <sonnet\|opus\|haiku\|reset>` | Model used to decide whether a message matches the trigger (default `haiku`) |
| `!watch-set <channel_id> triageEffort <low\|medium\|high\|xhigh\|max\|reset>` | Reasoning effort of that decision call (unset = SDK default, same as before) |
| `!watches` | List all watches |
| `!unwatch <channel_id>` | Remove a watch |

### Claude Account (OAuth tokens)

| Command | Description |
|---------|-------------|
| `!account` / `!account list` | Registered accounts + currently active |
| `!account current` | Show active account |
| `!account add <name> <token>` | Register an account (DM only; token from `claude setup-token`) |
| `!account switch <name>` | Switch active account (applies to next request) |
| `!account remove <name>` | Remove an account |

## Project Structure

```
src/
├── index.js       # Express server, event handler, orchestration
├── socket.js      # Socket Mode client — replaced when it stays disconnected for 2 minutes
├── picker.js      # Repo / skill pickers (!wd, !skills) — skill catalog, buttons, argument modal (appends other skills)
├── session.js     # Claude engine flow — per-turn views, message injection while waiting on background work
├── claude.js      # Agent SDK query() wrapper (streaming input), turn / tool / background task events
├── turn-view.js   # Slack rendering — streamed turn message (task timeline), background status card
├── format.js      # Shared formatting (elapsed, ctx, tool labels)
├── commands.js    # Command handlers (!new, !session, !wd, !cron, !watch, etc.)
├── cron.js        # Cron job management and scheduled execution
├── watch.js       # Channel watch — Haiku triage and auto-response
├── slack.js       # Slack WebClient wrapper, thread history fetching
├── security.js    # Request signature verification, user whitelist
├── store.js       # JSON file-based persistence + session file decoding
└── stt.js         # Speech-to-text (OpenAI / Google fallback)
```

## Data Storage

Session and state data are stored as JSON files in `~/.claude/slack-bridge/` (or `SLACK_BRIDGE_DATA_DIR`):

| File | Purpose |
|------|---------|
| `sessions.json` | Thread ↔ Claude session ID mapping |
| `threads.json` | Thread metadata (user, creation time, working directory, model/effort/silent) |
| `workdirs.json` | Per-user default working directories |
| `paused.json` | Paused threads |
| `crons.json` | Scheduled jobs + execution history |
| `watches.json` | Channel watch configurations |
| `processing.json` | In-flight "processing…" messages (recovered on restart) |
| `accounts.json` | Registered Claude OAuth accounts |
| `sync-points.json` | Last sync point per session |
| `inbox.json` | Incoming message audit log |
| `skill-usage.json` | Skill run counts per repo (orders the skill picker buttons) |

## API Endpoints

| Method | Path | Mode | Description |
|--------|------|------|-------------|
| POST | `/slack/events` | HTTP only | Slack event webhook |
| POST | `/slack/interactive` | HTTP only | Picker buttons and argument modal (Interactivity Request URL) |
| GET | `/health` | both | Health check |
| GET | `/sessions` | both | List active sessions |
| GET | `/inbox` | both | Incoming message log |
| DELETE | `/inbox` | both | Clear inbox |

In Socket mode, `/slack/events` and `/slack/interactive` are not registered; events and interactions arrive over the Slack WebSocket.

## License

MIT
