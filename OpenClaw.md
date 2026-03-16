# OpenClaw

A multi-channel AI agent framework. Connects messaging platforms (Telegram, WhatsApp, Slack, Discord) to a cascade of LLM providers through a persistent, proactive agent runtime.

Runs entirely on a VPS (Ubuntu 24.04). The local machine is for editing and pushing only.

---

## LLM Stack

Two providers, direct API keys (no subscription auth, no OpenRouter):

| Provider | Key type |
|---|---|
| Anthropic | API key |
| OpenAI | API key |

**Model selection by task complexity:**

| Complexity | Model |
|---|---|
| High | Claude Opus 4.6 |
| Low | GPT-5 Mini |
| Default / general | GPT-5.4 |
| Context summarization | GPT-5.4 |
| Complexity classifier | GPT-5 Mini (single fast call returning "high" or "low") |

**Resilience:** if a model fails it moves to the next in chain. If a provider's API key hits zero balance, OpenClaw switches to the other provider and sends a Telegram message to the user immediately.

---

## Architecture

Three layers:

1. **Gateway** — WebSocket server, all traffic lands here first
2. **Agent Runtime** — manages sessions, tool calls, memory, context
3. **Channels** — thin MCP servers connecting to messaging platforms (bidirectional)

**Deployment layout:**

| What | Where |
|---|---|
| Config, code edits | Local machine |
| Gateway, runtime, heartbeat | VPS |
| Browser automation | VPS (headless Chromium) |
| API keys / secrets | VPS env vars only |

**Security constraint: OpenClaw is never run locally.** The codebase is edited and typechecked on the local machine, then pushed to the VPS where it runs inside Docker. API keys and the `.env` file exist only on the VPS — never on the local machine. This prevents accidental key exposure, keeps browser automation and bash tool execution off the local filesystem, and ensures Docker network isolation is always in effect.

---

## Message Routing

The gateway assigns each incoming message to an agent based on:

- **Channel** — e.g. a Telegram-specific agent
- **Role** — e.g. Financial Analyst

**Single persona:** OpenClaw presents one consistent persona regardless of which channel the message came from.

Default is a general-purpose agent.

Each agent run starts with: full session history, context sources in the system prompt (identity, tools, channel rules, time, saved memory), and available tools.

---

## Session Model

**Session = task, not time window.** Sessions are short and purposeful, not long-running open connections.

### Session states

| State | Condition | Heartbeat |
|---|---|---|
| **Active** | User messaged in last 4 hours | Yes |
| **Idle** | No activity for 4–48 hours | Yes — checks for unfinished tasks |
| **Archived** | 7 days idle, or `/end` command | No — compacted to summary, stored |

`/end` triggers immediate archiving.

### Session separation

When a new message arrives, a GPT-5 Mini classifier answers: *"Is this continuing the current session's topic, or starting something new?"*

| Situation | Action |
|---|---|
| No active session | Start new session |
| Active session, same topic | Continue it |
| Active session, new topic | Archive current → start new |
| Active session, ambiguous | Continue — user can `/new` to force |

The agent also self-archives on task completion: last step finished, no outstanding tool calls, no pending task objects.

**On archive:** GPT-5.4 writes a summary of what was done and the outcome. That summary is embedded and written to the vector store for future retrieval.

### Session store schema (SQLite)

Each record:

```
{
  session_id,
  parent_session_id?,   // set for sub-agent sessions
  depth,                // 0 = main, 1 = sub-agent (max)
  status,               // active | idle | archived
  timestamp,
  message_id,
  role,                 // user | assistant | tool
  content,
  tool_call_id?,
  model_used,
  token_count,
  metadata: {}
}
```

---

## Lane Queue

Most frameworks work like a deli counter — take a number, wait your turn. OpenClaw uses a highway model:

- **Session lanes** — each conversation has its own lane, they don't block each other
- **Global lane** — for system-wide operations
- **Steering** — a new message mid-response cancels the current run and restarts with the new message appended to history, so the agent sees the full updated picture
- **Idle-aware flushing** — tool results accumulate while the model is thinking, flushed only when it goes idle

---

## Context Management

Context window limits are **model-aware**: a `MODEL_CONTEXT_SIZES` map stores the token limit per model. The 80% trigger and 30% tool cap are derived from this map at runtime, not hardcoded.

