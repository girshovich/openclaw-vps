import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createLearningService } from './learning-service.js';
import type { LearningService } from './learning-service.js';
import type { Title, User } from './types.js';

let db: RecommenderDb;
let repo: Repository;
let learning: LearningService;
let user: User;
let title: Title;

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
  learning = createLearningService(repo);

  const household = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  user = repo.createUser({ household_id: household.id, name: 'A' });
  title = repo.upsertTitle({
    source: 'tmdb',
    source_id: '1',
    title: 'Kung Fu Panda',
    media_type: 'movie',
    genres: ['genre:action', 'genre:comedy'],
    themes: ['theme:friendship'],
    tropes: ['trope:underdog_hero'],
  });
});

function watchAndFeedback(rating: 'loved' | 'ok' | 'disliked', opts: { abandoned?: boolean; tags?: string[] } = {}) {
  const event = repo.createWatchEvent({ title_id: title.id, viewers: [{ user_id: user.id, age_at_watch: 6 }] });
  const fb = repo.addFeedback({
    watch_event_id: event.id,
    user_id: user.id,
    rating,
    abandoned: opts.abandoned ? 1 : 0,
    tags: opts.tags ?? [],
  });
  return fb;
}

test('loved feedback increases the weight of the title\'s genre/theme/trope/source_type features', () => {
  const fb = watchAndFeedback('loved');
  learning.applyFeedback(fb.id);

  const prefs = repo.getPreferences(user.id);
  const byValue = new Map(prefs.map((p) => [p.value, p]));
  assert.ok(byValue.get('genre:action')!.weight > 0);
  assert.ok(byValue.get('genre:comedy')!.weight > 0);
  assert.ok(byValue.get('theme:friendship')!.weight > 0);
  assert.ok(byValue.get('trope:underdog_hero')!.weight > 0);
  assert.ok(byValue.get('source_type:movie')!.weight > 0);
  assert.equal(byValue.get('genre:action')!.origin, 'feedback');
  assert.equal(byValue.get('genre:action')!.age_at_signal, 6);
});

test('disliked feedback decreases weights', () => {
  const fb = watchAndFeedback('disliked');
  learning.applyFeedback(fb.id);

  const prefs = repo.getPreferences(user.id);
  for (const p of prefs) assert.ok(p.weight < 0);
});

test('abandoned feedback is a stronger negative than plain disliked, especially for tropes', () => {
  const disliked = watchAndFeedback('disliked');
  learning.applyFeedback(disliked.id);
  const dislikedTropeWeight = repo.getPreferences(user.id).find((p) => p.value === 'trope:underdog_hero')!.weight;

  // fresh state for a clean abandoned comparison
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
  learning = createLearningService(repo);
  const household = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  user = repo.createUser({ household_id: household.id, name: 'A' });
  title = repo.upsertTitle({
    source: 'tmdb',
    source_id: '1',
    title: 'Kung Fu Panda',
    media_type: 'movie',
    genres: ['genre:action'],
    tropes: ['trope:underdog_hero'],
  });
  const abandoned = watchAndFeedback('disliked', { abandoned: true });
  learning.applyFeedback(abandoned.id);
  const abandonedTropeWeight = repo.getPreferences(user.id).find((p) => p.value === 'trope:underdog_hero')!.weight;

  assert.ok(abandonedTropeWeight < dislikedTropeWeight);
});

test('ok feedback does not write any preference rows', () => {
  const fb = watchAndFeedback('ok');
  learning.applyFeedback(fb.id);
  assert.deepEqual(repo.getPreferences(user.id), []);
});

test('applyFeedback is idempotent: a second call does not change weights again', () => {
  const fb = watchAndFeedback('loved');
  learning.applyFeedback(fb.id);
  const first = repo.getPreferences(user.id).find((p) => p.value === 'genre:action')!.weight;

  learning.applyFeedback(fb.id);
  const second = repo.getPreferences(user.id).find((p) => p.value === 'genre:action')!.weight;

  assert.equal(first, second);
});

test('a trigger-prefixed tag creates a user_constraint', () => {
  const fb = watchAndFeedback('disliked', { abandoned: true, tags: ['trigger:loud_noises'] });
  learning.applyFeedback(fb.id);

  const constraints = repo.getConstraints(user.id);
  const trigger = constraints.find((c) => c.type === 'trigger');
  assert.equal(trigger?.value, 'trigger:loud_noises');
  assert.equal(trigger?.origin, 'feedback');
});
