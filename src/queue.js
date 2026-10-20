/**
 * Shared BullMQ queue + Redis connection for the media job pipeline. Route
 * handlers in src/server.js enqueue work here; src/worker.js consumes it and
 * runs the actual yt-dlp/ffmpeg/whisper.cpp work.
 *
 * The ioredis connection and the BullMQ Queue are built lazily (only on first
 * actual use, via getConnection()/getQueue()) — BullMQ's Queue constructor
 * forces an immediate connection attempt regardless of ioredis's lazyConnect
 * option, so constructing one eagerly at require time would make merely
 * requiring src/server.js reach out to Redis. That breaks tests that never
 * touch the queue (see test/audio-upload-http.test.js) whenever Redis isn't
 * running.
 */

const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const cfg = require('./config');

const QUEUE_NAME = 'media-jobs';

const JOB_NAMES = {
  YOUTUBE_TRANSCRIBE: 'youtube:transcribe',
  AUDIO_TRANSCRIBE: 'audio:transcribe',
};

let connection = null;
function getConnection() {
  if (!connection) {
    connection = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', (err) => console.error('[media] redis connection error:', err.message));
  }
  return connection;
}

let queue = null;
function getQueue() {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: cfg.JOB_ATTEMPTS,
        removeOnComplete: { age: cfg.JOB_RETENTION_MS / 1000 },
        removeOnFail: { age: cfg.JOB_RETENTION_MS / 1000 },
      },
    });
  }
  return queue;
}

/** Enqueue a job and return its id (used by callers to poll GET /jobs/:id). */
async function enqueueJob(name, data) {
  const job = await getQueue().add(name, data);
  return job.id;
}

/**
 * Enqueue under a deterministic job id so the same work is only done once:
 * BullMQ ignores an add() whose id already exists, so a repeat submission while
 * the job is queued/active joins it, and one after it completed is a cache hit
 * served from the stored return value until removeOnComplete evicts it
 * (JOB_RETENTION_MS). A *failed* job is not kept — a 429 or a since-fixed
 * yt-dlp problem shouldn't be replayed for a day — so it's removed and re-run.
 * `force` drops a *completed* result the same way (e.g. after a yt-dlp update);
 * an in-flight job is still joined, so forcing can't start a second concurrent run.
 *
 * Returns { jobId, state, deduped }; `state` is the pre-existing job's BullMQ
 * state when deduped, null for a freshly enqueued one.
 */
async function enqueueDedupedJob(name, data, jobId, { force = false, queue = getQueue() } = {}) {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'failed' && !(force && state === 'completed')) {
      return { jobId: existing.id, state, deduped: true };
    }
    // A concurrent request may have removed/replaced it already — the add()
    // below is idempotent on the id either way, so a failed remove is fine.
    await existing.remove().catch(() => {});
  }
  const job = await queue.add(name, data, { jobId });
  return { jobId: job.id, state: null, deduped: false };
}

/** Look up a previously submitted job by id (null if it doesn't exist / was evicted). */
function getJob(id) {
  return getQueue().getJob(id);
}

module.exports = { getConnection, getQueue, enqueueJob, enqueueDedupedJob, getJob, JOB_NAMES, QUEUE_NAME };
