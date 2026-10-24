/**
 * src/whisper.js destructures execRaw from src/ytdlp.js at require time, so each
 * test re-requires it fresh after installing the mock — same pattern as
 * test/ffmpeg.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const ytdlp = require('../src/ytdlp');
const cfg = require('../src/config');

function loadFreshWhisper() {
  delete require.cache[require.resolve('../src/whisper')];
  return require('../src/whisper');
}

/** Point the module at a model path + known settings for one test. */
function withWhisperCfg(t, overrides = {}) {
  const keys = ['WHISPER_MODEL_PATH', 'ASR_TIMEOUT_MS', 'ASR_MAX_DURATION_SEC', 'ASR_THREADS', 'ASR_BEAM_SIZE', 'ASR_BEST_OF'];
  const prev = Object.fromEntries(keys.map((k) => [k, cfg[k]]));
  Object.assign(cfg, { WHISPER_MODEL_PATH: '/opt/whisper-models/ggml-large-v3-turbo.bin' }, overrides);
  t.after(() => Object.assign(cfg, prev));
}

test('wavDurationSec reads duration straight off the file size', () => {
  const { wavDurationSec } = require('../src/whisper');
  // 16 kHz mono s16 = 32000 bytes/s, plus the 44-byte canonical header.
  assert.strictEqual(wavDurationSec(32_000 * 10 + 44), 10);
  assert.strictEqual(wavDurationSec(44), 0);
  assert.strictEqual(wavDurationSec(0), 0, 'never negative');
});

test('asrFeasibility refuses audio that cannot finish inside the timeout', (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 1200, ASR_TIMEOUT_MS: 1_800_000 });
  const { asrFeasibility } = loadFreshWhisper();

  // The exact video from the production report.
  const over = asrFeasibility(1594);
  assert.strictEqual(over.ok, false);
  assert.match(over.reason, /1594s/);
  assert.match(over.reason, /ASR_MAX_DURATION_SEC/);
  assert.match(over.reason, /ASR_TIMEOUT_MS/);

  assert.strictEqual(asrFeasibility(1200).ok, true, 'the cap itself is allowed');
  assert.strictEqual(asrFeasibility(600).ok, true);
  assert.strictEqual(asrFeasibility(NaN).ok, true, 'an unknown duration cannot be judged');
});

test('asrFeasibility treats a zero cap as "no cap"', (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  const { asrFeasibility } = loadFreshWhisper();
  assert.strictEqual(asrFeasibility(99_999).ok, true);
});

test('buildWhisperArgs passes greedy decoding, threads and the language hint', (t) => {
  withWhisperCfg(t, { ASR_THREADS: 2, ASR_BEAM_SIZE: 1, ASR_BEST_OF: 1 });
  const { buildWhisperArgs } = loadFreshWhisper();
  const args = buildWhisperArgs({ wavPath: '/tmp/a.wav', outBase: '/tmp/asr', lang: 'en' });

  assert.strictEqual(args[args.indexOf('-l') + 1], 'en');
  assert.strictEqual(args[args.indexOf('-t') + 1], '2');
  // beam_size > 1 is what selects BEAM_SEARCH in whisper.cpp, so 1 == greedy.
  assert.strictEqual(args[args.indexOf('-bs') + 1], '1');
  assert.strictEqual(args[args.indexOf('-bo') + 1], '1');
  // The output contract src/whisper.js reads back must be intact.
  assert.ok(args.includes('-oj'));
  assert.strictEqual(args[args.indexOf('-of') + 1], '/tmp/asr');
  assert.strictEqual(args[args.indexOf('-f') + 1], '/tmp/a.wav');
  assert.ok(!args.includes('-p'), 'parallel chunking loses accuracy at chunk seams');
  assert.ok(!args.includes('-fa'), 'flash attention is already default-on upstream');
});

test('transcribeAudio refuses over-long audio before spawning whisper', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 1200 });
  let spawned = false;
  t.mock.method(ytdlp, 'execRaw', async () => {
    spawned = true;
    return { stdout: '', stderr: '' };
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 1594 }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      assert.match(err.message, /Refusing to run Whisper/);
      assert.match(err.message, /ASR_MAX_DURATION_SEC/);
      return true;
    },
  );
  assert.strictEqual(spawned, false);
});

