# Movies Skill

Family movie and anime recommender for OpenClaw. Tracks a household's watch history, taste profiles (per viewer, age-aware), and recommendations from TMDB and Jikan/AniList.

## Required configuration

Set these environment variables (copy `.env.example` to `.env`):

```
TMDB_API_KEY=<your TMDB v3 API key>
```

TMDB key is required. Get one free at <https://developer.themoviedb.org/>. Without it the skill silently skips registration at startup.

Jikan (MyAnimeList) requires no API key — it uses the public REST endpoint at `https://api.jikan.moe/v4`.

## Database

The skill creates a separate SQLite file (`recommender.db`, sibling of the session DB). It is never merged with the session store. The schema is applied automatically on first startup via `createRecommenderDb()`.

## First-time setup

Send a message like:

> "Привет, я хочу отслеживать, что мы смотрим. Я Михаил 38, и со мной сын Тимур 6 лет."

The skill calls `setup` to create the household and viewers from free text. Onboarding completes in one step — no separate commands.

## Trope dictionary

30 child-relevant tropes are seeded automatically on first launch (see `seed.ts`). To add a new trope manually:

```ts
import { createRecommenderDb } from './src/skills/movies/db.js';
import { createRepository } from './src/skills/movies/repository.js';

const repo = createRepository(createRecommenderDb());
repo.addTrope({
  canonical_id: 'trope:chosen_one',
  label: 'chosen one',
  aliases: ['избранный', 'chosen one'],
});
```

Tropes are also extracted automatically by the LLM when a new title is cached (via `TropeService`). Only high-confidence extractions that map to an existing dictionary entry (or are new with ≥0.7 confidence) are persisted. Raw/hallucinated strings are never stored.

## Adding a new source adapter

1. Implement the `SourceAdapter` interface (`src/skills/movies/adapters/types.ts`):

```ts
interface SourceAdapter {
  search(query: string, mediaType?: MediaType): Promise<NormalizedTitle[]>;
  getDetails(sourceId: string, mediaType?: MediaType): Promise<NormalizedTitle | null>;
}
```

2. Normalize all genres/themes via `repo.resolveTaxonomy(source, term)` — never store raw source tags; always map to `genre:*` / `theme:*` canonical ids.

3. Register the adapter in `registerMoviesSkill()` inside `index.ts` and pass it to `createCatalogService`.

4. Add a `taxonomy_map` seed for your source's genre vocabulary in `seed.ts` so the resolver can map terms automatically.

## Architecture notes

- **Inline skill** — runs in the main agent turn, never as a sub-agent. Sub-agents are used only for background trope extraction over many titles.
- **Stateless tools** — all tools are stateless (args + `recommender.db` only) so OpenClaw's mid-response steering (cancel/restart) is always safe.
- **Age decay** — preference weights decay exponentially (0.85/year) relative to the age at which the signal was recorded, using `effectiveWeight()` at scoring time. Manual/onboarding preferences do not decay.
- **Joint watch** — profiles are merged via `Math.min` per feature across all viewers (intersection of positives, union of negatives). Age ceiling = youngest viewer.

## Running tests

```
npm test
```

All tests run against an in-memory SQLite database; no network calls, no API keys required.
