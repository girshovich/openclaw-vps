# Integration Notes — OpenClaw Host Hooks (Phase 0)

Five real host hooks the movies skill (and the Phase 0.5 Skill framework) will plug into. Verified against the current source tree.

## 1. Tool registration & execution
`src/runtime/tools.ts`
- `ALL_TOOLS: ToolDefinition[]` — `src/runtime/tools.ts:17` — static array of every tool the agent can call.
- `getToolDefinitions(depth)` — `src/runtime/tools.ts:152` — returns the tool set for a turn (full set at depth 0, restricted `SUB_AGENT_TOOLS` subset at depth ≥ 1).
- `executeTool(call, ctx)` — `src/runtime/tools.ts:159` — `switch` on `call.name` that dispatches to each tool's handler.

The Skill registry will need to extend both: append active skills' tools to what `getToolDefinitions` returns, and fall through to a skill's `executeTool` when `call.name` isn't one of the core tools.

## 2. LLM client / multi-model layer
`src/llm/index.ts`
- `chat(messages, model, systemPrompt, tools, signal)` — `src/llm/index.ts:286` — the single entry point used by the runtime loop; routes to Anthropic or OpenAI (`callAnthropic` / `callOpenAI`) with automatic fallback on zero-balance (`withFallback`, `src/llm/index.ts:268`).
- `ToolDefinition` / `ToolCall` shapes — `src/llm/index.ts:38` and `src/llm/index.ts:48` — provider-agnostic shapes that both `runtime/tools.ts` and the movies skill's tool schemas must conform to.
- `simpleChat(prompt, model, systemPrompt)` — `src/llm/index.ts:303` — one-shot text call (no tools); used by the classifier (`src/runtime/classifier.ts:13`) and will be reused by `TropeService`/`ProfileService` for LLM extraction.

The movies skill reuses `chat`/`simpleChat` directly — no new key path, no new provider client.

## 3. Telegram send layer
`src/channels/telegram/index.ts`
- `sendMessage(chatId, text)` — `src/channels/telegram/index.ts:38` — **text-only today**: calls `bot.api.sendMessage` with `parse_mode: 'Markdown'`, falling back to plain text on parse errors. No `reply_markup` (buttons) or `sendPhoto` (posters) path exists yet — confirms spec §7's text-only v1 and Phase 9's gateway-protocol-extension requirement.
- Inbound flow: `bot.on('message:text', ...)` — `src/channels/telegram/index.ts:93` — forwards non-command text to the gateway over the WebSocket opened in `connectWithRetry` (`src/channels/telegram/index.ts:10`).

## 4. Persistence pattern
`src/memory/sqlite.ts`
- `initDb()` — `src/memory/sqlite.ts:62` — opens a `better-sqlite3` handle from `process.env['DB_PATH']`, sets WAL mode, then runs a single `db.exec` block of `CREATE TABLE IF NOT EXISTS` statements (`src/memory/sqlite.ts:66`–`126`).
- Manual migrations for existing DBs — `src/memory/sqlite.ts:129`–`131` — `try { db.exec('ALTER TABLE ...') } catch { /* already exists */ }`, since there is no migration framework.
- This is the **session store** (`sessions`, `messages`, `tasks`, `cron_jobs`, `pending_embeddings`). The movies skill must follow the same `CREATE TABLE IF NOT EXISTS` + try/catch-`ALTER` pattern but against a **separate** `better-sqlite3` handle/file (`recommender.db`), opened from the skill's own `migrate()` — never importing this module's `db`.

## 5. Runtime loop — where tools are assembled per turn
`src/runtime/index.ts`
- `runTurn(sessionId, userMessage, signal, depth)` — `src/runtime/index.ts:81` — the agent loop: appends the user message, builds the system prompt (`buildSystemPrompt`, `src/runtime/index.ts:38`), calls `getToolDefinitions(depth)` (`src/runtime/index.ts:91`), then loops `chat` → `executeTool` (`Promise.all` over `response.calls`, `src/runtime/index.ts:138`) until a text response.
- This is exactly where the Phase 0.5 **Skill activator** hooks in: line 90–91 is where `systemPrompt` and `tools` are assembled for the turn, so an active skill's `systemPromptFragment` gets appended to `buildSystemPrompt`'s output and its `tools[]` get concatenated onto `getToolDefinitions(depth)`'s result, before the loop at line 106 begins.
- Cost guard (`BudgetExceededError`, `src/runtime/index.ts:11`, checked at `src/runtime/index.ts:110`) and compaction (`compactIfNeeded`, `src/runtime/index.ts:112`) are pre-existing concerns the skill must not bypass — tool results still flow through the same `appendMessage` / 30%-cap truncation at `src/runtime/index.ts:142`–`151`.

## Bonus reference (not one of the five, but relevant to Phase 0.5)
`src/runtime/classifier.ts:8` — `classifySession(recentHistory, newMessage)` using `CLASSIFY_MODEL` (`gpt-5-mini`, `src/llm/index.ts:29`). Spec §8 says the Skill activator should reuse "OpenClaw's existing GPT-5 Mini classifier" — this is that classifier; today it only decides new-vs-continuing session, so activator gating will need its own prompt/pass, not a literal call to `classifySession`.
