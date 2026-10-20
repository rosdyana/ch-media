require('dotenv').config();

const os = require('os');

const num = (v, d) => Number.parseInt(v, 10) || d;
// Like `num`, but 0 is a real value rather than a fall-through to the default —
// `Number.parseInt('0', 10) || d` yields `d`. Only for knobs where 0 means
// something ("disabled"); `num` is left alone so e.g. ASR_CONCURRENCY=0 keeps
// degrading to its default instead of deadlocking the semaphore.
const intOr = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
// Unlike `num`, this can express a default of `true`: the inline
// `process.env.X === 'true'` idiom used below for ASR_ENABLED silently turns any
// unset flag into `false`, which is wrong for knobs that should be on by default.
// Empty string counts as "unset" so a `.env` copied from .env.example with a blank
// value gets the documented default instead of `false`.
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

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
  // YouTube requires a JS runtime to solve its player challenge; without one yt-dlp warns
  // "some formats may be missing" and falls back to a degraded client. Node is already a hard
  // dependency of this service, so we opt into it by default — it only runs JS locally.
  // Set to "" to disable, or "node:/path/to/node" if node isn't on the service's PATH.
  // Silently skipped when the installed yt-dlp is too old to know the flag.
  JS_RUNTIMES: process.env.YTDLP_JS_RUNTIMES ?? 'node',
  // Opt-in (empty default): makes yt-dlp FETCH AND EXECUTE JavaScript from GitHub. Only needed
  // if your yt-dlp build doesn't bundle the EJS scripts. See README troubleshooting.
  REMOTE_COMPONENTS: process.env.YTDLP_REMOTE_COMPONENTS || '',
  // Tried in order when a media download fails with "Requested format is not available" —
  // YouTube degrades/rotates which clients get real formats, so switching client often works.
  // Empty string = yt-dlp's own default client. Costs one extra request per attempt.
  PLAYER_CLIENT_FALLBACKS: (process.env.YTDLP_PLAYER_CLIENT_FALLBACKS ?? 'tv,web_safari,ios')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // The caption stage asks the metadata JSON which languages actually exist and then
  // requests exactly one, instead of firing a timedtext request per configured language.
  // Escape hatch: some player clients (tv, android_vr, bot-flagged sessions) hand back an
  // info JSON with EMPTY caption maps for videos that demonstrably have captions. Trusting
  // that would silently turn every job into an ASR job — strictly worse than before. Set
  // this to "false" to fall back to the old "ask for every language" behaviour without a
  // code change.
  TRUST_CAPTION_METADATA: bool(process.env.YTDLP_TRUST_CAPTION_METADATA, true),
  // Process-wide cooldown after a 429. MIN_GAP_MS paces normal calls; this is the much
  // longer window every in-flight job waits out once YouTube has actually throttled us,
  // so one job's 429 slows all WORKER_CONCURRENCY of them instead of just itself.
  COOLDOWN_MS: num(process.env.YTDLP_COOLDOWN_MS, 60_000),
  COOLDOWN_MAX_MS: num(process.env.YTDLP_COOLDOWN_MAX_MS, 600_000),

  // ASR (Whisper) fallback
  ASR_ENABLED: process.env.ASR_ENABLED === 'true' || process.env.ASR_ENABLED === '1',
  ASR_CONCURRENCY: num(process.env.ASR_CONCURRENCY, 1),
  ASR_TIMEOUT_MS: num(process.env.ASR_TIMEOUT_MS, 1_800_000), // 30 min; see ASR_MAX_DURATION_SEC
  ASR_LANG: process.env.ASR_LANG || 'auto',
  // whisper.cpp's own default is min(4, hardware_concurrency), so this only matters on hosts
  // with more than 4 cores. NOTE: availableParallelism() reads the CPU affinity mask, which
  // does NOT see Docker's --cpus CFS quota — pin ASR_THREADS explicitly if you ever add one.
  ASR_THREADS: num(process.env.ASR_THREADS, os.availableParallelism?.() ?? os.cpus().length),
  // whisper.cpp defaults both of these to 5, i.e. beam search with 5 decoder passes. Its
  // strategy is chosen as `beam_size > 1 ? BEAM_SEARCH : GREEDY`, so ASR_BEAM_SIZE=1 is the
  // knob that actually buys greedy decoding — several times faster on a CPU-only box, for a
  // modest accuracy cost. Set both back to 5 to restore upstream behaviour.
  ASR_BEAM_SIZE: num(process.env.ASR_BEAM_SIZE, 1),
  ASR_BEST_OF: num(process.env.ASR_BEST_OF, 1),
  // Refuse ASR for audio this long *before* downloading it. Transcribing more than we can
  // finish inside ASR_TIMEOUT_MS costs the full timeout and returns nothing, which is how a
  // 26-minute video burned 30 minutes of CPU for zero output. 20 min is what large-v3-turbo
  // on ~2 cores can plausibly manage in the default 30-minute timeout; the success path logs
  // the measured realtime factor so this can be retuned from data.
  ASR_MAX_DURATION_SEC: intOr(process.env.ASR_MAX_DURATION_SEC, 1200),
  // Escape hatch: "true" restores the old behaviour of running ASR even when captions
  // failed only because YouTube rate-limited us. Off by default — a 429 says nothing about
  // whether captions exist, so the right move is to retry later, not to transcribe audio.
  ASR_ON_RATE_LIMIT: bool(process.env.ASR_ON_RATE_LIMIT, false),

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

  // Job queue (Redis + BullMQ) — endpoints enqueue work here instead of processing inline.
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  // Concurrent BullMQ jobs the worker process runs at once. Distinct from ASR_CONCURRENCY,
  // which separately throttles whisper.cpp invocations inside src/whisper.js — this lets
  // cheap jobs (search, captions-only transcribe) run in parallel while heavy ASR calls
  // stay serialized by that existing semaphore.
  WORKER_CONCURRENCY: num(process.env.WORKER_CONCURRENCY, 4),
  JOB_ATTEMPTS: num(process.env.JOB_ATTEMPTS, 1),
  // How long finished jobs stick around in Redis before BullMQ evicts them.
  JOB_RETENTION_MS: num(process.env.JOB_RETENTION_MS, 24 * 60 * 60 * 1000),
  // How long a finished YouTube transcript is served from its own Redis key
  // (src/cache.js) instead of being re-run. Separate from JOB_RETENTION_MS on
  // purpose: BullMQ trims the whole completed set by whichever job finishes, so a
  // long age there would keep every job's result that long. 0 disables the cache.
  TRANSCRIPT_CACHE_TTL_SEC: intOr(process.env.TRANSCRIPT_CACHE_TTL_SEC, 365 * 24 * 60 * 60),
};
