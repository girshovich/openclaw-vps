import type { Skill, SkillToolContext } from '../types.js';
import type { ToolCall, ToolDefinition } from '../../llm/index.js';
import { simpleChat, CLASSIFY_MODEL } from '../../llm/index.js';
import { registerSkill } from '../registry.js';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import { createCatalogService } from './catalog.js';
import type { CatalogService } from './catalog.js';
import { createProfileService } from './profile-service.js';
import { createLearningService } from './learning-service.js';
import { createRecommendationService } from './recommendation-service.js';
import { createTmdbAdapter } from './adapters/tmdb.js';
import { createJikanAdapter } from './adapters/jikan.js';
import type { User } from './types.js';

// Spec §3.2: prefer birth_date; fall back to age_static + approximate aging from age_recorded_at
function computeCurrentAge(user: User): number | null {
  if (user.birth_date) {
    const birth = new Date(user.birth_date);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const m = now.getMonth() - birth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
    return age;
  }
  if (user.age_static !== null) {
    if (!user.age_recorded_at) return user.age_static;
    return user.age_static + (new Date().getFullYear() - new Date(user.age_recorded_at).getFullYear());
  }
  return null;
}

const MOVIES_TOOLS: ToolDefinition[] = [
  {
    name: 'recommend',
    description:
      'Recommend movies or anime for one or more viewers based on their taste profiles. Returns ranked candidates with match scores.',
    parameters: {
      type: 'object',
      properties: {
        viewer_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of viewers to recommend for. One for solo, multiple for joint watch.' },
        context: { type: 'string', enum: ['evening', 'quick', 'seasonal', 'general'], description: 'Viewing context.' },
        runtime_max_min: { type: 'number', description: 'Maximum runtime in minutes (overrides stored constraint for this query only).' },
        exclude_seen: { type: 'boolean', description: 'Exclude titles the viewer has already watched. Default true.' },
        count: { type: 'number', description: 'Number of recommendations to return. Default 3.' },
      },
      required: ['viewer_ids'],
    },
  },
  {
    name: 'log_watch',
    description:
      'Record that viewers watched a title. Resolves the title by name (or source:id). Returns the watch event id.',
    parameters: {
      type: 'object',
      properties: {
        title_query: { type: 'string', description: 'Title name or partial name to resolve.' },
        viewer_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of viewers who watched.' },
        watched_at: { type: 'string', description: 'ISO date (YYYY-MM-DD) of when it was watched. Default: today.' },
      },
      required: ['title_query', 'viewer_ids'],
    },
  },
  {
    name: 'add_feedback',
    description:
      'Record a viewer\'s rating for a watched title. Updates the viewer\'s taste profile automatically.',
    parameters: {
      type: 'object',
      properties: {
        title_query: { type: 'string', description: 'Title name, partial name, or the watch_event_id (UUID) if known.' },
        viewer_id: { type: 'string', description: 'ID of the viewer giving feedback.' },
        rating: { type: 'string', enum: ['loved', 'ok', 'disliked'], description: 'Overall rating.' },
        abandoned: { type: 'boolean', description: 'True if the viewer stopped watching before the end.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Reasons: "too_long", "too_scary", "boring", or "trigger:X" to add a hard constraint.' },
        review_text: { type: 'string', description: 'Optional free-text comment.' },
      },
      required: ['title_query', 'viewer_id', 'rating'],
    },
  },
  {
    name: 'manage_viewers',
    description: 'Add, edit, list, or remove household viewers.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'edit', 'list', 'remove'], description: 'Operation to perform.' },
        user_id: { type: 'string', description: 'Required for edit and remove.' },
        name: { type: 'string', description: 'Viewer display name.' },
        birth_date: { type: 'string', description: 'Birth date as YYYY-MM-DD. Preferred over age.' },
        age: { type: 'number', description: 'Current age as a fallback when birth_date is unknown.' },
        include_in_recommendations: { type: 'boolean', description: 'Whether this viewer is included in recommendations. Adults may opt out.' },
        confirm: { type: 'boolean', description: 'Must be true to confirm a remove action.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_taste',
    description: 'Set preferences from free text, add a title to the watchlist, or suppress content.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set_preferences', 'add_to_watchlist', 'suppress'], description: 'Operation.' },
        user_id: { type: 'string', description: 'ID of the viewer whose taste to manage.' },
        free_text: { type: 'string', description: 'For set_preferences: raw NL preference statement, e.g. "Тимур теперь фанатеет от роботов".' },
        loved_titles: { type: 'array', items: { type: 'string' }, description: 'For set_preferences: known loved title names as extra seeds.' },
        title_query: { type: 'string', description: 'For add_to_watchlist: title to add.' },
        status: { type: 'string', enum: ['wishlist', 'favorite'], description: 'For add_to_watchlist: list status.' },
        added_from: { type: 'string', enum: ['recommendation', 'manual'], description: 'For add_to_watchlist: how it was added.' },
        scope: { type: 'string', enum: ['title', 'trope', 'theme', 'genre'], description: 'For suppress: what to suppress.' },
        value: { type: 'string', description: 'For suppress: the canonical value to suppress, e.g. "theme:fairies".' },
        reason: { type: 'string', enum: ['outgrown', 'seen', 'tired_of'], description: 'For suppress: reason.' },
      },
      required: ['action', 'user_id'],
    },
  },
  {
    name: 'show',
    description: 'Show the viewer\'s favorites, watch history, or taste profile.',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['favorites', 'history', 'profile'], description: 'What to show.' },
        user_id: { type: 'string', description: 'Viewer ID. Defaults to the first household member.' },
        range: { type: 'string', description: 'For history: time range, e.g. "this month", "last week".' },
      },
      required: ['view'],
    },
  },
  {
    name: 'setup',
    description: 'First-run household setup. Creates the household and all viewers from a free-text description.',
    parameters: {
      type: 'object',
      properties: {
        members_free_text: { type: 'string', description: 'Description of household members, e.g. "я Михаил 38 и сын Тимур 6".' },
        timezone: { type: 'string', description: 'IANA timezone, e.g. "Asia/Yerevan". Default "UTC".' },
        language: { type: 'string', description: 'Language code, e.g. "ru". Default "ru".' },
        recommend_for_adult: { type: 'boolean', description: 'Whether to include the adult member in recommendations.' },
      },
      required: ['members_free_text'],
    },
  },
  {
    name: 'undo_last',
    description: 'Revert the last recorded action (watched a title, gave feedback, added a viewer).',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

export interface MovieSkillDeps {
  db: RecommenderDb;
  catalogService: CatalogService;
  callLlm?: (prompt: string) => Promise<string>;
}

export function createMoviesSkill(deps: MovieSkillDeps): Skill {
  const { db, catalogService } = deps;
  const callLlm = deps.callLlm ?? (async (p: string) => (await simpleChat(p, CLASSIFY_MODEL)).text);

  const repo = createRepository(db);
  const profileService = createProfileService(repo, { callLlm });
  const learningService = createLearningService(repo);
  const recommendationService = createRecommendationService(repo);

  async function executeTool(call: ToolCall, _ctx: SkillToolContext): Promise<string> {
    const inp = call.input;

    switch (call.name) {
      // ── recommend ───────────────────────────────────────────────────────────
      case 'recommend': {
        const viewerIds = inp['viewer_ids'] as string[];
        const recContext = inp['context'] as string | undefined;
        const candidates = await recommendationService.recommend(viewerIds, {
          ...(recContext !== undefined && { context: recContext }),
          excludeSeen: (inp['exclude_seen'] as boolean | undefined) ?? true,
          limit: (inp['count'] as number | undefined) ?? 3,
          ...(inp['runtime_max_min'] !== undefined && { runtimeMaxMin: inp['runtime_max_min'] as number }),
        });
        return JSON.stringify({
          candidates: candidates.map((c) => ({
            title_id: c.title.id,
            title: c.title.title,
            year: c.title.year,
            runtime: c.title.runtime,
            age_rating: c.title.age_rating,
            external_rating: c.title.external_rating,
            media_type: c.title.media_type,
            poster_url: c.title.poster_url,
            match_score: c.match_score,
            match_reasons: c.match_reasons,
          })),
        });
      }

      // ── log_watch ────────────────────────────────────────────────────────────
      case 'log_watch': {
        const titleQuery = inp['title_query'] as string;
        const viewerIds = inp['viewer_ids'] as string[];
        const watchedAt = inp['watched_at'] as string | undefined;

        const { match, alternatives } = await catalogService.resolveTitle(titleQuery);
        const allUsers = repo.listUsers();
        const viewers = viewerIds
          .map((id) => allUsers.find((u) => u.id === id))
          .filter((u): u is User => u !== undefined);

        const event = repo.createWatchEvent({
          title_id: match.id,
          ...(watchedAt !== undefined && { watched_at: watchedAt }),
          viewers: viewers.map((u) => ({ user_id: u.id, age_at_watch: computeCurrentAge(u) ?? 0 })),
        });
        repo.pushAction({ action_type: 'watch_logged', entity_ref: `watch_event:${event.id}`, previous_state: null });

        const result: Record<string, unknown> = { watch_event_id: event.id, resolved_title: match.title };
        if (alternatives.length > 0) result['ambiguous_matches'] = alternatives.map((t) => t.title);
        return JSON.stringify(result);
      }

      // ── add_feedback ─────────────────────────────────────────────────────────
      case 'add_feedback': {
        const titleQuery = inp['title_query'] as string;
        const viewerId = inp['viewer_id'] as string;
        const rating = inp['rating'] as 'loved' | 'ok' | 'disliked';

        // Detect UUID (watch_event_id) vs title name
        let watchEventId: string;
        if (/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(titleQuery)) {
          watchEventId = titleQuery;
        } else {
          const { match } = await catalogService.resolveTitle(titleQuery);
          const history = repo.getWatchHistory(viewerId);
          const entry = [...history].reverse().find((e) => e.title_id === match.id);
          if (!entry) return JSON.stringify({ error: 'No watch event found for this title and viewer.' });
          watchEventId = entry.watch_event_id;
        }

        const fbTags = inp['tags'] as string[] | undefined;
        const fbReview = inp['review_text'] as string | undefined;
        const feedback = repo.addFeedback({
          watch_event_id: watchEventId,
          user_id: viewerId,
          rating,
          abandoned: (inp['abandoned'] as boolean | undefined) ? 1 : 0,
          ...(fbTags !== undefined && { tags: fbTags }),
          ...(fbReview !== undefined && { review_text: fbReview }),
        });
        learningService.applyFeedback(feedback.id);
        repo.pushAction({ action_type: 'feedback_added', entity_ref: `feedback:${feedback.id}`, previous_state: null });

        return JSON.stringify({ feedback_id: feedback.id, profile_updated: true });
      }

      // ── manage_viewers ───────────────────────────────────────────────────────
      case 'manage_viewers': {
        const action = inp['action'] as string;
        if (action === 'list') {
          return JSON.stringify({ users: repo.listUsers() });
        }
        if (action === 'add') {
          const household = repo.getHousehold();
          if (!household) return JSON.stringify({ error: 'Run setup first.' });
          const age = inp['age'] as number | undefined;
          const birthDate = inp['birth_date'] as string | undefined;
          const includeRec = inp['include_in_recommendations'] as boolean | undefined;
          const user = repo.createUser({
            household_id: household.id,
            name: inp['name'] as string,
            ...(birthDate !== undefined && { birth_date: birthDate }),
            ...(age !== undefined && { age_static: age }),
            ...(includeRec !== undefined && { include_in_recommendations: includeRec ? 1 : 0 }),
          });
          repo.pushAction({ action_type: 'user_added', entity_ref: `user:${user.id}`, previous_state: null });
          return JSON.stringify({ user_id: user.id, user });
        }
        if (action === 'edit') {
          const userId = inp['user_id'] as string;
          const age = inp['age'] as number | undefined;
          const birthDate = inp['birth_date'] as string | undefined;
          const includeRec = inp['include_in_recommendations'] as boolean | undefined;
          const user = repo.updateUser(userId, {
            ...(inp['name'] !== undefined && { name: inp['name'] as string }),
            ...(birthDate !== undefined && { birth_date: birthDate }),
            ...(age !== undefined && { age_static: age }),
            ...(includeRec !== undefined && { include_in_recommendations: includeRec ? 1 : 0 }),
          });
          return JSON.stringify({ user });
        }
        if (action === 'remove') {
          if (!inp['confirm']) return JSON.stringify({ error: 'Pass confirm: true to remove a viewer.' });
          const userId = inp['user_id'] as string;
          const user = repo.listUsers().find((u) => u.id === userId);
          repo.removeUser(userId);
          repo.pushAction({ action_type: 'user_removed', entity_ref: `user:${userId}`, previous_state: user ?? null });
          return JSON.stringify({ removed: true });
        }
        return JSON.stringify({ error: `Unknown action: ${action}` });
      }

      // ── manage_taste ─────────────────────────────────────────────────────────
      case 'manage_taste': {
        const action = inp['action'] as string;
        const userId = inp['user_id'] as string;
        if (action === 'set_preferences') {
          const freeText = inp['free_text'] as string | undefined;
          if (!freeText) return JSON.stringify({ error: 'free_text is required for set_preferences.' });
          const lovedTitleNames = inp['loved_titles'] as string[] | undefined;

          // Auto-log each loved title as watched + loved so history is populated immediately.
          const loggedTitles: string[] = [];
          if (lovedTitleNames && lovedTitleNames.length > 0) {
            const user = repo.listUsers().find((u) => u.id === userId);
            if (user) {
              const seenIds = new Set(repo.getWatchHistory(userId).map((e) => e.title_id));
              await Promise.allSettled(
                lovedTitleNames.map(async (name) => {
                  try {
                    const { match } = await catalogService.resolveTitle(name);
                    if (seenIds.has(match.id)) return;
                    const event = repo.createWatchEvent({
                      title_id: match.id,
                      viewers: [{ user_id: userId, age_at_watch: computeCurrentAge(user) ?? 0 }],
                    });
                    const feedback = repo.addFeedback({ watch_event_id: event.id, user_id: userId, rating: 'loved', abandoned: 0 });
                    learningService.applyFeedback(feedback.id);
                    repo.pushAction({ action_type: 'feedback_added', entity_ref: `feedback:${feedback.id}`, previous_state: null });
                    loggedTitles.push(match.title);
                  } catch { /* unresolvable title — skipped */ }
                }),
              );
            }
          }

          const extracted = await profileService.setPreferences(userId, freeText, lovedTitleNames);
          const summary = profileService.summary(userId);
          return JSON.stringify({ profile_summary: summary, extracted, logged_as_watched: loggedTitles });
        }
        if (action === 'add_to_watchlist') {
          const titleQuery = inp['title_query'] as string;
          const { match, alternatives } = await catalogService.resolveTitle(titleQuery);
          const entry = repo.addWatchlist({
            user_id: userId,
            title_id: match.id,
            status: (inp['status'] as 'wishlist' | 'favorite') ?? 'wishlist',
            added_from: (inp['added_from'] as 'recommendation' | 'manual') ?? 'manual',
          });
          const result: Record<string, unknown> = { watchlist_id: entry.id, resolved_title: match.title };
          if (alternatives.length > 0) result['ambiguous_matches'] = alternatives.map((t) => t.title);
          return JSON.stringify(result);
        }
        if (action === 'suppress') {
          repo.addSuppression({
            user_id: userId,
            scope: inp['scope'] as 'title' | 'trope' | 'theme' | 'genre',
            value: inp['value'] as string,
            reason: inp['reason'] as 'outgrown' | 'seen' | 'tired_of',
          });
          return JSON.stringify({ suppressed: true });
        }
        return JSON.stringify({ error: `Unknown action: ${action}` });
      }

      // ── show ─────────────────────────────────────────────────────────────────
      case 'show': {
        const view = inp['view'] as string;
        const userId = (inp['user_id'] as string | undefined) ?? repo.listUsers()[0]?.id;
        if (!userId) return JSON.stringify({ error: 'No viewers found. Run setup first.' });

        if (view === 'profile') {
          return JSON.stringify({ profile_one_liner: profileService.summary(userId) });
        }
        if (view === 'favorites') {
          return JSON.stringify({ favorites: repo.getWatchlist(userId, 'favorite') });
        }
        if (view === 'history') {
          return JSON.stringify({ events: repo.getWatchHistory(userId) });
        }
        return JSON.stringify({ error: `Unknown view: ${view}` });
      }

      // ── setup ────────────────────────────────────────────────────────────────
      case 'setup': {
        if (repo.getHousehold()) return JSON.stringify({ error: 'Household already set up.' });

        const raw = await callLlm(
          `Parse this description of household members: "${inp['members_free_text'] as string}"\n` +
          `Return ONLY valid JSON: {"members": [{"name": string, "birth_date": string|null, "age": number|null, "self": boolean}]}\n` +
          `"birth_date": ISO date YYYY-MM-DD if any date of birth is given (convert from any format, e.g. 01.01.1986 → 1986-01-01), otherwise null.\n` +
          `"age": current age as integer only when no birth date is available, otherwise null.\n` +
          `"self": true if this member is clearly the speaker (first-person markers like "я", "мне", "меня", "I", "me"). If no member can be identified as the speaker, set "self": false for all. Output ONLY the JSON object.`,
        );
        let members: Array<{ name: string; birth_date: string | null; age: number | null; self: boolean }> = [];
        try {
          const match = /\{[\s\S]*\}/.exec(raw);
          if (match) members = (JSON.parse(match[0]) as { members: typeof members }).members ?? [];
        } catch { /* fall through with empty list */ }

        const timezone = (inp['timezone'] as string | undefined) ?? 'UTC';
        const language = (inp['language'] as string | undefined) ?? 'ru';
        const recommendForAdult = (inp['recommend_for_adult'] as boolean | undefined) ?? false;

        const noSelfDetected = members.length > 0 && !members.some((m) => m.self);

        const household = repo.createHousehold({ timezone, language });
        const created_users = members.map((m) =>
          repo.createUser({
            household_id: household.id,
            name: m.name,
            ...(m.birth_date ? { birth_date: m.birth_date } : m.age !== null ? { age_static: m.age } : {}),
            include_in_recommendations: m.self ? (recommendForAdult ? 1 : 0) : 1,
          }),
        );
        repo.setOnboarded();
        const result: Record<string, unknown> = { household, created_users };
        if (noSelfDetected) result['warning'] = 'Could not identify which member is the primary user. All members are included in recommendations. Use manage_viewers to set include_in_recommendations=false for any adult who should be excluded.';
        return JSON.stringify(result);
      }

      // ── undo_last ────────────────────────────────────────────────────────────
      case 'undo_last': {
        const action = repo.popLastAction();
        if (!action) return JSON.stringify({ reverted_action: 'nothing to undo' });

        const [, entityId] = action.entity_ref.split(':') as [string, string];
        if (action.action_type === 'watch_logged') {
          repo.deleteWatchEvent(entityId);
        } else if (action.action_type === 'feedback_added') {
          repo.deleteFeedback(entityId);
        } else if (action.action_type === 'user_added') {
          repo.removeUser(entityId);
        }
        return JSON.stringify({ reverted_action: action.entity_ref });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${call.name}` });
    }
  }

  return {
    name: 'movies',
    description:
      'Подбор фильмов и аниме для семьи, запись просмотров, оценки и ревью, избранное и вишлист, профили вкуса детей с учётом возраста. Всё про "что посмотреть", "смотрели", "понравилось/не зашло", "добавь в избранное", "чем занять ребёнка".',
    examples: [
      'что посмотреть',
      'фильм',
      'аниме',
      'кино',
      'смотр',
      'избран',
      'movie',
      'anime',
    ],
    tools: MOVIES_TOOLS,
    executeTool,
    systemPromptFragment: [
      'Use movies skill tools whenever the user mentions films, anime, ratings, recommendations, or watch history.',
      'If no viewers are configured (manage_viewers action=list returns empty), ask for household members names and ages first, then call setup. Do not recommend before setup is complete.',
      '',
      '== Logging watched / liked titles ==',
      'When the user names specific titles they liked or watched — ALWAYS extract those titles into the loved_titles array. NEVER bury title names inside free_text — they will not be recorded as watch history.',
      'Split mixed messages: titles → loved_titles, qualitative statements and constraints → free_text.',
      'Example: "сыну нравятся Звёздные Войны, One Piece, боится страшного"',
      '→ set_preferences(user_id=..., loved_titles=["Звёздные Войны", "One Piece"], free_text="боится страшного")',
      'NOT: set_preferences(user_id=..., free_text="сыну нравятся Звёздные Войны, One Piece, боится страшного")',
      '',
      'Use set_preferences when the user is describing general taste (with or without named titles as examples).',
      'Use log_watch + add_feedback(rating=loved) when recording a specific watch event (user says they just watched something, or gives an explicit rating).',
      'For franchises or numbered series ("episodes 1–9", "all parts", "seasons 1–3") — emit one log_watch call per installment in a single response. They execute in parallel so latency is the same as one call.',
      '',
      '== Recommendation card format ==',
      '🎬 1. Title (year) · age rating · XX min · ⭐N.N · SOURCE',
      'Short description (up to 120 chars)',
      'Why: match N% — ✓tag ✓tag',
      '',
      'After showing cards add a hint: (rate: "1 loved it", "2 it was ok", "dropped 1")',
      'User rating shortcuts (accept in any language):',
      '  "1 loved" / "1 зашло" / "1 понравилось" → add_feedback(rating=loved)',
      '  "2 ok" / "2 так себе" / "2 нормально" → add_feedback(rating=ok)',
      '  "3 disliked" / "3 не зашло" → add_feedback(rating=disliked)',
      '  "dropped 2" / "бросили 2" → add_feedback(rating=disliked, abandoned=true)',
      '  "fav 1" / "в избранное 1" → manage_taste(action=add_to_watchlist, status=favorite)',
      'On a negative rating ask a follow-up: "too scary / boring / long?"',
    ].join('\n'),
    migrate() {
      // db schema already applied by createRecommenderDb at construction time
    },
  };
}

export function registerMoviesSkill(): void {
  const db = createRecommenderDb();
  const repo = createRepository(db);
  const tmdbApiKey = process.env['TMDB_API_KEY'];
  const tmdbAdapter = createTmdbAdapter({
    resolveGenre: (term) => repo.resolveTaxonomy('tmdb', term),
    ...(tmdbApiKey !== undefined && { apiKey: tmdbApiKey }),
  });
  const jikanAdapter = createJikanAdapter({
    resolveGenre: (term) => repo.resolveTaxonomy('jikan', term),
  });
  const catalogService = createCatalogService(repo, { tmdb: tmdbAdapter, jikan: jikanAdapter });
  registerSkill(createMoviesSkill({ db, catalogService }));
}
