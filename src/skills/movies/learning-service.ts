import type { Repository } from './repository.js';
import type { FeedbackRating, PreferenceDimension } from './types.js';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// Spec §6.4: loved/disliked move weights; abandoned is a stronger negative
// than disliked and pushes tropes (the most salient signal) further still.
function deltaFor(rating: FeedbackRating, abandoned: boolean, dimension: PreferenceDimension): number | null {
  if (abandoned) return dimension === 'trope' ? -0.8 : -0.6;
  switch (rating) {
    case 'loved':
      return 0.3;
    case 'disliked':
      return -0.3;
    case 'ok':
      return null;
  }
}

export interface LearningService {
  applyFeedback(feedbackId: string): void;
}

export function createLearningService(repo: Repository): LearningService {
  return {
    applyFeedback(feedbackId: string): void {
      const context = repo.getFeedbackContext(feedbackId);
      if (!context) return;
      const { feedback, title, age_at_watch } = context;
      if (feedback.applied_to_profile) return;

      const features: Array<{ dimension: PreferenceDimension; value: string }> = [
        ...title.genres.map((value) => ({ dimension: 'genre' as const, value })),
        ...title.themes.map((value) => ({ dimension: 'theme' as const, value })),
        ...title.tropes.map((value) => ({ dimension: 'trope' as const, value })),
        { dimension: 'source_type' as const, value: `source_type:${title.media_type}` },
      ];

      const existing = new Map(repo.getPreferences(feedback.user_id).map((p) => [`${p.dimension}:${p.value}`, p.weight]));

      for (const { dimension, value } of features) {
        const delta = deltaFor(feedback.rating, feedback.abandoned === 1, dimension);
        if (delta === null) continue;
        const current = existing.get(`${dimension}:${value}`) ?? 0;
        const newWeight = clamp(current + delta, -1, 1);
        existing.set(`${dimension}:${value}`, newWeight);
        repo.upsertPreference({
          user_id: feedback.user_id,
          dimension,
          value,
          weight: newWeight,
          origin: 'feedback',
          age_at_signal: age_at_watch,
        });
      }

      for (const tag of feedback.tags) {
        if (tag.startsWith('trigger:')) {
          repo.upsertConstraint({ user_id: feedback.user_id, type: 'trigger', value: tag, origin: 'feedback' });
        } else if (tag === 'too_long') {
          if (title.runtime !== null) {
            repo.upsertConstraint({
              user_id: feedback.user_id,
              type: 'max_runtime',
              value: `max_runtime:${Math.max(30, title.runtime - 15)}`,
              origin: 'feedback',
            });
          }
        } else if (tag === 'too_scary') {
          const scaryFeatures: Array<{ dimension: PreferenceDimension; value: string }> = [
            ...title.themes.map((value) => ({ dimension: 'theme' as const, value })),
            ...title.tropes.map((value) => ({ dimension: 'trope' as const, value })),
          ];
          for (const { dimension, value } of scaryFeatures) {
            const current = existing.get(`${dimension}:${value}`) ?? 0;
            repo.upsertPreference({
              user_id: feedback.user_id,
              dimension,
              value,
              weight: clamp(current - 0.3, -1, 1),
              origin: 'feedback',
              age_at_signal: age_at_watch,
            });
          }
        } else if (tag === 'boring') {
          for (const value of title.tropes) {
            const current = existing.get(`trope:${value}`) ?? 0;
            repo.upsertPreference({
              user_id: feedback.user_id,
              dimension: 'trope',
              value,
              weight: clamp(current - 0.3, -1, 1),
              origin: 'feedback',
              age_at_signal: age_at_watch,
            });
          }
        }
      }

      repo.markFeedbackApplied(feedback.id);
    },
  };
}
