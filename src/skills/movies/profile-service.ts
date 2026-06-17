import { simpleChat, CLASSIFY_MODEL } from '../../llm/index.js';
import type { Repository } from './repository.js';
import type { ConstraintType, PreferenceDimension } from './types.js';

export interface ProfileServiceOptions {
  callLlm?: (prompt: string) => Promise<string>;
}

interface ExtractedPreference {
  dimension: PreferenceDimension;
  value: string;
  weight: number;
}
interface ExtractedConstraint {
  type: ConstraintType;
  value: string;
}
interface Extraction {
  preferences: ExtractedPreference[];
  constraints: ExtractedConstraint[];
}

const DIMENSIONS: PreferenceDimension[] = ['genre', 'theme', 'trope', 'tone', 'pace', 'runtime', 'source_type'];
const CONSTRAINT_TYPES: ConstraintType[] = [
  'trigger',
  'max_runtime',
  'min_age_rating',
  'max_age_rating',
  'no_subtitles',
  'exclude_source',
  'exclude_trope',
  'exclude_theme',
];

function buildPrompt(freeText: string, lovedTitles: string[]): string {
  const loved = lovedTitles.length > 0 ? `\nLoved titles: ${lovedTitles.join(', ')}` : '';
  return `Free-text preference statement: "${freeText}"${loved}

Extract taste preferences and hard constraints implied by this. Respond with ONLY JSON shaped:
{ "preferences": [{ "dimension": "genre"|"theme"|"trope"|"tone"|"pace"|"runtime"|"source_type", "value": string, "weight": number }],
  "constraints": [{ "type": "trigger"|"max_runtime"|"min_age_rating"|"max_age_rating"|"no_subtitles"|"exclude_source"|"exclude_trope"|"exclude_theme", "value": string }] }
Preference "value" MUST start with the dimension name and a colon: dimension "genre" → "genre:adventure" (never just "adventure"); dimension "trope" → "trope:underdog_hero"; dimension "theme" → "theme:friendship".
Constraint "value" examples by type: "trigger:parent_separation", "max_runtime:90", "min_age_rating:PG", "max_age_rating:PG-13", "exclude_theme:theme:horror", "exclude_trope:trope:jump_scare", "exclude_source:source_type:anime". For exclude_* types the value MUST include the dimension prefix (theme:, trope:, source_type:).
"weight" is a float from -1.0 to 1.0 (positive = likes, negative = dislikes/avoid). Output nothing but the JSON object.`;
}

function parseExtraction(raw: string): Extraction {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (!match) return { preferences: [], constraints: [] };
  try {
    const parsed = JSON.parse(match[0]) as Partial<Extraction>;
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences.filter(
          (p): p is ExtractedPreference =>
            typeof p === 'object' &&
            p !== null &&
            DIMENSIONS.includes((p as ExtractedPreference).dimension) &&
            typeof (p as ExtractedPreference).value === 'string' &&
            (p as ExtractedPreference).value.startsWith(`${(p as ExtractedPreference).dimension}:`) &&
            typeof (p as ExtractedPreference).weight === 'number',
        )
      : [];
    const constraints = Array.isArray(parsed.constraints)
      ? parsed.constraints.filter(
          (c): c is ExtractedConstraint =>
            typeof c === 'object' &&
            c !== null &&
            CONSTRAINT_TYPES.includes((c as ExtractedConstraint).type) &&
            typeof (c as ExtractedConstraint).value === 'string',
        )
      : [];
    return { preferences, constraints };
  } catch {
    return { preferences: [], constraints: [] };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export interface ProfileService {
  setPreferences(userId: string, freeText: string, lovedTitles?: string[]): Promise<Extraction>;
  summary(userId: string): string;
}

export function createProfileService(repo: Repository, opts: ProfileServiceOptions = {}): ProfileService {
  const callLlm = opts.callLlm ?? (async (prompt: string) => (await simpleChat(prompt, CLASSIFY_MODEL)).text);

  return {
    async setPreferences(userId, freeText, lovedTitles = []) {
      const raw = await callLlm(buildPrompt(freeText, lovedTitles));
      const { preferences, constraints } = parseExtraction(raw);

      for (const p of preferences) {
        repo.upsertPreference({
          user_id: userId,
          dimension: p.dimension,
          value: p.value,
          weight: clamp(p.weight, -1, 1),
          origin: 'manual',
        });
      }
      for (const c of constraints) {
        repo.upsertConstraint({ user_id: userId, type: c.type, value: c.value, origin: 'manual' });
      }

      return { preferences, constraints };
    },

    summary(userId) {
      const liked = repo
        .getPreferences(userId)
        .filter((p) => p.weight > 0)
        .sort((a, b) => b.weight - a.weight);
      const avoided = repo.getConstraints(userId).filter((c) => c.active === 1);

      const parts: string[] = [];
      if (liked.length > 0) parts.push(`Любит: ${liked.slice(0, 5).map((p) => p.value).join(', ')}`);
      if (avoided.length > 0) parts.push(`Избегает: ${avoided.map((c) => c.value).join(', ')}`);
      return parts.length > 0 ? parts.join('. ') : 'Профиль пока пуст.';
    },
  };
}
