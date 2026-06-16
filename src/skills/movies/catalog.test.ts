import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommenderDb } from './db.js';
import type { RecommenderDb } from './db.js';
import { createRepository } from './repository.js';
import type { Repository } from './repository.js';
import { createCatalogService } from './catalog.js';
import type { SourceAdapter, NormalizedTitle } from './adapters/types.js';

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
  assert.equal(result.match.title, 'The Matrix');
  assert.equal(result.match.source, 'tmdb');
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
  assert.equal(result.match.source, 'jikan');
  assert.equal(result.match.title, 'Cowboy Bebop');
});

test('resolveTitle returns alternatives for ambiguous queries and throws when nothing is found', async () => {
  const tmdb = stubAdapter('tmdb', [
    { source: 'tmdb', sourceId: '1', title: 'Aladdin', year: 1992, mediaType: 'movie', genres: [], themes: [] },
    { source: 'tmdb', sourceId: '2', title: 'Aladdin', year: 2019, mediaType: 'movie', genres: [], themes: [] },
  ]);
  const jikan = stubAdapter('jikan', []);
  const catalog = createCatalogService(repo, { tmdb, jikan });

  const result = await catalog.resolveTitle('aladdin');
  assert.equal(result.match.year, 1992);
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0]!.year, 2019);

  const emptyCatalog = createCatalogService(repo, { tmdb: stubAdapter('tmdb', []), jikan });
  await assert.rejects(() => emptyCatalog.resolveTitle('not a real movie title xyz'), /No results found/);
});
