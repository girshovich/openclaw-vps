import { randomUUID } from 'node:crypto';
import type { RecommenderDb } from './db.js';
import type {
  Household,
  NewHousehold,
  User,
  NewUser,
  UserPatch,
  Preference,
  NewPreference,
  Constraint,
  NewConstraint,
  Suppression,
  NewSuppression,
  Title,
  NewTitle,
  TitleSource,
  MediaType,
  NewWatchEvent,
  WatchEvent,
  NewFeedback,
  Feedback,
  DateRange,
  WatchEntry,
  NewWatchlist,
  Watchlist,
  WatchlistStatus,
  NewRecommendationLog,
  RecommendationLogEntry,
  RecommendationOutcome,
  NewAction,
  ActionLogEntry,
  NewTropeDictionaryEntry,
  TropeDictionaryEntry,
  FeedbackContext,
} from './types.js';

export interface Repository {
  getHousehold(): Household | null;
  createHousehold(h: NewHousehold): Household;
  setOnboarded(): void;

  createUser(u: NewUser): User;
  listUsers(): User[];
  updateUser(id: string, patch: UserPatch): User;
  removeUser(id: string): void;

  upsertPreference(p: NewPreference): void;
  getPreferences(userId: string): Preference[];
  upsertConstraint(c: NewConstraint): void;
  getConstraints(userId: string): Constraint[];
  getSuppressions(userId: string): Suppression[];
  addSuppression(s: NewSuppression): Suppression;

  upsertTitle(t: NewTitle): Title;
  findTitle(source: TitleSource, sourceId: string): Title | null;
  searchCachedTitles(query: string): Title[];
  setTropes(titleId: string, tropes: string[]): void;

  createWatchEvent(e: NewWatchEvent): WatchEvent;
  addFeedback(f: NewFeedback): Feedback;
  markFeedbackApplied(id: string): void;
  deleteWatchEvent(id: string): void;
  deleteFeedback(id: string): void;
  getWatchHistory(userId: string, range?: DateRange): WatchEntry[];
  getFeedbackContext(feedbackId: string): FeedbackContext | null;

  listTitles(mediaType?: MediaType): Title[];
  getWatchedTitleIds(userId: string): string[];
  getRecentlyDismissedTitleIds(userId: string, sinceMs: number): string[];

  addWatchlist(w: NewWatchlist): Watchlist;
  getWatchlist(userId: string, status?: WatchlistStatus): Watchlist[];

  logRecommendation(r: NewRecommendationLog): RecommendationLogEntry;
  setRecOutcome(id: string, outcome: RecommendationOutcome): void;

  pushAction(a: NewAction): ActionLogEntry;
  popLastAction(): ActionLogEntry | null;

  resolveTrope(raw: string): string | null;
  addTrope(entry: NewTropeDictionaryEntry): string;

  resolveTaxonomy(source: TitleSource, term: string): string | null;
  reverseTaxonomy(source: TitleSource, canonical: string): string[];

  restorePreferences(userId: string, snapshot: Preference[]): void;
  restoreUser(user: User): void;

  findRecentRecLogs(userId: string, titleId: string, sinceMs: number): RecommendationLogEntry[];
  getWatchEventTitleId(watchEventId: string): string | null;
}

function toJson(arr: string[] | undefined): string {
  return JSON.stringify(arr ?? []);
}
function fromJson(text: string): string[] {
  return JSON.parse(text) as string[];
}

interface TitleRow {
  id: string;
  source: TitleSource;
  source_id: string;
  title: string;
  original_title: string | null;
  year: number | null;
  media_type: Title['media_type'];
  runtime: number | null;
  age_rating: string | null;
  synopsis: string | null;
  poster_url: string | null;
  external_rating: number | null;
  genres: string;
  themes: string;
  tropes: string;
  tropes_extracted_at: number | null;
  cached_at: number;
  last_refreshed_at: number;
}
function decodeTitle(row: TitleRow): Title {
  return { ...row, genres: fromJson(row.genres), themes: fromJson(row.themes), tropes: fromJson(row.tropes) };
}

