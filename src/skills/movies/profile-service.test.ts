import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createProfileService } from './profile-service.js';
import type { User } from './types.js';

let db: RecommenderDb;
let repo: Repository;
let user: User;

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
  const household = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  user = repo.createUser({ household_id: household.id, name: 'Тимур' });
});

test('setPreferences upserts extracted preferences and constraints with manual origin', async () => {
  const callLlm = async () =>
    JSON.stringify({
      preferences: [{ dimension: 'trope', value: 'trope:robot_best_friend', weight: 0.9 }],
      constraints: [{ type: 'exclude_theme', value: 'theme:fairies' }],
    });
  const service = createProfileService(repo, { callLlm });

  const result = await service.setPreferences(user.id, 'Тимур теперь фанатеет от роботов');
  assert.equal(result.preferences.length, 1);

  const prefs = repo.getPreferences(user.id);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]!.value, 'trope:robot_best_friend');
  assert.equal(prefs[0]!.weight, 0.9);
  assert.equal(prefs[0]!.origin, 'manual');

  const constraints = repo.getConstraints(user.id);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0]!.value, 'theme:fairies');
  assert.equal(constraints[0]!.origin, 'manual');
});

test('setPreferences clamps out-of-range weights and ignores malformed entries', async () => {
  const callLlm = async () =>
    JSON.stringify({
      preferences: [
        { dimension: 'genre', value: 'genre:adventure', weight: 5 },
        { dimension: 'not_a_dimension', value: 'x', weight: 1 },
      ],
      constraints: [],
    });
  const service = createProfileService(repo, { callLlm });

  await service.setPreferences(user.id, 'любит приключения');
  const prefs = repo.getPreferences(user.id);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]!.weight, 1);
});

test('setPreferences returns empty extraction on invalid LLM JSON, without throwing', async () => {
  const service = createProfileService(repo, { callLlm: async () => 'not json' });
  const result = await service.setPreferences(user.id, 'что-то непонятное');
  assert.deepEqual(result, { preferences: [], constraints: [] });
  assert.deepEqual(repo.getPreferences(user.id), []);
});

test('summary renders liked features and avoided constraints in human-readable form', () => {
  repo.upsertPreference({ user_id: user.id, dimension: 'trope', value: 'trope:underdog_hero', weight: 0.7, origin: 'feedback' });
  repo.upsertPreference({ user_id: user.id, dimension: 'genre', value: 'genre:horror', weight: -0.5, origin: 'feedback' });
  repo.upsertConstraint({ user_id: user.id, type: 'exclude_theme', value: 'theme:fairies', origin: 'feedback' });

  const service = createProfileService(repo);
  const text = service.summary(user.id);
  assert.match(text, /Любит:.*trope:underdog_hero/);
  assert.doesNotMatch(text, /genre:horror/);
  assert.match(text, /Избегает:.*theme:fairies/);
});

test('summary handles an empty profile gracefully', () => {
  const service = createProfileService(repo);
  assert.equal(service.summary(user.id), 'Профиль пока пуст.');
});