**Compaction triggers at ~80% capacity:**
1. GPT-5.4 summarizes the oldest conversation chunk in place
2. If that fails: strips tool result metadata, then oldest non-essential messages
3. Up to 3 retries with different strategies

Any single tool result is hard-capped at **30% of the model's context window** and progressively truncated if oversized.

---

## Memory

Two tiers:

1. **Session store** — SQLite, active conversation history per session
2. **Vector search** — Qdrant (runs as a Docker container), semantic search across full history. Hybrid 70% vector / 30% BM25 keyword.

**Embeddings:** OpenAI's embedding model only. If OpenAI is unavailable at write time, the record is queued and embedded when the API comes back. Embedding models are never mixed in the same index.

**Retrieval triggers vector search when:**
- Session is new (no active history to draw from)
- Message contains temporal references ("last time", "remember", "before")
- Agent explicitly calls the `memory_search` tool

Otherwise: in-context session history is used directly.

---

## Proactive Behavior

Agents run 24/7 with a heartbeat firing every 5 minutes:

- Checks for sessions with unfinished task objects (tracked as explicit records with states, not inferred from language)
- If an unfinished task is found, the agent returns to it with a proposal unprompted
- Supports cron-scheduled messages and delayed responses

---

## Missing Capability Reporting

When an agent determines it lacks a tool or capability required to complete a task, it does not attempt to self-repair. Instead:

```
Agent hits a capability gap
  └─► Formulates a clear description of what is missing and why
        └─► Sends the description to the user via Telegram
              └─► Stops or continues with what it can do
```

The message includes: what the agent was trying to do, what specific capability is missing, and what would be needed to handle it. The user decides what action to take.

---

## Agentic Orchestration

Complex tasks spawn parallel sub-agents. Example: "research three restaurants" → three researcher agents run simultaneously, each with its own context, tools, and model.

- Sub-agents report back to the parent orchestrator via a queue
- The parent can steer a sub-agent mid-run
- **Sub-agents cannot spawn their own sub-agents** — enforced at the runtime level via the `depth` field: spawn requests at `depth >= 1` are rejected, not just instructed against
- Sub-agent sessions are persisted to SQLite with `parent_session_id` and `depth: 1`; on restart, in-progress sub-agent sessions are re-queued

---

## Security

All external content (emails, webpages, webhooks) is wrapped in a boundary before the model sees it:

```
<<EXTERNAL UNTRUSTED CONTEXT>>
[content]
<<END OF THE EXTERNAL UNTRUSTED CONTENT>>
```

Additional scanning for prompt injection patterns and Unicode homoglyph attacks. Suspicious content is logged but processed safely.

---

## Isolation

OpenClaw runs on its own Docker network (`openclaw-net`). Other services on the same VPS run on separate networks and cannot reach OpenClaw unless explicitly connected.

```bash
docker network create openclaw-net
docker run --network openclaw-net ... openclaw-gateway
docker run --network openclaw-net ... openclaw-runtime
```

Resource limits on all OpenClaw containers prevent a runaway process from starving other services on the VPS.

---

## Tools

50+ built-in tools including:

- **Browser** — Playwright/Chromium automation imitating real user behavior (handles Cloudflare, bot detection)
- **Bash** — terminal command execution
- **Memory search** — vector history lookup via Qdrant
- **Cron** — recurring task scheduling
- **Heartbeat** — keeps sessions alive and proactive

### Browser on Ubuntu Server

```bash
npx playwright install chromium
npx playwright install-deps chromium
```

For headed mode (stronger bot-detection evasion):

```bash
sudo apt-get install -y xvfb
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
```

---

## Channel Connectors

One thin MCP server per platform. Each exposes two tools: `send_message` and `get_updates`.

Telegram uses **long polling** (no public HTTPS endpoint required).

---

## Infrastructure Summary

| Component | Technology |
|---|---|
| Runtime | Node.js / TypeScript |
| Session store | SQLite |
| Vector store | Qdrant (Docker) |
| Channel connectors | MCP servers (one per platform) |
| Browser automation | Playwright + Chromium |
| VPS OS | Ubuntu 24.04 |
| Container runtime | Docker |
| LLM providers | Anthropic API, OpenAI API |
