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

test('core tools stay present regardless of skill activation', () => {
  const echo = makeStubSkill('echo', 'echo this');
  registerSkill(echo);
  activateSkills('session-e', 'echo this please');

  const core = getToolDefinitions(0);
  assert.ok(core.some((t) => t.name === 'bash'));
  assert.ok(core.some((t) => t.name === 'task_create'));
});
