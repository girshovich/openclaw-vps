import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createCatalogService } from './catalog.js';
import type { SourceAdapter, NormalizedTitle } from './adapters/types.js';
import type { TropeService } from './trope-service.js';
import type { Title } from './types.js';

let db: RecommenderDb;
let repo: Repository;

beforeEach(() => {
  db = createRecommenderDb(':memory:');
  repo = createRepository(db);
});

function stubAdapter(source: 'tmdb' | 'jikan', titles: NormalizedTitle[]): SourceAdapter {
  return {
    source,
    async search() {
      return titles;
    },
    async getDetails(sourceId: string) {
      const found = titles.find((t) => t.sourceId === sourceId);
      if (!found) throw new Error(`not found: ${sourceId}`);
      return found;
    },
  };
}

test('resolveTitle hits the adapter and upserts on a cache miss', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: '603', title: 'The Matrix', mediaType: 'movie', genres: ['genre:action'], themes: [] },
  ]);
  const jikan = stubAdapter('jikan', []);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  const result = await catalog.resolveTitle('matrix');
  assert.equal(result.match!.title, 'The Matrix');
  assert.equal(result.match!.source, 'tmdb');
  assert.equal(result.alternatives.length, 0);
});

test('resolveTitle is cache-first: a repeat query skips the adapter and does not duplicate the title row', async () => {
  let searchCalls = 0;
  const tmdb: SourceAdapter = {
    source: 'tmdb',
    async search() {
      searchCalls += 1;
      return [{ source: 'tmdb', sourceId: '603', title: 'The Matrix', mediaType: 'movie', genres: [], themes: [] }];
    },
    async getDetails(sourceId: string) {
      return { source: 'tmdb', sourceId, title: 'The Matrix', mediaType: 'movie', genres: [], themes: [] };
    },
  };
  const jikan = stubAdapter('jikan', []);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  await catalog.resolveTitle('matrix');
  await catalog.resolveTitle('matrix');

  assert.equal(searchCalls, 1);
  const count = db.prepare(`SELECT COUNT(*) as c FROM title`).get() as { c: number };
  assert.equal(count.c, 1);
});

test('resolveTitle routes mediaType=anime to the jikan adapter', async () => {
  const tmdb = stubAdapter('tmdb', []);
  const jikan = stubAdapter('jikan', [
    { source: 'jikan', sourceId: '1', title: 'Cowboy Bebop', mediaType: 'anime', genres: ['genre:action'], themes: [] },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  const result = await catalog.resolveTitle('cowboy bebop', { mediaType: 'anime' });
  assert.equal(result.match!.source, 'jikan');
  assert.equal(result.match!.title, 'Cowboy Bebop');
});

test('resolveTitle returns alternatives for ambiguous queries', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: '1', title: 'Aladdin', year: 1992, mediaType: 'movie', genres: [], themes: [] },
    { source: 'tmdb', sourceId: '2', title: 'Aladdin', year: 2019, mediaType: 'movie', genres: [], themes: [] },
  ]);
  const jikan = stubAdapter('jikan', []);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  const result = await catalog.resolveTitle('aladdin');
  assert.equal(result.match!.year, 1992);
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0]!.year, 2019);
});

test('resolveTitle falls back to Jikan when TMDB returns nothing', async () => {
  const tmdb = stubAdapter('tmdb', []);
  const jikan = stubAdapter('jikan', [
    { source: 'jikan', sourceId: '1', title: 'Spirited Away', mediaType: 'anime', genres: [], themes: [] },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  const result = await catalog.resolveTitle('spirited away');
  assert.equal(result.match!.source, 'jikan');
  assert.equal(result.match!.title, 'Spirited Away');
});

// ── C3: TropeService injection fires extraction on real source hits ────────────

test('C3: resolveTitle calls tropeService.extract after a real source hit with synopsis', async () => {
  const extracted: Title[] = [];
  const stubTrope: TropeService = {
    async extract(title) { extracted.push(title); return []; },
  };
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: '1', title: 'With Synopsis', mediaType: 'movie', genres: [], themes: [], synopsis: 'A story.' },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) }, { tropeService: stubTrope });

  const result = await catalog.resolveTitle('with synopsis');
  // Wait a tick for fire-and-forget
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(extracted.some((t) => t.id === result.match!.id), 'extract must be called for a title with synopsis');
});

test('C3: resolveTitle does not call tropeService.extract for manual stubs (no synopsis)', async () => {
  const extracted: Title[] = [];
  const stubTrope: TropeService = {
    async extract(title) { extracted.push(title); return []; },
  };
  const catalog = createCatalogService(
    repo,
    { tmdb: stubAdapter('tmdb', []), jikan: stubAdapter('jikan', []) },
    { tropeService: stubTrope },
  );

  await catalog.resolveTitle('Stub Movie With No Source');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(extracted.length, 0, 'extract must not be called for manual stubs');
});

