/**
 * Media job worker — consumes the queue defined in src/queue.js and runs the
 * yt-dlp/ffmpeg/whisper.cpp work that src/server.js's routes used to run
 * inline. Runs as its own process (see ch-media-worker.service in README) so
 * a heavy or crashing job can't take down the HTTP API.
 */

const fsp = require('fs/promises');
const { Worker } = require('bullmq');
const cfg = require('./config');
const { getConnection, QUEUE_NAME, JOB_NAMES } = require('./queue');
const { MediaError } = require('./ytdlp');
const { transcribeYoutube } = require('./youtube');
const { transcribeUploadedAudio } = require('./audio');

async function processJob(job) {
  switch (job.name) {
    case JOB_NAMES.YOUTUBE_TRANSCRIBE: {
      const { url } = job.data;
      return transcribeYoutube(url);
    }
    case JOB_NAMES.AUDIO_TRANSCRIBE: {
      const { inputPath, tmpDir } = job.data;
      try {
        return await transcribeUploadedAudio(inputPath, tmpDir);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    default:
      throw new MediaError(`Unknown job type "${job.name}"`);
  }
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    try {
      return await processJob(job);
    } catch (err) {
      const statusCode = err instanceof MediaError ? err.statusCode : 500;
      if (statusCode >= 500) console.error(`[media-worker] job ${job.id} (${job.name}) failed:`, err);
      // BullMQ only persists err.message as the job's failedReason, so encode
      // the status code alongside it for GET /jobs/:id to parse back out.
      throw new Error(JSON.stringify({ message: err.message || 'Internal error', statusCode }));
    }
  },
  { connection: getConnection(), concurrency: cfg.WORKER_CONCURRENCY },
);

worker.on('ready', () => {
  console.log(`[media-worker] listening on queue "${QUEUE_NAME}" (concurrency ${cfg.WORKER_CONCURRENCY})`);
});
worker.on('error', (err) => {
  console.error('[media-worker] worker error:', err);
});

if (require.main === module) {
  const shutdown = (signal) => {
    console.log(`[media-worker] ${signal} received, shutting down`);
    worker.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = worker;
