/**
 * Pure helpers only — no subprocess, and no wall-clock sleeps. The cooldown is
 * asserted through its computed remainder rather than by waiting it out.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ytdlp = require('../src/ytdlp');
const cfg = require('../src/config');

test('tailStderr leaves short output alone', () => {
  assert.strictEqual(ytdlp.tailStderr('one\ntwo'), 'one\ntwo');
  assert.strictEqual(ytdlp.tailStderr(''), '');
  assert.strictEqual(ytdlp.tailStderr(undefined), '');
});

test('tailStderr keeps the last lines and says how many it dropped', () => {
  const out = ytdlp.tailStderr(Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), { maxLines: 3 });
  assert.match(out, /^… \(27 earlier lines omitted\)\n/);
  assert.match(out, /line 27\nline 28\nline 29$/);
  assert.ok(!out.includes('line 26'));
});

test('tailStderr respects maxChars', () => {
  const out = ytdlp.tailStderr('x'.repeat(5000), { maxChars: 100 });
  assert.match(out, /truncated/);
  assert.ok(out.length < 200);
});

test("tailStderr preserves yt-dlp's verdict, so classification still works after truncation", () => {
  // The real production failure: pages of banner, then the one line that matters.
  const banner = Array.from({ length: 200 }, (_, i) => `whisper_model_load: noise ${i}`).join('\n');
  const summary = ytdlp.tailStderr(
    `${banner}\nERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests`,
  );
  assert.ok(ytdlp.isRateLimited(summary), 'a truncated 429 must still read as a 429');
  assert.ok(summary.length < 900);

  const formatErr = ytdlp.tailStderr(`${banner}\nERROR: Requested format is not available`);
  assert.ok(ytdlp.isFormatUnavailable(formatErr));
});

test('isTimeoutKill matches execFile timeouts and nothing else', () => {
  // Verified shape: execFile's `timeout:` option SIGTERMs the child and leaves
  // code null — ETIMEDOUT is an execFileSync-ism and never appears here.
  assert.ok(ytdlp.isTimeoutKill({ code: null, killed: true, signal: 'SIGTERM' }));
  assert.ok(ytdlp.isTimeoutKill({ code: 'ETIMEDOUT' }));
  assert.ok(!ytdlp.isTimeoutKill({ code: 3, killed: false, signal: null }));
  assert.ok(!ytdlp.isTimeoutKill({ killed: false, signal: 'SIGKILL' }));
  assert.ok(!ytdlp.isTimeoutKill(undefined));
});

test('isExternalKill matches a signal we did not send (OOM killer, docker stop)', () => {
  assert.ok(ytdlp.isExternalKill({ killed: false, signal: 'SIGKILL' }));
  assert.ok(!ytdlp.isExternalKill({ killed: true, signal: 'SIGTERM' }), 'our own timeout is not external');
  assert.ok(!ytdlp.isExternalKill({ code: 1, killed: false, signal: null }));
});

test('classifyYtDlpError reads the real production strings', () => {
  assert.deepStrictEqual(
    ytdlp.classifyYtDlpError("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests"),
    { rateLimited: true, formatUnavailable: false },
  );
  assert.deepStrictEqual(ytdlp.classifyYtDlpError('ERROR: Requested format is not available'), {
    rateLimited: false,
    formatUnavailable: true,
  });
  assert.deepStrictEqual(ytdlp.classifyYtDlpError("Sign in to confirm you're not a bot"), {
    rateLimited: false,
    formatUnavailable: false,
  });
});

test('backoffDelayMs brackets the un-jittered curve and grows with the attempt', () => {
  const base = cfg.BACKOFF_MS;
  for (const attempt of [1, 2, 3, 4]) {
    const plain = base * 2 ** (attempt - 1);
    assert.strictEqual(ytdlp.backoffDelayMs(attempt, { rand: () => 0 }), plain * 0.5);
    assert.strictEqual(ytdlp.backoffDelayMs(attempt, { rand: () => 1 }), plain * 1.5);
    assert.strictEqual(ytdlp.backoffDelayMs(attempt, { rand: () => 0.5 }), plain);
  }
  assert.ok(ytdlp.backoffDelayMs(4, { rand: () => 0 }) > ytdlp.backoffDelayMs(1, { rand: () => 1 }));
  assert.ok(ytdlp.backoffDelayMs(0, { rand: () => 0 }) >= 0, 'never negative');
});

test('nextCooldownMs starts at the base, doubles, then clamps', () => {
  const { COOLDOWN_MS: base, COOLDOWN_MAX_MS: max } = cfg;
  assert.strictEqual(ytdlp.nextCooldownMs(0), base);
  assert.strictEqual(ytdlp.nextCooldownMs(undefined), base);
  assert.strictEqual(ytdlp.nextCooldownMs(base), base * 2);
  assert.strictEqual(ytdlp.nextCooldownMs(max), max);
  assert.strictEqual(ytdlp.nextCooldownMs(max * 4), max);
});

test('noteRateLimit opens a shared window that clears on reset', (t) => {
  t.after(() => ytdlp._resetRateLimitState());
  ytdlp._resetRateLimitState();
  assert.strictEqual(ytdlp.rateLimitRemainingMs(), 0);

  const now = Date.now();
  const opened = ytdlp.noteRateLimit(now);
  assert.strictEqual(opened, cfg.COOLDOWN_MS);
  assert.ok(ytdlp.rateLimitRemainingMs(now) > 0);
  assert.strictEqual(ytdlp.rateLimitRemainingMs(now + cfg.COOLDOWN_MS + 1), 0, 'the window expires');

  // A second 429 *inside* the open window must not escalate: one call's retry
  // loop 429s repeatedly, and compounding each would slam the shared window to
  // its ceiling from a single unlucky job.
  assert.strictEqual(ytdlp.noteRateLimit(now + 10), cfg.COOLDOWN_MS);

  // Once it has expired, a fresh 429 does escalate.
  assert.strictEqual(ytdlp.noteRateLimit(now + cfg.COOLDOWN_MS + 1), cfg.COOLDOWN_MS * 2);

  ytdlp._resetRateLimitState();
  assert.strictEqual(ytdlp.rateLimitRemainingMs(), 0);
});

test('MediaError carries retryable, defaulting to false', () => {
  assert.strictEqual(new ytdlp.MediaError('x').retryable, false);
  assert.strictEqual(new ytdlp.MediaError('x', { retryable: true, statusCode: 429 }).retryable, true);
  assert.strictEqual(new ytdlp.MediaError('x', { statusCode: 422 }).statusCode, 422);
});
