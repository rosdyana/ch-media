/**
 * Whisper (whisper.cpp) ASR — transcribe a 16 kHz mono WAV file. Guarded by a
 * concurrency semaphore so heavy transcriptions don't thrash CPU/GPU.
 */

const fsp = require('fs/promises');
const path = require('path');
const cfg = require('./config');
const { MediaError, execRaw, tailStderr, isTimeoutKill, isExternalKill } = require('./ytdlp');

// ── Concurrency semaphore ─────────────────────────────────────────────────────
let active = 0;
const waiters = [];
function acquire() {
  return new Promise((resolve) => {
    const attempt = () => {
      if (active < cfg.ASR_CONCURRENCY) {
        active += 1;
        resolve();
      } else {
        waiters.push(attempt);
      }
    };
    attempt();
  });
}
function release() {
  active -= 1;
  const next = waiters.shift();
  if (next) next();
}

// ── Feasibility ───────────────────────────────────────────────────────────────

/**
 * whisper.cpp wants 16 kHz mono signed-16 PCM, i.e. exactly 32000 bytes per
 * second, so the file size *is* the duration — no ffprobe subprocess needed. The
 * 44-byte canonical WAV header is subtracted; a few bytes of slop either way is
 * irrelevant to a check measured in minutes.
 */
function wavDurationSec(bytes) {
  return Math.max(0, Math.round((Number(bytes) - 44) / 32000));
}

/**
 * Can this host plausibly transcribe `durationSec` of audio before
 * ASR_TIMEOUT_MS kills the process?
 *
 * Refusing up front costs nothing. Finding out the hard way costs the *entire*
 * timeout and yields no text at all — which is exactly how a 26-minute video
 * burned 30 minutes of CPU and returned a 3 KB model-load banner as its error.
 */
function asrFeasibility(durationSec) {
  const maxSec = cfg.ASR_MAX_DURATION_SEC;
  // Unknown duration can't be judged, and 0 disables the cap entirely.
  if (!maxSec || !Number.isFinite(durationSec) || durationSec <= 0) return { ok: true, maxSec, reason: null };
  if (durationSec <= maxSec) return { ok: true, maxSec, reason: null };
  return {
    ok: false,
    maxSec,
    reason:
      `audio is ${Math.round(durationSec)}s, over the ${maxSec}s ASR_MAX_DURATION_SEC cap — ` +
      `whisper would not finish inside the ${Math.round(cfg.ASR_TIMEOUT_MS / 1000)}s ASR_TIMEOUT_MS. ` +
      `Raise both (and check the logged realtime factor), or use a smaller model.`,
  };
}

/**
 * Pure arg builder, so the flag contract is unit-testable without a binary.
 *
 * Two whisper.cpp defaults are worth stating, because both cost real time on a
 * CPU-only host: `-t` defaults to min(4, hardware_concurrency) — so it only
 * helps on hosts with more than 4 cores, NOT on the 2-CPU container where this
 * bug surfaced — and `-bs`/`-bo` both default to 5. Its strategy is picked as
 * `beam_size > 1 ? BEAM_SEARCH : GREEDY`, which makes ASR_BEAM_SIZE=1 the flag
 * that actually buys greedy decoding (the failing log shows "5 beams + best of
 * 5", i.e. five decoder passes over 26 minutes of audio).
 *
 * Deliberately not passed: `-fa` (flash attention is already default-on
 * upstream) and `-p` (parallel chunking loses accuracy at chunk seams and, on
 * two cores, just steals threads from the decoder).
 */
function buildWhisperArgs({
  wavPath,
  outBase,
  model = cfg.WHISPER_MODEL_PATH,
  lang = cfg.ASR_LANG,
  threads = cfg.ASR_THREADS,
  beamSize = cfg.ASR_BEAM_SIZE,
  bestOf = cfg.ASR_BEST_OF,
}) {
  return [
    '-m', model,
    '-f', wavPath,
    '-oj',
    '-of', outBase,
    '-l', lang,
    '-t', String(threads),
    '-bs', String(beamSize),
    '-bo', String(bestOf),
  ];
}

/**
 * Turn a failed whisper-cli *spawn/run* into a MediaError that says what to do.
 * The old version pasted the raw stderr in, which on a timeout meant ~3 KB of
 * model-load banner arriving as the API's error message.
 */
