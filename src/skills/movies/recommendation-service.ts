import { effectiveWeight } from './decay.js';
import type { Repository } from './repository.js';
import type { MediaType, Preference, Title, User } from './types.js';

export interface RecommendOptions {
  mediaType?: MediaType;
  context?: string;
  excludeSeen?: boolean; // default true
  limit?: number; // default 10
}

export interface RecommendationCandidate {
  title: Title;
  match_score: number;
  match_reasons: string[];
}

export interface RecommendationService {
  recommend(viewerIds: string[], opts?: RecommendOptions): Promise<RecommendationCandidate[]>;
}

// Spec §6.3: tropes predict a child's reaction best, so they outrank themes/genres
const MULTIPLIERS: Record<string, number> = {
  trope: 3,
  theme: 2,
  genre: 1.5,
  source_type: 1,
};

const RECENTLY_DISMISSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function parseRatingAge(rating: string): number {
  return parseInt(rating, 10);
}

function titleMinAge(title: Title): number {
  return title.age_rating ? parseRatingAge(title.age_rating) : 0;
}

// Spec §3.2: prefer birth_date; fall back to age_static + years since age_recorded_at
function computeCurrentAge(user: User): number | null {
  if (user.birth_date) {
    const birth = new Date(user.birth_date);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age;
  }
  if (user.age_static !== null) {
    if (!user.age_recorded_at) return user.age_static;
    const recordedYear = new Date(user.age_recorded_at).getFullYear();
    return user.age_static + (new Date().getFullYear() - recordedYear);
  }
  return null;
}

function featureKey(dimension: string, value: string): string {
  return `${dimension}:${value}`;
}

function buildJointProfile(viewerPrefs: Preference[][], youngestAge: number | null): Map<string, number> {
  const perViewer = viewerPrefs.map((prefs) => {
    const m = new Map<string, number>();
    for (const p of prefs) {
      m.set(featureKey(p.dimension, p.value), effectiveWeight(p, youngestAge ?? (p.age_at_signal ?? 0)));
    }
    return m;
  });

  const allKeys = new Set<string>();
  for (const m of perViewer) for (const k of m.keys()) allKeys.add(k);

  const joint = new Map<string, number>();
  for (const key of allKeys) {
    const weights = perViewer.map((m) => m.get(key) ?? 0);
    // Spec §6.3: intersection of positives (min), union of negatives (min)
    joint.set(key, Math.min(...weights));
  }
  return joint;
}

function titleFeatures(title: Title): Array<{ dimension: string; value: string }> {
  return [
    ...title.genres.map((v) => ({ dimension: 'genre', value: v })),
    ...title.themes.map((v) => ({ dimension: 'theme', value: v })),
    ...title.tropes.map((v) => ({ dimension: 'trope', value: v })),
    { dimension: 'source_type', value: `source_type:${title.media_type}` },
  ];
}

// Spec §6.2 filtering helpers

function isAgeAllowed(title: Title, ceilingAge: number | null): boolean {
  if (ceilingAge === null) return true;
  return titleMinAge(title) <= ceilingAge;
}

function violatesConstraints(
  title: Title,
  constraintValues: { type: string; value: string }[],
): boolean {
  for (const c of constraintValues) {
    if (c.type === 'max_runtime') {
      const maxMin = parseInt(c.value.replace('max_runtime:', ''), 10);
      if (title.runtime !== null && title.runtime > maxMin) return true;
    } else if (c.type === 'max_age_rating') {
      const maxAge = parseRatingAge(c.value);
      if (titleMinAge(title) > maxAge) return true;
    } else if (c.type === 'exclude_trope') {
      if (title.tropes.includes(c.value)) return true;
    } else if (c.type === 'exclude_theme') {
      if (title.themes.includes(c.value)) return true;
    } else if (c.type === 'exclude_source') {
      if (title.source === c.value) return true;
    } else if (c.type === 'trigger') {
      // Trigger value "trigger:X" blocks titles with theme:X or trope:X
      const topic = c.value.replace(/^trigger:/, '');
      if (title.themes.includes(`theme:${topic}`) || title.tropes.includes(`trope:${topic}`)) return true;
    }
  }
  return false;
}

function isSuppressed(title: Title, suppressions: { scope: string; value: string }[]): boolean {
  for (const s of suppressions) {
    if (s.scope === 'title' && title.id === s.value) return true;
    if (s.scope === 'genre' && title.genres.includes(s.value)) return true;
    if (s.scope === 'theme' && title.themes.includes(s.value)) return true;
    if (s.scope === 'trope' && title.tropes.includes(s.value)) return true;
  }
  return false;
}

