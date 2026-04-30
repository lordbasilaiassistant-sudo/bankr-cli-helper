# Bankr CLI Helper

A local web app that wraps the [Bankr CLI](https://www.npmjs.com/package/@bankr/cli)
with a Groq LLM frontend. Chat with your own AI about your Bankr wallet,
run raw CLI commands with one click, and let an auto-mode engine claim fees,
launch tokens, and snapshot your portfolio on a schedule.

![panel](docs/screenshot.png) <!-- optional -->

## Why

The `bankr agent` / `bankr prompt` commands route through Bankr's paid LLM. Every
prompt costs credits. But every *direct* CLI command (`wallet portfolio`,
`tokens search`, `fees`, `fees claim`, `launch`, …) is free.

This app puts Groq in front of the CLI and lets it pick commands on your
behalf. Groq has a generous free tier with rate limits (~30 req/min on most
models) and a pay-as-you-go paid tier for higher throughput — either way it
works out far cheaper per turn than Bankr's paid LLM credits.

## Features

- **Chat** — Groq LLM picks and runs the right bankr CLI commands based on your question.
- **Raw CLI** — Type any bankr command directly. Writes stage for one-click confirmation.
- **Auto Mode** — Scheduled actions that run 24/7 until you toggle them off:
  - Claim creator fees when claimable exceeds a threshold
  - Launch tokens from a customizable queue (ancient/dead-language names)
  - Hourly portfolio snapshots
  - Periodic whoami refresh
- **Kill switch** — Stop all auto actions instantly.
- **Activity log** — Every action the auto-mode engine takes, with timestamps.
- **Skills browser** — Loads SKILL.md files from
  [BankrBot/skills](https://github.com/BankrBot/skills) to give the LLM context.
- **Long-term memory** — Persists wallet addresses, tokens, preferences across chats.
- **Threads** — Each conversation is saved; revisit any time.

## Install

```bash
git clone https://github.com/YOUR_USERNAME/bankr-cli-helper.git
cd bankr-cli-helper
npm install
cp .env.example .env
# then edit .env with your keys, OR add them in the Settings panel after first run
npm start
# open http://localhost:3847
```

### Keys you need

- **Groq API key** — sign up at [console.groq.com](https://console.groq.com). Free tier covers most casual use (rate-limited); paid tier is pay-as-you-go (~$0.05–$0.80 per 1M tokens depending on model).
- **Bankr API key** — generate at [bankr.bot/api](https://bankr.bot/api)

Both can be set via `.env` OR pasted into the Settings panel (stored in
`data/settings.json`, which is gitignored).

## Auto-mode safety

**Auto mode moves real value on-chain.** Every write command (transfers, claims,
token launches) requires explicit confirmation in chat/raw-CLI. Auto-mode has:

- Kill switch — always visible in the top bar when active; halts on click
- Per-action toggles in the Auto Mode panel
- Daily caps (`maxLaunchesPerDay`, `claimThresholdUsd`, `maxUsdPerAction`)
- Append-only activity log at `data/automode-log.jsonl`
- Defaults that lean conservative (launches OFF by default)

Turn it on **only after** configuring your limits and reading the log a few times.

## Architecture

```
public/index.html  — single-page frontend (no framework, vanilla JS)
server.js          — Express API + Groq proxy + bankr CLI spawner
automode.js        — scheduler (1-min tick), state file, action log
data/              — local state (gitignored)
  settings.json      API keys (plain text — local only)
  memory.json        long-term memory the LLM writes to
  automode.json      auto-mode config + counters
  automode-log.jsonl action log (append-only)
  token-queue.json   queued tokens for auto-launch
  threads/*.json     conversation history
```

### How commands are picked

1. User sends a message in Chat
2. Server calls Groq with the full conversation history + a system prompt that
   lists every bankr CLI command
3. Groq emits one or more ```bankr-run blocks with commands to execute
4. Server executes non-write commands, stages write commands for confirmation
5. Server re-prompts Groq with the command output
6. Groq writes a clean, user-facing answer
7. Frontend renders answer + any pending-confirmation boxes

The LLM never calls `bankr agent` or `bankr prompt` — those cost Bankr credits.
Only direct CLI is used.

## API reference (server)

| Method | Path | Purpose |
|---|---|---|
| GET | /api/settings | Current settings (masked keys) |
| POST | /api/settings | Save API keys / model |
| GET | /api/memory | Long-term memory |
| POST | /api/memory | Overwrite memory |
| GET | /api/threads | List threads |
| GET | /api/threads/:id | Load a thread |
| DELETE | /api/threads/:id | Delete a thread |
| POST | /api/chat | Send a message (LLM-routed) |
| POST | /api/bankr | Run a raw command (writes stage) |
| POST | /api/bankr/confirm | Confirm a staged write |
| GET | /api/overview | Whoami + portfolio snapshot |
| GET | /api/automode | Current auto-mode state + recent log |
| POST | /api/automode/toggle | Turn auto-mode on/off |
| POST | /api/automode/kill | Activate kill switch |
| POST | /api/automode/reset-kill | Reset kill switch |
| POST | /api/automode/config | Update limits / schedule / strategy |
| POST | /api/automode/run-now/:action | Fire one action now |
| GET | /api/automode/queue | View launch queue |
| POST | /api/automode/queue | Overwrite launch queue |
| GET | /api/automode/log | Recent activity log |

## Threat model

This app executes wallet writes on your behalf. Before running:

- **Localhost-only.** The server binds to `127.0.0.1` (override with `HOST` env
  var at your own risk). Do not expose to a LAN, tunnel, or public internet —
  there is no authentication and `/api/chat` is a billable Groq proxy.
- **Read commands are cheap, writes ask first.** Every `wallet transfer`,
  `wallet sign`, `wallet submit`, `launch`, `fees claim*`, `llm credits add`,
  `config set`, and `x402 deploy` stages a structured confirm box in the
  frontend. Transfers additionally require typing the last 4 hex chars of the
  destination — you must actually look.
- **CLI output is untrusted input to the LLM.** Token names, fee-dashboard
  entries, and other on-chain data are fenced with `<<<BANKR_OUTPUT>>>…<<<END>>>`
  and the system prompt tells the model not to treat them as instructions. Each
  command's output is truncated to 4 KB before being fed back.
- **Long-term memory is append-only for wallets and tokens.** The LLM can add
  new entries but cannot overwrite existing `wallets.main_evm` etc. A poisoned
  CLI output can therefore not silently re-route "your wallet" to an attacker.
- **Auto-mode has three independent locks.** `enabled` (global), per-action
  `enabled`, and the kill switch. All three must allow an action for it to run.
  Launches are disabled by default; flip them on only after watching the log.
- **API keys are plain-text on disk** in `data/settings.json`. Use FDE and keep
  the folder off shared drives (OneDrive/iCloud version history will keep
  deleted copies — rotate keys if you ever had one in a sync'd folder).
- **CLI commands spawn `node dist/cli.js` directly, no shell.** Args are passed
  as arrays. Automode's `launch` uses the array form end-to-end; any
  user-supplied token name is also validated against `[A-Za-z0-9 _\-]{1,40}`
  before it reaches the spawner.
- **`data/` is gitignored.** Your keys, memory, chat history, and action log
  never leave the machine unless you `git add -f` them.

If any of this is news to you, read through `server.js` before you enable
auto-mode. The whole point of this app is that you own the keys and the
LLM — every moving part is in one ~600-line file.

## Contributing

PRs welcome — especially for additional auto-mode actions (swaps via on-chain
simulation, stop-loss / limit monitors), skill loaders, and tighter LLM
command-routing.

## License

MIT. See [LICENSE](LICENSE).