function describeWhisperFailure(err, { audioNote, threads }) {
  if (err.code === 'ENOENT') {
    return new MediaError(`whisper binary not found (looked for "${cfg.WHISPER_CPP_PATH}"). Set WHISPER_CPP_PATH.`);
  }
  // Not retryable: the same audio on the same host will time out identically.
  if (isTimeoutKill(err)) {
    return new MediaError(
      `whisper timed out after ${Math.round(cfg.ASR_TIMEOUT_MS / 1000)}s ` +
        `(${audioNote}, ${threads} threads, model ${path.basename(cfg.WHISPER_MODEL_PATH)}) — ` +
        `raise ASR_TIMEOUT_MS, lower ASR_MAX_DURATION_SEC, or use a smaller model`,
      { statusCode: 422, cause: err },
    );
  }
  // A signal we didn't send, on a small container running a large model: this is
  // the OOM killer far more often than anything else, and "raise the timeout"
  // would be exactly the wrong fix.
  if (isExternalKill(err)) {
    return new MediaError(
      `whisper was killed by ${err.signal} without hitting ASR_TIMEOUT_MS (${audioNote}) — ` +
        `likely the OOM killer; ggml-large-v3-turbo needs roughly 1.5 GB RSS`,
      { cause: err },
    );
  }
  return new MediaError(`whisper failed: ${tailStderr(err.stderr || err.message)}`, { cause: err });
}

/**
 * Transcribe a WAV file with whisper.cpp.
 * @param {string} wavPath
 * @param {string} tmpDir  writable dir for the JSON output
 * @param {{ lang?: string, durationSec?: number }} [opts]
 *   `lang` is an ISO-639-1 hint (see youtube.js#toWhisperLang) — passing the
 *   language we already know beats `-l auto`, which decides from only the first
 *   30-second window and tagged an English video as Arabic in production.
 * @returns {Promise<{ text: string, language: string|null }>}
 */
async function transcribeAudio(wavPath, tmpDir, { lang, durationSec } = {}) {
  if (!cfg.WHISPER_MODEL_PATH) {
    throw new MediaError('WHISPER_MODEL_PATH is not set — cannot run ASR.');
  }

  // Second line of defence behind youtube.js's pre-download gate — and the only
  // one on the upload path (src/audio.js), which never knows a duration up front.
  let seconds = durationSec;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    seconds = await fsp
      .stat(wavPath)
      .then((s) => wavDurationSec(s.size))
      .catch(() => NaN);
  }
  const feasible = asrFeasibility(seconds);
  if (!feasible.ok) {
    throw new MediaError(`Refusing to run Whisper: ${feasible.reason}`, { statusCode: 422 });
  }

  const language = lang || cfg.ASR_LANG;
  const threads = cfg.ASR_THREADS;
  const audioNote = Number.isFinite(seconds) && seconds > 0 ? `${Math.round(seconds)}s of audio` : 'unknown audio length';

  await acquire();
  const outBase = path.join(tmpDir, 'asr');
  const startedAt = Date.now();
  try {
    // whisper.cpp `whisper-cli`/`main`: -oj writes <outBase>.json with
    // { result: { language }, transcription: [{ text }] }.
    //
    // Classified in its own try so that an ENOENT from *spawning* whisper stays
    // distinguishable from an ENOENT reading its output below — they have
    // completely different fixes, and lumping them together reported a missing
    // result file as "whisper binary not found".
    try {
      await execRaw(cfg.WHISPER_CPP_PATH, buildWhisperArgs({ wavPath, outBase, lang: language, threads }), cfg.ASR_TIMEOUT_MS);
    } catch (err) {
      throw describeWhisperFailure(err, { audioNote, threads });
    }

    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(`${outBase}.json`, 'utf8'));
    } catch (err) {
      // whisper-cli exits *zero* on some fatal argument errors — notably an
      // unrecognised -l, where it prints "error: unknown language 'xx'", dumps
      // its usage and exits 0 without transcribing anything. The absent JSON is
      // the only signal we get, so name the likeliest cause instead of leaking
      // a bare ENOENT. (src/youtube.js#toWhisperLang exists to prevent this.)
      throw new MediaError(
        `whisper exited successfully but wrote no usable JSON (${audioNote}, language "${language}", ` +
          `model ${path.basename(cfg.WHISPER_MODEL_PATH)}) — whisper-cli exits 0 on an unknown -l, ` +
          `so check the language hint first: ${err.message}`,
        { cause: err },
      );
    }
    const text = (parsed.transcription || [])
      .map((t) => (t.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const detected = parsed.result?.language || null;

    // Logged so ASR_MAX_DURATION_SEC can be tuned from measurement rather than
    // from the guess baked into its default.
    const elapsed = (Date.now() - startedAt) / 1000;
    if (Number.isFinite(seconds) && seconds > 0 && elapsed > 0) {
      console.log(
        `[media] whisper: ${Math.round(seconds)}s audio in ${elapsed.toFixed(0)}s ` +
          `(${(seconds / elapsed).toFixed(1)}x realtime, ${threads} threads, lang ${language})`,
      );
    }
    return { text, language: detected };
  } finally {
    release();
  }
}

module.exports = { transcribeAudio, wavDurationSec, asrFeasibility, buildWhisperArgs };
