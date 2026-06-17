# Implementation plan — movies skill title-logging fixes

Context: when a user reports titles a viewer "watched and loved", the movies skill
records them as watch events with `rating: loved`. The intent is correct, but the
resolution and commit path produce wrong/junk titles silently. This plan covers
fixes #1–#5. Scope is `src/skills/movies/`. Cost-cap changes (#6) are already done.

Conventions to follow:
- TypeScript, ESM (`.js` import suffixes), match existing style.
- Every step lists a verification. Run `pnpm typecheck` and `pnpm test` after each item.
- Add/extend `*.test.ts` next to the file you change; do not weaken existing tests.
- Keep changes surgical (see CLAUDE.md). No speculative config or abstractions.

Touch points discovered during analysis:
- `catalog.ts` `resolveTitle` — takes `found[0]` blindly, defaults media type to movie,
  no language/year, fabricates a `manual` stub on zero results, checks `searchCachedTitles` first.
- `adapters/tmdb.ts` `search` — hits `/search/movie` unless `mediaType === 'series'`;
  sends no `language` or `year` param.
- `index.ts` `manage_taste` (`set_preferences`) — loops `loved_titles`, resolves each,
  creates watch event + `loved` feedback. No range expansion, no confirmation.
- `index.ts` `undo_last` + `repo.popLastAction` — undo exists but is not surfaced;
  a new session does not know it can undo prior-session actions.

---

## Item 1 — Title resolution accuracy

Goal: the right title is resolved for `"One Piece от Netflix"` (a 2023 series),
`"Назад в Будущее 2"`, `"Как приручить дракона"`, etc. — not clip reels, specials,
wrong sequels, or untranslated stubs.

### 1a. Search both movies and series
- In `adapters/tmdb.ts`, add a `searchMulti` path (TMDB `/search/multi`) or run
  `/search/movie` and `/search/tv` and merge. `/search/multi` returns a `media_type`
  per result — map `movie`→`movie`, `tv`→`series`; drop `person`.
- In `catalog.ts` `resolveTitle`, stop forcing movie. When `mediaType` is not given,
  use multi-search so series are reachable.
- Verify: a test where the top movie hit and a series hit both exist resolves to the
  series when the query names a series (mock adapter returning both).

### 1b. Pass user language and original text
- Thread household language into resolution. `repo.getHousehold()` has `language`
  (default `ru`). Pass it from `index.ts` callers into `resolveTitle(query, { mediaType?, language? })`,
  then into the adapter as TMDB `language=ru-RU` (map `ru`→`ru-RU`).
- In the `index.ts` system prompt fragment, forbid the model from translating titles —
  it must pass the user's original-language string. (The bad `"How to Tame the Dragon?"`
  came from model-side translation.)
- Verify: adapter test asserts `language` is forwarded to the TMDB query params.

### 1c. Use year / sequel / platform cues
- Accept an optional `year` on `resolveTitle` and forward TMDB `primary_release_year`
  (movies) / `first_air_date_year` (series).
- Extract a 4-digit year from the query if present, and have the model pass `year`
  when the user gives one ("One Piece 2023"). Update the `log_watch` / `set_preferences`
  tool params to accept an optional `year` per title if needed.
- Verify: test that `"Назад в Будущее 2" + year 1989` resolves to Part II, not a special.

### 1d. Rank candidates and filter non-films
- In `catalog.ts`, after fetching results, rank by: exact/normalized title match first,
  then `popularity`/`vote_count` desc. Do not just take index 0.
- Filter out compilation/clip/special entries for a "watched a film" intent — drop
  results whose title matches `/greatest moments|behind.the.scenes|special presentation|clip|compilation/i`
  unless the user query itself contains those words.
- Fetch `getDetails` for the top N (e.g. 3) so candidates carry year + poster for Item 2.
- Verify: test with a "Greatest Moments" decoy ranked first asserts the canonical film wins.

### 1e. Stop fabricating junk stubs on a watched+loved log
- Today zero results → `repo.upsertTitle({ source: 'manual', ... })` with no metadata,
  which is then logged as loved and learned from (no features → no learning).
- Change: on zero results, do NOT auto-create a stub-and-log. Return a "could not
  resolve" outcome so the caller (Item 2) asks the user instead. If a stub is ever
  created, mark it low-confidence and exclude it from `learningService.applyFeedback`.
