import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Skill } from './types.js';
import { registerSkill, getAllSkills, _resetRegistryForTests } from './registry.js';
import { activateSkills, _resetActivatorForTests } from './activator.js';
import { getToolDefinitions } from '../runtime/tools.js';

function makeStubSkill(name: string, trigger: string): Skill {
  return {
    name,
    description: `Stub skill for ${name}`,
    examples: [trigger],
    tools: [
      {
        name: `${name}_tool`,
        description: `Echoes back text for ${name}`,
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Text to echo back' } },
          required: ['text'],
        },
      },
    ],
    async executeTool(call) {
      return String(call.input['text'] ?? '');
    },
    migrate() {
      // stub: no persistence
    },
  };
}

beforeEach(() => {
  _resetRegistryForTests();
  _resetActivatorForTests();
});

test('skill tool appears only for a matching session message', () => {
  const echo = makeStubSkill('echo', 'echo this');
  registerSkill(echo);

  const matching = activateSkills('session-a', 'please echo this back to me');
  assert.deepEqual(matching.map((s) => s.name), ['echo']);

  const nonMatching = activateSkills('session-b', 'what is the weather today');
  assert.deepEqual(nonMatching, []);
});

test('activation is sticky + additive: a second domain does not evict the first', () => {
  const echo = makeStubSkill('echo', 'echo this');
  const movies = makeStubSkill('movies', 'what to watch');
  registerSkill(echo);
  registerSkill(movies);

  const afterFirst = activateSkills('session-c', 'echo this please');
  assert.deepEqual(afterFirst.map((s) => s.name), ['echo']);

  const afterSecond = activateSkills('session-c', 'what to watch tonight');
  assert.deepEqual(afterSecond.map((s) => s.name).sort(), ['echo', 'movies']);
});

test('registered skills are absent from a session that never mentioned them', () => {
  const echo = makeStubSkill('echo', 'echo this');
  registerSkill(echo);

  const active = activateSkills('session-d', 'totally unrelated message');
  assert.equal(active.length, 0);
  assert.equal(getAllSkills().length, 1); // registered, just not activated for this session
});

// ── M1: whole-word matching prevents false activations ───────────────────────

test('M1: activator does not trigger on a word that merely contains the example as a substring', () => {
  const movies = makeStubSkill('movies', 'смотр');
  registerSkill(movies);
  // "осмотр" contains "смотр" as substring — should NOT activate with whole-word matching
  const result = activateSkills('session-m1', 'у меня осмотр у врача');
  assert.equal(result.length, 0, '"осмотр" must not activate a skill whose example is "смотр"');
});

test('M1: exact whole-word example still activates', () => {
  const movies = makeStubSkill('movies', 'фильм');
  registerSkill(movies);
  const result = activateSkills('session-m1b', 'что посмотреть, фильм');
  assert.equal(result.length, 1, '"фильм" as standalone word must activate');
});

test('stem example activates on inflected Russian forms', () => {
  const movies = makeStubSkill('movies', 'фильм');
  registerSkill(movies);
  // Prepositional/genitive plural — different tokens than the bare "фильм".
  assert.equal(activateSkills('session-infl-a', 'В фильмах есть профиль Артема?').length, 1, '"фильмах" must activate the "фильм" stem');
  assert.equal(activateSkills('session-infl-b', 'Ну в таком скилле выбора фильмов').length, 1, '"фильмов" must activate the "фильм" stem');
});

test('stem example "избран" activates on "избранное"', () => {
  const movies = makeStubSkill('movies', 'избран');
  registerSkill(movies);
  assert.equal(activateSkills('session-fav', 'покажи избранное').length, 1, '"избранное" must activate the "избран" stem');
});

test('core tools stay present regardless of skill activation', () => {
  const echo = makeStubSkill('echo', 'echo this');
  registerSkill(echo);
  activateSkills('session-e', 'echo this please');

  const core = getToolDefinitions(0);
  assert.ok(core.some((t) => t.name === 'bash'));
  assert.ok(core.some((t) => t.name === 'task_create'));
});
