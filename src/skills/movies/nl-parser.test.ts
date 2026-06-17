import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRatingReply, parseFavoriteReply, parseFollowUpTags } from './nl-parser.js';

// ── parseRatingReply ──────────────────────────────────────────────────────────

test('parseRatingReply "1 зашло" → loved, index 0', () => {
  const r = parseRatingReply('1 зашло');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 0);
  assert.equal(r.rating, 'loved');
  assert.equal(r.abandoned, false);
});

test('parseRatingReply "2 так себе" → ok, index 1', () => {
  const r = parseRatingReply('2 так себе');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 1);
  assert.equal(r.rating, 'ok');
});

test('parseRatingReply "3 не зашло" → disliked, index 2', () => {
  const r = parseRatingReply('3 не зашло');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 2);
  assert.equal(r.rating, 'disliked');
  assert.equal(r.abandoned, false);
});

test('parseRatingReply "бросили 2" → disliked + abandoned, index 1', () => {
  const r = parseRatingReply('бросили 2');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 1);
  assert.equal(r.rating, 'disliked');
  assert.equal(r.abandoned, true);
});

test('parseRatingReply "2 так себе, длинно" → ok + too_long tag', () => {
  const r = parseRatingReply('2 так себе, длинно');
  assert.ok(r !== null);
  assert.equal(r.rating, 'ok');
  assert.ok(r.tags.includes('too_long'));
});

test('parseRatingReply "бросили 1, страшно" → too_scary tag', () => {
  const r = parseRatingReply('бросили 1, страшно');
  assert.ok(r !== null);
  assert.ok(r.tags.includes('too_scary'));
});

test('parseRatingReply returns null for unrelated text', () => {
  assert.equal(parseRatingReply('привет как дела'), null);
  assert.equal(parseRatingReply('покажи историю'), null);
});

// ── parseFavoriteReply ────────────────────────────────────────────────────────

test('parseFavoriteReply "в избранное 1" → index 0', () => {
  const r = parseFavoriteReply('в избранное 1');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 0);
});

test('parseFavoriteReply "в избранное 3" → index 2', () => {
  const r = parseFavoriteReply('в избранное 3');
  assert.ok(r !== null);
  assert.equal(r.candidateIndex, 2);
});

test('parseFavoriteReply returns null for non-favorite text', () => {
  assert.equal(parseFavoriteReply('1 зашло'), null);
  assert.equal(parseFavoriteReply('привет'), null);
});

// ── parseFollowUpTags ─────────────────────────────────────────────────────────

test('parseFollowUpTags "страшно" → [too_scary]', () => {
  assert.deepEqual(parseFollowUpTags('страшно'), ['too_scary']);
});

test('parseFollowUpTags "скучно и длинно" → [too_long, boring]', () => {
  const tags = parseFollowUpTags('скучно и длинно');
  assert.ok(tags.includes('boring'));
  assert.ok(tags.includes('too_long'));
});

test('parseFollowUpTags with no keywords → []', () => {
  assert.deepEqual(parseFollowUpTags('всё хорошо'), []);
});
