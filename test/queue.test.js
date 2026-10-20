// enqueueDedupedJob against a fake BullMQ queue (injected via its 4th argument),
// so no Redis is needed — src/queue.js builds its real Queue lazily.
const { test } = require('node:test');
const assert = require('node:assert');
const { enqueueDedupedJob } = require('../src/queue');

function fakeQueue(initial = {}) {
  const jobs = new Map(Object.entries(initial));
  const calls = { add: [], remove: [] };
  return {
    calls,
    jobs,
    getJob: async (id) => {
      const state = jobs.get(id);
      if (state === undefined) return null;
      return {
        id,
        getState: async () => state,
        remove: async () => {
          calls.remove.push(id);
          jobs.delete(id);
        },
      };
    },
    add: async (name, data, opts) => {
      calls.add.push({ name, data, opts });
      if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, 'waiting');
      return { id: opts.jobId };
    },
  };
}

test('enqueues under the given job id when none exists', async () => {
  const q = fakeQueue();
  const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { queue: q });
  assert.deepStrictEqual(out, { jobId: 'yt-abc', state: null, deduped: false });
  assert.deepStrictEqual(q.calls.add, [{ name: 'youtube:transcribe', data: { url: 'u' }, opts: { jobId: 'yt-abc' } }]);
});

for (const state of ['waiting', 'active', 'delayed', 'completed']) {
  test(`reuses an existing ${state} job instead of adding another`, async () => {
    const q = fakeQueue({ 'yt-abc': state });
    const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { queue: q });
    assert.deepStrictEqual(out, { jobId: 'yt-abc', state, deduped: true });
    assert.strictEqual(q.calls.add.length, 0);
    assert.strictEqual(q.calls.remove.length, 0);
  });
}

test('force discards a completed result and re-runs the video', async () => {
  const q = fakeQueue({ 'yt-abc': 'completed' });
  const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { force: true, queue: q });
  assert.deepStrictEqual(out, { jobId: 'yt-abc', state: null, deduped: false });
  assert.deepStrictEqual(q.calls.remove, ['yt-abc']);
  assert.strictEqual(q.calls.add.length, 1);
});

for (const state of ['waiting', 'active', 'delayed']) {
  test(`force still joins an in-flight ${state} job rather than running it twice`, async () => {
    const q = fakeQueue({ 'yt-abc': state });
    const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { force: true, queue: q });
    assert.deepStrictEqual(out, { jobId: 'yt-abc', state, deduped: true });
    assert.strictEqual(q.calls.add.length, 0);
    assert.strictEqual(q.calls.remove.length, 0);
  });
}

test('replaces a failed job rather than replaying its failure', async () => {
  const q = fakeQueue({ 'yt-abc': 'failed' });
  const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { queue: q });
  assert.deepStrictEqual(out, { jobId: 'yt-abc', state: null, deduped: false });
  assert.deepStrictEqual(q.calls.remove, ['yt-abc']);
  assert.strictEqual(q.calls.add.length, 1);
  assert.strictEqual(q.jobs.get('yt-abc'), 'waiting');
});

test('still enqueues when removing the failed job loses a race', async () => {
  const q = fakeQueue({ 'yt-abc': 'failed' });
  const realGet = q.getJob;
  q.getJob = async (id) => {
    const job = await realGet(id);
    if (job) job.remove = async () => { throw new Error('Missing key for job'); };
    return job;
  };
  const out = await enqueueDedupedJob('youtube:transcribe', { url: 'u' }, 'yt-abc', { queue: q });
  assert.strictEqual(out.deduped, false);
  assert.strictEqual(q.calls.add.length, 1);
});
