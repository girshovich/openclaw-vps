import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPhoto } from './photo-marker.js';

test('extractPhoto strips [PHOTO:url] marker and returns photo URL', () => {
  const input = '[PHOTO:https://image.tmdb.org/t/p/w500/abc.jpg]\nHere are your recommendations.';
  const { text, photo } = extractPhoto(input);
  assert.equal(photo, 'https://image.tmdb.org/t/p/w500/abc.jpg');
  assert.ok(!text.includes('[PHOTO:'));
  assert.ok(text.includes('recommendations'));
});

test('extractPhoto returns undefined photo when no marker present (text path fallback)', () => {
  const input = 'Here are your recommendations.';
  const { text, photo } = extractPhoto(input);
  assert.equal(photo, undefined);
  assert.equal(text, input);
});

test('extractPhoto handles marker at start of multi-line text', () => {
  const input = '[PHOTO:https://example.com/poster.jpg]\nLine 1\nLine 2';
  const { text, photo } = extractPhoto(input);
  assert.equal(photo, 'https://example.com/poster.jpg');
  assert.equal(text, 'Line 1\nLine 2');
});

test('extractPhoto does not strip embedded [PHOTO:] not at start', () => {
  // marker only stripped when at the very start of the text
  const input = 'Some text [PHOTO:https://example.com/x.jpg] more text';
  // This should still be extracted since the regex uses /m multiline start anchor per line
  // but our actual impl uses ^ which in /m matches start of each line
  // Let's verify the actual behavior
  const { photo } = extractPhoto(input);
  // The regex is /^\[PHOTO:...\]\n?/ without /m flag, so ^ = start of string only
  assert.equal(photo, undefined);
});
