import { getSessionHistory, replaceSessionHistory } from '../memory/sqlite.js';
import type { DbMessage } from '../memory/sqlite.js';
import { simpleChat, SUMMARIZE_MODEL, MODEL_CONTEXT_SIZES, DEFAULT_MODEL } from '../llm/index.js';
import type { ModelId } from '../llm/index.js';
import type { MessageRole } from '../types.js';

type AppendOpts = {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  modelUsed?: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
};

function dbToOpts(m: DbMessage): AppendOpts {
  const opts: AppendOpts = {
    role: m.role,
    content: m.content,
    tokenCount: m.token_count,
    metadata: JSON.parse(m.metadata) as Record<string, unknown>,
  };
  if (m.tool_call_id) opts.toolCallId = m.tool_call_id;
  if (m.model_used) opts.modelUsed = m.model_used;
  return opts;
}

function totalTokens(msgs: DbMessage[]): number {
  return msgs.reduce((s, m) => s + m.token_count, 0);
}

// Group messages so assistant+tool_result sets are never split across a boundary.
function groupMessages(msgs: DbMessage[]): DbMessage[][] {
  const groups: DbMessage[][] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = msgs[i]!;
    if (m.role === 'assistant') {
      const meta = JSON.parse(m.metadata) as { toolCalls?: Array<{ id: string }> };
      const ids = new Set(meta.toolCalls?.map((c) => c.id) ?? []);
      if (ids.size > 0) {
        const group: DbMessage[] = [m];
        let j = i + 1;
        while (j < msgs.length && msgs[j]!.role === 'tool' && ids.has(msgs[j]!.tool_call_id ?? '')) {
          group.push(msgs[j]!);
          j++;
        }
        groups.push(group);
        i = j;
        continue;
      }
    }
    groups.push([m]);
    i++;
  }
  return groups;
}

async function summarizeChunk(msgs: DbMessage[]): Promise<string> {
  const text = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join('\n');
  const result = await simpleChat(
    `Summarize the following conversation concisely, preserving key facts and outcomes:\n\n${text}`,
    SUMMARIZE_MODEL,
  );
  return result.text;
}

export async function compactIfNeeded(
  sessionId: string,
  model: ModelId = DEFAULT_MODEL,
): Promise<DbMessage[]> {
  const messages = getSessionHistory(sessionId);
  const limit = MODEL_CONTEXT_SIZES[model];
  if (totalTokens(messages) < limit * 0.8) return messages;

  // Split at a group boundary so neither half starts with orphaned tool messages.
  const groups = groupMessages(messages);
  const targetSplit = Math.max(1, Math.floor(messages.length * 0.3));
  let boundary = 0;
  let counted = 0;
  for (let g = 0; g < groups.length - 1; g++) {
    counted += groups[g]!.length;
    if (counted >= targetSplit) { boundary = g + 1; break; }
  }
  if (boundary === 0) boundary = 1;
  const toCompact = groups.slice(0, boundary).flat();
  const toKeep = groups.slice(boundary).flat();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt === 0) {
        // Strategy 1: Summarize oldest 30% with GPT-5.4
        const summary = await summarizeChunk(toCompact);
        const summaryOpt: AppendOpts = {
          role: 'user',
          content: `[Summary of earlier conversation]: ${summary}`,
          tokenCount: Math.ceil(summary.length / 4),
        };
        replaceSessionHistory(sessionId, [summaryOpt, ...toKeep.map(dbToOpts)]);
        return getSessionHistory(sessionId);
      } else if (attempt === 1) {
        // Strategy 2: Strip tool result content to first 100 chars
        const stripped = messages.map((m): AppendOpts => {
          if (m.role === 'tool') {
            const short = m.content.slice(0, 100) + (m.content.length > 100 ? '…' : '');
            return { ...dbToOpts(m), content: short, tokenCount: Math.ceil(short.length / 4) };
          }
          return dbToOpts(m);
        });
        replaceSessionHistory(sessionId, stripped);
        return getSessionHistory(sessionId);
      } else {
        // Strategy 3: Drop oldest groups until under 70% — never split assistant+tool pairs.
        let gs = groupMessages(messages);
        while (totalTokens(gs.flat()) > limit * 0.7 && gs.length > 1) {
          gs = gs.slice(1);
        }
        replaceSessionHistory(sessionId, gs.flat().map(dbToOpts));
        return getSessionHistory(sessionId);
      }
    } catch {
      // try next strategy
    }
  }

  return messages;
}
