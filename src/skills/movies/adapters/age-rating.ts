// Shared by both adapters: TMDB certifications (e.g. "PG-13") and Jikan ratings
// (e.g. "R - 17+ (violence & profanity)") use the same MPAA-derived vocabulary.
const RATING_TO_AGE: Record<string, string> = {
  G: '0+',
  'TV-Y': '0+',
  'TV-G': '0+',
  'TV-Y7': '6+',
  PG: '6+',
  'TV-PG': '6+',
  'PG-13': '12+',
  'TV-14': '12+',
  R: '16+',
  'R+': '18+',
  Rx: '18+',
  'NC-17': '18+',
  'TV-MA': '18+',
};

export function normalizeAgeRating(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const code = raw.split(' - ')[0]!.trim();
  return RATING_TO_AGE[code];
}
