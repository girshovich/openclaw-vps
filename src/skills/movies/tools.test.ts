import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createMoviesSkill } from './index.js';
import type { Skill } from '../types.js';
import { registerSkill, _resetRegistryForTests } from '../registry.js';
import { activateSkills, _resetActivatorForTests } from '../activator.js';
import type { Title } from './types.js';
import type { CatalogService, ResolveResult } from './catalog.js';
import type { ToolCall } from '../../llm/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

let db: RecommenderDb;
let repo: Repository;
let skill: Skill;

// Minimal mock CatalogService that resolves to a fixed in-memory title
function mockCatalog(repo: Repository): CatalogService {
  return {
    async resolveTitle(query): Promise<ResolveResult> {
      const cached = repo.searchCachedTitles(query);
      if (cached.length > 0) return { match: cached[0]!, alternatives: cached.slice(1) };
      const match = repo.upsertTitle({
        source: 'tmdb',
        source_id: 'mock-1',
        title: query,
        media_type: 'movie',
        genres: ['genre:adventure'],
      });
      return { match, alternatives: [] };
    },
  };
}

function makeCall(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, input };
}

const ctx = { sessionId: 'test', signal: undefined };

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
  skill = createMoviesSkill({ db, catalogService: mockCatalog(repo) });
  _resetRegistryForTests();
  _resetActivatorForTests();
});

// ── manage_viewers: list / add / edit / remove ────────────────────────────────

test('manage_viewers list returns empty users array before setup', async () => {
  const res = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'list' }), ctx)) as { users: unknown[] };
  assert.deepEqual(res.users, []);
});

test('manage_viewers add creates a user and returns user_id', async () => {
  const h = repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const res = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'add', name: 'Тимур', age: 6 }), ctx)) as { user_id: string };
  assert.ok(typeof res.user_id === 'string');
  assert.equal(repo.listUsers().find((u) => u.household_id === h.id)?.name, 'Тимур');
});

test('manage_viewers edit updates an existing user', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const addRes = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'add', name: 'Тимур', age: 6 }), ctx)) as { user_id: string };
  const editRes = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'edit', user_id: addRes.user_id, name: 'Тимур Б.' }), ctx)) as { user: { name: string } };
  assert.equal(editRes.user.name, 'Тимур Б.');
});

test('manage_viewers remove requires confirm: true', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const addRes = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'add', name: 'Тимур', age: 6 }), ctx)) as { user_id: string };
  const noConfirm = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'remove', user_id: addRes.user_id }), ctx)) as { error?: string };
  assert.ok(noConfirm.error);

  const ok = JSON.parse(await skill.executeTool(makeCall('manage_viewers', { action: 'remove', user_id: addRes.user_id, confirm: true }), ctx)) as { removed: boolean };
  assert.equal(ok.removed, true);
  assert.equal(repo.listUsers().length, 0);
});

// ── log_watch ────────────────────────────────────────────────────────────────

test('log_watch returns watch_event_id and resolved_title', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  const res = JSON.parse(await skill.executeTool(makeCall('log_watch', { title_query: 'Kung Fu Panda', viewer_ids: [user.id] }), ctx)) as { watch_event_id: string; resolved_title: string };
  assert.ok(typeof res.watch_event_id === 'string');
  assert.equal(res.resolved_title, 'Kung Fu Panda');
});

test('log_watch pushes a watch_logged action that undo_last can revert', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  const logRes = JSON.parse(await skill.executeTool(makeCall('log_watch', { title_query: 'Kung Fu Panda', viewer_ids: [user.id] }), ctx)) as { watch_event_id: string };
  const watchId = logRes.watch_event_id;

  // Verify watch event exists
  assert.equal((db.prepare(`SELECT COUNT(*) as c FROM watch_event WHERE id = ?`).get(watchId) as { c: number }).c, 1);

  const undoRes = JSON.parse(await skill.executeTool(makeCall('undo_last', {}), ctx)) as { reverted_action: string };
  assert.ok(undoRes.reverted_action.includes(watchId));

  // Watch event should be deleted
  assert.equal((db.prepare(`SELECT COUNT(*) as c FROM watch_event WHERE id = ?`).get(watchId) as { c: number }).c, 0);
});

// ── add_feedback ─────────────────────────────────────────────────────────────

test('add_feedback returns feedback_id and profile_updated: true', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: 'kfp', title: 'Kung Fu Panda', media_type: 'movie', genres: ['genre:action'] });
  const event = repo.createWatchEvent({ title_id: title.id, viewers: [{ user_id: user.id, age_at_watch: 7 }] });
  void event;

  const res = JSON.parse(await skill.executeTool(makeCall('add_feedback', { title_query: 'Kung Fu Panda', viewer_id: user.id, rating: 'loved' }), ctx)) as { feedback_id: string; profile_updated: boolean };
  assert.ok(typeof res.feedback_id === 'string');
  assert.equal(res.profile_updated, true);

  // Learning applied: genre:action weight should now be positive
  const prefs = repo.getPreferences(user.id);
  assert.ok(prefs.some((p) => p.value === 'genre:action' && p.weight > 0));
});

test('add_feedback with watch_event_id (UUID) instead of title name works', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: 'kfp2', title: 'KFP 2', media_type: 'movie' });
  const event = repo.createWatchEvent({ title_id: title.id, viewers: [{ user_id: user.id, age_at_watch: 7 }] });

  const res = JSON.parse(await skill.executeTool(makeCall('add_feedback', { title_query: event.id, viewer_id: user.id, rating: 'ok' }), ctx)) as { feedback_id: string };
  assert.ok(typeof res.feedback_id === 'string');
});

