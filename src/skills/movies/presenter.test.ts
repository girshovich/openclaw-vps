import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRecommendationCard,
  renderRecommendationCards,
  renderFavoritesList,
  renderHistoryList,
  renderProfile,
} from './presenter.js';
import type { RecCard, FavoriteEntry, HistoryEntry } from './presenter.js';

const card: RecCard = {
  title: 'Кунг-фу Панда',
  year: 2008,
  runtime: 92,
  age_rating: 'PG',
  external_rating: 7.6,
  source: 'tmdb',
  match_score: 87,
  match_reasons: ['trope:underdog_hero', 'genre:animation', 'theme:friendship'],
  synopsis: 'История панды, ставшей кунг-фу мастером.',
};

test('renderRecommendationCard includes title, year, source, score', () => {
  const out = renderRecommendationCard(1, card);
  assert.ok(out.includes('Кунг-фу Панда'));
  assert.ok(out.includes('2008'));
  assert.ok(out.includes('TMDB'));
  assert.ok(out.includes('87%'));
  assert.ok(out.includes('🎬 1.'));
});

test('renderRecommendationCard strips trope prefix in reasons', () => {
  const out = renderRecommendationCard(1, card);
  assert.ok(out.includes('underdog hero'));
  assert.ok(!out.includes('trope:'));
});

test('renderRecommendationCard includes synopsis truncated to 120 chars', () => {
  const longCard: RecCard = { ...card, synopsis: 'A'.repeat(200) };
  const out = renderRecommendationCard(1, longCard);
  assert.ok(out.includes('A'.repeat(120)));
  assert.ok(!out.includes('A'.repeat(121)));
});

test('renderRecommendationCard without optional fields omits them', () => {
  const minimal: RecCard = { title: 'X', source: 'jikan', match_score: 50, match_reasons: [] };
  const out = renderRecommendationCard(2, minimal);
  assert.ok(out.includes('2.'));
  assert.ok(!out.includes('мин'));
  assert.ok(!out.includes('⭐'));
  assert.ok(!out.includes('Почему'));
});

test('renderRecommendationCards appends rating hint', () => {
  const out = renderRecommendationCards([card]);
  assert.ok(out.includes('оцените'));
  assert.ok(out.includes('зашло'));
  assert.ok(out.includes('бросили'));
});

test('renderFavoritesList includes user name, age, and titles', () => {
  const favs: FavoriteEntry[] = [
    { title: 'Кунг-фу Панда', age_at_watch: 6, rating: 'loved', abandoned: false },
    { title: 'Тролли', age_at_watch: 5, rating: 'ok', abandoned: false },
  ];
  const out = renderFavoritesList('Тимур', 7, favs, ['trope:underdog_hero'], ['theme:horror']);
  assert.ok(out.includes('Тимур'));
  assert.ok(out.includes('сейчас 7'));
  assert.ok(out.includes('Кунг-фу Панда'));
  assert.ok(out.includes('смотрели в 6'));
  assert.ok(out.includes('👍'));
  assert.ok(out.includes('underdog hero'));
  assert.ok(out.includes('horror'));
});

test('renderFavoritesList with null age omits age string', () => {
  const out = renderFavoritesList('Тимур', null, [], [], []);
  assert.ok(!out.includes('сейчас'));
});

test('renderFavoritesList abandoned adds ✋ to emoji', () => {
  const favs: FavoriteEntry[] = [
    { title: 'X', rating: 'loved', abandoned: true },
  ];
  const out = renderFavoritesList('U', null, favs);
  assert.ok(out.includes('✋'));
});

test('renderHistoryList includes title, date, age, emoji', () => {
  const entries: HistoryEntry[] = [
    { title: 'Кунг-фу Панда', watched_at: '2025-01-15T10:00:00Z', age_at_watch: 6, rating: 'loved', abandoned: false },
  ];
  const out = renderHistoryList('Тимур', entries);
  assert.ok(out.includes('История просмотров'));
  assert.ok(out.includes('Тимур'));
  assert.ok(out.includes('Кунг-фу Панда'));
  assert.ok(out.includes('2025-01-15'));
  assert.ok(out.includes('в 6'));
  assert.ok(out.includes('👍'));
});

test('renderProfile returns name + summary', () => {
  const out = renderProfile('Тимур', 'Любит: animation. Избегает: horror.');
  assert.ok(out.includes('👤'));
  assert.ok(out.includes('Тимур'));
  assert.ok(out.includes('Любит: animation'));
});