- Verify: test that an unresolvable query does not create a watch event or feedback.

---

## Item 2 — Confirm before committing

Goal: resolve the whole batch, show the user `Title (year)` (+ poster when available),
and only write watch events + feedback after explicit confirmation. Wrong matches are
caught before they hit the DB.

- Split `set_preferences` (and `log_watch` for multi-title) into resolve → confirm → commit:
  1. Resolve all titles, classify each as `confident` / `ambiguous` / `unresolved`.
  2. Return a structured preview (no DB writes for the watch events yet): resolved name,
     year, media type, and `alternatives` for ambiguous ones.
  3. The agent presents the list and asks "записать эти? / поправить?" Commit happens
     on the next turn after the user confirms (or sends corrections).
- Note free-text preferences (`profileService.setPreferences`) can still be applied
  immediately — only the *watch + loved* writes need the gate, since those are the
  records that were corrupted.
- Keep it terse in the prompt fragment: show the list, one confirm step, offer inline fixes.
  No multi-paragraph apologies.
- Verify: test that `set_preferences` with `loved_titles` returns a preview and creates
  no watch events until a confirm/commit call is made. Update existing test
  "auto-logs them as watched+loved" to reflect the confirm step.

---

## Item 3 — Franchise / numbered-series expansion (preferences path)

Goal: `"Star Wars 1-9"` / `"all parts"` / `"seasons 1-3"` expands to the real
installments instead of one wrong clip-reel match.

- The prompt already tells the model to emit one `log_watch` per installment, but only
  for `log_watch`. Apply the same expansion to the watched+loved path used by
  `set_preferences`, OR route multi-installment watches through `log_watch` so the
  existing per-installment logic is reused.
- Detect ranges in the title/loved_titles ("1-9", "1–9", "episodes 1 to 9", "all parts",
  "seasons 1-3"). For a numbered franchise, resolve the franchise then enumerate the
  installments (TMDB collection / per-episode entries) rather than logging one title.
- This feeds Item 2: the expanded list is part of the confirmation preview.
- Verify: test that "Star Wars 1-9" yields 9 resolved installments in the preview.

---

## Item 4 — Stop the cache from making errors sticky

Goal: a wrong resolution must not be returned forever, and a user correction must fix it.

- `resolveTitle` returns `searchCachedTitles(query)[0]` first. Once `"Star Wars (1-9)"`
  → "Greatest Moments" is cached, every future resolution of that string repeats it.
- Changes:
  - Do not cache low-confidence / stub matches as the answer for a raw query.
  - When the user corrects a match (Item 2), overwrite/repoint the cache entry to the
    confirmed title so the correction sticks.
  - Prefer keying cache on resolved identity (`source:source_id`), not the raw query
    string, so unrelated queries can't collide on a bad row.
- Verify: test that after a correction, re-resolving the same query returns the corrected
  title; and that a stub match is not served from cache on the next call.

---

## Item 5 — Undo discoverability + cross-session continuity

Goal: undo is one tap, and a session started with `/new` knows it can undo the previous
session's last action (the image-6 "I have no tool to edit" dead end must be impossible).

- Surface undo: after any committed watch/feedback/viewer write, include an inline
  "↩️ Undo" affordance in the response (button or a clear `undo` shortcut documented in
  the prompt fragment). `undo_last` already exists in `index.ts`.
- Cross-session: `popLastAction` reads from `action_log`. Confirm the action log is
  household-scoped (not session-scoped) so a fresh session's `undo_last` reverts the
  prior session's action. If it is session-scoped, change it to household-scoped (or
  expose the last action to the new session).
- Persist a short "last action" summary the agent can always read, and update the prompt
  so the agent never claims it lacks an edit/undo tool — it must call `undo_last`.
- Verify: test that `undo_last` in a new session reverts a watch event logged in a
  previous session of the same household.

---

## Suggested order
1 → 2 → 4 → 3 → 5. Item 1 makes matches correct; Item 2 makes them confirmable and is
the safety net; Item 4 prevents regressions from sticking; Item 3 and 5 are additive.
Run `pnpm typecheck && pnpm test` after each item; keep all 142 existing tests green.
