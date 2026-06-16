import type { Repository } from './repository.js';
import type { NewTitle, Title, MediaType } from './types.js';
import type { NormalizedTitle, SourceAdapter } from './adapters/types.js';

export interface ResolveResult {
  match: Title;
  alternatives: Title[];
}

export interface CatalogAdapters {
  tmdb: SourceAdapter;
  jikan: SourceAdapter;
}

export interface CatalogService {
  resolveTitle(query: string, opts?: { mediaType?: MediaType }): Promise<ResolveResult>;
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

export function createCatalogService(repo: Repository, adapters: CatalogAdapters): CatalogService {
  return {
    async resolveTitle(query, opts) {
      const cached = repo.searchCachedTitles(query);
      if (cached.length > 0) {
        return { match: cached[0]!, alternatives: cached.slice(1) };
      }

      const adapter = opts?.mediaType === 'anime' ? adapters.jikan : adapters.tmdb;
      const found = await adapter.search(query, opts?.mediaType ? { mediaType: opts.mediaType } : undefined);
      if (found.length === 0) throw new Error(`No results found for "${query}"`);

      const [top, ...rest] = found;
      const detailed = await adapter.getDetails(top!.sourceId);
      const match = repo.upsertTitle(toNewTitle(detailed));
      const alternatives = rest.map((r) => repo.upsertTitle(toNewTitle(r)));
      return { match, alternatives };
    },
  };
}
