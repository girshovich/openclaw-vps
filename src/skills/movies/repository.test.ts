import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { seedRecommenderDb } from './seed.js';
import { initDb } from '../../memory/sqlite.js';

let db: RecommenderDb;
let repo: Repository;

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
});

test('household CRUD round-trip', () => {
  assert.equal(repo.getHousehold(), null);
  const h = repo.createHousehold({ timezone: 'Asia/Yerevan', language: 'ru' });
  assert.equal(h.timezone, 'Asia/Yerevan');
  assert.equal(h.onboarded, 0);
  repo.setOnboarded();
  assert.equal(repo.getHousehold()?.onboarded, 1);
});

test('user CRUD round-trip', () => {
  const h = repo.createHousehold({ timezone: 'Asia/Yerevan', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'Тимур', age_static: 6 });
  assert.equal(u.name, 'Тимур');
  assert.equal(repo.listUsers().length, 1);

  const updated = repo.updateUser(u.id, { name: 'Тимур Б.' });
  assert.equal(updated.name, 'Тимур Б.');

  repo.removeUser(u.id);
  assert.equal(repo.listUsers().length, 0);
});

test('preference upsert is idempotent on (user, dimension, value)', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'A' });
  repo.upsertPreference({ user_id: u.id, dimension: 'genre', value: 'genre:adventure', weight: 0.5, origin: 'manual' });
  repo.upsertPreference({ user_id: u.id, dimension: 'genre', value: 'genre:adventure', weight: 0.9, origin: 'feedback' });
  const prefs = repo.getPreferences(u.id);
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0]!.weight, 0.9);
  assert.equal(prefs[0]!.origin, 'feedback');
});

test('constraint CRUD round-trip', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'A' });
  repo.upsertConstraint({ user_id: u.id, type: 'max_runtime', value: '90', origin: 'manual' });
  const constraints = repo.getConstraints(u.id);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0]!.value, '90');
});

test('suppression CRUD round-trip', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'A' });
  repo.addSuppression({ user_id: u.id, scope: 'theme', value: 'theme:fairies', reason: 'outgrown' });
  const sup = repo.getSuppressions(u.id);
  assert.equal(sup.length, 1);
  assert.equal(sup[0]!.value, 'theme:fairies');
});

test('title upsert round-trip and unique constraint on (source, source_id)', () => {
  const t1 = repo.upsertTitle({
    source: 'tmdb',
    source_id: '123',
    title: 'Kung Fu Panda',
    media_type: 'movie',
    genres: ['genre:action', 'genre:comedy'],
  });
  assert.deepEqual(t1.genres, ['genre:action', 'genre:comedy']);

  // Re-upsert with the same (source, source_id) updates in place, doesn't duplicate.
  const t2 = repo.upsertTitle({
    source: 'tmdb',
    source_id: '123',
    title: 'Kung Fu Panda (2008)',
    media_type: 'movie',
    genres: ['genre:action'],
  });
  assert.equal(t1.id, t2.id);
  assert.equal(t2.title, 'Kung Fu Panda (2008)');

  const found = repo.findTitle('tmdb', '123');
  assert.equal(found?.id, t1.id);

  const count = db.prepare(`SELECT COUNT(*) as c FROM title`).get() as { c: number };
  assert.equal(count.c, 1);
});

test('watch event freezes age at watch time, independent of later birth_date/age changes', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'Тимур', birth_date: '2020-01-01' });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '1', title: 'X', media_type: 'movie' });

  const event = repo.createWatchEvent({
    title_id: title.id,
    watched_at: '2026-01-01',
    viewers: [{ user_id: u.id, age_at_watch: 6 }],
  });
  assert.equal(event.viewers[0]!.age_at_watch, 6);

  repo.updateUser(u.id, { age_static: 7 });
  const history = repo.getWatchHistory(u.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.age_at_watch, 6);
});

test('feedback CRUD round-trip and applied_to_profile guard', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'A' });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '2', title: 'Y', media_type: 'movie' });
  const event = repo.createWatchEvent({ title_id: title.id, viewers: [{ user_id: u.id, age_at_watch: 5 }] });

  const fb = repo.addFeedback({ watch_event_id: event.id, user_id: u.id, rating: 'loved', tags: ['too_long'] });
  assert.equal(fb.applied_to_profile, 0);
  assert.deepEqual(fb.tags, ['too_long']);

  repo.markFeedbackApplied(fb.id);
  const history = repo.getWatchHistory(u.id);
  assert.equal(history[0]!.feedback?.applied_to_profile, 1);
});

