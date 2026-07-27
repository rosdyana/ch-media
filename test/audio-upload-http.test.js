// HTTP-level test for POST /audio/transcribe. All cases here fail validation
// before any real ffmpeg/whisper binary would be invoked, so no such binaries
// need to be installed to run this file.
//
// Env vars are pinned *before* the first require of src/config (via src/server)
// so behavior doesn't depend on whatever a developer's local .env happens to
// contain — dotenv only fills in vars that aren't already set.
process.env.MEDIA_SERVICE_TOKEN = '';
process.env.ASR_ENABLED = 'true';
process.env.WHISPER_MODEL_PATH = '/fake/whisper-model.bin';
process.env.UPLOAD_MAX_BYTES = '1024';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const cfg = require('../src/config');
const app = require('../src/server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('rejects an oversized upload with 413', async () => {
  const form = new FormData();
  const oversized = Buffer.alloc(cfg.UPLOAD_MAX_BYTES + 1024, 1);
  form.append('audio', new Blob([oversized], { type: 'audio/mpeg' }), 'big.mp3');
  const res = await fetch(`${baseUrl}/audio/transcribe`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 413);
});

test('rejects a disallowed file extension with 415', async () => {
  const form = new FormData();
  form.append('audio', new Blob([Buffer.from('not audio')], { type: 'text/plain' }), 'notes.txt');
  const res = await fetch(`${baseUrl}/audio/transcribe`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 415);
});

test('rejects a request with no audio field with 400', async () => {
  const form = new FormData();
  form.append('note', 'forgot to attach the audio field');
  const res = await fetch(`${baseUrl}/audio/transcribe`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 400);
});

test('returns 503 when ASR_ENABLED is false', async () => {
  const original = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = false;
  try {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('fake mp3 bytes')], { type: 'audio/mpeg' }), 'song.mp3');
    const res = await fetch(`${baseUrl}/audio/transcribe`, { method: 'POST', body: form });
    assert.strictEqual(res.status, 503);
  } finally {
    cfg.ASR_ENABLED = original;
  }
});

test('returns 503 when WHISPER_MODEL_PATH is unset', async () => {
  const original = cfg.WHISPER_MODEL_PATH;
  cfg.WHISPER_MODEL_PATH = '';
  try {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.from('fake mp3 bytes')], { type: 'audio/mpeg' }), 'song.mp3');
    const res = await fetch(`${baseUrl}/audio/transcribe`, { method: 'POST', body: form });
    assert.strictEqual(res.status, 503);
  } finally {
    cfg.WHISPER_MODEL_PATH = original;
  }
});
