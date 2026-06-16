import type { Preference } from './types.js';

// Spec §6.5: weight older signals less the further age_at_signal is from the
// current age. 0.85/year keeps a 1-year gap near full strength and fades out
// signals from several years ago without ever hitting exactly zero.
const DECAY_RATE_PER_YEAR = 0.85;

export function effectiveWeight(pref: Preference, currentAge: number): number {
  if (pref.age_at_signal == null) return pref.weight;
  const years = Math.abs(currentAge - pref.age_at_signal);
  return pref.weight * Math.pow(DECAY_RATE_PER_YEAR, years);
}
