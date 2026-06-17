import { effectiveWeight } from './decay.js';
import { computeCurrentAge } from './age.js';
import type { Repository } from './repository.js';
import type { CatalogService } from './catalog.js';
import type { MediaType, Preference, Title } from './types.js';
import { normalizeAgeRating } from './adapters/age-rating.js';

export interface RecommendOptions {
  mediaType?: MediaType;
  context?: string;
  excludeSeen?: boolean; // default true
  limit?: number; // default 10
  runtimeMaxMin?: number; // ephemeral runtime cap (not persisted)
}

export interface RecommendationCandidate {
  title: Title;
  match_score: number;
  match_reasons: string[];
}

export interface RecommendationService {
  recommend(viewerIds: string[], opts?: RecommendOptions): Promise<RecommendationCandidate[]>;
}

const MULTIPLIERS: Record<string, number> = {
  trope: 3,
  theme: 2,
  genre: 1.5,
  source_type: 1,
};

const RECENTLY_DISMISSED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function ratingToAge(raw: string | null | undefined): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  if (/^\d+\+?$/.test(trimmed)) return parseInt(trimmed, 10);
  const norm = normalizeAgeRating(trimmed);
  return norm ? parseInt(norm, 10) : 0;
}

function titleMinAge(title: Title): number {
  return ratingToAge(title.age_rating);
}

function featureKey(dimension: string, value: string): string {
  return `${dimension}:${value}`;
}

function displayId(key: string): string {
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(colon + 1).replace(/_/g, ' ') : key;
}

function buildJointProfile(viewerPrefs: Preference[][], viewerAges: (number | null)[]): Map<string, number> {
  const perViewer = viewerPrefs.map((prefs, i) => {
    const age = viewerAges[i] ?? null;
    const m = new Map<string, number>();
    for (const p of prefs) {
      m.set(featureKey(p.dimension, p.value), effectiveWeight(p, age ?? (p.age_at_signal ?? 0)));
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

function violatesConstraints(
  title: Title,
  constraintValues: { type: string; value: string }[],
): boolean {
  for (const c of constraintValues) {
    if (c.type === 'max_runtime') {
      const maxMin = parseInt(c.value.replace('max_runtime:', ''), 10);
      if (title.runtime !== null && title.runtime > maxMin) return true;
    } else if (c.type === 'max_age_rating') {
      const maxAge = ratingToAge(c.value.replace(/^max_age_rating:/, ''));
      if (titleMinAge(title) > maxAge) return true;
    } else if (c.type === 'exclude_trope') {
      if (title.tropes.includes(c.value)) return true;
    } else if (c.type === 'exclude_theme') {
      if (title.themes.includes(c.value)) return true;
    } else if (c.type === 'exclude_source') {
      if (title.source === c.value) return true;
    } else if (c.type === 'trigger') {
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

export function createRecommendationService(repo: Repository, catalogService?: CatalogService): RecommendationService {
  return {
    async recommend(viewerIds, opts = {}) {
      const { mediaType, context, excludeSeen = true, limit = 10, runtimeMaxMin } = opts;

      const allUsers = repo.listUsers();
      const viewers = allUsers.filter((u) => viewerIds.includes(u.id));
      if (viewers.length === 0) return [];

      const ages = viewers.map(computeCurrentAge);

      // Per-viewer data for filtering
      const constraintsByViewer = viewers.map((u) => repo.getConstraints(u.id).filter((c) => c.active === 1));
      const suppressionsByViewer = viewers.map((u) => repo.getSuppressions(u.id));
      const seenByViewer = excludeSeen
        ? viewers.map((u) => new Set(repo.getWatchedTitleIds(u.id)))
        : viewers.map(() => new Set<string>());
      const dismissedByViewer = viewers.map((u) =>
        new Set(repo.getRecentlyDismissedTitleIds(u.id, Date.now() - RECENTLY_DISMISSED_WINDOW_MS)),
      );

      const allConstraints = constraintsByViewer.flat();
      const allSuppressions = suppressionsByViewer.flat();
      const seenUnion = new Set<string>([...seenByViewer.flatMap((s) => [...s])]);
      const dismissedUnion = new Set<string>([...dismissedByViewer.flatMap((s) => [...s])]);

      // Build joint profile early — needed for generate step
      const viewerPrefs = viewers.map((u) => repo.getPreferences(u.id));
      const jointProfile = buildJointProfile(viewerPrefs, ages);

      // Generate fresh candidates from adapters based on top positive features
      if (catalogService?.generate) {
        const topFeatures = [...jointProfile.entries()]
          .filter(([, w]) => w > 0)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([key]) => {
            const colon = key.indexOf(':');
            return { dimension: key.slice(0, colon), value: key.slice(colon + 1) };
          })
          .filter((f) => f.dimension === 'genre' || f.dimension === 'theme');
        if (topFeatures.length > 0) {
          const genOpts = { limit: 20, ...(mediaType !== undefined && { mediaType }), ...(runtimeMaxMin !== undefined && { runtimeMaxMin }) };
          await catalogService.generate(topFeatures, genOpts);
        }
      }

      const candidates = repo.listTitles(mediaType);

      const runtimeConstraints =
        runtimeMaxMin !== undefined
          ? [...allConstraints, { type: 'max_runtime', value: `max_runtime:${runtimeMaxMin}` }]
          : allConstraints;

      const survivors = candidates.filter((title) => {
        if (violatesConstraints(title, runtimeConstraints)) return false;
        if (isSuppressed(title, allSuppressions)) return false;
        if (excludeSeen && seenUnion.has(title.id)) return false;
        if (dismissedUnion.has(title.id)) return false;
        return true;
      });

      // Score survivors
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
          .map((c) => displayId(c.label));

        return { title, raw, reasons };
      });

      // Normalize to 0-100
      const maxRaw = Math.max(...scored.map((c) => c.raw), 0.001);
      const results: RecommendationCandidate[] = scored.map(({ title, raw, reasons }) => ({
        title,
        match_score: Math.round(Math.min(100, Math.max(0, (raw / maxRaw) * 100))),
        match_reasons: reasons,
      }));

      results.sort((a, b) => b.match_score - a.match_score);
      const top = results.slice(0, limit);

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
