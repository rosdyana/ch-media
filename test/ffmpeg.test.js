const { test } = require('node:test');
const assert = require('node:assert');
const ytdlp = require('../src/ytdlp');

// ffmpeg.js destructures `execRaw` off this same cached module object at require
// time, so mocking ytdlp.execRaw and then re-requiring ffmpeg.js fresh lets the
// mock take effect without spawning a real ffmpeg process.
function loadFreshFfmpeg() {
  delete require.cache[require.resolve('../src/ffmpeg')];
  return require('../src/ffmpeg');
}

test('convertToWav16kMono throws a MediaError naming FFMPEG_PATH when the binary is missing', async (t) => {
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('spawn ffmpeg ENOENT');
    err.code = 'ENOENT';
    throw err;
  });
  const { convertToWav16kMono } = loadFreshFfmpeg();
  await assert.rejects(
    () => convertToWav16kMono('in.mp3', 'out.wav'),
    (err) => /FFMPEG_PATH/.test(err.message),
  );
});

test('convertToWav16kMono wraps a generic ffmpeg failure with its stderr', async (t) => {
  t.mock.method(ytdlp, 'execRaw', async () => {
    const err = new Error('boom');
    err.stderr = 'invalid data found when processing input';
    throw err;
  });
  const { convertToWav16kMono } = loadFreshFfmpeg();
  await assert.rejects(
    () => convertToWav16kMono('in.mp3', 'out.wav'),
    (err) => /invalid data found/.test(err.message),
  );
});
