/**
 * Whisper (whisper.cpp) ASR — transcribe a 16 kHz mono WAV file. Guarded by a
 * concurrency semaphore so heavy transcriptions don't thrash CPU/GPU.
 */

const fsp = require('fs/promises');
const path = require('path');
const cfg = require('./config');
const { MediaError, execRaw } = require('./ytdlp');

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

/**
 * Transcribe a WAV file with whisper.cpp.
 * @param {string} wavPath
 * @param {string} tmpDir  writable dir for the JSON output
 * @returns {Promise<{ text: string, language: string|null }>}
 */
async function transcribeAudio(wavPath, tmpDir) {
  if (!cfg.WHISPER_MODEL_PATH) {
    throw new MediaError('WHISPER_MODEL_PATH is not set — cannot run ASR.');
  }
  await acquire();
  const outBase = path.join(tmpDir, 'asr');
  try {
    // whisper.cpp `whisper-cli`/`main`: -oj writes <outBase>.json with
    // { result: { language }, transcription: [{ text }] }.
    await execRaw(
      cfg.WHISPER_CPP_PATH,
      ['-m', cfg.WHISPER_MODEL_PATH, '-f', wavPath, '-oj', '-of', outBase, '-l', cfg.ASR_LANG],
      cfg.ASR_TIMEOUT_MS,
    );

    const raw = await fsp.readFile(`${outBase}.json`, 'utf8');
    const parsed = JSON.parse(raw);
    const text = (parsed.transcription || [])
      .map((t) => (t.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const language = parsed.result?.language || null;
    return { text, language };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new MediaError(`whisper binary not found (looked for "${cfg.WHISPER_CPP_PATH}"). Set WHISPER_CPP_PATH.`);
    }
    throw new MediaError(`whisper failed: ${err.stderr || err.message}`, { cause: err });
  } finally {
    release();
  }
}

module.exports = { transcribeAudio };
