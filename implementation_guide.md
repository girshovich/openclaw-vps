# OpenClaw — Implementation Guide

Step-by-step from bare VPS to running agent.

---

## Phase 1 — VPS Setup

SSH in and run once:

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
npm install -g pnpm

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# Xvfb (for headed browser mode)
sudo apt-get install -y xvfb
```

---

## Phase 2 — Project Scaffold (local machine)

```bash
cd openclaw
pnpm init
pnpm add -D typescript tsx @types/node eslint prettier
pnpm tsc --init
```

**Directory structure:**

```
openclaw/
  src/
    gateway/          # WebSocket server + message routing
    runtime/          # Agent loop, session management, context
    llm/              # Provider abstraction (Anthropic + OpenAI)
    memory/           # SQLite session store + Qdrant vector store
    channels/
      telegram/       # Polling + MCP server
    tools/            # All built-in tools
    heartbeat/        # 5-min proactive loop
  docker/
    docker-compose.yml
  .env.example
```

**Core dependencies:**

```bash
# LLM providers
pnpm add @anthropic-ai/sdk openai

# Storage
pnpm add better-sqlite3 @qdrant/js-client-rest
pnpm add -D @types/better-sqlite3

# Gateway + channels
pnpm add ws grammy @modelcontextprotocol/sdk
pnpm add -D @types/ws

# Browser
pnpm add playwright

# Utilities
pnpm add dotenv zod uuid
```

> **grammy** is the Telegram library — modern, TypeScript-first, built-in long polling.

---

## Phase 3 — Infrastructure on VPS

```bash
# Isolated Docker network
docker network create openclaw-net

# Qdrant vector store
docker run -d \
  --name qdrant \
  --network openclaw-net \
  --restart unless-stopped \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

Qdrant is now reachable at `http://qdrant:6333` from within `openclaw-net`.

---

## Phase 4 — Secrets

On the VPS only, never in the repo:

```bash
# /opt/openclaw/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
TELEGRAM_BOT_TOKEN=...       # from @BotFather on Telegram
TELEGRAM_CHAT_ID=...         # your personal chat ID (from @userinfobot)
SIGNING_SECRET=...           # random 32-char string for self-repair correlation IDs
QDRANT_URL=http://qdrant:6333
DB_PATH=/opt/openclaw/data/sessions.db
```

**Get your Telegram bot token:** message `@BotFather` → `/newbot` → follow prompts.
**Get your chat ID:** message `@userinfobot`.

---

## Phase 5 — Build Order

Build in this order. Each step depends on the previous.

### Step 1 — LLM provider module

Single function: `chat(messages, model)` → response. Wraps both `@anthropic-ai/sdk` and `openai`. On any API call, checks for zero-balance errors → switches provider → sends Telegram alert → retries.

### Step 2 — SQLite session store

Initialize the DB schema on startup. CRUD functions: `appendMessage`, `getSessionHistory`, `updateSessionStatus`, `createSession`. Sub-agent sessions get `parent_session_id` and `depth` columns from the start.

### Step 3 — Agent runtime (single turn, no tools)

Takes a session ID + new message → loads history from SQLite → calls LLM → appends response → returns. No tools, no compaction yet. Just the loop.

### Step 4 — Telegram channel connector

Two responsibilities:
- **Inbound:** `grammy` bot in long-polling mode, pushes each incoming message to the gateway via WebSocket
- **Outbound:** MCP server exposing `telegram:send_message` tool that the agent calls to reply

### Step 5 — Gateway

WebSocket server. Receives messages from channel connectors. Routes to the agent runtime based on channel type. Returns agent response to the originating connector.

---

**At this point: send a Telegram message → agent replies. First milestone.**

---

### Step 6 — `MODEL_CONTEXT_SIZES` map + context compaction

Define the map (Opus 4.6: 200k, Sonnet 4.6: 200k, GPT-5.4: N tokens, etc.). Add token counting to every append. Add the 80% compaction trigger: call GPT-5.4 to summarize oldest chunk, fall back to stripping metadata, up to 3 retries. Enforce 30% hard cap on individual tool results.

### Step 7 — Memory (Qdrant + embedding queue)

On session archive: embed the GPT-5.4 summary → write to Qdrant. On retrieval triggers (new session, temporal reference, explicit tool call): query Qdrant with hybrid 70/30 vector+BM25. Embedding queue: if OpenAI unavailable, write to a `pending_embeddings` SQLite table; a background flush loop retries.

### Step 8 — Session classifier

Wrap every incoming message (when an active session exists) with a GPT-5 Mini call: *"same topic or new?"* → continue or archive+new. Handle `/new` and `/end` commands explicitly before the classifier runs.

### Step 9 — Heartbeat

A `setInterval` every 5 minutes. Queries SQLite for sessions with `status = active OR idle` and any task records with `status = pending OR in_progress`. If found: triggers the agent runtime with the session context + a system-injected "continue unfinished task" prompt.

### Step 10 — Lane queue

Replace direct runtime calls with a per-session queue. Each session gets its own processing lane. Mid-run message: cancel current stream (abort signal), append new message, restart. Accumulate tool results while model is mid-generation, flush on idle.

### Step 11 — Tools

Build in this order (highest value first):
1. `bash` — spawn a child process, return stdout/stderr
2. `memory_search` — calls Qdrant
3. `cron` — wraps a cron scheduler, stores jobs in SQLite
4. `browser` — Playwright with the `DISPLAY=:99` env var set
5. Remaining tools

### Step 12 — Sub-agents

Agent runtime gains a `spawnSubAgent(task, model)` function. Checks `depth` field — rejects if `>= 1`. Creates a new SQLite session with `parent_session_id` and `depth: 1`. Runs in parallel, reports back to parent queue on completion. On restart: re-queues in-progress sub-agent sessions.

### Step 13 — Missing capability reporting

When the agent determines it lacks a tool or capability to complete a task, it formulates a plain-language description of what is missing and why, then sends it to the user via Telegram. No execution, no approval flow. The agent stops or continues with what it can do.

---

## Phase 6 — Docker Compose + Run

`docker/docker-compose.yml`:

```yaml
version: "3.9"
services:
  qdrant:
    image: qdrant/qdrant
    networks: [openclaw-net]
    volumes:
      - qdrant_storage:/qdrant/storage
    restart: unless-stopped

  openclaw:
    build: .
    networks: [openclaw-net]
    env_file: .env
    volumes:
      - /opt/openclaw/data:/opt/openclaw/data
    restart: unless-stopped
    mem_limit: 2g
    cpus: 1.5

networks:
  openclaw-net:
    external: true

volumes:
  qdrant_storage:
```

On the VPS:

```bash
# First run
docker compose -f docker/docker-compose.yml up -d

# Watch logs
docker compose logs -f openclaw

# Restart after pushing updates
git pull && docker compose up -d --build openclaw
```

---

## Build sequence summary

```
LLM provider
  → SQLite store
    → Agent runtime (no tools)
      → Telegram connector
        → Gateway
          ✓ FIRST MESSAGE WORKS
            → Context compaction
              → Memory (Qdrant)
                → Session classifier
                  → Heartbeat
                    → Lane queue
                      → Tools
                        → Sub-agents
                          → Self-repair
```