export function createRepository(db: RecommenderDb): Repository {
  return {
    getHousehold(): Household | null {
      return (db.prepare(`SELECT * FROM household LIMIT 1`).get() as Household | undefined) ?? null;
    },

    createHousehold(h: NewHousehold): Household {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO household (id, timezone, language, onboarded, created_at)
        VALUES (?, ?, ?, 0, ?)
      `).run(id, h.timezone, h.language, Date.now());
      return db.prepare(`SELECT * FROM household WHERE id = ?`).get(id) as Household;
    },

    setOnboarded(): void {
      db.prepare(`UPDATE household SET onboarded = 1`).run();
    },

    createUser(u: NewUser): User {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO user
          (id, household_id, name, birth_date, age_static, age_recorded_at, include_in_recommendations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        u.household_id,
        u.name,
        u.birth_date ?? null,
        u.age_static ?? null,
        u.age_recorded_at ?? null,
        u.include_in_recommendations ?? 1,
        Date.now(),
      );
      return db.prepare(`SELECT * FROM user WHERE id = ?`).get(id) as User;
    },

    listUsers(): User[] {
      return db.prepare(`SELECT * FROM user ORDER BY created_at ASC`).all() as User[];
    },

    updateUser(id: string, patch: UserPatch): User {
      const current = db.prepare(`SELECT * FROM user WHERE id = ?`).get(id) as User | undefined;
      if (!current) throw new Error(`User not found: ${id}`);
      const next: User = { ...current, ...patch };
      db.prepare(`
        UPDATE user
        SET name = ?, birth_date = ?, age_static = ?, age_recorded_at = ?, include_in_recommendations = ?
        WHERE id = ?
      `).run(next.name, next.birth_date, next.age_static, next.age_recorded_at, next.include_in_recommendations, id);
      return db.prepare(`SELECT * FROM user WHERE id = ?`).get(id) as User;
    },

    removeUser(id: string): void {
      db.prepare(`DELETE FROM user WHERE id = ?`).run(id);
    },

    upsertPreference(p: NewPreference): void {
      db.prepare(`
        INSERT INTO user_preference (id, user_id, dimension, value, weight, origin, updated_at, age_at_signal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, dimension, value)
        DO UPDATE SET weight = excluded.weight, origin = excluded.origin, updated_at = excluded.updated_at,
                      age_at_signal = excluded.age_at_signal
      `).run(randomUUID(), p.user_id, p.dimension, p.value, p.weight, p.origin, Date.now(), p.age_at_signal ?? null);
    },

    getPreferences(userId: string): Preference[] {
      return db.prepare(`SELECT * FROM user_preference WHERE user_id = ?`).all(userId) as Preference[];
    },

    upsertConstraint(c: NewConstraint): void {
      db.prepare(`
        INSERT INTO user_constraint (id, user_id, type, value, active, origin, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, type, value)
        DO UPDATE SET active = excluded.active, origin = excluded.origin
      `).run(randomUUID(), c.user_id, c.type, c.value, c.active ?? 1, c.origin, Date.now());
    },

    getConstraints(userId: string): Constraint[] {
      return db.prepare(`SELECT * FROM user_constraint WHERE user_id = ?`).all(userId) as Constraint[];
    },

    getSuppressions(userId: string): Suppression[] {
      return db.prepare(`SELECT * FROM suppression WHERE user_id = ?`).all(userId) as Suppression[];
    },

    addSuppression(s: NewSuppression): Suppression {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO suppression (id, user_id, scope, value, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, s.user_id, s.scope, s.value, s.reason, Date.now());
      return db.prepare(`SELECT * FROM suppression WHERE id = ?`).get(id) as Suppression;
    },

    upsertTitle(t: NewTitle): Title {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO title
          (id, source, source_id, title, original_title, year, media_type, runtime, age_rating,
           synopsis, poster_url, external_rating, genres, themes, tropes, cached_at, last_refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_id) DO UPDATE SET
          title = excluded.title,
          original_title = excluded.original_title,
          year = excluded.year,
          media_type = excluded.media_type,
          runtime = excluded.runtime,
          age_rating = excluded.age_rating,
          synopsis = excluded.synopsis,
          poster_url = excluded.poster_url,
          external_rating = excluded.external_rating,
          genres = excluded.genres,
          themes = excluded.themes,
          tropes = excluded.tropes,
          last_refreshed_at = excluded.last_refreshed_at
      `).run(
        id,
        t.source,
        t.source_id,
        t.title,
        t.original_title ?? null,
        t.year ?? null,
        t.media_type,
        t.runtime ?? null,
        t.age_rating ?? null,
        t.synopsis ?? null,
        t.poster_url ?? null,
        t.external_rating ?? null,
        toJson(t.genres),
        toJson(t.themes),
        toJson(t.tropes),
        now,
        now,
      );
      const row = db.prepare(`SELECT * FROM title WHERE source = ? AND source_id = ?`).get(t.source, t.source_id) as TitleRow;
      return decodeTitle(row);
    },

    findTitle(source: TitleSource, sourceId: string): Title | null {
      const row = db.prepare(`SELECT * FROM title WHERE source = ? AND source_id = ?`).get(source, sourceId) as
        | TitleRow
        | undefined;
      return row ? decodeTitle(row) : null;
    },

    searchCachedTitles(query: string): Title[] {
      const rows = db
        .prepare(`SELECT * FROM title WHERE title LIKE ? OR original_title LIKE ?`)
        .all(`%${query}%`, `%${query}%`) as TitleRow[];
      return rows.map(decodeTitle);
    },

    setTropes(titleId: string, tropes: string[]): void {
      db.prepare(`UPDATE title SET tropes = ?, tropes_extracted_at = ? WHERE id = ?`).run(
        toJson(tropes),
        Date.now(),
        titleId,
      );
    },

    createWatchEvent(e: NewWatchEvent): WatchEvent {
      const id = randomUUID();
      const now = Date.now();
      const watchedAt = e.watched_at ?? new Date(now).toISOString().slice(0, 10);
      db.prepare(`
        INSERT INTO watch_event (id, title_id, watched_at, created_at)
        VALUES (?, ?, ?, ?)
      `).run(id, e.title_id, watchedAt, now);

      const insertViewer = db.prepare(`
        INSERT INTO watch_event_viewer (watch_event_id, user_id, age_at_watch)
        VALUES (?, ?, ?)
      `);
      for (const viewer of e.viewers) {
        insertViewer.run(id, viewer.user_id, viewer.age_at_watch);
      }

      return { id, title_id: e.title_id, watched_at: watchedAt, created_at: now, viewers: e.viewers };
    },

    addFeedback(f: NewFeedback): Feedback {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO feedback
          (id, watch_event_id, user_id, rating, abandoned, tags, review_text, applied_to_profile, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
      `).run(id, f.watch_event_id, f.user_id, f.rating, f.abandoned ?? 0, toJson(f.tags), f.review_text ?? null, now);
      const row = db.prepare(`SELECT * FROM feedback WHERE id = ?`).get(id) as Feedback & { tags: string };
      return { ...row, tags: fromJson(row.tags) };
    },

    markFeedbackApplied(id: string): void {
      db.prepare(`UPDATE feedback SET applied_to_profile = 1 WHERE id = ?`).run(id);
    },

    deleteWatchEvent(id: string): void {
      db.prepare(`DELETE FROM watch_event_viewer WHERE watch_event_id = ?`).run(id);
      db.prepare(`DELETE FROM watch_event WHERE id = ?`).run(id);
    },

    deleteFeedback(id: string): void {
      db.prepare(`DELETE FROM feedback WHERE id = ?`).run(id);
    },

    getWatchHistory(userId: string, range?: DateRange): WatchEntry[] {
      const rows = db
        .prepare(`
          SELECT
            wev.watch_event_id AS watch_event_id,
            we.title_id        AS title_id,
            t.title             AS title,
            we.watched_at       AS watched_at,
            wev.age_at_watch    AS age_at_watch
          FROM watch_event_viewer wev
          JOIN watch_event we ON we.id = wev.watch_event_id
          JOIN title t ON t.id = we.title_id
          WHERE wev.user_id = ?
            AND (? IS NULL OR we.watched_at >= ?)
            AND (? IS NULL OR we.watched_at <= ?)
          ORDER BY we.watched_at ASC
        `)
        .all(userId, range?.from ?? null, range?.from ?? null, range?.to ?? null, range?.to ?? null) as Array<
        Omit<WatchEntry, 'feedback'>
      >;

      const getFeedback = db.prepare(`
        SELECT * FROM feedback WHERE watch_event_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1
      `);
      return rows.map((row) => {
        const fb = getFeedback.get(row.watch_event_id, userId) as (Feedback & { tags: string }) | undefined;
        return { ...row, feedback: fb ? { ...fb, tags: fromJson(fb.tags) } : null };
      });
    },

    getFeedbackContext(feedbackId: string): FeedbackContext | null {
      const row = db
        .prepare(`
          SELECT f.*, we.title_id AS context_title_id, wev.age_at_watch AS context_age_at_watch
          FROM feedback f
          JOIN watch_event we ON we.id = f.watch_event_id
          JOIN watch_event_viewer wev ON wev.watch_event_id = we.id AND wev.user_id = f.user_id
          WHERE f.id = ?
        `)
        .get(feedbackId) as
        | (Feedback & { tags: string; context_title_id: string; context_age_at_watch: number })
        | undefined;
      if (!row) return null;

      const { context_title_id, context_age_at_watch, ...feedbackRow } = row;
      const titleRow = db.prepare(`SELECT * FROM title WHERE id = ?`).get(context_title_id) as TitleRow;
      return {
        feedback: { ...feedbackRow, tags: fromJson(feedbackRow.tags) },
        title: decodeTitle(titleRow),
        age_at_watch: context_age_at_watch,
      };
    },

    listTitles(mediaType?: MediaType): Title[] {
      const rows = mediaType
        ? (db.prepare(`SELECT * FROM title WHERE media_type = ?`).all(mediaType) as TitleRow[])
        : (db.prepare(`SELECT * FROM title`).all() as TitleRow[]);
      return rows.map(decodeTitle);
    },

    getWatchedTitleIds(userId: string): string[] {
      const rows = db
        .prepare(
          `SELECT DISTINCT we.title_id FROM watch_event we
           JOIN watch_event_viewer wev ON wev.watch_event_id = we.id
           WHERE wev.user_id = ?`,
        )
        .all(userId) as Array<{ title_id: string }>;
      return rows.map((r) => r.title_id);
    },

    getRecentlyDismissedTitleIds(userId: string, sinceMs: number): string[] {
      const rows = db
        .prepare(
          `SELECT DISTINCT title_id FROM recommendation_log
           WHERE user_id = ? AND outcome = 'dismissed' AND shown_at >= ?`,
        )
        .all(userId, sinceMs) as Array<{ title_id: string }>;
      return rows.map((r) => r.title_id);
    },

    addWatchlist(w: NewWatchlist): Watchlist {
      const id = randomUUID();
      db.prepare(`
        INSERT INTO watchlist (id, user_id, title_id, status, added_from, added_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, w.user_id, w.title_id, w.status, w.added_from, Date.now());
      return db.prepare(`SELECT * FROM watchlist WHERE id = ?`).get(id) as Watchlist;
    },

    getWatchlist(userId: string, status?: WatchlistStatus): Watchlist[] {
      if (status) {
        return db
          .prepare(`SELECT * FROM watchlist WHERE user_id = ? AND status = ? ORDER BY added_at DESC`)
          .all(userId, status) as Watchlist[];
      }
      return db.prepare(`SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC`).all(userId) as Watchlist[];
    },

    logRecommendation(r: NewRecommendationLog): RecommendationLogEntry {
      const id = randomUUID();
      const shownAt = r.shown_at ?? Date.now();
      db.prepare(`
        INSERT INTO recommendation_log
          (id, user_id, viewer_ids, title_id, context, match_score, match_reasons, shown_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(id, r.user_id ?? null, toJson(r.viewer_ids), r.title_id, r.context ?? null, r.match_score, toJson(r.match_reasons), shownAt);
      const row = db.prepare(`SELECT * FROM recommendation_log WHERE id = ?`).get(id) as RecommendationLogEntry & {
        viewer_ids: string;
        match_reasons: string;
      };
      return { ...row, viewer_ids: fromJson(row.viewer_ids), match_reasons: fromJson(row.match_reasons) };
    },

    setRecOutcome(id: string, outcome: RecommendationOutcome): void {
      db.prepare(`UPDATE recommendation_log SET outcome = ? WHERE id = ?`).run(outcome, id);
    },

    pushAction(a: NewAction): ActionLogEntry {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(`
        INSERT INTO action_log (id, action_type, entity_ref, previous_state, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, a.action_type, a.entity_ref, JSON.stringify(a.previous_state), now);
      return { id, action_type: a.action_type, entity_ref: a.entity_ref, previous_state: a.previous_state, created_at: now };
    },

    popLastAction(): ActionLogEntry | null {
      const row = db.prepare(`SELECT * FROM action_log ORDER BY created_at DESC LIMIT 1`).get() as
        | (ActionLogEntry & { previous_state: string })
        | undefined;
      if (!row) return null;
      db.prepare(`DELETE FROM action_log WHERE id = ?`).run(row.id);
      return { ...row, previous_state: JSON.parse(row.previous_state) };
    },

    resolveTrope(raw: string): string | null {
      const lower = raw.toLowerCase();
      const rows = db.prepare(`SELECT * FROM trope_dictionary`).all() as Array<TropeDictionaryEntry & { aliases: string }>;
      for (const row of rows) {
        if (row.canonical_id.toLowerCase() === lower) return row.canonical_id;
        if (row.label_ru.toLowerCase() === lower) return row.canonical_id;
        if (row.label_en.toLowerCase() === lower) return row.canonical_id;
        if (fromJson(row.aliases).some((alias) => alias.toLowerCase() === lower)) return row.canonical_id;
      }
      return null;
    },

    addTrope(entry: NewTropeDictionaryEntry): string {
      db.prepare(`
        INSERT INTO trope_dictionary (id, canonical_id, label_ru, label_en, aliases, category)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_id) DO NOTHING
      `).run(randomUUID(), entry.canonical_id, entry.label_ru, entry.label_en, toJson(entry.aliases), entry.category ?? null);
      return entry.canonical_id;
    },

    resolveTaxonomy(source: TitleSource, term: string): string | null {
      const row = db
        .prepare(`SELECT canonical_value FROM taxonomy_map WHERE source = ? AND source_term = ?`)
        .get(source, term) as { canonical_value: string } | undefined;
      return row?.canonical_value ?? null;
    },

    reverseTaxonomy(source: TitleSource, canonical: string): string[] {
      const rows = db
        .prepare(`SELECT source_term FROM taxonomy_map WHERE source = ? AND canonical_value = ?`)
        .all(source, canonical) as Array<{ source_term: string }>;
      return rows.map((r) => r.source_term);
    },

    restorePreferences(userId: string, snapshot: Preference[]): void {
      const snapshotKeys = new Set(snapshot.map((p) => `${p.dimension}:${p.value}`));
      const current = db.prepare(`SELECT * FROM user_preference WHERE user_id = ?`).all(userId) as Preference[];
      for (const p of current) {
        if (!snapshotKeys.has(`${p.dimension}:${p.value}`)) {
          db.prepare(`DELETE FROM user_preference WHERE user_id = ? AND dimension = ? AND value = ?`)
            .run(userId, p.dimension, p.value);
        }
      }
      for (const p of snapshot) {
        db.prepare(`
          INSERT INTO user_preference (id, user_id, dimension, value, weight, origin, updated_at, age_at_signal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, dimension, value)
          DO UPDATE SET weight = excluded.weight, origin = excluded.origin, updated_at = excluded.updated_at,
                        age_at_signal = excluded.age_at_signal
        `).run(randomUUID(), p.user_id, p.dimension, p.value, p.weight, p.origin, p.updated_at, p.age_at_signal ?? null);
      }
    },

    restoreUser(user: User): void {
      db.prepare(`
        INSERT OR IGNORE INTO user
          (id, household_id, name, birth_date, age_static, age_recorded_at, include_in_recommendations, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(user.id, user.household_id, user.name, user.birth_date, user.age_static, user.age_recorded_at, user.include_in_recommendations, user.created_at);
    },

    findRecentRecLogs(userId: string, titleId: string, sinceMs: number): RecommendationLogEntry[] {
      const rows = db
        .prepare(`
          SELECT * FROM recommendation_log
          WHERE user_id = ? AND title_id = ? AND shown_at >= ? AND outcome IS NULL
          ORDER BY shown_at DESC
        `)
        .all(userId, titleId, sinceMs) as Array<RecommendationLogEntry & { viewer_ids: string; match_reasons: string }>;
      return rows.map((r) => ({ ...r, viewer_ids: fromJson(r.viewer_ids), match_reasons: fromJson(r.match_reasons) }));
    },

    getWatchEventTitleId(watchEventId: string): string | null {
      const row = db.prepare(`SELECT title_id FROM watch_event WHERE id = ?`).get(watchEventId) as { title_id: string } | undefined;
      return row?.title_id ?? null;
    },
  };
}
