require('dotenv').config();

const num = (v, d) => Number.parseInt(v, 10) || d;

module.exports = {
  PORT: num(process.env.PORT, 4020),
  HOST: process.env.HOST || '0.0.0.0',
  // Shared secret required on every request (Authorization: Bearer <token>).
  // If unset, auth is disabled (dev only) — a warning is logged at boot.
  TOKEN: process.env.MEDIA_SERVICE_TOKEN || '',

  // Binaries
  YTDLP_PATH: process.env.YTDLP_PATH || 'yt-dlp',
  FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
  WHISPER_CPP_PATH: process.env.WHISPER_CPP_PATH || 'whisper-cli',
  WHISPER_MODEL_PATH: process.env.WHISPER_MODEL_PATH || '',

  // yt-dlp behaviour / rate-limit defenses (same knobs as the old collector)
  YTDLP_TIMEOUT_MS: num(process.env.YTDLP_TIMEOUT_MS, 120_000),
  MAX_TRANSCRIPT_CHARS: num(process.env.YTDLP_MAX_TRANSCRIPT_CHARS, 100_000),
  SUB_LANGS: (process.env.YTDLP_SUB_LANGS || 'en,zh-TW,zh-Hant,zh,ja').split(',').map((s) => s.trim()),
  MIN_GAP_MS: num(process.env.YTDLP_MIN_GAP_MS, 2000),
  MAX_RETRIES: num(process.env.YTDLP_MAX_RETRIES, 4),
  BACKOFF_MS: num(process.env.YTDLP_BACKOFF_MS, 3000),
  SLEEP_REQUESTS: process.env.YTDLP_SLEEP_REQUESTS || '1',
  SLEEP_SUBTITLES: process.env.YTDLP_SLEEP_SUBTITLES || '2',
  HTTP_RETRIES: process.env.YTDLP_RETRIES || '5',
  EXTRACTOR_RETRIES: process.env.YTDLP_EXTRACTOR_RETRIES || '3',
  PLAYER_CLIENT: process.env.YTDLP_PLAYER_CLIENT || '',
  COOKIES_FILE: process.env.YTDLP_COOKIES || '',
  COOKIES_FROM_BROWSER: process.env.YTDLP_COOKIES_FROM_BROWSER || '',

  // ASR (Whisper) fallback
  ASR_ENABLED: process.env.ASR_ENABLED === 'true' || process.env.ASR_ENABLED === '1',
  ASR_CONCURRENCY: num(process.env.ASR_CONCURRENCY, 1),
  ASR_TIMEOUT_MS: num(process.env.ASR_TIMEOUT_MS, 1_800_000), // 30 min; no length cap on audio
  ASR_LANG: process.env.ASR_LANG || 'auto',

  // Direct audio upload (POST /audio/transcribe)
  UPLOAD_MAX_BYTES: num(process.env.UPLOAD_MAX_BYTES, 50 * 1024 * 1024),
  UPLOAD_ALLOWED_EXTENSIONS: (process.env.UPLOAD_ALLOWED_EXTENSIONS || '.mp3,.wav,.m4a,.ogg,.webm,.flac')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  UPLOAD_ALLOWED_MIMETYPES: (
    process.env.UPLOAD_ALLOWED_MIMETYPES ||
    'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/wave,audio/vnd.wave,audio/mp4,audio/x-m4a,audio/ogg,application/ogg,audio/webm,audio/flac,audio/x-flac'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  UPLOAD_FFMPEG_TIMEOUT_MS: num(process.env.UPLOAD_FFMPEG_TIMEOUT_MS, 300_000), // 5 min; ASR_TIMEOUT_MS covers transcription
};
