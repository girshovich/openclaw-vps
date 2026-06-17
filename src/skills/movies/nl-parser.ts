// Spec §7 NL rating parser — regex only, no LLM.
// Parses Russian shorthand replies to recommendation cards.

export interface RatingParsed {
  candidateIndex: number; // 0-based
  rating: 'loved' | 'ok' | 'disliked';
  abandoned: boolean;
  tags: string[];
}

// "длинно/долго" → too_long; "страшно" → too_scary; "скучно" → boring
function extractTags(text: string): string[] {
  const tags: string[] = [];
  if (/длинн|долго|слишком длин/i.test(text)) tags.push('too_long');
  if (/страшн/i.test(text)) tags.push('too_scary');
  if (/скучн/i.test(text)) tags.push('boring');
  return tags;
}

// Parse "1 зашло", "2 так себе", "3 не зашло", "бросили 2"
// Returns null when the text doesn't look like a rating reply.
export function parseRatingReply(text: string): RatingParsed | null {
  const t = text.trim();

  // "бросили N" — abandoned dislike
  const abandoned = /бросили\s+(\d+)/i.exec(t);
  if (abandoned) {
    return {
      candidateIndex: parseInt(abandoned[1]!, 10) - 1,
      rating: 'disliked',
      abandoned: true,
      tags: extractTags(t),
    };
  }

  // "N зашло" — loved
  const loved = /(\d+)\s+(зашло|понравилось|супер|отлично|класс)/i.exec(t);
  if (loved) {
    return { candidateIndex: parseInt(loved[1]!, 10) - 1, rating: 'loved', abandoned: false, tags: extractTags(t) };
  }

  // "N не зашло" — disliked
  const disliked = /(\d+)\s+(не\s+зашло|не\s+понравилось|плохо|скучно)/i.exec(t);
  if (disliked) {
    return { candidateIndex: parseInt(disliked[1]!, 10) - 1, rating: 'disliked', abandoned: false, tags: extractTags(t) };
  }

  // "N так себе" — ok
  const ok = /(\d+)\s+(так\s+себе|нормально|сойдёт|сойдет)/i.exec(t);
  if (ok) {
    return { candidateIndex: parseInt(ok[1]!, 10) - 1, rating: 'ok', abandoned: false, tags: extractTags(t) };
  }

  return null;
}

// Parse "в избранное N" → {candidateIndex}
export function parseFavoriteReply(text: string): { candidateIndex: number } | null {
  const m = /в\s+избранное\s+(\d+)/i.exec(text.trim());
  if (!m) return null;
  return { candidateIndex: parseInt(m[1]!, 10) - 1 };
}

// Parse standalone follow-up tags from text like "страшно" / "длинно" / "скучно"
export function parseFollowUpTags(text: string): string[] {
  return extractTags(text);
}
