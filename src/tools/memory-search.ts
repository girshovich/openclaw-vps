import { searchMemory } from '../memory/qdrant.js';
import { embedQuery } from '../memory/embeddings.js';

export async function executeMemorySearch(query: string): Promise<string> {
  const vector = await embedQuery(query);
  const results = await searchMemory(query, vector, 5);
  if (results.length === 0) return 'No relevant memories found.';
  return results
    .map((r, i) => `[${i + 1}] (relevance: ${r.score.toFixed(2)}) ${r.text}`)
    .join('\n\n');
}
