/**
 * CH Media Service — internal HTTP API around yt-dlp + ffmpeg + whisper.cpp.
 * Keeps all media binaries + heavy transcription off the load-balanced CHBackend.
 */

const fsp = require('fs/promises');
const express = require('express');
const cfg = require('./config');
const { MediaError } = require('./ytdlp');
const { runUpload } = require('./upload');
const { searchYoutube } = require('./youtube');
const { enqueueJob, getJob, JOB_NAMES } = require('./queue');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Auth (shared secret) ──────────────────────────────────────────────────────
if (!cfg.TOKEN) {
  console.warn('[media] MEDIA_SERVICE_TOKEN is not set — authentication is DISABLED (dev only).');
}
function auth(req, res, next) {
  if (!cfg.TOKEN) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== cfg.TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Small async wrapper so thrown MediaErrors map to their status codes.
const handle = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err instanceof MediaError ? err.statusCode : 500;
    if (status >= 500) console.error('[media] error:', err);
    // Only the synchronous routes (POST /youtube/search) can surface a 429 as a
    // real HTTP status — the queued ones report it inside GET /jobs/:id's body.
    // Advertise the cooldown so a caller doesn't retry straight into it.
    if (status === 429) res.set('Retry-After', String(Math.ceil(cfg.COOLDOWN_MS / 1000)));
    res.status(status).json({ error: err.message || 'Internal error' });
  });
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', asrEnabled: cfg.ASR_ENABLED, timestamp: new Date().toISOString() });
});

// POST /youtube/search { keyword, max } — synchronous; it's a fast metadata
// lookup, not worth the queue round-trip the other two endpoints need.
app.post(
  '/youtube/search',
  auth,
  handle(async (req, res) => {
    const { keyword, max } = req.body || {};
    if (!keyword || typeof keyword !== 'string') {
      throw new MediaError('keyword is required', { statusCode: 400 });
    }
    const data = await searchYoutube(keyword, max);
    res.json({ data });
  }),
);

// POST /youtube/transcribe { url } — enqueues a job, returns 202 + jobId.
// Poll GET /jobs/:id for the transcript result.
app.post(
  '/youtube/transcribe',
  auth,
  handle(async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      throw new MediaError('url is required', { statusCode: 400 });
    }
    const jobId = await enqueueJob(JOB_NAMES.YOUTUBE_TRANSCRIBE, { url });
    res.status(202).json({ jobId, status: 'queued' });
  }),
);

// POST /audio/transcribe (multipart, field "audio") — general-purpose upload transcription.
// Enqueues a job and returns 202 + jobId; poll GET /jobs/:id for the result.
app.post(
  '/audio/transcribe',
  auth,
  handle(async (req, res) => {
    if (!cfg.ASR_ENABLED) {
      throw new MediaError('Audio transcription is disabled (ASR_ENABLED=false).', { statusCode: 503 });
    }
    if (!cfg.WHISPER_MODEL_PATH) {
      throw new MediaError('Audio transcription is unavailable (WHISPER_MODEL_PATH is not set).', { statusCode: 503 });
    }
    let jobEnqueued = false;
    try {
      await runUpload(req, res);
      if (!req.file) {
        throw new MediaError('audio file is required (multipart field "audio")', { statusCode: 400 });
      }
      const jobId = await enqueueJob(JOB_NAMES.AUDIO_TRANSCRIBE, {
        inputPath: req.file.path,
        tmpDir: req.uploadTmpDir,
      });
      jobEnqueued = true;
      res.status(202).json({ jobId, status: 'queued' });
    } finally {
      // Only clean up here on a pre-enqueue failure (e.g. bad file type) — once
      // a job is enqueued, the worker owns the tmp dir's lifetime (src/worker.js).
      if (!jobEnqueued && req.uploadTmpDir) {
        await fsp.rm(req.uploadTmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }),
);

// BullMQ job state -> the simplified status this API reports.
const JOB_STATUS_MAP = {
  waiting: 'queued',
  delayed: 'queued',
  'waiting-children': 'queued',
  prioritized: 'queued',
  active: 'processing',
  completed: 'done',
  failed: 'failed',
};

// GET /jobs/:id — poll the status/result of a previously submitted job.
app.get(
  '/jobs/:id',
  auth,
  handle(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) throw new MediaError('Job not found', { statusCode: 404 });
    const state = await job.getState();
    const status = JOB_STATUS_MAP[state] || 'queued';

    // Timing, computed from BullMQ's own timestamps (already tracked per job,
    // just not previously surfaced): how long it sat queued before a worker
    // picked it up, and how long it's been (or took) actively processing.
    // Using "now" in place of a timestamp that hasn't been set yet lets both
    // fields report a live, growing duration for in-flight jobs.
    const now = Date.now();
    const queuedMs = (job.processedOn ?? now) - job.timestamp;
    const processingMs = job.processedOn != null ? (job.finishedOn ?? now) - job.processedOn : null;

    if (status === 'done') return res.json({ id: job.id, status, queuedMs, processingMs, result: job.returnvalue });
    if (status === 'failed') {
      // src/worker.js JSON-encodes { message, statusCode, retryable } into the
      // thrown error's message since BullMQ only persists err.message as
      // failedReason. Note this response is still HTTP 200 — a 429 in there means
      // "re-queue this later", and the caller has to read the field to see it.
      let error;
      try {
        error = { retryable: false, ...JSON.parse(job.failedReason) };
      } catch {
        error = { message: job.failedReason || 'Job failed', statusCode: 500, retryable: false };
      }
      return res.json({ id: job.id, status, queuedMs, processingMs, error });
    }
    res.json({ id: job.id, status, queuedMs, processingMs });
  }),
);

// Only bind a port when run directly (so tests can require the app).
if (require.main === module) {
  const server = app.listen(cfg.PORT, cfg.HOST, () => {
    console.log(`[media] CH Media Service listening on http://${cfg.HOST}:${cfg.PORT} (ASR ${cfg.ASR_ENABLED ? 'on' : 'off'})`);
  });

  const shutdown = (signal) => {
    console.log(`[media] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
