import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveWeight } from './decay.js';
import type { Preference } from './types.js';

function pref(weight: number, age_at_signal: number | null): Preference {
  return {
    id: '1',
    user_id: 'u1',
    dimension: 'trope',
    value: 'trope:underdog_hero',
    weight,
    origin: 'feedback',
    updated_at: Date.now(),
    age_at_signal,
  };
}

test('effectiveWeight returns the raw weight unchanged when age_at_signal is null', () => {
  assert.equal(effectiveWeight(pref(0.8, null), 10), 0.8);
});

test('effectiveWeight returns the raw weight when current age matches the signal age', () => {
  assert.equal(effectiveWeight(pref(0.8, 6), 6), 0.8);
});

test('effectiveWeight decays signals further from the current age, but never flips sign', () => {
  const near = effectiveWeight(pref(0.8, 6), 7);
  const far = effectiveWeight(pref(0.8, 6), 12);
  assert.ok(far < near);
  assert.ok(near < 0.8);
  assert.ok(far > 0);
});
