import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { seedRecommenderDb } from './seed.js';
import { createTropeService } from './trope-service.js';

let db: RecommenderDb;
let repo: Repository;

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
});

test('extract maps a known dictionary phrase to its existing canonical id and persists it on the title', async () => {
  seedRecommenderDb(db);
  const title = repo.upsertTitle({
    source: 'tmdb',
    source_id: '1',
    title: 'Kung Fu Panda',
    media_type: 'movie',
    synopsis: 'A clumsy panda is chosen to fulfill an ancient destiny.',
  });

  const callLlm = async () => JSON.stringify([{ phrase: 'underdog becomes hero', confidence: 'high' }]);
  const service = createTropeService(repo, { callLlm });

  const tropes = await service.extract(title);
  assert.deepEqual(tropes, ['trope:underdog_hero']);

  const stored = db.prepare(`SELECT tropes, tropes_extracted_at FROM title WHERE id = ?`).get(title.id) as {
    tropes: string;
    tropes_extracted_at: number;
  };
  assert.deepEqual(JSON.parse(stored.tropes), ['trope:underdog_hero']);
  assert.ok(stored.tropes_extracted_at > 0);
});

test('extract creates a new dictionary entry only for a high-confidence unmapped phrase', async () => {
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '2', title: 'Robot Pals', media_type: 'movie' });
  const callLlm = async () => JSON.stringify([{ phrase: 'robot best friend', confidence: 'high' }]);
  const service = createTropeService(repo, { callLlm });

  const tropes = await service.extract(title);
  assert.deepEqual(tropes, ['trope:robot_best_friend']);
  assert.equal(repo.resolveTrope('robot best friend'), 'trope:robot_best_friend');
});

test('extract drops low-confidence unmapped phrases: never stores raw/unmapped strings', async () => {
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '3', title: 'Mystery Movie', media_type: 'movie' });
  const callLlm = async () =>
    JSON.stringify([
      { phrase: 'a vague half-guessed pattern', confidence: 'low' },
      { phrase: 'underdog becomes hero', confidence: 'low' },
    ]);
  const service = createTropeService(repo, { callLlm });
  seedRecommenderDb(db); // dictionary has underdog_hero, but the LLM marked it low-confidence and it wasn't pre-resolved

  const tropes = await service.extract(title);
  assert.deepEqual(tropes, ['trope:underdog_hero']); // still resolved because it IS in the dictionary, regardless of confidence
  const stored = db.prepare(`SELECT tropes FROM title WHERE id = ?`).get(title.id) as { tropes: string };
  for (const t of JSON.parse(stored.tropes) as string[]) {
    assert.ok(t.startsWith('trope:'));
  }
  assert.equal(repo.resolveTrope('a vague half-guessed pattern'), null);
});

test('extract returns an empty list and persists no tropes when the LLM output is not valid JSON', async () => {
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '4', title: 'Garbled', media_type: 'movie' });
  const service = createTropeService(repo, { callLlm: async () => 'not json at all' });

  const tropes = await service.extract(title);
  assert.deepEqual(tropes, []);
  const stored = db.prepare(`SELECT tropes FROM title WHERE id = ?`).get(title.id) as { tropes: string };
  assert.deepEqual(JSON.parse(stored.tropes), []);
});
