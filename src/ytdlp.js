/**
 * yt-dlp subprocess wrapper with a global throttle + exponential backoff on
 * HTTP 429 (moved verbatim in spirit from the old CHBackend youtubeCollector).
 *
 * Also the de-facto subprocess module for the service: src/whisper.js and
 * src/ffmpeg.js both import execRaw plus the error-classification helpers from
 * here, so those live alongside MediaError rather than in a separate module.
 */

const { execFile } = require('child_process');
const cfg = require('./config');

class MediaError extends Error {
  constructor(message, { statusCode = 500, cause, retryable = false } = {}) {
    super(message);
    this.name = 'MediaError';
    this.statusCode = statusCode;
    // True only for failures that a later attempt could plausibly survive — today
    // that means "YouTube rate-limited us". Callers use it to decide whether to
    // re-queue; a 422 "this video has no usable captions or audio" never is.
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Subprocess error shapes ───────────────────────────────────────────────────

// Enough of a stderr blob to diagnose from, without pasting 3 KB of a model-load
// banner into an HTTP response. Not env vars: they belong to neither the YTDLP_*
// nor the ASR_* domain, and there's no operational reason to tune them.
const STDERR_MAX_LINES = 12;
const STDERR_MAX_CHARS = 800;

/**
 * Last few lines of subprocess stderr. Tail rather than head on purpose: both
 * yt-dlp and whisper.cpp print pages of banner/progress first and the actual
 * verdict last (yt-dlp's `ERROR:` line is always final), so keeping the tail is
 * what preserves the signal that isRateLimited/isFormatUnavailable look for.
 */
function tailStderr(text, { maxLines = STDERR_MAX_LINES, maxChars = STDERR_MAX_CHARS } = {}) {
  const raw = String(text ?? '').replace(/\s+$/, '');
  if (!raw) return '';
  const lines = raw.split('\n');
  const omitted = Math.max(0, lines.length - maxLines);
  let out = lines.slice(-maxLines).join('\n');
  const clipped = out.length > maxChars;
  if (clipped) out = out.slice(-maxChars);
  const notes = [];
  if (omitted) notes.push(`${omitted} earlier line${omitted === 1 ? '' : 's'} omitted`);
  if (clipped) notes.push('truncated');
  return notes.length ? `… (${notes.join(', ')})\n${out}` : out;
}

/**
 * Killed by execRaw's own `timeout:` option. execFile reports that as
 * { code: null, killed: true, signal: 'SIGTERM' } — ETIMEDOUT is what
 * execFileSync produces and never appears here, so it's belt-and-braces only.
 */
function isTimeoutKill(err) {
  return !!err && ((err.killed === true && err.signal === 'SIGTERM') || err.code === 'ETIMEDOUT');
}

/**
 * Killed by something outside this process — we never asked for it. On a small
 * container running a large model that's almost always the OOM killer, which is
 * a completely different fix from "raise the timeout" and deserves saying so.
 */
function isExternalKill(err) {
  return !!err && !err.killed && !!err.signal;
}

function isRateLimited(message) {
  return /HTTP Error 429|Too Many Requests|\b429\b/i.test(message || '');
}

/**
 * yt-dlp couldn't resolve a playable format — typically YouTube served a
 * degraded/empty format list to this client (SABR-only, bot-flagged datacenter
 * IP, missing JS runtime). Retrying under a different player_client often works.
 */
function isFormatUnavailable(message) {
  return /Requested format is not available|No video formats found|Only images are available/i.test(message || '');
}

/**
 * Classify a stderr blob once, at the source, on the *untruncated* text. The
 * flags then ride along on the thrown MediaError so downstream code never has to
 * re-grep a message that tailStderr may have clipped.
 */
function classifyYtDlpError(detail) {
  return { rateLimited: isRateLimited(detail), formatUnavailable: isFormatUnavailable(detail) };
}

// ── Pacing: per-call gap + process-wide 429 cooldown ─────────────────────────

// Process-wide gate: serialize + space out yt-dlp calls to avoid bursting YouTube.
let _lastCallAt = 0;
let _gate = Promise.resolve();

// Separate, much longer window that opens once YouTube has *actually* throttled
// us. MIN_GAP_MS paces the happy path; this is what makes one job's 429 slow all
// WORKER_CONCURRENCY of them instead of just its own.
let _cooldownUntil = 0;
let _cooldownMs = 0;

/** Next cooldown window. Pure so the growth/clamp curve is unit-testable. */
function nextCooldownMs(prevMs, { base = cfg.COOLDOWN_MS, max = cfg.COOLDOWN_MAX_MS } = {}) {
  return Math.min(max, Math.max(base, (prevMs || 0) * 2));
}

/** Per-attempt backoff with jitter. `rand` injectable for deterministic tests. */
function backoffDelayMs(attempt, { base = cfg.BACKOFF_MS, rand = Math.random } = {}) {
  // Four workers retrying on the same deterministic curve just re-burst together,
  // so spread each attempt over [0.5x, 1.5x] of its slot.
  return Math.round(base * 2 ** Math.max(0, attempt - 1) * (0.5 + rand()));
}

/**
 * Open (or widen) the shared cooldown after a 429.
 *
 * Only escalates when we weren't already cooling down: a single call's retry loop
 * 429s several times in a row, and compounding every one of those would push the
 * shared window to its ceiling from one unlucky job. Escalation should track
 * repeated failures *over time*, not retries within one call.
 */
function noteRateLimit(now = Date.now()) {
  if (rateLimitRemainingMs(now) === 0) {
    _cooldownMs = nextCooldownMs(_cooldownMs);
    _cooldownUntil = now + _cooldownMs;
    console.warn(`[media] yt-dlp rate-limited; cooling down all yt-dlp calls for ${_cooldownMs}ms`);
  }
  return _cooldownMs;
}

function rateLimitRemainingMs(now = Date.now()) {
  return Math.max(0, _cooldownUntil - now);
}

/** Any success means we're not blocked any more — recover without a decay timer. */
function clearRateLimit() {
  _cooldownMs = 0;
  _cooldownUntil = 0;
}

/** Test-only, underscore-prefixed like _gate/_lastCallAt. */
function _resetRateLimitState() {
  clearRateLimit();
}

function throttle({ respectCooldown = true } = {}) {
  const step = async () => {
    // Reading the cooldown remainder *when this call's turn comes* (not when it
    // queued) is what lets one 429 reach jobs already waiting in the gate — and
    // means only the first waiter pays the full window, so the cooldown doesn't
    // serialize into WORKER_CONCURRENCY x itself.
    const gap = _lastCallAt + cfg.MIN_GAP_MS - Date.now();
    const wait = respectCooldown ? Math.max(gap, rateLimitRemainingMs()) : gap;
    if (wait > 0) await sleep(wait);
    _lastCallAt = Date.now();
  };
  _gate = _gate.then(step, step);
  return _gate;
}

/**
 * One-shot, cached probe of which optional flags this yt-dlp build understands.
 * An unknown flag makes yt-dlp exit non-zero on *every* call, so newer options
 * (--js-runtimes, --remote-components — added late 2025 for YouTube's EJS
 * challenge) are only sent when `--help` actually lists them. On any probe
 * failure we assume unsupported, i.e. behave exactly as before.
 */
let _capsPromise = null;
function getCapabilities() {
  if (!_capsPromise) {
    _capsPromise = execRaw(cfg.YTDLP_PATH, ['--help'], 30_000)
      .then(({ stdout }) => ({
        jsRuntimes: stdout.includes('--js-runtimes'),
        remoteComponents: stdout.includes('--remote-components'),
      }))
      .catch(() => ({ jsRuntimes: false, remoteComponents: false }));
  }
  return _capsPromise;
}

/**
 * Flags shared by every yt-dlp call. `playerClient` overrides cfg.PLAYER_CLIENT
 * so callers can retry the same request under a different YouTube client when
 * the default one stops returning usable formats (see PLAYER_CLIENT_FALLBACKS).
 */
async function commonArgs({ playerClient } = {}) {
  const caps = await getCapabilities();
  const client = playerClient === undefined ? cfg.PLAYER_CLIENT : playerClient;
  const args = [
    '--no-warnings',
    '--sleep-requests',
    String(cfg.SLEEP_REQUESTS),
    '--retries',
    String(cfg.HTTP_RETRIES),
    '--extractor-retries',
    String(cfg.EXTRACTOR_RETRIES),
  ];
  if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
  if (cfg.COOKIES_FILE) args.push('--cookies', cfg.COOKIES_FILE);
  if (cfg.COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', cfg.COOKIES_FROM_BROWSER);
  if (cfg.JS_RUNTIMES && caps.jsRuntimes) args.push('--js-runtimes', cfg.JS_RUNTIMES);
  if (cfg.REMOTE_COMPONENTS && caps.remoteComponents) args.push('--remote-components', cfg.REMOTE_COMPONENTS);
  return args;
}

function execRaw(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** Run yt-dlp with throttling + 429 backoff. */
async function runYtDlp(args) {
  let attempt = 0;
  for (;;) {
    // A fresh call waits out any global 429 cooldown. A retry of a call already in
    // flight doesn't: it just slept its own jittered backoff, and making it serve
    // the (much longer) cooldown too would stretch one job across many minutes
    // before it could report the retryable 429 its caller is waiting for.
    await throttle({ respectCooldown: attempt === 0 });
    try {
      const result = await execRaw(cfg.YTDLP_PATH, args, cfg.YTDLP_TIMEOUT_MS);
      clearRateLimit();
      return result;
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new MediaError(`yt-dlp not found (looked for "${cfg.YTDLP_PATH}"). Install it or set YTDLP_PATH.`);
      }
      // On a timeout execFile leaves stderr empty, so the generic path below would
      // report a bare "Command failed: /usr/local/bin/yt-dlp ..." and nothing else.
      if (isTimeoutKill(error)) {
        throw new MediaError(`yt-dlp timed out after ${Math.round(cfg.YTDLP_TIMEOUT_MS / 1000)}s`, { cause: error });
      }
      const detail = error.stderr || error.message || '';
      const { rateLimited, formatUnavailable } = classifyYtDlpError(detail);
      // Widen the shared window before deciding whether to retry — even the
      // terminal 429 is worth telling the other in-flight jobs about.
      if (rateLimited) noteRateLimit();
      if (rateLimited && attempt < cfg.MAX_RETRIES) {
        attempt += 1;
        const delay = backoffDelayMs(attempt);
        console.warn(`[media] yt-dlp 429; backing off ${delay}ms (retry ${attempt}/${cfg.MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      const err = new MediaError(`yt-dlp failed: ${tailStderr(detail)}`, {
        cause: error,
        retryable: rateLimited,
        statusCode: rateLimited ? 429 : 500,
      });
      err.rateLimited = rateLimited;
      err.formatUnavailable = formatUnavailable;
      throw err;
    }
  }
}

module.exports = {
  MediaError,
  runYtDlp,
  execRaw,
  commonArgs,
  getCapabilities,
  isRateLimited,
  isFormatUnavailable,
  classifyYtDlpError,
  tailStderr,
  isTimeoutKill,
  isExternalKill,
  backoffDelayMs,
  nextCooldownMs,
  noteRateLimit,
  rateLimitRemainingMs,
  _resetRateLimitState,
  sleep,
};