export function createRecommendationService(repo: Repository): RecommendationService {
  return {
    async recommend(viewerIds, opts = {}) {
      const { mediaType, context, excludeSeen = true, limit = 10 } = opts;

      // Load all viewers
      const allUsers = repo.listUsers();
      const viewers = allUsers.filter((u) => viewerIds.includes(u.id));
      if (viewers.length === 0) return [];

      // Compute current ages; youngest determines the age ceiling
      const ages = viewers.map(computeCurrentAge);
      const definedAges = ages.filter((a): a is number => a !== null);
      const youngestAge = definedAges.length > 0 ? Math.min(...definedAges) : null;

      // Per-viewer data for filtering
      const constraintsByViewer = viewers.map((u) => repo.getConstraints(u.id).filter((c) => c.active === 1));
      const suppressionsByViewer = viewers.map((u) => repo.getSuppressions(u.id));
      const seenByViewer = excludeSeen
        ? viewers.map((u) => new Set(repo.getWatchedTitleIds(u.id)))
        : viewers.map(() => new Set<string>());
      const dismissedByViewer = viewers.map((u) =>
        new Set(repo.getRecentlyDismissedTitleIds(u.id, Date.now() - RECENTLY_DISMISSED_WINDOW_MS)),
      );

      // Flatten unions for filters (any viewer's constraint/suppression/seen applies)
      const allConstraints = constraintsByViewer.flat();
      const allSuppressions = suppressionsByViewer.flat();
      const seenUnion = new Set<string>([...seenByViewer.flatMap((s) => [...s])]);
      const dismissedUnion = new Set<string>([...dismissedByViewer.flatMap((s) => [...s])]);

      // Generate candidates from cache (spec §6.1: adapters provide search/getDetails but no
      // bulk-discovery endpoint; candidates accumulate in the cache via log_watch + resolve flows)
      const candidates = repo.listTitles(mediaType);

      // Filter (spec §6.2 hard rules)
      const survivors = candidates.filter((title) => {
        if (!isAgeAllowed(title, youngestAge)) return false;
        if (violatesConstraints(title, allConstraints)) return false;
        if (isSuppressed(title, allSuppressions)) return false;
        if (excludeSeen && seenUnion.has(title.id)) return false;
        if (dismissedUnion.has(title.id)) return false;
        return true;
      });

      // Build joint preference profile (spec §6.3 intersection/union logic)
      const viewerPrefs = viewers.map((u) => repo.getPreferences(u.id));
      const jointProfile = buildJointProfile(viewerPrefs, youngestAge);

      // Score survivors (spec §6.3)
      const scored = survivors.map((title) => {
        let raw = (title.external_rating ?? 0) * 0.01;
        const contributions: Array<{ label: string; value: number }> = [];

        for (const { dimension, value } of titleFeatures(title)) {
          const key = featureKey(dimension, value);
          const w = jointProfile.get(key) ?? 0;
          if (w === 0) continue;
          const mult = MULTIPLIERS[dimension] ?? 1;
          const contrib = w * mult;
          raw += contrib;
          if (contrib > 0) contributions.push({ label: value, value: contrib });
        }

        const reasons = contributions
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((c) => c.label);

        return { title, raw, reasons };
      });

      // Normalize to 0-100
      const maxRaw = Math.max(...scored.map((c) => c.raw), 0.001);
      const results: RecommendationCandidate[] = scored.map(({ title, raw, reasons }) => ({
        title,
        match_score: Math.round(Math.min(100, Math.max(0, (raw / maxRaw) * 100))),
        match_reasons: reasons,
      }));

      // Sort by score desc, take limit
      results.sort((a, b) => b.match_score - a.match_score);
      const top = results.slice(0, limit);

      // Log every shown candidate (spec §6.3: "Log every shown candidate")
      const sinceMs = Date.now();
      for (const { title, match_score, match_reasons } of top) {
        for (const viewer of viewers) {
          repo.logRecommendation({
            user_id: viewer.id,
            viewer_ids: viewerIds,
            title_id: title.id,
            match_score,
            match_reasons,
            shown_at: sinceMs,
            ...(context !== undefined && { context }),
          });
        }
      }

      return top;
    },
  };
}
