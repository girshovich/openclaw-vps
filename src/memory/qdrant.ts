import { QdrantClient } from '@qdrant/js-client-rest';

const COLLECTION = 'openclaw_memory';
const VECTOR_SIZE = 1536;

let _client: QdrantClient | undefined;

function getClient(): QdrantClient {
  if (!_client) {
    _client = new QdrantClient({ url: process.env['QDRANT_URL'] ?? 'http://localhost:6333' });
  }
  return _client;
}

export async function initQdrant(): Promise<void> {
  const client = getClient();
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === COLLECTION)) {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
    });
    await client.createPayloadIndex(COLLECTION, {
      field_name: 'session_id',
      field_schema: 'keyword',
    });
  }
}

export interface MemoryPoint {
  id: string;
  sessionId: string;
  text: string;
  timestamp: number;
}

export async function upsertMemory(point: MemoryPoint, vector: number[]): Promise<void> {
  await getClient().upsert(COLLECTION, {
    points: [{
      id: point.id,
      vector,
      payload: { session_id: point.sessionId, text: point.text, timestamp: point.timestamp },
    }],
  });
}

export interface MemorySearchResult {
  id: string;
  text: string;
  score: number;
  timestamp: number;
}

function keywordScore(query: string, text: string): number {
  const terms = new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  if (terms.size === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) if (lower.includes(term)) hits++;
  return hits / terms.size;
}

export async function searchMemory(
  query: string,
  vector: number[],
  limit = 5,
): Promise<MemorySearchResult[]> {
  const results = await getClient().search(COLLECTION, {
    vector,
    limit: limit * 3,
    with_payload: true,
  });

  return results
    .map((r) => {
      const payload = r.payload as { text?: string; timestamp?: number } | undefined;
      const text = payload?.text ?? '';
      return {
        id: String(r.id),
        text,
        score: 0.7 * r.score + 0.3 * keywordScore(query, text),
        timestamp: payload?.timestamp ?? 0,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
