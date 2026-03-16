import { chat, DEFAULT_MODEL } from '../llm/index.js';
import type { LLMMessage, ToolCall } from '../llm/index.js';
import { appendMessage, getSessionHistory, createSession } from '../memory/sqlite.js';
import type { DbMessage } from '../memory/sqlite.js';
import { compactIfNeeded } from './compaction.js';
import { getToolDefinitions, executeTool } from './tools.js';
import type { ToolContext } from './tools.js';
import { executeMemorySearch } from '../tools/memory-search.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// ── System prompt ─────────────────────────────────────────────────────────────

const _promptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../Agent_Persona.md');
let _basePrompt: string;
try {
  _basePrompt = readFileSync(_promptPath, 'utf8').trim();
} catch {
  _basePrompt = 'You are OpenClaw, a proactive personal AI assistant.\n\nGuidelines:\n- Be direct and thorough.';
}

function buildSystemPrompt(memoryContext?: string): string {
  const parts = [_basePrompt, `\nCurrent time: ${new Date().toISOString()}.`];
  if (memoryContext && memoryContext !== 'No relevant memories found.') {
    parts.push('\nRelevant memories from past conversations:\n' + memoryContext);
  }
  return parts.join('\n');
}

// ── Message conversion ────────────────────────────────────────────────────────

function historyToLLM(history: DbMessage[]): LLMMessage[] {
  return history.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool') {
      return { role: 'tool', toolCallId: m.tool_call_id ?? '', content: m.content };
    }
    // assistant
    const meta = JSON.parse(m.metadata) as { toolCalls?: ToolCall[] };
    if (meta.toolCalls?.length) {
      return { role: 'assistant', content: m.content, toolCalls: meta.toolCalls };
    }
    return { role: 'assistant', content: m.content };
  });
}

// ── Memory retrieval triggers ─────────────────────────────────────────────────

const TEMPORAL_RE = /\b(last time|remember|before|previously|earlier|yesterday|last week|you told|you said|when we)\b/i;

async function maybeRetrieveMemory(sessionId: string, message: string): Promise<string | undefined> {
  const history = getSessionHistory(sessionId);
  const isNewSession = history.length === 0;
  const hasTemporalRef = TEMPORAL_RE.test(message);
  if (!isNewSession && !hasTemporalRef) return undefined;
  try {
    return await executeMemorySearch(message);
  } catch {
    return undefined;
  }
}

// ── Agent loop ────────────────────────────────────────────────────────────────

export async function runTurn(
  sessionId: string,
  userMessage: string,
  signal?: AbortSignal,
  depth = 0,
): Promise<string> {
  appendMessage(sessionId, { role: 'user', content: userMessage });

  const memoryContext = await maybeRetrieveMemory(sessionId, userMessage);
  const systemPrompt = buildSystemPrompt(memoryContext);
  const tools = getToolDefinitions(depth);

  const ctx: ToolContext = {
    sessionId,
    depth,
    signal,
    spawnSubAgent: (task: string) => {
      const subId = createSession({ parentSessionId: sessionId, depth: 1 });
      return runTurn(subId, task, signal, 1);
    },
  };

  // Agentic loop: call LLM, execute tools, repeat until text response
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const history = await compactIfNeeded(sessionId, DEFAULT_MODEL);
    const messages = historyToLLM(history);

    const response = await chat(messages, DEFAULT_MODEL, systemPrompt, tools, signal);

    if (response.type === 'text') {
      appendMessage(sessionId, {
        role: 'assistant',
        content: response.text,
        modelUsed: response.modelUsed,
        tokenCount: response.outputTokens,
      });
      return response.text;
    }

    // Save assistant message with tool calls
    appendMessage(sessionId, {
      role: 'assistant',
      content: response.text,
      modelUsed: response.modelUsed,
      tokenCount: response.outputTokens,
      metadata: { toolCalls: response.calls },
    });

    // Execute all tool calls — parallel for independence
    const results = await Promise.all(
      response.calls.map((call) => executeTool(call, ctx)),
    );

    // Enforce 30% tool result cap per the context limit
    const limit = 128_000; // conservative
    const cap = Math.floor(limit * 0.3 * 4); // chars
    for (let i = 0; i < response.calls.length; i++) {
      const call = response.calls[i]!;
      let content = results[i] ?? '';
      if (content.length > cap) {
        content = content.slice(0, cap) + '\n[truncated: result exceeded 30% context cap]';
      }
      appendMessage(sessionId, { role: 'tool', content, toolCallId: call.id });
    }
  }
}
