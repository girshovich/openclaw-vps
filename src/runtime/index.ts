import { chat, DEFAULT_MODEL, estimateCost } from '../llm/index.js';
import type { LLMMessage, ToolCall } from '../llm/index.js';
import { appendMessage, getSessionHistory, createSession, addSessionCost, getSessionCost, getSessionCostWarned, markSessionCostWarned } from '../memory/sqlite.js';
import type { DbMessage } from '../memory/sqlite.js';

// ── Skill registration ────────────────────────────────────────────────────────

try {
  registerMoviesSkill();
} catch {
  // API key not configured or DB unavailable; movies skill is skipped silently
}

// ── Budget limits ─────────────────────────────────────────────────────────────

export const SESSION_COST_LIMIT_USD = parseFloat(process.env['SESSION_COST_LIMIT_USD'] ?? '4.00');
const SUBAGENT_COST_LIMIT_USD = parseFloat(process.env['SUBAGENT_COST_LIMIT_USD'] ?? '1.00');

export class BudgetExceededError extends Error {
  constructor(spent: number, limit: number) {
    super(
      `Session cost limit reached ($${spent.toFixed(4)} of $${limit.toFixed(2)}). ` +
      `Start a new session with /new to continue.`,
    );
    this.name = 'BudgetExceededError';
  }
}

// Returns a one-time notice the first time a session passes half its budget,
// else null. Threshold is derived from the live limit, so changing the limit
// automatically moves the warning point.
export function maybeHalfBudgetNotice(sessionId: string): string | null {
  const spent = getSessionCost(sessionId);
  if (spent < SESSION_COST_LIMIT_USD / 2) return null;
  if (getSessionCostWarned(sessionId)) return null;
  markSessionCostWarned(sessionId);
  return (
    `ℹ️ Used $${spent.toFixed(2)} of your $${SESSION_COST_LIMIT_USD.toFixed(2)} session limit (over half). ` +
    `You can keep going; at the limit you'll need /new to continue.`
  );
}
import { compactIfNeeded } from './compaction.js';
import { getToolDefinitions, executeTool } from './tools.js';
import type { ToolContext } from './tools.js';
import { executeMemorySearch } from '../tools/memory-search.js';
import { activateSkills } from '../skills/activator.js';
import { registerMoviesSkill } from '../skills/movies/index.js';
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

  // Skill activator: sticky + additive gating, scoped out of sub-agents
  const activeSkills = depth === 0 ? activateSkills(sessionId, userMessage) : [];
  const skillPromptFragment = activeSkills
    .map((skill) => skill.systemPromptFragment)
    .filter((fragment): fragment is string => Boolean(fragment))
    .join('\n\n');
  const skillToolOwner = new Map(
    activeSkills.flatMap((skill) => skill.tools.map((t) => [t.name, skill] as const)),
  );

  const systemPrompt =
    buildSystemPrompt(memoryContext) + (skillPromptFragment ? `\n\n${skillPromptFragment}` : '');
  const tools = [...getToolDefinitions(depth), ...activeSkills.flatMap((skill) => skill.tools)];

  const ctx: ToolContext = {
    sessionId,
    depth,
    signal,
    spawnSubAgent: (task: string) => {
      const subId = createSession({ parentSessionId: sessionId, depth: 1 });
      return runTurn(subId, task, signal, 1);
    },
  };

  const costLimit = depth > 0 ? SUBAGENT_COST_LIMIT_USD : SESSION_COST_LIMIT_USD;

  // Agentic loop: call LLM, execute tools, repeat until text response
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const spent = getSessionCost(sessionId);
    if (spent >= costLimit) throw new BudgetExceededError(spent, costLimit);

    const history = await compactIfNeeded(sessionId, DEFAULT_MODEL);
    const messages = historyToLLM(history);

    const response = await chat(messages, DEFAULT_MODEL, systemPrompt, tools, signal);
    addSessionCost(sessionId, estimateCost(response.modelUsed, response.inputTokens, response.outputTokens));

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

    // Execute all tool calls — parallel for independence.
    // allSettled guarantees every tool_call_id gets a response message even if one throws,
    // preventing the "tool_calls without responses" session corruption.
    const settled = await Promise.allSettled(
      response.calls.map((call) => {
        const owner = skillToolOwner.get(call.name);
        return owner ? owner.executeTool(call, { sessionId, signal }) : executeTool(call, ctx);
      }),
    );

    // Enforce 30% tool result cap per the context limit
    const limit = 128_000; // conservative
    const cap = Math.floor(limit * 0.3 * 4); // chars
    for (let i = 0; i < response.calls.length; i++) {
      const call = response.calls[i]!;
      const result = settled[i]!;
      let content = result.status === 'fulfilled'
        ? result.value
        : JSON.stringify({ error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      if (content.length > cap) {
        content = content.slice(0, cap) + '\n[truncated: result exceeded 30% context cap]';
      }
      appendMessage(sessionId, { role: 'tool', content, toolCallId: call.id });
    }
  }
}
