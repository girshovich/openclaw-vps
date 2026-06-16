import { simpleChat, CLASSIFY_MODEL } from '../../llm/index.js';
import type { Repository } from './repository.js';
import type { Title } from './types.js';

export interface TropeServiceOptions {
  callLlm?: (prompt: string) => Promise<string>;
}

interface ExtractedTrope {
  phrase: string;
  confidence: 'high' | 'low';
}

function slugify(phrase: string): string {
  const slug = phrase
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_');
  return `trope:${slug}`;
}

function buildPrompt(title: Title, reviewSnippets: string[]): string {
  const reviews = reviewSnippets.length > 0 ? `\nReview snippets:\n${reviewSnippets.join('\n')}` : '';
  return `Title: ${title.title}
Synopsis: ${title.synopsis ?? '(none)'}${reviews}

List the narrative tropes present in this title. Respond with ONLY a JSON array of objects shaped
{ "phrase": string, "confidence": "high" | "low" }. "phrase" is a short English description of the
trope (e.g. "underdog becomes hero"). Use "confidence": "high" only when you are certain this is a
real, reusable trope — use "low" for anything you are unsure about. Output nothing but the JSON array.`;
}

function parseExtraction(raw: string): ExtractedTrope[] {
  const match = /\[[\s\S]*\]/.exec(raw);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ExtractedTrope => typeof e === 'object' && e !== null && typeof (e as ExtractedTrope).phrase === 'string',
    );
  } catch {
    return [];
  }
}

export interface TropeService {
  extract(title: Title, reviewSnippets?: string[]): Promise<string[]>;
}

export function createTropeService(repo: Repository, opts: TropeServiceOptions = {}): TropeService {
  const callLlm = opts.callLlm ?? (async (prompt: string) => (await simpleChat(prompt, CLASSIFY_MODEL)).text);

  return {
    async extract(title, reviewSnippets = []) {
      const raw = await callLlm(buildPrompt(title, reviewSnippets));
      const extracted = parseExtraction(raw);

      const canonicalIds: string[] = [];
      for (const { phrase, confidence } of extracted) {
        const existing = repo.resolveTrope(phrase);
        if (existing) {
          canonicalIds.push(existing);
          continue;
        }
        // Spec §6.6: only create a new dictionary entry on high confidence; low-confidence
        // unmapped phrases are dropped rather than hallucinated onto the title or dictionary.
        if (confidence === 'high') {
          const id = repo.addTrope({
            canonical_id: slugify(phrase),
            label_en: phrase,
            label_ru: phrase,
            aliases: [phrase],
          });
          canonicalIds.push(id);
        }
      }

      const unique = [...new Set(canonicalIds)];
      repo.setTropes(title.id, unique);
      return unique;
    },
  };
}
