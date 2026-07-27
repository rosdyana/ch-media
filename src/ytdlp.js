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

function commonArgs() {
  const args = [
    '--no-warnings',
    '--sleep-requests',
    String(cfg.SLEEP_REQUESTS),
    '--retries',
    String(cfg.HTTP_RETRIES),
    '--extractor-retries',
    String(cfg.EXTRACTOR_RETRIES),
  ];
  if (cfg.PLAYER_CLIENT) args.push('--extractor-args', `youtube:player_client=${cfg.PLAYER_CLIENT}`);
  if (cfg.COOKIES_FILE) args.push('--cookies', cfg.COOKIES_FILE);
  if (cfg.COOKIES_FROM_BROWSER) args.push('--cookies-from-browser', cfg.COOKIES_FROM_BROWSER);
  return args;
}

function isRateLimited(message) {
  return /HTTP Error 429|Too Many Requests|\b429\b/i.test(message || '');
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

module.exports = { MediaError, runYtDlp, execRaw, commonArgs, isRateLimited, sleep };
