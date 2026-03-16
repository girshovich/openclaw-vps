import OpenAI from 'openai';
import { upsertMemory } from './qdrant.js';
import { addPendingEmbedding, getPendingEmbeddings, deletePendingEmbedding } from './sqlite.js';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;

let _openai: OpenAI | undefined;

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

export async function embed(text: string): Promise<number[]> {
  const response = await getOpenAI().embeddings.create({
    model: EMBED_MODEL,
    input: text,
    dimensions: EMBED_DIM,
  });
  const data = response.data[0];
  if (!data) throw new Error('No embedding returned');
  return data.embedding;
}

export async function embedAndStore(
  id: string,
  sessionId: string,
  text: string,
  timestamp: number,
): Promise<void> {
  try {
    const vector = await embed(text);
    await upsertMemory({ id, sessionId, text, timestamp }, vector);
  } catch {
    addPendingEmbedding(sessionId, text, { id, timestamp });
  }
}

export async function embedQuery(query: string): Promise<number[]> {
  return embed(query);
}

export async function flushPendingEmbeddings(): Promise<void> {
  const pending = getPendingEmbeddings();
  for (const p of pending) {
    try {
      const meta = JSON.parse(p.metadata) as { id?: string; timestamp?: number };
      const vector = await embed(p.text);
      await upsertMemory(
        { id: meta.id ?? p.id, sessionId: p.session_id, text: p.text, timestamp: meta.timestamp ?? p.created_at },
        vector,
      );
      deletePendingEmbedding(p.id);
    } catch {
      break; // OpenAI still unavailable — stop trying
    }
  }
}
