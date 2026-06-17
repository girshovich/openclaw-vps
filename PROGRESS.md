# Movies Skill — Build Progress Ledger

**Durable source of truth for the build.** Each `/loop` iteration reads this first, does the next unchecked phase, runs that phase's tests, commits, and ticks the box. Survives auto-compaction because progress lives here + in git, not in conversation context.

- Spec (what): `movie_recommender_skill.md`
- Plan (how): `implement-skills-movie.md`

## Current state
- **Active phase:** Phase 6
- **Last commit:** `037de1c` — Phase 5: recommendation engine (gen→filter→score)
- **Notes / blockers:** _(none)_

## Phases
- [x] **Phase 0** — Discover host; write `INTEGRATION_NOTES.md` (five hooks w/ file:line)
- [x] **Phase 0.5** — Skill framework: contract + registry + activator + stub skill
- [x] **Phase 1** — Persistence in separate `recommender.db`; Repository; seed dictionaries
- [x] **Phase 2** — Source adapters (TMDB, Jikan) + CatalogService
- [x] **Phase 3** — Trope extraction + dictionary mapping
- [x] **Phase 4** — Profile & learning (weights, feedback, decay)
- [x] **Phase 5** — Recommendation engine (gen→filter→score)
- [ ] **Phase 6** — Tools layer (~8 tools) + register skill with activator
- [ ] **Phase 7** — Presentation (text-only renderers + NL rating parse)
- [ ] **Phase 8** — End-to-end: 13 flows + acceptance criteria + README
- [ ] **Phase 9** — (deferred) Buttons & posters: gateway protocol extension

## Log
_(append one line per completed phase: date · phase · commit hash · one-line outcome)_
- 2026-06-16 · Phase 0 · `b3a81b8` · Wrote INTEGRATION_NOTES.md documenting five host hooks (tools.ts, llm/index.ts, telegram/index.ts, memory/sqlite.ts, runtime/index.ts) with verified file:line refs.
- 2026-06-16 · Phase 0.5 · `2821a3f` · Added `src/skills/{types,registry,activator}.ts` (Skill contract, registry, sticky+additive activator), wired into `src/runtime/index.ts` turn assembly (tools + prompt fragment + tool dispatch), added `npm test` (node:test via tsx) and 4 passing tests against a stub skill fixture.
- 2026-06-16 · Phase 1 · `4127188` · Added `src/skills/movies/{types,db,seed,repository}.ts`: separate `recommender.db` (14 tables incl. household/user/preference/constraint/title/trope_dictionary/taxonomy_map/watch_event(+viewer)/feedback/watchlist/suppression/recommendation_log/action_log), sync `Repository` (24 methods), seed of 30 tropes + tmdb/jikan taxonomy map. 18 passing `node:test` cases incl. CRUD round-trips, unique-constraint dedup, age-frozen-at-watch, and recommender.db isolation from the session store.
- 2026-06-16 · Phase 2 · `e5e4e11` · Added `src/skills/movies/adapters/{types,age-rating,tmdb,jikan}.ts` (`SourceAdapter`/`NormalizedTitle` boundary types, TMDB adapter w/ movie→tv 404 fallback for series + US certification normalization, Jikan adapter w/ genre/theme split by canonical prefix), `src/skills/movies/catalog.ts` (`CatalogService.resolveTitle`: cache-first via `searchCachedTitles`, else adapter search→getDetails→upsert, ambiguous results returned as alternatives), plus `Repository.resolveTaxonomy` (needed by adapters to map source genre/tag terms to canonical ids) and `TMDB_API_KEY` in `.env.example`. 12 new passing `node:test` cases (fixture-mocked `fetch`, no new deps) covering normalization, the movie/tv fallback, missing-API-key error, cache-first dedup, and anime routing.
- 2026-06-16 · Phase 3 · `4dd323d` · Added `src/skills/movies/trope-service.ts`: `TropeService.extract(title, reviewSnippets?)` prompts the LLM (default `simpleChat`+`CLASSIFY_MODEL`, injectable `callLlm` for tests) for a JSON list of `{phrase, confidence}`, resolves each via `Repository.resolveTrope` first, and only creates a new `trope_dictionary` entry (via slugified canonical id) when unmapped AND high-confidence — low-confidence unmapped phrases are dropped, never persisted raw (spec §6.6). Added `Repository.setTropes` (persists mapped ids + stamps `tropes_extracted_at`). 5 new passing `node:test` cases incl. known-phrase resolution, new high-confidence dictionary entry creation, low-confidence drop (with proof no non-`trope:`-prefixed string is ever stored), and graceful empty-result handling on invalid LLM JSON.
- 2026-06-17 · Phase 5 · `037de1c` · Added `src/skills/movies/recommendation-service.ts`: `RecommendationService.recommend(viewerIds, opts?)` pulls candidates from the cached title store (§6.1; adapters have no bulk-discover endpoint, cache accumulates via log_watch flows), applies §6.2 hard filters (youngest-viewer age ceiling, max_runtime/exclude_trope/theme/trigger constraints, trope/genre/theme/title suppressions, exclude_seen union across all viewers, recent dismissals), scores by §6.3 (Σ effectiveWeight×multiplier: tropes:3 > themes:2 > genres:1.5 > source_type:1, + external_rating bonus), merges joint profile via `Math.min` across all viewer weights (intersection of positives / union of negatives per spec §6.3), normalizes scores to 0-100, logs every shown candidate to `recommendation_log`, returns top N with `match_reasons`. Added `Repository.listTitles`, `getWatchedTitleIds`, `getRecentlyDismissedTitleIds`. 14 new tests (63 total) covering all filter types, ranking, joint-watch ceiling, match_reasons, and logging.
- 2026-06-16 · Phase 4 · `72a2cd5` · Added `src/skills/movies/profile-service.ts` (`ProfileService.setPreferences(userId, freeText, lovedTitles?)` — LLM extracts `{preferences[], constraints[]}` from NL via injectable `callLlm`, validates dimension/type enums, clamps weights to [-1,1], upserts with `origin='manual'`; `summary(userId)` — pure formatting, no LLM, renders liked features + active constraints) and `src/skills/movies/learning-service.ts` (`LearningService.applyFeedback(feedbackId)` — reads title features + `age_at_watch` via new `Repository.getFeedbackContext`, applies §6.4 weight deltas: loved +0.3 / disliked -0.3 / ok no-op / abandoned -0.6 (-0.8 for tropes, the most salient signal), guarded by `applied_to_profile` for idempotency, and turns any `trigger:`-prefixed feedback tag into a `user_constraint`). Added `user_preference.age_at_signal` column (the viewer's `age_at_watch` when a feedback-driven weight was last set; null for manual/onboarding prefs) and `src/skills/movies/decay.ts` (`effectiveWeight(pref, currentAge)` — read-time exponential decay (0.85/year) per spec §6.5, no-op when `age_at_signal` is null). 18 new passing `node:test` cases covering weight direction/magnitude for loved/disliked/abandoned, idempotency, trigger-tag→constraint, decay monotonicity, and LLM-extraction edge cases (malformed JSON, out-of-range weights, unknown dimensions).
