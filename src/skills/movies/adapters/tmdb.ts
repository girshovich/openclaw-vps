import type { NormalizedTitle, SourceAdapter, DiscoverOpts } from './types.js';
import { normalizeAgeRating } from './age-rating.js';

// Map a household language code to a TMDB language tag (e.g. "ru" → "ru-RU").
function tmdbLanguage(code: string): string {
  return code.includes('-') ? code : `${code}-${code.toUpperCase()}`;
}

export interface TmdbAdapterOptions {
  apiKey?: string;
  resolveGenre: (term: string) => string | null;
  fetchImpl?: typeof fetch;
}

class TmdbNotFoundError extends Error {}

const TMDB_GENRE_IDS: Record<string, string> = {
  Action: '28',
  Adventure: '12',
  Animation: '16',
  Comedy: '35',
  Crime: '80',
  Documentary: '99',
  Drama: '18',
  Family: '10751',
  Fantasy: '14',
  History: '36',
  Horror: '27',
  Music: '10402',
  Mystery: '9648',
  Romance: '10749',
  'Science Fiction': '878',
  Thriller: '53',
  War: '10752',
  Western: '37',
};

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
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 500 * attempt + Math.random() * 300));
      const res = await fetchImpl(url.toString());
      if (res.status === 404) throw new TmdbNotFoundError(`TMDB resource not found: ${path}`);
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`TMDB ${res.status}`); continue; }
      if (!res.ok) throw new Error(`TMDB request failed: ${res.status} ${res.statusText}`);
      return res.json() as Promise<TmdbRaw>;
    }
    throw lastErr!;
  }

  function normalizeSearchResult(raw: TmdbRaw, mediaType: 'movie' | 'series'): NormalizedTitle {
    const isSeries = mediaType === 'series';
    const originalTitle = (isSeries ? raw.original_name : raw.original_title) || undefined;
    const year = yearFrom(isSeries ? raw.first_air_date : raw.release_date);
    const synopsis = raw.overview || undefined;
    const poster = posterUrl(raw.poster_path);
    const externalRating = raw.vote_average ?? undefined;
    const popularity = raw.popularity ?? undefined;
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
      ...(popularity !== undefined && { popularity }),
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
      const language = searchOpts?.language ? tmdbLanguage(searchOpts.language) : undefined;
      const requested = searchOpts?.mediaType;

      // When the caller knows the media type, hit the dedicated endpoint and can
      // narrow by release year. Otherwise multi-search so series are reachable too.
      if (requested === 'movie' || requested === 'series') {
        const endpoint = requested === 'series' ? '/search/tv' : '/search/movie';
        const params: Record<string, string> = { query };
        if (language) params['language'] = language;
        if (searchOpts?.year !== undefined) {
          params[requested === 'series' ? 'first_air_date_year' : 'primary_release_year'] = String(searchOpts.year);
        }
        const data = await callApi(endpoint, params);
        return (data.results ?? []).map((r: TmdbRaw) => normalizeSearchResult(r, requested));
      }

      const params: Record<string, string> = { query };
      if (language) params['language'] = language;
      const data = await callApi('/search/multi', params);
      return (data.results ?? [])
        .filter((r: TmdbRaw) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r: TmdbRaw) => normalizeSearchResult(r, r.media_type === 'tv' ? 'series' : 'movie'));
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

    async discover(opts: DiscoverOpts) {
      const mediaType = opts.mediaType === 'series' ? 'series' : 'movie';
      const endpoint = mediaType === 'series' ? '/discover/tv' : '/discover/movie';
      const genreIds = (opts.genres ?? [])
        .map((g) => TMDB_GENRE_IDS[g])
        .filter((id): id is string => id !== undefined)
        .join(',');
      const params: Record<string, string> = { sort_by: 'popularity.desc' };
      if (genreIds) params['with_genres'] = genreIds;
      if (opts.runtimeMaxMin !== undefined) params['with_runtime.lte'] = String(opts.runtimeMaxMin);
      const data = await callApi(endpoint, params);
      const results: TmdbRaw[] = data.results ?? [];
      return results.slice(0, opts.limit ?? 20).map((r: TmdbRaw) => normalizeSearchResult(r, mediaType));
    },
  };
}
