// HTTP-level tests for the async job endpoints (POST .../transcribe +
// GET /jobs/:id). src/queue.js is swapped for an in-memory fake via
// require.cache before src/server.js is required, so these run without a
// real Redis instance (same require.cache-swap trick as test/ffmpeg.test.js).
//
// Note: POST /youtube/search is synchronous (not queued) — it's a fast
// metadata lookup, not worth the queue round-trip — so it isn't covered here.
process.env.MEDIA_SERVICE_TOKEN = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const queuePath = require.resolve('../src/queue');
const fakeJobs = new Map();
let nextId = 1;

require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    JOB_NAMES: {
      YOUTUBE_TRANSCRIBE: 'youtube:transcribe',
      AUDIO_TRANSCRIBE: 'audio:transcribe',
    },
    enqueueJob: async (name, data) => {
      const id = String(nextId++);
      fakeJobs.set(id, {
        name,
        data,
        state: 'completed',
        returnvalue: { url: data.url, text: 'transcript' },
        timestamp: 1_000,
        processedOn: 1_500,
        finishedOn: 2_000,
      });
      return id;
    },
    // Mirrors the real one's contract: an existing id is returned as-is (deduped)
    // with its state. The failed-job replacement path is covered in queue.test.js.
    enqueueDedupedJob: async (name, data, jobId, { force = false } = {}) => {
      const existing = fakeJobs.get(jobId);
      if (existing && !(force && existing.state === 'completed')) {
        return { jobId, state: existing.state, deduped: true };
      }
      fakeJobs.set(jobId, {
        name,
        data,
        state: 'completed',
        returnvalue: { url: data.url, text: 'transcript' },
        timestamp: 1_000,
        processedOn: 1_500,
        finishedOn: 2_000,
      });
      return { jobId, state: null, deduped: false };
    },
    getJob: async (id) => {
      const job = fakeJobs.get(id);
      if (!job) return null;
      return {
        id,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        getState: async () => job.state,
      };
    },
  },
};

