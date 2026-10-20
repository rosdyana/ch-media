// src/cache.js against a fake Redis client (injected as the last argument), so
// no Redis is needed.
const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/config');
const cache = require('../src/cache');

const realTtl = cfg.TRANSCRIPT_CACHE_TTL_SEC;
afterEach(() => {
  cfg.TRANSCRIPT_CACHE_TTL_SEC = realTtl;
});

function fakeRedis() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    exists: async (k) => (store.has(k) ? 1 : 0),
    get: async (k) => store.get(k) ?? null,
    set: async (k, v, ...rest) => {
      calls.push(['set', k, ...rest]);
      store.set(k, v);
    },
    del: async (k) => void store.delete(k),
  };
}

const brokenRedis = new Proxy({}, { get: () => async () => { throw new Error('redis down'); } });

test('defaults to a one-year TTL', () => {
  assert.strictEqual(realTtl, 365 * 24 * 60 * 60);
});

test('round-trips a result under a per-video key with the configured expiry', async () => {
  const redis = fakeRedis();
  cfg.TRANSCRIPT_CACHE_TTL_SEC = 1234;
  const result = { url: 'u', text: 'hello', meta: { videoId: 'abc' } };

  assert.strictEqual(await cache.hasCachedTranscript('abc', redis), false);
  await cache.setCachedTranscript('abc', result, redis);
  assert.deepStrictEqual(redis.calls, [['set', 'ch-media:yt-cache:abc', 'EX', 1234]]);
  assert.strictEqual(await cache.hasCachedTranscript('abc', redis), true);
  assert.deepStrictEqual(await cache.getCachedTranscript('abc', redis), result);

  await cache.deleteCachedTranscript('abc', redis);
  assert.strictEqual(await cache.hasCachedTranscript('abc', redis), false);
  assert.strictEqual(await cache.getCachedTranscript('abc', redis), null);
});

test('TRANSCRIPT_CACHE_TTL_SEC <= 0 turns the cache off', async () => {
  for (const ttl of [0, -1]) {
    cfg.TRANSCRIPT_CACHE_TTL_SEC = ttl;
    const redis = fakeRedis();
    await cache.setCachedTranscript('abc', { text: 'x' }, redis);
    assert.strictEqual(redis.store.size, 0);
    redis.store.set('ch-media:yt-cache:abc', JSON.stringify({ text: 'x' }));
    assert.strictEqual(await cache.hasCachedTranscript('abc', redis), false);
    assert.strictEqual(await cache.getCachedTranscript('abc', redis), null);
  }
});

test('a Redis failure degrades to a miss / skipped write instead of throwing', async () => {
  assert.strictEqual(await cache.hasCachedTranscript('abc', brokenRedis), false);
  assert.strictEqual(await cache.getCachedTranscript('abc', brokenRedis), null);
  await cache.setCachedTranscript('abc', { text: 'x' }, brokenRedis);
  await cache.deleteCachedTranscript('abc', brokenRedis);
});

test('a corrupt cached value reads as a miss', async () => {
  const redis = fakeRedis();
  redis.store.set('ch-media:yt-cache:abc', '{not json');
  assert.strictEqual(await cache.getCachedTranscript('abc', redis), null);
});
