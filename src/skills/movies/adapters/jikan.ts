import type { NormalizedTitle, SourceAdapter } from './types.js';
import { normalizeAgeRating } from './age-rating.js';

export interface JikanAdapterOptions {
  resolveGenre: (term: string) => string | null;
  fetchImpl?: typeof fetch;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JikanRaw = any;

function parseDurationMin(duration: string | null | undefined): number | undefined {
  if (!duration) return undefined;
  const hours = /(\d+)\s*hr/.exec(duration);
  const minutes = /(\d+)\s*min/.exec(duration);
  const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
  return total > 0 ? total : undefined;
}

export function createJikanAdapter(opts: JikanAdapterOptions): SourceAdapter {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function callApi(path: string): Promise<JikanRaw> {
    const res = await fetchImpl(`https://api.jikan.moe/v4${path}`);
    if (!res.ok) throw new Error(`Jikan request failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  function normalize(raw: JikanRaw): NormalizedTitle {
    const canonical = [...(raw.genres ?? []), ...(raw.themes ?? [])]
      .map((g: JikanRaw) => opts.resolveGenre(g.name))
      .filter((v: string | null): v is string => v !== null);

    const originalTitle = raw.title_english || undefined;
    const year = raw.aired?.prop?.from?.year ?? undefined;
    const runtimeMin = parseDurationMin(raw.duration);
    const ageRating = normalizeAgeRating(raw.rating);
    const synopsis = raw.synopsis || undefined;
    const posterUrl = raw.images?.jpg?.image_url || undefined;
    const externalRating = raw.score ?? undefined;

    return {
      source: 'jikan',
      sourceId: String(raw.mal_id),
      title: raw.title,
      mediaType: 'anime',
      genres: canonical.filter((v) => v.startsWith('genre:')),
      themes: canonical.filter((v) => v.startsWith('theme:')),
      ...(originalTitle !== undefined && { originalTitle }),
      ...(year !== undefined && { year }),
      ...(runtimeMin !== undefined && { runtimeMin }),
      ...(ageRating !== undefined && { ageRating }),
      ...(synopsis !== undefined && { synopsis }),
      ...(posterUrl !== undefined && { posterUrl }),
      ...(externalRating !== undefined && { externalRating }),
    };
  }

  return {
    source: 'jikan',

    async search(query) {
      const data = await callApi(`/anime?q=${encodeURIComponent(query)}`);
      return (data.data ?? []).map((r: JikanRaw) => normalize(r));
    },

    async getDetails(sourceId) {
      const data = await callApi(`/anime/${sourceId}/full`);
      return normalize(data.data);
    },
  };
}