// ── manage_taste ─────────────────────────────────────────────────────────────

test('manage_taste set_preferences calls ProfileService and returns profile_summary', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  const mockLlm = async () => JSON.stringify({ preferences: [{ dimension: 'trope', value: 'trope:robot_best_friend', weight: 0.9 }], constraints: [] });
  const testSkill = createMoviesSkill({ db, catalogService: mockCatalog(repo), callLlm: mockLlm });

  const res = JSON.parse(await testSkill.executeTool(makeCall('manage_taste', { action: 'set_preferences', user_id: user.id, free_text: 'любит роботов' }), ctx)) as { profile_summary: string; extracted: { preferences: unknown[] } };
  assert.ok(typeof res.profile_summary === 'string');
  assert.ok(res.extracted.preferences.length > 0);
});

test('manage_taste suppress adds a suppression entry', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  await skill.executeTool(makeCall('manage_taste', { action: 'suppress', user_id: user.id, scope: 'theme', value: 'theme:fairies', reason: 'outgrown' }), ctx);
  assert.equal(repo.getSuppressions(user.id).length, 1);
});

// ── show ──────────────────────────────────────────────────────────────────────

test('show profile returns a profile_one_liner', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  const res = JSON.parse(await skill.executeTool(makeCall('show', { view: 'profile', user_id: user.id }), ctx)) as { profile_one_liner: string };
  assert.ok(typeof res.profile_one_liner === 'string');
});

test('show history returns events array', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });
  const title = repo.upsertTitle({ source: 'tmdb', source_id: 'x1', title: 'X', media_type: 'movie' });
  repo.createWatchEvent({ title_id: title.id, viewers: [{ user_id: user.id, age_at_watch: 7 }] });

  const res = JSON.parse(await skill.executeTool(makeCall('show', { view: 'history', user_id: user.id }), ctx)) as { events: unknown[] };
  assert.equal(res.events.length, 1);
});

// ── recommend ─────────────────────────────────────────────────────────────────

test('recommend returns candidates array (may be empty with no cached titles)', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const user = repo.createUser({ household_id: repo.getHousehold()!.id, name: 'Тимур', age_static: 7 });

  const res = JSON.parse(await skill.executeTool(makeCall('recommend', { viewer_ids: [user.id] }), ctx)) as { candidates: unknown[] };
  assert.ok(Array.isArray(res.candidates));
});

// ── setup ─────────────────────────────────────────────────────────────────────

test('setup parses members and creates household + users', async () => {
  const mockLlm = async () =>
    JSON.stringify({ members: [{ name: 'Михаил', birth_date: null, age: 38, self: true }, { name: 'Тимур', birth_date: null, age: 6, self: false }] });
  const testSkill = createMoviesSkill({ db, catalogService: mockCatalog(repo), callLlm: mockLlm });

  const res = JSON.parse(await testSkill.executeTool(makeCall('setup', { members_free_text: 'я Михаил 38 и сын Тимур 6' }), ctx)) as { household: { id: string }; created_users: unknown[] };
  assert.ok(res.household.id);
  assert.equal(res.created_users.length, 2);
  assert.ok(repo.getHousehold()?.onboarded === 1);
});

test('setup stores birth_date when LLM returns it instead of age', async () => {
  const mockLlm = async () =>
    JSON.stringify({ members: [{ name: 'Михаил', birth_date: '1986-01-01', age: null, self: true }] });
  const testSkill = createMoviesSkill({ db, catalogService: mockCatalog(repo), callLlm: mockLlm });

  await testSkill.executeTool(makeCall('setup', { members_free_text: 'я Михаил 01.01.1986' }), ctx);
  const user = repo.listUsers()[0]!;
  assert.equal(user.birth_date, '1986-01-01');
  assert.equal(user.age_static, null);
});

test('setup returns error if household already exists', async () => {
  repo.createHousehold({ timezone: 'UTC', language: 'ru' });
  const res = JSON.parse(await skill.executeTool(makeCall('setup', { members_free_text: 'я Михаил' }), ctx)) as { error: string };
  assert.ok(res.error.includes('already'));
});

// ── undo_last ─────────────────────────────────────────────────────────────────

test('undo_last returns nothing to undo when action_log is empty', async () => {
  const res = JSON.parse(await skill.executeTool(makeCall('undo_last', {}), ctx)) as { reverted_action: string };
  assert.equal(res.reverted_action, 'nothing to undo');
});

// ── Skill activation: movie tools in movie sessions, absent otherwise ─────────

test('movies skill tools are available in movie sessions after registration', () => {
  registerSkill(skill);
  const active = activateSkills('s1', 'что посмотреть с сыном вечером');
  assert.ok(active.some((s) => s.name === 'movies'), 'movies skill must activate for movie message');
  const toolNames = active.flatMap((s) => s.tools.map((t) => t.name));
  assert.ok(toolNames.includes('recommend'));
  assert.ok(toolNames.includes('log_watch'));
});

test('movies skill tools are absent from non-movie sessions', () => {
  registerSkill(skill);
  const active = activateSkills('s2', 'set a timer for 10 minutes');
  assert.ok(!active.some((s) => s.name === 'movies'));
});
