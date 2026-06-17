// C2 validation: createRecommenderDb seeds taxonomy and tropes automatically on creation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import { createRepository } from './repository.js';

test('createRecommenderDb seeds taxonomy_map and trope_dictionary automatically', () => {
  const db = createRecommenderDb(':memory:');
  const repo = createRepository(db);
  assert.equal(repo.resolveTaxonomy('tmdb', 'Action'), 'genre:action');
  assert.ok(repo.resolveTrope('underdog becomes hero'), 'trope alias must resolve after auto-seed');
});
