/**
 * CH Media Service — internal HTTP API around yt-dlp + ffmpeg + whisper.cpp.
 * Keeps all media binaries + heavy transcription off the load-balanced CHBackend.
 */

const express = require('express');
const cfg = require('./config');
const { MediaError } = require('./ytdlp');
const { searchYoutube, transcribeYoutube } = require('./youtube');

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
    res.status(status).json({ error: err.message || 'Internal error' });
  });
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', asrEnabled: cfg.ASR_ENABLED, timestamp: new Date().toISOString() });
});

// POST /youtube/search { keyword, max }
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

// POST /youtube/transcribe { url }
app.post(
  '/youtube/transcribe',
  auth,
  handle(async (req, res) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      throw new MediaError('url is required', { statusCode: 400 });
    }
    res.json(await transcribeYoutube(url));
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