test('C3: resolveTitle does not call tropeService.extract when tropes_extracted_at is already set', async () => {
  const extracted: Title[] = [];
  const stubTrope: TropeService = {
    async extract(title) { extracted.push(title); return []; },
  };
  // Pre-seed a title with tropes_extracted_at set
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: '42', title: 'Already Extracted', mediaType: 'movie', genres: [], themes: [], synopsis: 'Synopsis.' },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) }, { tropeService: stubTrope });

  // First call — sets tropes_extracted_at via extract (fire-and-forget)
  await catalog.resolveTitle('Already Extracted');
  await new Promise((r) => setTimeout(r, 10));
  // Manually stamp tropes_extracted_at in DB to simulate completed extraction
  db.prepare(`UPDATE title SET tropes_extracted_at = ? WHERE source_id = '42'`).run(Date.now());
  extracted.length = 0;

  // Second call — cache hit, no extract needed; but even if adapter called, extraction skipped
  await catalog.resolveTitle('Already Extracted');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(extracted.length, 0, 'extract must not be called when tropes_extracted_at is already set');
});

// ── Item 1: resolution accuracy ────────────────────────────────────────────────

test('Item 1a: a series query resolves to the series even when a movie hit also exists', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: 'm1', title: 'One Piece Film: Red', year: 2022, mediaType: 'movie', genres: [], themes: [], popularity: 500 },
    { source: 'tmdb', sourceId: 's1', title: 'One Piece', year: 2023, mediaType: 'series', genres: [], themes: [], popularity: 50 },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) });

  const result = await catalog.resolveTitle('One Piece');
  assert.equal(result.match!.media_type, 'series', 'exact-title series must outrank a non-matching movie hit');
  assert.equal(result.match!.title, 'One Piece');
});

test('Item 1c: a year disambiguates a numbered sequel from a same-named special', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: 'sp', title: 'Назад в будущее 2', year: 2015, mediaType: 'movie', genres: [], themes: [], popularity: 900 },
    { source: 'tmdb', sourceId: 'p2', title: 'Назад в будущее 2', year: 1989, mediaType: 'movie', genres: [], themes: [], popularity: 10 },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) });

  const result = await catalog.resolveTitle('Назад в Будущее 2', { year: 1989 });
  assert.equal(result.match!.year, 1989, 'year must win over a more popular same-named entry');
});

test('Item 1d: a "Greatest Moments" decoy ranked first is filtered so the canonical film wins', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: 'clip', title: 'Star Wars: Greatest Moments', year: 2010, mediaType: 'movie', genres: [], themes: [], popularity: 9999 },
    { source: 'tmdb', sourceId: 'sw', title: 'Star Wars', year: 1977, mediaType: 'movie', genres: [], themes: [], popularity: 100 },
  ]);
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) });

  const result = await catalog.resolveTitle('Star Wars');
  assert.equal(result.match!.title, 'Star Wars');
  assert.equal(result.match!.year, 1977);
});

test('Item 4: an explicit year bypasses a stale cached match and re-resolves correctly', async () => {
  const tmdb: SourceAdapter = {
    source: 'tmdb',
    async search(_q, opts) {
      return opts?.year === 1977
        ? [{ source: 'tmdb', sourceId: 'sw-1977', title: 'Star Wars', year: 1977, mediaType: 'movie', genres: [], themes: [] }]
        : [{ source: 'tmdb', sourceId: 'sw-bad', title: 'Star Wars', year: 2000, mediaType: 'movie', genres: [], themes: [] }];
    },
    async getDetails(id) {
      return id === 'sw-1977'
        ? { source: 'tmdb', sourceId: 'sw-1977', title: 'Star Wars', year: 1977, mediaType: 'movie', genres: [], themes: [] }
        : { source: 'tmdb', sourceId: 'sw-bad', title: 'Star Wars', year: 2000, mediaType: 'movie', genres: [], themes: [] };
    },
  };
  const catalog = createCatalogService(repo, { tmdb, jikan: stubAdapter('jikan', []) });

  const first = await catalog.resolveTitle('Star Wars');
  assert.equal(first.match!.year, 2000, 'the wrong match gets cached on a bare query');

  const corrected = await catalog.resolveTitle('Star Wars', { year: 1977 });
  assert.equal(corrected.match!.year, 1977, 'an explicit year must bypass the stale cache and re-resolve');
});

test('Item 1e: resolveTitle returns unresolved (no stub) when both adapters return nothing', async () => {
  const catalog = createCatalogService(repo, {
    tmdb: stubAdapter('tmdb', []),
    jikan: stubAdapter('jikan', []),
  });

  const result = await catalog.resolveTitle('Советский мультфильм про зайца');
  assert.equal(result.status, 'unresolved');
  assert.equal(result.match, null);
  assert.equal(result.alternatives.length, 0);

  // No junk stub row was written to the catalog.
  const count = db.prepare(`SELECT COUNT(*) as c FROM title`).get() as { c: number };
  assert.equal(count.c, 0);

  // A second call is still unresolved — a stub is never served from cache.
  const result2 = await catalog.resolveTitle('Советский мультфильм про зайца');
  assert.equal(result2.status, 'unresolved');
  assert.equal(result2.match, null);
});
