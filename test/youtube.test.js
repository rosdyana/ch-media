const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { parseJson3, pickBestCaption, transcribeYoutube } = require('../src/youtube');
const ytdlp = require('../src/ytdlp');
const whisper = require('../src/whisper');
const cfg = require('../src/config');

test('parseJson3 joins segments and skips newline-only events', () => {
  const json = JSON.stringify({
    events: [
      { segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { segs: [{ utf8: '\n' }] },
      { segs: [{ utf8: 'second line' }] },
    ],
  });
  assert.strictEqual(parseJson3(json), 'Hello world second line');
});

test('parseJson3 returns empty string on malformed json', () => {
  assert.strictEqual(parseJson3('not json'), '');
});

test('pickBestCaption respects SUB_LANGS preference (en before ja by default)', () => {
  const best = pickBestCaption([
    { lang: 'ja', file: 'a' },
    { lang: 'en', file: 'b' },
  ]);
  assert.strictEqual(best.file, 'b');
});

// ── transcribeYoutube fallback wiring ───────────────────────────────────────
// These mock ytdlp.runYtDlp / whisper.transcribeAudio through the module
// objects (youtube.js calls them the same way), so no real subprocess or
// filesystem download ever runs.

/** Directory yt-dlp would have written into, from a call's `-o <dir>/%(id)s.%(ext)s` arg. */
function outDirFromArgs(args) {
  const i = args.indexOf('-o');
  return i >= 0 ? path.dirname(args[i + 1]) : null;
}

test('transcribeYoutube: metadata fetch fails, ASR fallback fills in the transcript', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      throw new ytdlp.MediaError("yt-dlp failed: Sign in to confirm you're not a bot");
    }
    if (args.includes('--write-subs')) {
      return { stdout: '' }; // no caption files written -> "no captions" (not an error)
    }
    if (args.includes('-x')) {
      const dir = outDirFromArgs(args);
      await fsp.writeFile(path.join(dir, 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => ({ text: 'asr transcript', language: 'en' }));

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'asr');
  assert.strictEqual(result.title, '');
  assert.match(result.text, /asr transcript/);
});

test('transcribeYoutube: caption fetch fails, ASR fallback still runs (regression for !captionError guard)', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'My Video', id: 'abc' }) };
    }
    if (args.includes('--write-subs')) {
      throw new ytdlp.MediaError('yt-dlp failed: captions blocked');
    }
    if (args.includes('-x')) {
      const dir = outDirFromArgs(args);
      await fsp.writeFile(path.join(dir, 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => ({ text: 'whisper filled this in', language: 'en' }));

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'asr');
  assert.strictEqual(result.title, 'My Video');
  assert.match(result.text, /whisper filled this in/);
});

test('transcribeYoutube: a caption file written before the run failed is still used', async (t) => {
  // yt-dlp fetches several languages in one run; a 429 on a later language must
  // not throw away an earlier language that already landed on disk.
  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'My Video', id: 'abc' }) };
    }
    if (args.includes('--write-subs')) {
      const dir = outDirFromArgs(args);
      await fsp.writeFile(
        path.join(dir, 'abc.en.json3'),
        JSON.stringify({ events: [{ segs: [{ utf8: 'salvaged caption text' }] }] }),
      );
      throw new ytdlp.MediaError('yt-dlp failed: HTTP Error 429: Too Many Requests');
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => {
    throw new Error('should not be called — captions were salvaged');
  });

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'captions');
  assert.strictEqual(result.language, 'en');
  assert.match(result.text, /salvaged caption text/);
});

test('transcribeYoutube: audio download retries under a fallback player client on format error', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  const clientsTried = [];
  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ title: 'My Video', id: 'abc' }) };
    if (args.includes('--write-subs')) return { stdout: '' };
    if (args.includes('-x')) {
      const i = args.indexOf('--extractor-args');
      clientsTried.push(i >= 0 ? args[i + 1] : 'default');
      if (clientsTried.length === 1) {
        throw new ytdlp.MediaError('yt-dlp failed: ERROR: Requested format is not available');
      }
      const dir = outDirFromArgs(args);
      await fsp.writeFile(path.join(dir, 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => ({ text: 'asr after client retry', language: 'en' }));

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'asr');
  assert.deepStrictEqual(clientsTried, ['default', 'youtube:player_client=tv']);
  assert.match(result.text, /asr after client retry/);
});

test('transcribeYoutube: a non-format error does not burn retries on other clients', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  let audioAttempts = 0;
  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify({ title: 'My Video', id: 'abc' }) };
    if (args.includes('--write-subs')) return { stdout: '' };
    if (args.includes('-x')) {
      audioAttempts += 1;
      throw new ytdlp.MediaError("yt-dlp failed: Sign in to confirm you're not a bot");
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });

  await assert.rejects(() => transcribeYoutube('https://www.youtube.com/watch?v=abc'));
  assert.strictEqual(audioAttempts, 1, 'bot-detection should fail fast, not cycle through clients');
});

test('transcribeYoutube: identical failures across every stage collapse into one reason', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  const sameError = 'yt-dlp failed: ERROR: Requested format is not available';
  t.mock.method(ytdlp, 'runYtDlp', async () => {
    throw new ytdlp.MediaError(sameError);
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      assert.match(err.message, /all with the same error/);
      assert.strictEqual(
        err.message.split('Requested format is not available').length - 1,
        1,
        'the identical yt-dlp error should be printed once, not once per stage',
      );
      assert.match(err.message, /YTDLP_JS_RUNTIMES/);
      return true;
    },
  );
});

test('transcribeYoutube: captions and ASR both fail -> 422 combining both reasons', async (t) => {
  const prevAsr = cfg.ASR_ENABLED;
  cfg.ASR_ENABLED = true;
  t.after(() => {
    cfg.ASR_ENABLED = prevAsr;
  });

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'My Video', id: 'abc' }) };
    }
    if (args.includes('--write-subs')) {
      throw new ytdlp.MediaError('yt-dlp failed: captions blocked');
    }
    if (args.includes('-x')) {
      throw new ytdlp.MediaError("yt-dlp failed: Sign in to confirm you're not a bot");
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => {
    throw new Error('should not be called — audio download already failed');
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      assert.match(err.message, /captions failed: yt-dlp failed: captions blocked/);
      assert.match(err.message, /ASR failed: yt-dlp failed: Sign in to confirm you're not a bot/);
      return true;
    },
  );
});
