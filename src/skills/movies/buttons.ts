// Phase 9: button layout and callback data codec for movies recommendation cards.
// Shared between the movies skill (builds layouts) and the Telegram connector (routes callbacks).

import type { InlineKeyboardButton } from '../../types.js';

export const MOVIES_CALLBACK_PREFIX = 'mv';

// Callback data format: "mv:{action}:{1-based candidate index}"
// Kept under 64 bytes (Telegram limit): longest is "mv:abandoned:99" = 15 chars.
const ACTIONS = {
  loved:    (i: number) => `${i} зашло`,
  ok:       (i: number) => `${i} так себе`,
  disliked: (i: number) => `${i} не зашло`,
  abandoned:(i: number) => `бросили ${i}`,
  fav:      (i: number) => `в избранное ${i}`,
} as const;

// One button row per candidate card: 👍 😐 👎 ✋ ➕
export function buildRecommendationButtons(count: number): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 1; i <= Math.max(0, count); i++) {
    rows.push([
      { text: `${i} 👍`, callback_data: `mv:loved:${i}` },
      { text: `${i} 😐`, callback_data: `mv:ok:${i}` },
      { text: `${i} 👎`, callback_data: `mv:disliked:${i}` },
      { text: `${i} ✋`, callback_data: `mv:abandoned:${i}` },
      { text: `${i} ➕`, callback_data: `mv:fav:${i}` },
    ]);
  }
  return rows;
}

export interface CallbackParsed {
  skill: string;
  action: string;
  index: number; // 1-based
}

export function parseCallbackData(data: string): CallbackParsed | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [skill, action, indexStr] = parts as [string, string, string];
  const index = parseInt(indexStr, 10);
  if (!skill || !action || isNaN(index) || index < 1) return null;
  return { skill, action, index };
}

// Maps a callback payload to the NL shorthand the agent already understands.
// Returns null for unrecognised payloads (ignore them).
export function callbackDataToNL(data: string): string | null {
  const parsed = parseCallbackData(data);
  if (!parsed || parsed.skill !== MOVIES_CALLBACK_PREFIX) return null;
  const fn = ACTIONS[parsed.action as keyof typeof ACTIONS];
  return fn ? fn(parsed.index) : null;
}

// Count 🎬 N. cards in a response text (0 = no recommendation list).
export function detectCardCount(text: string): number {
  const m = text.match(/🎬 \d+\./g);
  return m ? m.length : 0;
}
