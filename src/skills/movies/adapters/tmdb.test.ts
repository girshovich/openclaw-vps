import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmdbAdapter } from './tmdb.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('TmdbAdapter.search normalizes a movie result (genres are resolved at getDetails time, not search time)', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return jsonResponse({
      results: [
        {
          id: 603,
          title: 'The Matrix',
          original_title: 'The Matrix',
          release_date: '1999-03-30',
          overview: 'A hacker discovers reality is a simulation.',
          poster_path: '/poster.jpg',
          vote_average: 8.2,
          genre_ids: [28, 878],
        },
      ],
    });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre: () => null, fetchImpl });

  const results = await adapter.search('matrix', { mediaType: 'movie' });
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.sourceId, '603');
  assert.equal(r.title, 'The Matrix');
  assert.equal(r.year, 1999);
  assert.equal(r.posterUrl, 'https://image.tmdb.org/t/p/w500/poster.jpg');
  assert.deepEqual(r.genres, []);
  assert.ok(calls[0]!.includes('/search/movie'));
  assert.ok(calls[0]!.includes('api_key=test-key'));
});

test('TmdbAdapter.search uses /search/multi when no media type is given and maps tv→series, dropping person', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse({
      results: [
        { id: 1, media_type: 'movie', title: 'A Movie', release_date: '2010-01-01' },
        { id: 2, media_type: 'tv', name: 'A Series', first_air_date: '2023-01-01' },
        { id: 3, media_type: 'person', name: 'Some Actor' },
      ],
    });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre: () => null, fetchImpl });

  const results = await adapter.search('one piece');
  assert.ok(requestedUrl.includes('/search/multi'), 'no media type must use multi-search');
  assert.equal(results.length, 2, 'person results must be dropped');
  assert.equal(results.find((x) => x.sourceId === '1')!.mediaType, 'movie');
  assert.equal(results.find((x) => x.sourceId === '2')!.mediaType, 'series');
});

test('TmdbAdapter.search forwards language and release year to the TMDB query', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse({ results: [] });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre: () => null, fetchImpl });

  await adapter.search('назад в будущее 2', { mediaType: 'movie', language: 'ru', year: 1989 });
  assert.ok(requestedUrl.includes('language=ru-RU'), 'household language must be forwarded as ru-RU');
  assert.ok(requestedUrl.includes('primary_release_year=1989'), 'year must be forwarded for a movie search');
});

test('TmdbAdapter.getDetails normalizes genres, runtime, and US certification for a movie', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      id: 603,
      title: 'The Matrix',
      original_title: 'The Matrix',
      release_date: '1999-03-30',
      runtime: 136,
      overview: 'A hacker discovers reality is a simulation.',
      poster_path: '/poster.jpg',
      vote_average: 8.2,
      genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
    })) as unknown as typeof fetch;
  const resolveGenre = (term: string) =>
    term === 'Action' ? 'genre:action' : term === 'Science Fiction' ? 'genre:scifi' : null;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre, fetchImpl });

  const detail = await adapter.getDetails('603');
  assert.deepEqual(detail.genres, ['genre:action', 'genre:scifi']);
  assert.equal(detail.runtimeMin, 136);
  assert.equal(detail.ageRating, '16+');
  assert.equal(detail.mediaType, 'movie');
});

test('TmdbAdapter.getDetails falls back to /tv when /movie 404s, normalizing series fields', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    calls += 1;
    if (String(url).includes('/movie/')) return jsonResponse({}, 404);
    return jsonResponse({
      id: 1399,
      name: 'Game of Thrones',
      original_name: 'Game of Thrones',
      first_air_date: '2011-04-17',
      episode_run_time: [60],
      overview: '...',
      poster_path: '/got.jpg',
      vote_average: 8.4,
      genres: [{ id: 18, name: 'Drama' }],
      content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] },
    });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({
    apiKey: 'test-key',
    resolveGenre: (term) => (term === 'Drama' ? 'genre:drama' : null),
    fetchImpl,
  });

  const detail = await adapter.getDetails('1399');
  assert.equal(detail.mediaType, 'series');
  assert.equal(detail.title, 'Game of Thrones');
  assert.equal(detail.ageRating, '18+');
  assert.equal(detail.runtimeMin, 60);
  assert.equal(calls, 2);
});

test('TmdbAdapter.discover sends with_genres (canonical→id) and runtime ceiling, normalizing results', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse({
      results: [
        { id: 603, title: 'The Matrix', release_date: '1999-03-30', vote_average: 8.2, poster_path: '/p.jpg' },
      ],
    });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre: () => null, fetchImpl });

  const results = await adapter.discover!({ genres: ['Action'], runtimeMaxMin: 90, limit: 5 });
  assert.ok(requestedUrl.includes('/discover/movie'));
  assert.ok(requestedUrl.includes('with_genres=28'), 'Action must map to TMDB id 28');
  assert.ok(requestedUrl.includes('with_runtime.lte=90'), 'runtime ceiling must be sent');
  assert.equal(results.length, 1);
  assert.equal(results[0]!.sourceId, '603');
  assert.equal(results[0]!.title, 'The Matrix');
});

test('TmdbAdapter retries once on 429 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, 429);
    return jsonResponse({ results: [{ id: 1, title: 'OK', release_date: '2020-01-01' }] });
  }) as unknown as typeof fetch;
  const adapter = createTmdbAdapter({ apiKey: 'test-key', resolveGenre: () => null, fetchImpl });

  const results = await adapter.search('whatever', { mediaType: 'movie' });
  assert.equal(calls, 2, 'must retry exactly once after a 429');
  assert.equal(results[0]!.title, 'OK');
});

test('TmdbAdapter throws a clear setup error when no API key is available', async () => {
  const original = process.env['TMDB_API_KEY'];
  delete process.env['TMDB_API_KEY'];
  try {
    const adapter = createTmdbAdapter({
      resolveGenre: () => null,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    await assert.rejects(() => adapter.search('matrix'), /TMDB_API_KEY/);
  } finally {
    if (original !== undefined) process.env['TMDB_API_KEY'] = original;
  }
});