test('watchlist CRUD round-trip', () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const u = repo.createUser({ household_id: h.id, name: 'A' });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '3', title: 'Z', media_type: 'movie' });
  repo.addWatchlist({ user_id: u.id, title_id: title.id, status: 'favorite', added_from: 'manual' });

  assert.equal(repo.getWatchlist(u.id, 'favorite').length, 1);
  assert.equal(repo.getWatchlist(u.id, 'wishlist').length, 0);
});

test('recommendation_log CRUD round-trip', () => {
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '4', title: 'W', media_type: 'movie' });
  const log = repo.logRecommendation({ title_id: title.id, match_score: 87, match_reasons: ['mentors'] });
  assert.equal(log.outcome, null);

  repo.setRecOutcome(log.id, 'picked');
  const row = db.prepare(`SELECT outcome FROM recommendation_log WHERE id = ?`).get(log.id) as { outcome: string };
  assert.equal(row.outcome, 'picked');
});

test('action_log push/pop acts as a stack for undo_last', () => {
  assert.equal(repo.popLastAction(), null);
  repo.pushAction({ action_type: 'feedback_added', entity_ref: 'feedback:1', previous_state: null });
  const second = repo.pushAction({
    action_type: 'watch_logged',
    entity_ref: 'watch_event:1',
    previous_state: { foo: 'bar' },
  });

  const popped = repo.popLastAction();
  assert.equal(popped?.id, second.id);
  assert.deepEqual(popped?.previous_state, { foo: 'bar' });

  const first = repo.popLastAction();
  assert.equal(first?.action_type, 'feedback_added');
  assert.equal(repo.popLastAction(), null);
});

test('trope dictionary seed: resolveTrope by canonical id, label, and alias; addTrope', () => {
  seedRecommenderDb(db);
  assert.equal(repo.resolveTrope('underdog becomes hero'), 'trope:underdog_hero');
  assert.equal(repo.resolveTrope('zero to hero'), 'trope:underdog_hero');
  assert.equal(repo.resolveTrope('not a real trope'), null);

  const id = repo.addTrope({ canonical_id: 'trope:custom_one', label_ru: 'тест', label_en: 'test', aliases: ['testy'] });
  assert.equal(id, 'trope:custom_one');
  assert.equal(repo.resolveTrope('testy'), 'trope:custom_one');
});

test('setTropes persists mapped canonical ids and stamps tropes_extracted_at', () => {
  const title = repo.upsertTitle({ source: 'tmdb', source_id: '5', title: 'V', media_type: 'movie' });
  assert.equal(title.tropes_extracted_at, null);

  repo.setTropes(title.id, ['trope:underdog_hero', 'trope:wise_mentor']);
  const row = db.prepare(`SELECT tropes, tropes_extracted_at FROM title WHERE id = ?`).get(title.id) as {
    tropes: string;
    tropes_extracted_at: number;
  };
  assert.deepEqual(JSON.parse(row.tropes), ['trope:underdog_hero', 'trope:wise_mentor']);
  assert.ok(row.tropes_extracted_at > 0);
});

test('resolveTaxonomy maps a source genre term to its canonical value', () => {
  seedRecommenderDb(db);
  assert.equal(repo.resolveTaxonomy('tmdb', 'Animation'), 'genre:animation');
  assert.equal(repo.resolveTaxonomy('jikan', 'Slice of Life'), 'theme:slice_of_life');
  assert.equal(repo.resolveTaxonomy('tmdb', 'NotARealGenre'), null);
});

test('seed populates ~30 tropes and a taxonomy_map for both tmdb and jikan', () => {
  seedRecommenderDb(db);
  const tropeCount = db.prepare(`SELECT COUNT(*) as c FROM trope_dictionary`).get() as { c: number };
  assert.ok(tropeCount.c >= 30);

  const tmdb = db
    .prepare(`SELECT canonical_value FROM taxonomy_map WHERE source = 'tmdb' AND source_term = 'Animation'`)
    .get() as { canonical_value: string };
  const jikan = db
    .prepare(`SELECT canonical_value FROM taxonomy_map WHERE source = 'jikan' AND source_term = 'Slice of Life'`)
    .get() as { canonical_value: string };
  assert.equal(tmdb.canonical_value, 'genre:animation');
  assert.equal(jikan.canonical_value, 'theme:slice_of_life');
});

test('recommender.db is a separate connection/schema from the session store', () => {
  process.env['DB_PATH'] = ':memory:';
  initDb();

  const sessionTableInRecommender = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`)
    .get();
  assert.equal(sessionTableInRecommender, undefined);

  const householdTableInRecommender = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='household'`)
    .get();
  assert.ok(householdTableInRecommender);
});
