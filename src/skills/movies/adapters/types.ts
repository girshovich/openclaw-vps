// Adapter-facing boundary type (spec §9). camelCase here, unlike the DB-facing
// snake_case Title/NewTitle in ../types.ts — this is what raw source APIs map to
// before CatalogService converts it for the Repository.
import type { MediaType, TitleSource } from '../types.js';

export interface NormalizedTitle {
  source: TitleSource;
  sourceId: string;
  title: string;
  originalTitle?: string;
  year?: number;
  mediaType: MediaType;
  runtimeMin?: number;
  ageRating?: string;
  synopsis?: string;
  posterUrl?: string;
  externalRating?: number;
  genres: string[];
  themes: string[];
}

export interface DiscoverOpts {
  genres?: string[];
  mediaType?: MediaType;
  runtimeMaxMin?: number;
  limit?: number;
}

export interface SourceAdapter {
  readonly source: 'tmdb' | 'jikan';
  search(query: string, opts?: { mediaType?: MediaType }): Promise<NormalizedTitle[]>;
  getDetails(sourceId: string): Promise<NormalizedTitle>;
  discover?(opts: DiscoverOpts): Promise<NormalizedTitle[]>;
}
