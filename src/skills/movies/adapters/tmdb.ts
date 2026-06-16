import type { NormalizedTitle, SourceAdapter } from './types.js';
import { normalizeAgeRating } from './age-rating.js';

export interface TmdbAdapterOptions {
  apiKey?: string;
  resolveGenre: (term: string) => string | null;
  fetchImpl?: typeof fetch;
}

class TmdbNotFoundError extends Error {}

function yearFrom(date: string | null | undefined): number | undefined {
  return date ? Number(date.slice(0, 4)) : undefined;
}

function posterUrl(path: string | null | undefined): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TmdbRaw = any;

export function createTmdbAdapter(opts: TmdbAdapterOptions): SourceAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiKey = opts.apiKey ?? process.env['TMDB_API_KEY'];

  async function callApi(path: string, params: Record<string, string>): Promise<TmdbRaw> {
    if (!apiKey) throw new Error('TMDB_API_KEY is not set');
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    url.searchParams.set('api_key', apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url.toString());
    if (res.status === 404) throw new TmdbNotFoundError(`TMDB resource not found: ${path}`);
    if (!res.ok) throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  function normalizeSearchResult(raw: TmdbRaw, mediaType: 'movie' | 'series'): NormalizedTitle {
    const isSeries = mediaType === 'series';
    const originalTitle = (isSeries ? raw.original_name : raw.original_title) || undefined;
    const year = yearFrom(isSeries ? raw.first_air_date : raw.release_date);
    const synopsis = raw.overview || undefined;
    const poster = posterUrl(raw.poster_path);
    const externalRating = raw.vote_average ?? undefined;
    return {
      source: 'tmdb',
      sourceId: String(raw.id),
      title: isSeries ? raw.name : raw.title,
      mediaType,
      genres: [],
      themes: [],
      ...(originalTitle !== undefined && { originalTitle }),
      ...(year !== undefined && { year }),
      ...(synopsis !== undefined && { synopsis }),
      ...(poster !== undefined && { posterUrl: poster }),
      ...(externalRating !== undefined && { externalRating }),
    };
  }

  function normalizeMovieDetails(raw: TmdbRaw): NormalizedTitle {
    const us = raw.release_dates?.results?.find((r: TmdbRaw) => r.iso_3166_1 === 'US');
    const cert = us?.release_dates?.find((d: TmdbRaw) => d.certification)?.certification;
    const originalTitle = raw.original_title || undefined;
    const year = yearFrom(raw.release_date);
    const runtimeMin = raw.runtime ?? undefined;
    const ageRating = normalizeAgeRating(cert);
    const synopsis = raw.overview || undefined;
    const poster = posterUrl(raw.poster_path);
    const externalRating = raw.vote_average ?? undefined;
    return {
      source: 'tmdb',
      sourceId: String(raw.id),
      title: raw.title,
      mediaType: 'movie',
      genres: (raw.genres ?? [])
        .map((g: TmdbRaw) => opts.resolveGenre(g.name))
        .filter((v: string | null): v is string => v !== null),
      themes: [],
      ...(originalTitle !== undefined && { originalTitle }),
      ...(year !== undefined && { year }),
      ...(runtimeMin !== undefined && { runtimeMin }),
      ...(ageRating !== undefined && { ageRating }),
      ...(synopsis !== undefined && { synopsis }),
      ...(poster !== undefined && { posterUrl: poster }),
      ...(externalRating !== undefined && { externalRating }),
    };
  }

  function normalizeTvDetails(raw: TmdbRaw): NormalizedTitle {
    const us = raw.content_ratings?.results?.find((r: TmdbRaw) => r.iso_3166_1 === 'US');
    const originalTitle = raw.original_name || undefined;
    const year = yearFrom(raw.first_air_date);
    const runtimeMin = raw.episode_run_time?.[0] ?? undefined;
    const ageRating = normalizeAgeRating(us?.rating);
    const synopsis = raw.overview || undefined;
    const poster = posterUrl(raw.poster_path);
    const externalRating = raw.vote_average ?? undefined;
    return {
      source: 'tmdb',
      sourceId: String(raw.id),
      title: raw.name,
      mediaType: 'series',
      genres: (raw.genres ?? [])
        .map((g: TmdbRaw) => opts.resolveGenre(g.name))
        .filter((v: string | null): v is string => v !== null),
      themes: [],
      ...(originalTitle !== undefined && { originalTitle }),
      ...(year !== undefined && { year }),
      ...(runtimeMin !== undefined && { runtimeMin }),
      ...(ageRating !== undefined && { ageRating }),
      ...(synopsis !== undefined && { synopsis }),
      ...(poster !== undefined && { posterUrl: poster }),
      ...(externalRating !== undefined && { externalRating }),
    };
  }

  return {
    source: 'tmdb',

    async search(query, searchOpts) {
      const mediaType = searchOpts?.mediaType === 'series' ? 'series' : 'movie';
      const endpoint = mediaType === 'series' ? '/search/tv' : '/search/movie';
      const data = await callApi(endpoint, { query });
      return (data.results ?? []).map((r: TmdbRaw) => normalizeSearchResult(r, mediaType));
    },

    async getDetails(sourceId) {
      try {
        const raw = await callApi(`/movie/${sourceId}`, { append_to_response: 'release_dates' });
        return normalizeMovieDetails(raw);
      } catch (err) {
        if (!(err instanceof TmdbNotFoundError)) throw err;
        const raw = await callApi(`/tv/${sourceId}`, { append_to_response: 'content_ratings' });
        return normalizeTvDetails(raw);
      }
    },
  };
}