const app = require('../src/server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('POST /youtube/transcribe enqueues a job and returns 202', async () => {
  const res = await fetch(`${baseUrl}/youtube/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' }),
  });
  assert.strictEqual(res.status, 202);
  const body = await res.json();
  assert.strictEqual(body.status, 'queued');
  assert.ok(body.jobId);
});

const postTranscribe = (url, extra = {}) =>
  fetch(`${baseUrl}/youtube/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, ...extra }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

test('POST /youtube/transcribe force:true re-runs a cached video, but only for a literal true', async () => {
  const url = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  await postTranscribe(url); // creates the job; the fake finishes it immediately

  const truthy = await postTranscribe(url, { force: 'yes' });
  assert.deepStrictEqual(truthy.body, { jobId: 'yt-aaaaaaaaaaa', status: 'done', deduped: true });

  const forced = await postTranscribe(url, { force: true });
  assert.strictEqual(forced.status, 202);
  assert.deepStrictEqual(forced.body, { jobId: 'yt-aaaaaaaaaaa', status: 'queued' });
});

test('POST /youtube/transcribe dedupes the same video across URL forms', async () => {
  const first = await postTranscribe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.strictEqual(first.status, 202);
  assert.strictEqual(first.body.jobId, 'yt-dQw4w9WgXcQ');
  assert.deepStrictEqual(first.body, { jobId: 'yt-dQw4w9WgXcQ', status: 'queued' });

  // Still queued -> the second caller joins the same job.
  fakeJobs.get('yt-dQw4w9WgXcQ').state = 'waiting';
  const joined = await postTranscribe('https://youtu.be/dQw4w9WgXcQ?t=30');
  assert.deepStrictEqual(joined.body, { jobId: 'yt-dQw4w9WgXcQ', status: 'queued', deduped: true });

  // Once finished, a repeat reports the cached job as done.
  fakeJobs.get('yt-dQw4w9WgXcQ').state = 'completed';
  const cached = await postTranscribe('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.strictEqual(cached.status, 202);
  assert.deepStrictEqual(cached.body, { jobId: 'yt-dQw4w9WgXcQ', status: 'done', deduped: true });
});

test('POST /youtube/transcribe enqueues a URL with no video id fresh every time', async () => {
  const a = await postTranscribe('https://www.youtube.com/playlist?list=PL123');
  const b = await postTranscribe('https://www.youtube.com/playlist?list=PL123');
  assert.notStrictEqual(a.body.jobId, b.body.jobId);
  assert.strictEqual(b.body.deduped, undefined);
});

test('POST /youtube/transcribe still 400s on a missing url before touching the queue', async () => {
  const res = await fetch(`${baseUrl}/youtube/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 400);
});

test('GET /jobs/:id reports a completed job\'s result', async () => {
  const submit = await fetch(`${baseUrl}/youtube/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' }),
  });
  const { jobId } = await submit.json();

  const res = await fetch(`${baseUrl}/jobs/${jobId}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'done');
  assert.deepStrictEqual(body.result, { url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk', text: 'transcript' });
  assert.strictEqual(body.queuedMs, 500); // processedOn (1500) - timestamp (1000)
  assert.strictEqual(body.processingMs, 500); // finishedOn (2000) - processedOn (1500)
});

test('GET /jobs/:id reports a failed job with its message + statusCode', async () => {
  const id = String(nextId++);
  fakeJobs.set(id, {
    state: 'failed',
    // An older worker's payload, with no `retryable` field — it must still
    // default rather than come back undefined.
    failedReason: JSON.stringify({ message: 'boom', statusCode: 422 }),
    timestamp: 1_000,
    processedOn: 1_200,
    finishedOn: 1_900,
  });

  const res = await fetch(`${baseUrl}/jobs/${id}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'failed');
  assert.deepStrictEqual(body.error, { message: 'boom', statusCode: 422, retryable: false });
  assert.strictEqual(body.queuedMs, 200);
  assert.strictEqual(body.processingMs, 700);
});

test('GET /jobs/:id surfaces a rate-limited job as a retryable 429 in the body', async () => {
  // The HTTP status stays 200 — callers have to read error.statusCode to know
  // this one is worth re-queueing rather than a permanently unusable video.
  const id = String(nextId++);
  fakeJobs.set(id, {
    state: 'failed',
    failedReason: JSON.stringify({ message: 'Rate-limited by YouTube', statusCode: 429, retryable: true }),
    timestamp: 1_000,
    processedOn: 1_200,
    finishedOn: 1_900,
  });

  const res = await fetch(`${baseUrl}/jobs/${id}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.error, { message: 'Rate-limited by YouTube', statusCode: 429, retryable: true });
});

test('GET /jobs/:id keeps a non-JSON failedReason readable', async () => {
  const id = String(nextId++);
  fakeJobs.set(id, { state: 'failed', failedReason: 'worker crashed', timestamp: 1_000, processedOn: 1_200, finishedOn: 1_900 });
  const res = await fetch(`${baseUrl}/jobs/${id}`);
  const body = await res.json();
  assert.deepStrictEqual(body.error, { message: 'worker crashed', statusCode: 500, retryable: false });
});

test('GET /jobs/:id reports a still-queued job with a live queuedMs and no processingMs yet', async () => {
  const id = String(nextId++);
  fakeJobs.set(id, { state: 'waiting', timestamp: Date.now() - 250 });

  const res = await fetch(`${baseUrl}/jobs/${id}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'queued');
  assert.strictEqual(body.processingMs, null);
  assert.ok(body.queuedMs >= 250, `expected queuedMs >= 250, got ${body.queuedMs}`);
});

test('GET /jobs/:id 404s for an unknown job', async () => {
  const res = await fetch(`${baseUrl}/jobs/does-not-exist`);
  assert.strictEqual(res.status, 404);
});
