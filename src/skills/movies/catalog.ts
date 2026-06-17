import type { Repository } from './repository.js';
import type { NewTitle, Title, MediaType, TitleSource } from './types.js';
import type { NormalizedTitle, SourceAdapter } from './adapters/types.js';
import type { TropeService } from './trope-service.js';

export type ResolveStatus = 'confident' | 'ambiguous' | 'unresolved';

export interface ResolveResult {
  status: ResolveStatus;
  match: Title | null;
  alternatives: Title[];
}

export interface ResolveOpts {
  mediaType?: MediaType;
  language?: string;
  year?: number;
}

export interface CatalogAdapters {
  tmdb: SourceAdapter;
  jikan: SourceAdapter;
}

export interface CatalogServiceOptions {
  tropeService?: TropeService;
}

export interface CatalogService {
  resolveTitle(query: string, opts?: ResolveOpts): Promise<ResolveResult>;
  generate?(features: { dimension: string; value: string }[], opts: { mediaType?: MediaType; runtimeMaxMin?: number; limit?: number }): Promise<Title[]>;
}

// Compilation/clip/special decoys that should not win a "watched a film" intent.
const NON_FILM_RE = /greatest moments|behind.the.scenes|special presentation|clip|compilation/i;

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Extract a plausible 4-digit release year from a free-text query. Ignores
// future years (e.g. "Blade Runner 2049") which are part of a title, not a date.
function extractYear(query: string): number | undefined {
  const match = /\b(19|20)\d{2}\b/.exec(query);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year <= new Date().getFullYear() + 1 ? year : undefined;
}

function filterNonFilms(found: NormalizedTitle[], query: string): NormalizedTitle[] {
  if (NON_FILM_RE.test(query)) return found; // user explicitly asked for clips/specials
  const filtered = found.filter((c) => !NON_FILM_RE.test(c.title) && !(c.originalTitle && NON_FILM_RE.test(c.originalTitle)));
  return filtered.length > 0 ? filtered : found; // never filter down to nothing
}

function exactMatch(c: NormalizedTitle, nq: string): boolean {
  return normalizeTitle(c.title) === nq || (c.originalTitle !== undefined && normalizeTitle(c.originalTitle) === nq);
}

