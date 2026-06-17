import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecommendationButtons,
  callbackDataToNL,
  detectCardCount,
  parseCallbackData,
  MOVIES_CALLBACK_PREFIX,
} from './buttons.js';
// ── buildRecommendationButtons ────────────────────────────────────────────────

test('buildRecommendationButtons(3) produces 3 rows, each with 5 buttons', () => {
  const rows = buildRecommendationButtons(3);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.length, 5);
    assert.ok(row.every((b) => b.callback_data.startsWith(MOVIES_CALLBACK_PREFIX)));
  }
});

test('buildRecommendationButtons uses 1-based index in callback_data', () => {
  const rows = buildRecommendationButtons(2);
  assert.ok(rows[0]!.some((b) => b.callback_data === 'mv:loved:1'));
  assert.ok(rows[1]!.some((b) => b.callback_data === 'mv:loved:2'));
});

test('buildRecommendationButtons(0) returns empty array', () => {
  assert.deepEqual(buildRecommendationButtons(0), []);
});

// ── parseCallbackData ─────────────────────────────────────────────────────────

test('parseCallbackData parses valid callback data', () => {
  const r = parseCallbackData('mv:loved:1');
  assert.deepEqual(r, { skill: 'mv', action: 'loved', index: 1 });
});

test('parseCallbackData returns null for malformed data', () => {
  assert.equal(parseCallbackData(''), null);
  assert.equal(parseCallbackData('mv:loved'), null);
  assert.equal(parseCallbackData('mv:loved:abc'), null);
  assert.equal(parseCallbackData('mv:loved:0'), null); // index must be ≥1
});

// ── callbackDataToNL ──────────────────────────────────────────────────────────

test('mv:loved:1 → "1 зашло"', () => {
  assert.equal(callbackDataToNL('mv:loved:1'), '1 зашло');
});

test('mv:ok:2 → "2 так себе"', () => {
  assert.equal(callbackDataToNL('mv:ok:2'), '2 так себе');
});

test('mv:disliked:3 → "3 не зашло"', () => {
  assert.equal(callbackDataToNL('mv:disliked:3'), '3 не зашло');
});

test('mv:abandoned:1 → "бросили 1"', () => {
  assert.equal(callbackDataToNL('mv:abandoned:1'), 'бросили 1');
});

test('mv:fav:2 → "в избранное 2"', () => {
  assert.equal(callbackDataToNL('mv:fav:2'), 'в избранное 2');
});

test('callbackDataToNL returns null for unknown action', () => {
  assert.equal(callbackDataToNL('mv:unknown:1'), null);
});

test('callbackDataToNL returns null for non-movies prefix', () => {
  assert.equal(callbackDataToNL('travel:loved:1'), null);
});

// ── detectCardCount ───────────────────────────────────────────────────────────

test('detectCardCount returns correct count for recommendation response', () => {
  const text = '🎬 1. Кунг-фу Панда (2008)\nПочему: 87%\n\n🎬 2. Зверополис (2016)\nПочему: 72%';
  assert.equal(detectCardCount(text), 2);
});

test('detectCardCount returns 0 for text without cards (text path fallback)', () => {
  assert.equal(detectCardCount('Привет! Как дела?'), 0);
  assert.equal(detectCardCount('Ваш профиль: Любит анимацию.'), 0);
  assert.equal(detectCardCount(''), 0);
});

test('detectCardCount handles single card correctly', () => {
  assert.equal(detectCardCount('🎬 1. Рапунцель · 6+ · 92 мин'), 1);
});
