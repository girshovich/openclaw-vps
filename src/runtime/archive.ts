import { randomUUID } from 'node:crypto';
import { getSessionHistory, updateSessionStatus, addPendingEmbedding } from '../memory/sqlite.js';
import { simpleChat, SUMMARIZE_MODEL } from '../llm/index.js';
import { embedAndStore } from '../memory/embeddings.js';

export async function archiveSession(sessionId: string): Promise<void> {
  const history = getSessionHistory(sessionId);

  if (history.length === 0) {
    updateSessionStatus(sessionId, 'archived');
    return;
  }

  // Build summary
  let summary = '';
  try {
    const text = history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n');
    const result = await simpleChat(
      `Summarize this conversation concisely, preserving key facts, decisions, and outcomes:\n\n${text}`,
      SUMMARIZE_MODEL,
    );
    summary = result.text;
  } catch {
    summary = `Session archived at ${new Date().toISOString()}.`;
  }

  // Embed and store in Qdrant (queue on failure)
  try {
    await embedAndStore(randomUUID(), sessionId, summary, Date.now());
  } catch {
    addPendingEmbedding(sessionId, summary, { timestamp: Date.now() });
  }

  updateSessionStatus(sessionId, 'archived');
}
