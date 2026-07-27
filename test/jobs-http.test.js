// HTTP-level tests for the async job endpoints (POST .../search|transcribe +
// GET /jobs/:id). src/queue.js is swapped for an in-memory fake via
// require.cache before src/server.js is required, so these run without a
// real Redis instance (same require.cache-swap trick as test/ffmpeg.test.js).
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
      YOUTUBE_SEARCH: 'youtube:search',
      YOUTUBE_TRANSCRIBE: 'youtube:transcribe',
      AUDIO_TRANSCRIBE: 'audio:transcribe',
    },
    enqueueJob: async (name, data) => {
      const id = String(nextId++);
      fakeJobs.set(id, { name, data, state: 'completed', returnvalue: { data: [] } });
      return id;
    },
    getJob: async (id) => {
      const job = fakeJobs.get(id);
      if (!job) return null;
      return {
        id,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
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

test('POST /youtube/search enqueues a job and returns 202', async () => {
  const res = await fetch(`${baseUrl}/youtube/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: 'lo-fi beats' }),
  });
  assert.strictEqual(res.status, 202);
  const body = await res.json();
  assert.strictEqual(body.status, 'queued');
  assert.ok(body.jobId);
});

test('POST /youtube/search still 400s on a missing keyword before touching the queue', async () => {
  const res = await fetch(`${baseUrl}/youtube/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.strictEqual(res.status, 400);
});

test('GET /jobs/:id reports a completed job\'s result', async () => {
  const submit = await fetch(`${baseUrl}/youtube/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyword: 'lo-fi beats' }),
  });
  const { jobId } = await submit.json();

  const res = await fetch(`${baseUrl}/jobs/${jobId}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'done');
  assert.deepStrictEqual(body.result, { data: [] });
});

test('GET /jobs/:id reports a failed job with its message + statusCode', async () => {
  const id = String(nextId++);
  fakeJobs.set(id, { state: 'failed', failedReason: JSON.stringify({ message: 'boom', statusCode: 422 }) });

  const res = await fetch(`${baseUrl}/jobs/${id}`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'failed');
  assert.deepStrictEqual(body.error, { message: 'boom', statusCode: 422 });
});

test('GET /jobs/:id 404s for an unknown job', async () => {
  const res = await fetch(`${baseUrl}/jobs/does-not-exist`);
  assert.strictEqual(res.status, 404);
});
