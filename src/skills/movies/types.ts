// Domain types for the movies skill's recommender.db.
// Field names are snake_case to mirror the DB columns directly, matching the
// convention in src/memory/sqlite.ts (DbMessage, DbTask, etc.). Booleans are
// stored as INTEGER (0|1), matching DbCronJob.recurrent.

export interface Household {
  id: string;
  timezone: string;
  language: string;
  onboarded: number;
  created_at: number;
}
export interface NewHousehold {
  timezone: string;
  language: string;
}

export interface User {
  id: string;
  household_id: string;
  name: string;
  birth_date: string | null;
  age_static: number | null;
  age_recorded_at: string | null;
  include_in_recommendations: number;
  created_at: number;
}
export interface NewUser {
  household_id: string;
  name: string;
  birth_date?: string;
  age_static?: number;
  age_recorded_at?: string;
  include_in_recommendations?: number;
}
export type UserPatch = Partial<
  Pick<User, 'name' | 'birth_date' | 'age_static' | 'age_recorded_at' | 'include_in_recommendations'>
>;

export type PreferenceDimension = 'genre' | 'theme' | 'trope' | 'tone' | 'pace' | 'runtime' | 'source_type';
export type PreferenceOrigin = 'onboarding' | 'feedback' | 'manual' | 'decayed';

export interface Preference {
  id: string;
  user_id: string;
  dimension: PreferenceDimension;
  value: string;
  weight: number;
  origin: PreferenceOrigin;
  updated_at: number;
}
export interface NewPreference {
  user_id: string;
  dimension: PreferenceDimension;
  value: string;
  weight: number;
  origin: PreferenceOrigin;
}

export type ConstraintType =
  | 'trigger'
  | 'max_runtime'
  | 'min_age_rating'
  | 'max_age_rating'
  | 'no_subtitles'
  | 'exclude_source'
  | 'exclude_trope'
  | 'exclude_theme';
export type ConstraintOrigin = 'onboarding' | 'feedback' | 'manual';

export interface Constraint {
  id: string;
  user_id: string;
  type: ConstraintType;
  value: string;
  active: number;
  origin: ConstraintOrigin;
  created_at: number;
}
export interface NewConstraint {
  user_id: string;
  type: ConstraintType;
  value: string;
  active?: number;
  origin: ConstraintOrigin;
}

export type MediaType = 'movie' | 'anime' | 'series';
export type TitleSource = 'tmdb' | 'jikan' | 'manual';

export interface Title {
  id: string;
  source: TitleSource;
  source_id: string;
  title: string;
  original_title: string | null;
  year: number | null;
  media_type: MediaType;
  runtime: number | null;
  age_rating: string | null;
  synopsis: string | null;
  poster_url: string | null;
  external_rating: number | null;
  genres: string[];
  themes: string[];
  tropes: string[];
  tropes_extracted_at: number | null;
  cached_at: number;
  last_refreshed_at: number;
}
export interface NewTitle {
  source: TitleSource;
  source_id: string;
  title: string;
  original_title?: string;
  year?: number;
  media_type: MediaType;
  runtime?: number;
  age_rating?: string;
  synopsis?: string;
  poster_url?: string;
  external_rating?: number;
  genres?: string[];
  themes?: string[];
  tropes?: string[];
}

export interface TropeDictionaryEntry {
  id: string;
  canonical_id: string;
  label_ru: string;
  label_en: string;
  aliases: string[];
  category: string | null;
}
export interface NewTropeDictionaryEntry {
  canonical_id: string;
  label_ru: string;
  label_en: string;
  aliases?: string[];
  category?: string;
}

export interface WatchEventViewerInput {
  user_id: string;
  age_at_watch: number;
}
export interface NewWatchEvent {
  title_id: string;
  watched_at?: string;
  viewers: WatchEventViewerInput[];
}
export interface WatchEvent {
  id: string;
  title_id: string;
  watched_at: string;
  created_at: number;
  viewers: WatchEventViewerInput[];
}

export type FeedbackRating = 'loved' | 'ok' | 'disliked';
export interface NewFeedback {
  watch_event_id: string;
  user_id: string;
  rating: FeedbackRating;
  abandoned?: number;
  tags?: string[];
  review_text?: string;
}
export interface Feedback {
  id: string;
  watch_event_id: string;
  user_id: string;
  rating: FeedbackRating;
  abandoned: number;
  tags: string[];
  review_text: string | null;
  applied_to_profile: number;
  created_at: number;
}

export type WatchlistStatus = 'wishlist' | 'favorite';
export type WatchlistSource = 'recommendation' | 'manual';
export interface NewWatchlist {
  user_id: string;
  title_id: string;
  status: WatchlistStatus;
  added_from: WatchlistSource;
}
export interface Watchlist {
  id: string;
  user_id: string;
  title_id: string;
  status: WatchlistStatus;
  added_from: WatchlistSource;
  added_at: number;
}

export type SuppressionScope = 'title' | 'trope' | 'theme' | 'genre';
export type SuppressionReason = 'outgrown' | 'seen' | 'tired_of';
export interface NewSuppression {
  user_id: string;
  scope: SuppressionScope;
  value: string;
  reason: SuppressionReason;
}
export interface Suppression {
  id: string;
  user_id: string;
  scope: SuppressionScope;
  value: string;
  reason: SuppressionReason;
  created_at: number;
}

export type RecommendationOutcome = 'picked' | 'dismissed' | 'ignored';
export interface NewRecommendationLog {
  user_id?: string;
  viewer_ids?: string[];
  title_id: string;
  context?: string;
  match_score: number;
  match_reasons?: string[];
  shown_at?: number;
}
export interface RecommendationLogEntry {
  id: string;
  user_id: string | null;
  viewer_ids: string[];
  title_id: string;
  context: string | null;
  match_score: number;
  match_reasons: string[];
  shown_at: number;
  outcome: RecommendationOutcome | null;
}

export interface NewAction {
  action_type: string;
  entity_ref: string;
  previous_state: unknown;
}
export interface ActionLogEntry {
  id: string;
  action_type: string;
  entity_ref: string;
  previous_state: unknown;
  created_at: number;
}

export interface DateRange {
  from?: string;
  to?: string;
}

export interface WatchEntry {
  watch_event_id: string;
  title_id: string;
  title: string;
  watched_at: string;
  age_at_watch: number;
  feedback: Feedback | null;
}