test('transcribeAudio reports a timeout in one line instead of dumping the model banner', async (t) => {
  withWhisperCfg(t, { ASR_TIMEOUT_MS: 1_800_000, ASR_THREADS: 2, ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('Command failed: whisper-cli -m ...');
    err.killed = true;
    err.signal = 'SIGTERM';
    err.code = null;
    // The 3 KB of noise that used to become the API's error message.
    err.stderr = Array.from({ length: 200 }, (_, i) => `whisper_model_load: noise ${i}`).join('\n');
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 1594 }),
    (err) => {
      assert.match(err.message, /whisper timed out after 1800s/);
      assert.match(err.message, /1594s of audio, 2 threads/);
      assert.match(err.message, /ggml-large-v3-turbo\.bin/);
      assert.ok(!/whisper_model_load/.test(err.message), 'the model-load banner must not be echoed back');
      assert.strictEqual(err.statusCode, 422);
      assert.strictEqual(err.retryable, false, 'the same audio on the same host times out identically');
      return true;
    },
  );
});

test('transcribeAudio names the OOM killer when something else killed the process', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('Command failed');
    err.killed = false;
    err.signal = 'SIGKILL';
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => {
      assert.match(err.message, /killed by SIGKILL/);
      assert.match(err.message, /OOM killer/);
      assert.ok(!/timed out/.test(err.message), 'raising the timeout would be the wrong fix here');
      return true;
    },
  );
});

test('transcribeAudio names a CPU/build mismatch, not the OOM killer, on SIGILL', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('Command failed');
    err.killed = false;
    err.signal = 'SIGILL';
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => {
      assert.match(err.message, /SIGILL/);
      assert.match(err.message, /GGML_NATIVE=OFF/);
      assert.ok(!/OOM/.test(err.message), 'more memory would not help an illegal instruction');
      assert.strictEqual(err.retryable, false);
      return true;
    },
  );
});

test('transcribeAudio reports other external signals without guessing at OOM', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('Command failed');
    err.killed = false;
    err.signal = 'SIGSEGV';
    err.stderr = 'ggml_abort: something broke';
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => {
      assert.match(err.message, /killed by SIGSEGV/);
      assert.match(err.message, /something broke/);
      assert.ok(!/OOM/.test(err.message));
      return true;
    },
  );
});

test('transcribeAudio truncates a generic whisper failure but keeps the real error', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('exit 1');
    err.stderr = `${Array.from({ length: 200 }, (_, i) => `whisper_model_load: noise ${i}`).join('\n')}\nerror: failed to open model`;
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => {
      assert.match(err.message, /failed to open model/);
      assert.ok(err.message.length < 900, `message was ${err.message.length} chars`);
      return true;
    },
  );
});

test('transcribeAudio still names WHISPER_CPP_PATH when the binary is missing', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('spawn whisper-cli ENOENT');
    err.code = 'ENOENT';
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();
  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => /WHISPER_CPP_PATH/.test(err.message),
  );
});

test('transcribeAudio explains a zero-exit run that wrote no JSON (the unknown -l trap)', async (t) => {
  // Verified in whisper.cpp's cli.cpp: an unrecognised -l prints
  // "error: unknown language" and calls exit(0), so execRaw resolves and the
  // missing output file is the only symptom. That used to surface as a bare
  // ENOENT reported as "whisper binary not found".
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => ({ stdout: '', stderr: "error: unknown language 'xx'" }));
  const { transcribeAudio } = loadFreshWhisper();

  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp/definitely-not-a-real-dir', { durationSec: 60, lang: 'xx' }),
    (err) => {
      assert.match(err.message, /wrote no usable JSON/);
      assert.match(err.message, /language "xx"/);
      assert.match(err.message, /exits 0 on an unknown -l/);
      assert.ok(!/binary not found/.test(err.message), 'must not be confused with a missing binary');
      return true;
    },
  );
});

test('transcribeAudio still distinguishes a missing binary from a missing result file', async (t) => {
  withWhisperCfg(t, { ASR_MAX_DURATION_SEC: 0 });
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('spawn whisper-cli ENOENT');
    err.code = 'ENOENT';
    throw err;
  });
  const { transcribeAudio } = loadFreshWhisper();
  await assert.rejects(
    () => transcribeAudio('/tmp/a.wav', '/tmp', { durationSec: 60 }),
    (err) => {
      assert.match(err.message, /whisper binary not found/);
      assert.ok(!/wrote no usable JSON/.test(err.message));
      return true;
    },
  );
});
