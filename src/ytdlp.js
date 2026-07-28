/**
 * yt-dlp subprocess wrapper with a global throttle + exponential backoff on
 * HTTP 429 (moved verbatim in spirit from the old CHBackend youtubeCollector).
 */

const { execFile } = require('child_process');
const cfg = require('./config');

class MediaError extends Error {
  constructor(message, { statusCode = 500, cause } = {}) {
    super(message);
    this.name = 'MediaError';
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Process-wide gate: serialize + space out yt-dlp calls to avoid bursting YouTube.
let _lastCallAt = 0;
let _gate = Promise.resolve();
function throttle() {
  const step = async () => {
    const wait = _lastCallAt + cfg.MIN_GAP_MS - Date.now();
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
    await throttle();
    try {
      return await execRaw(cfg.YTDLP_PATH, args, cfg.YTDLP_TIMEOUT_MS);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new MediaError(`yt-dlp not found (looked for "${cfg.YTDLP_PATH}"). Install it or set YTDLP_PATH.`);
      }
      const detail = error.stderr || error.message || '';
      if (isRateLimited(detail) && attempt < cfg.MAX_RETRIES) {
        attempt += 1;
        const delay = cfg.BACKOFF_MS * 2 ** (attempt - 1);
        console.warn(`[media] yt-dlp 429; backing off ${delay}ms (retry ${attempt}/${cfg.MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      throw new MediaError(`yt-dlp failed: ${detail}`, { cause: error });
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
  sleep,
};
