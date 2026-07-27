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

/** Look up a previously submitted job by id (null if it doesn't exist / was evicted). */
function getJob(id) {
  return getQueue().getJob(id);
}

module.exports = { getConnection, getQueue, enqueueJob, getJob, JOB_NAMES, QUEUE_NAME };
