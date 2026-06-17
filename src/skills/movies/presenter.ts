// Text renderers for spec §7 — text-only v1 presentation.
// Pure functions: no DB access, no LLM calls.

export interface RecCard {
  title: string;
  year?: number | null;
  runtime?: number | null;
  age_rating?: string | null;
  external_rating?: number | null;
  source: string;
  match_score: number;
  match_reasons: string[];
  synopsis?: string | null;
}

export interface FavoriteEntry {
  title: string;
  age_at_watch?: number | null;
  rating: 'loved' | 'ok' | 'disliked';
  abandoned: boolean;
}

export interface HistoryEntry {
  title: string;
  watched_at: string;
  age_at_watch: number;
  rating?: 'loved' | 'ok' | 'disliked';
  abandoned?: boolean;
}

// "trope:underdog_hero" → "underdog hero"
function displayId(canonicalId: string): string {
  return canonicalId.replace(/^[a-z_]+:/, '').replace(/_/g, ' ');
}

function ratingEmoji(rating: 'loved' | 'ok' | 'disliked', abandoned: boolean): string {
  const base = rating === 'loved' ? '👍' : rating === 'ok' ? '😐' : '👎';
  return abandoned ? base + '✋' : base;
}

// Spec §7 recommendation card format, 1-based index
export function renderRecommendationCard(index: number, card: RecCard): string {
  const parts: string[] = [];

  // Header line
  const yearStr = card.year ? ` (${card.year})` : '';
  const rating = card.age_rating ? ` · ${card.age_rating}` : '';
  const runtime = card.runtime ? ` · ${card.runtime} мин` : '';
  const stars = card.external_rating ? ` · ⭐${card.external_rating.toFixed(1)}` : '';
  const source = ` · ${card.source.toUpperCase()}`;
  parts.push(`🎬 ${index}. ${card.title}${yearStr}${rating}${runtime}${stars}${source}`);

  // Synopsis (one line if available)
  if (card.synopsis) parts.push(card.synopsis.slice(0, 120));

  // Why line
  if (card.match_reasons.length > 0) {
    const reasons = card.match_reasons.map((r) => `✓${displayId(r)}`).join(' ');
    parts.push(`Почему: совпадение ${card.match_score}% — ${reasons}`);
  }

  return parts.join('\n');
}

export function renderRecommendationCards(cards: RecCard[]): string {
  const cardLines = cards.map((c, i) => renderRecommendationCard(i + 1, c)).join('\n\n');
  const hint = `\n(оцените: «1 зашло», «2 так себе», «бросили 1»)`;
  return cardLines + hint;
}

// Spec §7 favorites list
export function renderFavoritesList(
  userName: string,
  userAge: number | null,
  favorites: FavoriteEntry[],
  topLikes: string[] = [],
  avoiding: string[] = [],
): string {
  const ageStr = userAge !== null ? ` (сейчас ${userAge})` : '';
  const lines = [`⭐ Избранное — ${userName}${ageStr}`];

  for (const f of favorites) {
    const watchedStr = f.age_at_watch !== null && f.age_at_watch !== undefined ? ` · смотрели в ${f.age_at_watch}` : '';
    lines.push(`🎬 ${f.title}${watchedStr} · ${ratingEmoji(f.rating, f.abandoned)}`);
  }

  if (topLikes.length > 0) lines.push(`Любимое: ${topLikes.map(displayId).join(', ')}`);
  if (avoiding.length > 0) lines.push(`Избегаем: ${avoiding.map(displayId).join(', ')}`);

  return lines.join('\n');
}

// Spec §7 history list (compact)
export function renderHistoryList(userName: string, entries: HistoryEntry[]): string {
  const lines = [`📋 История просмотров — ${userName}`];
  for (const e of entries) {
    const emoji = e.rating ? ratingEmoji(e.rating, e.abandoned ?? false) : '';
    const age = ` · в ${e.age_at_watch}`;
    lines.push(`🎬 ${e.title}${age} · ${e.watched_at.slice(0, 10)}${emoji ? ' ' + emoji : ''}`);
  }
  return lines.join('\n');
}

// Spec §7 profile view
export function renderProfile(userName: string, profileSummary: string): string {
  return `👤 ${userName}\n${profileSummary}`;
}
