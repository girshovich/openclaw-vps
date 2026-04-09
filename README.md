# OpenClaw

A personal AI agent framework for a VPS. Controlled via Telegram, runs 24/7.

## What it does

- **Telegram interface** — polling-based connector (no public HTTPS endpoint required). Send messages, receive replies.
- **Headless browser** — Playwright + stealth plugin. Navigate pages, click, type, extract text, eval JS. Auto-dismisses cookie banners. Persists browser sessions across turns.
- **Bash execution** — runs arbitrary shell commands on the VPS.
- **Long-term memory** — conversations are embedded (OpenAI) and stored in Qdrant. Semantic search via `memory_search` tool.
- **Session management** — SQLite-backed. GPT-5 Mini classifies each message as new or continuing session. Sessions transition: Active → Idle (4h) → Archived (2d).
- **Cron scheduling** — agent can create recurring or one-time jobs (`every Xm/h/d`, `daily HH:MM`, ISO datetime). Fires as agent turns.
- **Task tracking** — agent creates/completes tasks per session; heartbeat retries unfinished tasks (5min, then 1h).
- **Sub-agents** — agent can spawn a parallel sub-agent (depth capped at 1). Sub-agents get browser + bash + memory tools only.
- **Zero-balance fallback** — on API quota exhaustion, switches Anthropic ↔ OpenAI and notifies via Telegram.
- **Context summarization** — GPT-5.4 compacts conversation history when approaching model context limits.

## Models

| Role | Model |
|---|---|
| Default | GPT-5.4 |
| High complexity | Claude Opus 4.6 |
| Summarization | GPT-5.4 |
| Classifier | GPT-5 Mini |

## Stack

- **Runtime:** Node.js / TypeScript
- **Session store:** SQLite (better-sqlite3)
- **Vector store:** Qdrant (Docker)
- **Browser:** Playwright + puppeteer-extra-plugin-stealth
- **LLM providers:** Anthropic SDK + OpenAI SDK

## Setup

Copy `.env.example` to `.env` and fill in:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

```bash
pnpm install
pnpm start
```

Qdrant must be running on `localhost:6333` (Docker recommended).
For headless browser on a VPS without a display, set `DISPLAY=:99` and run Xvfb.
