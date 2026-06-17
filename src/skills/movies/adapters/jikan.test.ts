import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJikanAdapter } from './jikan.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('JikanAdapter.search normalizes an anime result, splitting canonical values into genres vs themes', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      data: [
        {
          mal_id: 1,
          title: 'Cowboy Bebop',
          title_english: 'Cowboy Bebop',
          duration: '24 min per ep',
          rating: 'R - 17+ (violence & profanity)',
          score: 8.75,
          synopsis: 'A bounty hunting crew chases criminals across the solar system.',
          images: { jpg: { image_url: 'https://example.com/poster.jpg' } },
          aired: { prop: { from: { year: 1998 } } },
          genres: [{ name: 'Action' }],
          themes: [{ name: 'Adult Cast' }],
        },
      ],
    })) as unknown as typeof fetch;
  const resolveGenre = (term: string) =>
    term === 'Action' ? 'genre:action' : term === 'Adult Cast' ? 'theme:adult_cast' : null;
  const adapter = createJikanAdapter({ resolveGenre, fetchImpl });

  const results = await adapter.search('cowboy bebop');
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.sourceId, '1');
  assert.equal(r.mediaType, 'anime');
  assert.equal(r.runtimeMin, 24);
  assert.equal(r.ageRating, '16+');
  assert.equal(r.year, 1998);
  assert.deepEqual(r.genres, ['genre:action']);
  assert.deepEqual(r.themes, ['theme:adult_cast']);
});

test('JikanAdapter.getDetails fetches the /full endpoint and normalizes a single anime', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse({
      data: {
        mal_id: 1,
        title: 'Cowboy Bebop',
        duration: '24 min per ep',
        rating: 'PG-13 - Teens 13 or older',
        score: 8.75,
        synopsis: '...',
        images: { jpg: { image_url: 'https://example.com/poster.jpg' } },
        aired: { prop: { from: { year: 1998 } } },
        genres: [],
        themes: [],
      },
    });
  }) as unknown as typeof fetch;
  const adapter = createJikanAdapter({ resolveGenre: () => null, fetchImpl });

  const detail = await adapter.getDetails('1');
  assert.equal(detail.ageRating, '12+');
  assert.ok(requestedUrl.includes('/anime/1/full'));
});

test('JikanAdapter.discover sends genre ids and order_by=score, normalizing results', async () => {
  let requestedUrl = '';
  const fetchImpl = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return jsonResponse({
      data: [
        { mal_id: 1, title: 'Cowboy Bebop', score: 8.75, genres: [{ name: 'Action' }], themes: [] },
      ],
    });
  }) as unknown as typeof fetch;
  const adapter = createJikanAdapter({ resolveGenre: (t) => (t === 'Action' ? 'genre:action' : null), fetchImpl });

  const results = await adapter.discover!({ genres: ['Action'], limit: 5 });
  assert.ok(requestedUrl.includes('genres=1'), 'Action must map to Jikan genre id 1');
  assert.ok(requestedUrl.includes('order_by=score'));
  assert.equal(results.length, 1);
  assert.equal(results[0]!.sourceId, '1');
  assert.deepEqual(results[0]!.genres, ['genre:action']);
});

test('JikanAdapter retries once on 429 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({}, 429);
    return jsonResponse({ data: [{ mal_id: 9, title: 'OK', genres: [], themes: [] }] });
  }) as unknown as typeof fetch;
  const adapter = createJikanAdapter({ resolveGenre: () => null, fetchImpl });

  const results = await adapter.search('whatever');
  assert.equal(calls, 2, 'must retry exactly once after a 429');
  assert.equal(results[0]!.title, 'OK');
});

test('JikanAdapter normalizes a movie-length duration ("1 hr 53 min")', async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      data: [
        {
          mal_id: 2,
          title: 'A Silent Voice',
          duration: '1 hr 50 min',
          rating: 'PG-13 - Teens 13 or older',
          aired: { prop: { from: { year: 2016 } } },
          genres: [],
          themes: [],
        },
      ],
    })) as unknown as typeof fetch;
  const adapter = createJikanAdapter({ resolveGenre: () => null, fetchImpl });

  const results = await adapter.search('a silent voice');
  assert.equal(results[0]!.runtimeMin, 110);
});