// Rank: exact title match first, then year match (when given), then popularity. Stable.
function rankCandidates(found: NormalizedTitle[], query: string, year: number | undefined): NormalizedTitle[] {
  const nq = normalizeTitle(query);
  return found
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ea = exactMatch(a.c, nq) ? 1 : 0;
      const eb = exactMatch(b.c, nq) ? 1 : 0;
      if (ea !== eb) return eb - ea;
      if (year !== undefined) {
        const ya = a.c.year === year ? 1 : 0;
        const yb = b.c.year === year ? 1 : 0;
        if (ya !== yb) return yb - ya;
      }
      const pa = a.c.popularity ?? a.c.externalRating ?? 0;
      const pb = b.c.popularity ?? b.c.externalRating ?? 0;
      if (pa !== pb) return pb - pa;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

function classify(ranked: NormalizedTitle[], query: string, year: number | undefined): ResolveStatus {
  if (ranked.length === 1) return 'confident';
  const nq = normalizeTitle(query);
  const exact = ranked.filter((c) => exactMatch(c, nq));
  if (exact.length === 1) return 'confident';
  if (year !== undefined && ranked.filter((c) => c.year === year).length === 1) return 'confident';
  return 'ambiguous';
}

function toNewTitle(t: NormalizedTitle): NewTitle {
  return {
    source: t.source,
    source_id: t.sourceId,
    title: t.title,
    media_type: t.mediaType,
    genres: t.genres,
    themes: t.themes,
    ...(t.originalTitle !== undefined && { original_title: t.originalTitle }),
    ...(t.year !== undefined && { year: t.year }),
    ...(t.runtimeMin !== undefined && { runtime: t.runtimeMin }),
    ...(t.ageRating !== undefined && { age_rating: t.ageRating }),
    ...(t.synopsis !== undefined && { synopsis: t.synopsis }),
    ...(t.posterUrl !== undefined && { poster_url: t.posterUrl }),
    ...(t.externalRating !== undefined && { external_rating: t.externalRating }),
  };
}

export function createCatalogService(
  repo: Repository,
  adapters: CatalogAdapters,
  opts: CatalogServiceOptions = {},
): CatalogService {
  function maybeExtractTropes(title: Title): void {
    if (!opts.tropeService) return;
    if (title.tropes_extracted_at || !title.synopsis) return;
    void opts.tropeService.extract(title).catch(() => { /* extraction is best-effort */ });
  }

  return {
    async resolveTitle(query, resolveOpts) {
      const mediaType = resolveOpts?.mediaType;
      const language = resolveOpts?.language;
      const year = resolveOpts?.year ?? extractYear(query);

      // Item 4: a bare query may reuse the loose title cache, but an explicit
      // year/mediaType is a disambiguation/correction — go to the source so a
      // stale cached match can't be served instead.
      if (mediaType === undefined && year === undefined) {
        const cached = repo.searchCachedTitles(query);
        if (cached.length > 0) {
          return { status: cached.length === 1 ? 'confident' : 'ambiguous', match: cached[0]!, alternatives: cached.slice(1) };
        }
      }

      const primary = mediaType === 'anime' ? adapters.jikan : adapters.tmdb;
      const fallback = mediaType === 'anime' ? null : adapters.jikan;

      const searchOpts = {
        ...(mediaType !== undefined && { mediaType }),
        ...(language !== undefined && { language }),
        ...(year !== undefined && { year }),
      };
      let found = await primary.search(query, Object.keys(searchOpts).length > 0 ? searchOpts : undefined);
      if (found.length === 0 && fallback) {
        found = await fallback.search(query);
      }

      found = filterNonFilms(found, query);
      if (found.length === 0) {
        // Item 1e: do not fabricate a junk stub-and-log; let the caller ask the user.
        return { status: 'unresolved', match: null, alternatives: [] };
      }

      const ranked = rankCandidates(found, query, year);
      // Item 1d: enrich the top candidates so they carry year/poster/genres for the preview.
      const topN = ranked.slice(0, 3);
      const detailed = await Promise.all(
        topN.map(async (c) => {
          const adapter = c.source === 'jikan' ? adapters.jikan : adapters.tmdb;
          try {
            return await adapter.getDetails(c.sourceId);
          } catch {
            return c; // fall back to the search-normalized form
          }
        }),
      );
      const upserted = [...detailed, ...ranked.slice(3)].map((r) => repo.upsertTitle(toNewTitle(r)));
      const [match, ...alternatives] = upserted;
      maybeExtractTropes(match!);
      return { status: classify(ranked, query, year), match: match!, alternatives };
    },

    async generate(features, genOpts) {
      const { mediaType, runtimeMaxMin, limit = 20 } = genOpts;
      const sources: Array<'tmdb' | 'jikan'> = mediaType === 'anime' ? ['jikan'] : ['tmdb', 'jikan'];
      const allTitles: Title[] = [];

      for (const source of sources) {
        const adapter = source === 'jikan' ? adapters.jikan : adapters.tmdb;
        if (!adapter.discover) continue;
        const genres = features
          .filter((f) => f.dimension === 'genre')
          .flatMap((f) => repo.reverseTaxonomy(source as TitleSource, f.value))
          .filter((v, i, a) => a.indexOf(v) === i);
        try {
          const discoverOpts = { genres, limit, ...(mediaType !== undefined && { mediaType }), ...(runtimeMaxMin !== undefined && { runtimeMaxMin }) };
          const discovered = await adapter.discover(discoverOpts);
          for (const norm of discovered) {
            const title = repo.upsertTitle(toNewTitle(norm));
            maybeExtractTropes(title);
            allTitles.push(title);
          }
        } catch {
          // discovery is best-effort
        }
      }

      return allTitles;
    },
  };
}
