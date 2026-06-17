import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createRecommendationService } from './recommendation-service.js';
import type { RecommendationService } from './recommendation-service.js';
import type { User, Title } from './types.js';

let db: RecommenderDb;
let repo: Repository;
let svc: RecommendationService;
let user: User;

function makeUser(name: string, ageStatic: number): User {
  const h = repo.getHousehold() ?? repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  return repo.createUser({ household_id: h.id, name, age_static: ageStatic });
}

function makeTitle(source_id: string, overrides: Partial<Parameters<Repository['upsertTitle']>[0]> = {}): Title {
  return repo.upsertTitle({
    source: 'tmdb',
    source_id,
    title: `Title ${source_id}`,
    media_type: 'movie',
    ...overrides,
  });
}

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
  svc = createRecommendationService(repo);
  user = makeUser('Тимур', 7);
});

// ── Filter: age_rating ceiling ────────────────────────────────────────────────

test('age-rated title is excluded when viewer is younger than the required minimum age', async () => {
  makeTitle('too-old', { age_rating: '12+' });   // requires 12+
  makeTitle('ok', { age_rating: '6+' });          // requires 6+, viewer is 7

  const results = await svc.recommend([user.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('too-old'), 'title rated 12+ must not appear for a 7-year-old');
  assert.ok(ids.includes('ok'), 'title rated 6+ must appear for a 7-year-old');
});

test('title with no age_rating is always allowed (unknown = no restriction)', async () => {
  makeTitle('unrated');
  const results = await svc.recommend([user.id]);
  assert.ok(results.some((r) => r.title.source_id === 'unrated'));
});

// ── Filter: joint watch youngest ceiling ─────────────────────────────────────

test('joint watch uses youngest viewer age as the ceiling', async () => {
  const older = makeUser('Михаил', 40);
  // Title requires 12+, but younger viewer (Тимур, 7) blocks it
  makeTitle('family-title', { age_rating: '12+', genres: ['genre:action'] });
  makeTitle('child-title', { age_rating: '6+', genres: ['genre:comedy'] });

  const results = await svc.recommend([user.id, older.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('family-title'), '12+ title must be excluded: youngest viewer is 7');
  assert.ok(ids.includes('child-title'), '6+ title must be included for a 7-year-old');
});

// ── Filter: constraint violations ────────────────────────────────────────────

test('max_runtime constraint filters out titles exceeding that runtime', async () => {
  makeTitle('long', { runtime: 150 });
  makeTitle('short', { runtime: 60 });
  repo.upsertConstraint({ user_id: user.id, type: 'max_runtime', value: 'max_runtime:90', origin: 'manual' });

  const results = await svc.recommend([user.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('long'));
  assert.ok(ids.includes('short'));
});

test('exclude_trope constraint filters out titles containing that trope', async () => {
  makeTitle('with-trope', { tropes: ['trope:parent_separation'] });
  makeTitle('without-trope', { tropes: ['trope:underdog_hero'] });
  repo.upsertConstraint({ user_id: user.id, type: 'exclude_trope', value: 'trope:parent_separation', origin: 'manual' });

  const results = await svc.recommend([user.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('with-trope'));
  assert.ok(ids.includes('without-trope'));
});

test('trigger constraint filters out titles whose theme matches the trigger topic', async () => {
  makeTitle('triggering', { themes: ['theme:parent_separation'] });
  makeTitle('safe', { themes: ['theme:friendship'] });
  repo.upsertConstraint({ user_id: user.id, type: 'trigger', value: 'trigger:parent_separation', origin: 'feedback' });

  const results = await svc.recommend([user.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('triggering'), 'title with theme:parent_separation must be filtered by trigger:parent_separation');
  assert.ok(ids.includes('safe'));
});

// ── Filter: suppression ───────────────────────────────────────────────────────

test('trope suppression removes titles containing the suppressed trope', async () => {
  const suppressed = makeTitle('sup', { tropes: ['trope:fairies'] });
  makeTitle('ok2');
  repo.addSuppression({ user_id: user.id, scope: 'trope', value: 'trope:fairies', reason: 'outgrown' });

  const results = await svc.recommend([user.id]);
  assert.ok(!results.some((r) => r.title.id === suppressed.id));
});

test('genre suppression removes titles in the suppressed genre', async () => {
  makeTitle('horror', { genres: ['genre:horror'] });
  makeTitle('comedy', { genres: ['genre:comedy'] });
  repo.addSuppression({ user_id: user.id, scope: 'genre', value: 'genre:horror', reason: 'outgrown' });

  const results = await svc.recommend([user.id]);
  const ids = results.map((r) => r.title.source_id);
  assert.ok(!ids.includes('horror'));
  assert.ok(ids.includes('comedy'));
});

// ── Filter: exclude seen ──────────────────────────────────────────────────────

test('already-watched titles are excluded when excludeSeen=true (default)', async () => {
  const watched = makeTitle('watched', { genres: ['genre:action'] });
  makeTitle('unwatched', { genres: ['genre:comedy'] });

  const event = repo.createWatchEvent({ title_id: watched.id, viewers: [{ user_id: user.id, age_at_watch: 7 }] });
  void event;

  const results = await svc.recommend([user.id]);
  assert.ok(!results.some((r) => r.title.id === watched.id));
});

test('already-watched titles appear when excludeSeen=false', async () => {
  const watched = makeTitle('watched2');
  repo.createWatchEvent({ title_id: watched.id, viewers: [{ user_id: user.id, age_at_watch: 7 }] });

  const results = await svc.recommend([user.id], { excludeSeen: false });
  assert.ok(results.some((r) => r.title.id === watched.id));
});

// ── Scoring & ranking order ───────────────────────────────────────────────────

test('titles with higher-weighted matching features rank above titles with lower-weighted features', async () => {
  makeTitle('loved', { tropes: ['trope:underdog_hero'], genres: ['genre:action'] });
  makeTitle('neutral', { genres: ['genre:romance'] });

  repo.upsertPreference({ user_id: user.id, dimension: 'trope', value: 'trope:underdog_hero', weight: 0.9, origin: 'feedback' });
  repo.upsertPreference({ user_id: user.id, dimension: 'genre', value: 'genre:action', weight: 0.7, origin: 'feedback' });

  const results = await svc.recommend([user.id]);
  assert.ok(results.length >= 2);
  assert.equal(results[0]!.title.source_id, 'loved', 'loved title must rank first');
});

test('match_reasons contains the top contributing positive feature values', async () => {
  makeTitle('with-features', { tropes: ['trope:underdog_hero'], genres: ['genre:comedy'] });
  repo.upsertPreference({ user_id: user.id, dimension: 'trope', value: 'trope:underdog_hero', weight: 0.8, origin: 'feedback' });
  repo.upsertPreference({ user_id: user.id, dimension: 'genre', value: 'genre:comedy', weight: 0.5, origin: 'feedback' });

  const results = await svc.recommend([user.id]);
  const top = results.find((r) => r.title.source_id === 'with-features');
  assert.ok(top, 'title must appear in results');
  assert.ok(top!.match_reasons.includes('trope:underdog_hero'), 'top trope must be in match_reasons');
});

// ── Joint watch: profile intersection ────────────────────────────────────────

test('joint watch: feature only contributes positively if BOTH viewers like it', async () => {
  const child = user; // likes action
  const parent = makeUser('Михаил', 35); // does not like action (weight 0)

  const titleA = makeTitle('action-title', { tropes: ['trope:underdog_hero'] });
  const titleB = makeTitle('both-like', { genres: ['genre:comedy'] });

  // child likes underdog trope; parent doesn't have any preference for it (neutral = 0)
  repo.upsertPreference({ user_id: child.id, dimension: 'trope', value: 'trope:underdog_hero', weight: 0.9, origin: 'feedback' });
  // both like comedy
  repo.upsertPreference({ user_id: child.id, dimension: 'genre', value: 'genre:comedy', weight: 0.6, origin: 'feedback' });
  repo.upsertPreference({ user_id: parent.id, dimension: 'genre', value: 'genre:comedy', weight: 0.7, origin: 'feedback' });

  const results = await svc.recommend([child.id, parent.id]);
  const comedy = results.find((r) => r.title.id === titleB.id);
  const action = results.find((r) => r.title.id === titleA.id);

  assert.ok(comedy, 'title both viewers like must appear');
  assert.ok(!comedy || comedy.match_score >= (action?.match_score ?? 0),
    'title both like should score at least as high as title only one likes');
});

// ── Recommendation log ────────────────────────────────────────────────────────

test('recommend logs every shown candidate to recommendation_log', async () => {
  makeTitle('logged1', { genres: ['genre:adventure'] });
  makeTitle('logged2', { genres: ['genre:comedy'] });

  await svc.recommend([user.id], { limit: 2 });

  const rows = db
    .prepare(`SELECT COUNT(*) as c FROM recommendation_log WHERE user_id = ?`)
    .get(user.id) as { c: number };
  assert.equal(rows.c, 2);
});
