import Database from 'better-sqlite3';

export type RecommenderDb = Database.Database;

// Separate from src/memory/sqlite.ts's session store (DB_PATH) — this DB is
// never touched by session compaction/archival.
export function createRecommenderDb(
  path: string = process.env['RECOMMENDER_DB_PATH'] ?? 'recommender.db',
): RecommenderDb {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

export function migrate(db: RecommenderDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS household (
      id          TEXT    PRIMARY KEY NOT NULL,
      timezone    TEXT    NOT NULL,
      language    TEXT    NOT NULL,
      onboarded   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user (
      id                          TEXT    PRIMARY KEY NOT NULL,
      household_id                TEXT    NOT NULL REFERENCES household(id),
      name                        TEXT    NOT NULL,
      birth_date                  TEXT,
      age_static                  INTEGER,
      age_recorded_at             TEXT,
      include_in_recommendations  INTEGER NOT NULL DEFAULT 1,
      created_at                  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_household ON user (household_id);

    CREATE TABLE IF NOT EXISTS user_preference (
      id          TEXT    PRIMARY KEY NOT NULL,
      user_id     TEXT    NOT NULL REFERENCES user(id),
      dimension   TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      weight      REAL    NOT NULL,
      origin      TEXT    NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(user_id, dimension, value)
    );
    CREATE INDEX IF NOT EXISTS idx_user_preference_user ON user_preference (user_id, dimension);

    CREATE TABLE IF NOT EXISTS user_constraint (
      id          TEXT    PRIMARY KEY NOT NULL,
      user_id     TEXT    NOT NULL REFERENCES user(id),
      type        TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      origin      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(user_id, type, value)
    );
    CREATE INDEX IF NOT EXISTS idx_user_constraint_user ON user_constraint (user_id, active);

    CREATE TABLE IF NOT EXISTS title (
      id                  TEXT    PRIMARY KEY NOT NULL,
      source              TEXT    NOT NULL,
      source_id           TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      original_title      TEXT,
      year                INTEGER,
      media_type          TEXT    NOT NULL,
      runtime             INTEGER,
      age_rating          TEXT,
      synopsis            TEXT,
      poster_url          TEXT,
      external_rating     REAL,
      genres              TEXT    NOT NULL DEFAULT '[]',
      themes              TEXT    NOT NULL DEFAULT '[]',
      tropes              TEXT    NOT NULL DEFAULT '[]',
      tropes_extracted_at INTEGER,
      cached_at           INTEGER NOT NULL,
      last_refreshed_at   INTEGER NOT NULL,
      UNIQUE(source, source_id)
    );

    CREATE TABLE IF NOT EXISTS trope_dictionary (
      id            TEXT PRIMARY KEY NOT NULL,
      canonical_id  TEXT NOT NULL UNIQUE,
      label_ru      TEXT NOT NULL,
      label_en      TEXT NOT NULL,
      aliases       TEXT NOT NULL DEFAULT '[]',
      category      TEXT
    );

    CREATE TABLE IF NOT EXISTS taxonomy_map (
      source          TEXT NOT NULL,
      source_term     TEXT NOT NULL,
      canonical_value TEXT NOT NULL,
      PRIMARY KEY (source, source_term)
    );

    CREATE TABLE IF NOT EXISTS watch_event (
      id          TEXT    PRIMARY KEY NOT NULL,
      title_id    TEXT    NOT NULL REFERENCES title(id),
      watched_at  TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_event_viewer (
      watch_event_id  TEXT    NOT NULL REFERENCES watch_event(id),
      user_id         TEXT    NOT NULL REFERENCES user(id),
      age_at_watch    INTEGER NOT NULL,
      PRIMARY KEY (watch_event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_watch_event_viewer_user ON watch_event_viewer (user_id);

    CREATE TABLE IF NOT EXISTS feedback (
      id                  TEXT    PRIMARY KEY NOT NULL,
      watch_event_id      TEXT    NOT NULL REFERENCES watch_event(id),
      user_id             TEXT    NOT NULL REFERENCES user(id),
      rating              TEXT    NOT NULL,
      abandoned           INTEGER NOT NULL DEFAULT 0,
      tags                TEXT    NOT NULL DEFAULT '[]',
      review_text         TEXT,
      applied_to_profile  INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_watch_event ON feedback (watch_event_id);

    CREATE TABLE IF NOT EXISTS watchlist (
      id          TEXT    PRIMARY KEY NOT NULL,
      user_id     TEXT    NOT NULL REFERENCES user(id),
      title_id    TEXT    NOT NULL REFERENCES title(id),
      status      TEXT    NOT NULL,
      added_from  TEXT    NOT NULL,
      added_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist (user_id, status);

    CREATE TABLE IF NOT EXISTS suppression (
      id          TEXT    PRIMARY KEY NOT NULL,
      user_id     TEXT    NOT NULL REFERENCES user(id),
      scope       TEXT    NOT NULL,
      value       TEXT    NOT NULL,
      reason      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suppression_user ON suppression (user_id);

    CREATE TABLE IF NOT EXISTS recommendation_log (
      id            TEXT    PRIMARY KEY NOT NULL,
      user_id       TEXT,
      viewer_ids    TEXT    NOT NULL DEFAULT '[]',
      title_id      TEXT    NOT NULL REFERENCES title(id),
      context       TEXT,
      match_score   REAL    NOT NULL,
      match_reasons TEXT    NOT NULL DEFAULT '[]',
      shown_at      INTEGER NOT NULL,
      outcome       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_recommendation_log_user ON recommendation_log (user_id, shown_at);

    CREATE TABLE IF NOT EXISTS action_log (
      id              TEXT    PRIMARY KEY NOT NULL,
      action_type     TEXT    NOT NULL,
      entity_ref      TEXT    NOT NULL,
      previous_state  TEXT    NOT NULL,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log (created_at);
  `);
}
