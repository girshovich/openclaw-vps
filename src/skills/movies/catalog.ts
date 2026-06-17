import type { Repository } from './repository.js';
import type { NewTitle, Title, MediaType, TitleSource } from './types.js';
import type { NormalizedTitle, SourceAdapter } from './adapters/types.js';
import type { TropeService } from './trope-service.js';

export interface ResolveResult {
  match: Title;
  alternatives: Title[];
}

export interface CatalogAdapters {
  tmdb: SourceAdapter;
  jikan: SourceAdapter;
}

export interface CatalogServiceOptions {
  tropeService?: TropeService;
}

export interface CatalogService {
  resolveTitle(query: string, opts?: { mediaType?: MediaType }): Promise<ResolveResult>;
  generate?(features: { dimension: string; value: string }[], opts: { mediaType?: MediaType; runtimeMaxMin?: number; limit?: number }): Promise<Title[]>;
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
      const cached = repo.searchCachedTitles(query);
      if (cached.length > 0) {
        return { match: cached[0]!, alternatives: cached.slice(1) };
      }

      const primary = resolveOpts?.mediaType === 'anime' ? adapters.jikan : adapters.tmdb;
      const fallback = resolveOpts?.mediaType === 'anime' ? null : adapters.jikan;

      let found = await primary.search(query, resolveOpts?.mediaType ? { mediaType: resolveOpts.mediaType } : undefined);

      if (found.length === 0 && fallback) {
        found = await fallback.search(query);
      }

      if (found.length === 0) {
        const stub = repo.upsertTitle({
          source: 'manual',
          source_id: query.toLowerCase().trim().replace(/\s+/g, '-'),
          title: query,
          media_type: resolveOpts?.mediaType ?? 'movie',
        });
        return { match: stub, alternatives: [] };
      }

      const [top, ...rest] = found;
      const detailAdapter = top!.source === 'jikan' ? adapters.jikan : adapters.tmdb;
      const detailed = await detailAdapter.getDetails(top!.sourceId);
      const match = repo.upsertTitle(toNewTitle(detailed));
      maybeExtractTropes(match);
      const alternatives = rest.map((r) => repo.upsertTitle(toNewTitle(r)));
      return { match, alternatives };
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
