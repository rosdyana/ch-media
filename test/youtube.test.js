const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fsp = require('node:fs/promises');
const {
  parseJson3,
  pickBestCaption,
  transcribeYoutube,
  langMatches,
  listCaptionTracks,
  pickCaptionLanguage,
  captionArgs,
  toWhisperLang,
  asrLangHint,
  youtubeVideoId,
} = require('../src/youtube');
const ytdlp = require('../src/ytdlp');
const whisper = require('../src/whisper');
const cfg = require('../src/config');

test('youtubeVideoId maps every single-video URL form to the same id', () => {
  const id = 'dQw4w9WgXcQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    assert.strictEqual(youtubeVideoId(url), id, url);
  }
});

test('youtubeVideoId returns null for anything that is not one recognisable video', () => {
  for (const url of [
    'https://www.youtube.com/playlist?list=PL123',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=tooshort',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'dQw4w9WgXcQ',
    'not a url',
    '',
  ]) {
    assert.strictEqual(youtubeVideoId(url), null, url);
  }
});

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

// ── Caption-track discovery ─────────────────────────────────────────────────
// Shapes here mirror a real `yt-dlp --dump-single-json` probe: 30 manual
// languages, 157 automatic_captions keys of which all but the original are
// machine translations carrying `tlang=` in the URL.

const json3 = (url) => [{ ext: 'json3', url }, { ext: 'vtt', url }];
const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=abc&caps=asr';

test('langMatches is a directional subtag match, not a bare prefix', () => {
  assert.ok(langMatches('en', 'en'));
  assert.ok(langMatches('en', 'en-orig'));
  assert.ok(langMatches('zh', 'zh-Hant'));
  assert.ok(!langMatches('en', 'enm'), "'en' must not match Middle English");
  assert.ok(!langMatches('zh-TW', 'zh-Hant'));
});

test('listCaptionTracks drops live_chat, keeps json3 only, and flags tlang= translations', () => {
  const tracks = listCaptionTracks({
    subtitles: {
      en: json3(`${TIMEDTEXT}&lang=en`),
      live_chat: [{ ext: 'json', url: 'https://x/chat' }],
      de: [{ ext: 'vtt', url: `${TIMEDTEXT}&lang=de` }], // no json3 -> unusable
    },
    automatic_captions: {
      'en-orig': json3(`${TIMEDTEXT}&kind=asr&lang=en`),
      ja: json3(`${TIMEDTEXT}&kind=asr&lang=en&tlang=ja`),
    },
  });
  assert.deepStrictEqual(tracks, [
    { lang: 'en', kind: 'manual', translated: false },
    { lang: 'en-orig', kind: 'auto', translated: false },
    { lang: 'ja', kind: 'auto', translated: true },
  ]);
});

test('pickCaptionLanguage prefers manual, then the original ASR track, then a translation', () => {
  const manual = { subtitles: { ja: json3(`${TIMEDTEXT}&lang=ja`) }, automatic_captions: { en: json3(`${TIMEDTEXT}&kind=asr&lang=en`) } };
  // 'en' outranks 'ja' in SUB_LANGS, but a manual track outranks an auto one.
  assert.deepStrictEqual(pickCaptionLanguage(manual), { lang: 'ja', kind: 'manual', translated: false });

  const autoOnly = { automatic_captions: { en: json3(`${TIMEDTEXT}&kind=asr&lang=en&tlang=en`), ja: json3(`${TIMEDTEXT}&kind=asr&lang=ja`) } };
  // The untranslated Japanese original beats the machine-translated English.
  assert.deepStrictEqual(pickCaptionLanguage(autoOnly), { lang: 'ja', kind: 'auto', translated: false });

  const translatedOnly = { automatic_captions: { en: json3(`${TIMEDTEXT}&kind=asr&lang=ko&tlang=en`) } };
  // Still one request and still far cheaper than local ASR — this is what
  // preserved the old behaviour for foreign-language uploads.
  assert.deepStrictEqual(pickCaptionLanguage(translatedOnly), { lang: 'en', kind: 'auto', translated: true });

  assert.strictEqual(pickCaptionLanguage({}), null);
  assert.strictEqual(pickCaptionLanguage({ subtitles: { ko: json3(`${TIMEDTEXT}&lang=ko`) } }), null, 'no preferred language matches');
});

test('captionArgs requests exactly one language and only the matching write flag', () => {
  const manual = captionArgs({ track: { lang: 'en', kind: 'manual' }, tmpDir: '/t', url: 'U' });
  assert.strictEqual(manual[manual.indexOf('--sub-langs') + 1], 'en');
  assert.ok(manual.includes('--write-subs'));
  assert.ok(!manual.includes('--write-auto-subs'));

  const auto = captionArgs({ track: { lang: 'en-orig', kind: 'auto' }, tmpDir: '/t', url: 'U' });
  assert.strictEqual(auto[auto.indexOf('--sub-langs') + 1], 'en-orig');
  assert.ok(auto.includes('--write-auto-subs'));
  assert.ok(!auto.includes('--write-subs'));
});

test('captionArgs falls back to every preferred language when the track is unknown', () => {
  const args = captionArgs({ track: null, tmpDir: '/t', url: 'U' });
  assert.strictEqual(args[args.indexOf('--sub-langs') + 1], cfg.SUB_LANGS.join(','));
  assert.ok(args.includes('--write-subs') && args.includes('--write-auto-subs'));
});

test('toWhisperLang maps to codes whisper.cpp actually accepts', () => {
  assert.strictEqual(toWhisperLang('en-orig'), 'en');
  assert.strictEqual(toWhisperLang('zh-Hant'), 'zh');
  assert.strictEqual(toWhisperLang('pt-BR'), 'pt');
  assert.strictEqual(toWhisperLang('iw'), 'he', "YouTube's legacy Hebrew code");
  assert.strictEqual(toWhisperLang('fil'), 'tl');
  assert.strictEqual(toWhisperLang('yue'), 'yue');
  // An unknown -l makes whisper.cpp exit non-zero, so anything unrecognised
  // must degrade to ASR_LANG rather than be passed through.
  assert.strictEqual(toWhisperLang('xx-Nonsense'), cfg.ASR_LANG);
  assert.strictEqual(toWhisperLang('live_chat'), cfg.ASR_LANG);
  assert.strictEqual(toWhisperLang(''), cfg.ASR_LANG);
});

test('asrLangHint uses the untranslated auto track, then meta.language', () => {
  const meta = { language: 'de', automatic_captions: { 'en-orig': json3(`${TIMEDTEXT}&kind=asr&lang=en`) } };
  assert.strictEqual(asrLangHint(meta, listCaptionTracks(meta)), 'en', "YouTube's own detection wins");
  assert.strictEqual(asrLangHint({ language: 'de' }, []), 'de');
  // Manual subs are often translations of the audio, so they must not be used.
  const manualOnly = { subtitles: { fr: json3(`${TIMEDTEXT}&lang=fr`) } };
  assert.strictEqual(asrLangHint(manualOnly, listCaptionTracks(manualOnly)), cfg.ASR_LANG);
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

/**
 * Metadata mock advertising one real manual English caption track. Needed by
 * any test that wants the caption stage to actually run: with no caption maps
 * the metadata now says "no captions exist" and the fetch is skipped entirely.
 */
const META_WITH_EN_CAPTIONS = {
  title: 'My Video',
  id: 'abc',
  duration: 60,
  language: 'en',
  subtitles: { en: json3(`${TIMEDTEXT}&lang=en`) },
};

/** Enable ASR (and optionally the rate-limit escape hatch) for one test. */
function withAsr(t, overrides = {}) {
  const prev = { ASR_ENABLED: cfg.ASR_ENABLED, ASR_ON_RATE_LIMIT: cfg.ASR_ON_RATE_LIMIT };
  cfg.ASR_ENABLED = true;
  Object.assign(cfg, overrides);
  t.after(() => Object.assign(cfg, prev));
}

test('transcribeYoutube: metadata fetch fails, ASR fallback fills in the transcript', async (t) => {
  withAsr(t);
  let subLangs = null;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      throw new ytdlp.MediaError("yt-dlp failed: Sign in to confirm you're not a bot");
    }
    if (args.includes('--write-subs')) {
      subLangs = args[args.indexOf('--sub-langs') + 1];
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
  // Without metadata we can't know which languages exist, so the degraded path
  // must still ask for all of them.
  assert.strictEqual(subLangs, cfg.SUB_LANGS.join(','));
});

test('transcribeYoutube: caption fetch fails, ASR fallback still runs (regression for !captionError guard)', async (t) => {
  withAsr(t);

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(META_WITH_EN_CAPTIONS) };
    if (args.includes('--write-subs')) {
      // Deliberately NOT a 429: a rate limit now short-circuits before ASR, so
      // this stays the guard that other caption failures still fall through.
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
  // yt-dlp can fail mid-run after already writing a usable file, so salvage is
  // read off disk regardless of exit status — and, critically, *before* the 429
  // short-circuit below classifies that failure. This is the ordering guard.
  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(META_WITH_EN_CAPTIONS) };
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

test('transcribeYoutube: a caption 429 fails retryably without downloading audio', async (t) => {
  // The production bug: a rate-limited caption fetch was treated as "no
  // captions", downloading 26 minutes of audio and grinding Whisper for the
  // full ASR_TIMEOUT_MS on a video whose English captions were fine.
  withAsr(t);
  let audioAttempts = 0;
  let whisperCalls = 0;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ ...META_WITH_EN_CAPTIONS, duration: 1594 }) };
    }
    if (args.includes('--write-subs')) {
      throw new ytdlp.MediaError(
        "yt-dlp failed: ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests",
      );
    }
    if (args.includes('-x')) {
      audioAttempts += 1;
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => {
    whisperCalls += 1;
    return { text: 'should never happen', language: 'ar' };
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 429);
      assert.strictEqual(err.retryable, true);
      assert.match(err.message, /Rate-limited by YouTube/);
      assert.match(err.message, /this video does have captions/);
      assert.match(err.message, /1594s of audio/);
      return true;
    },
  );
  assert.strictEqual(audioAttempts, 0, 'a rate limit must not trigger an audio download');
  assert.strictEqual(whisperCalls, 0, 'a rate limit must not trigger Whisper');
});

test('transcribeYoutube: ASR_ON_RATE_LIMIT restores the old fall-through', async (t) => {
  withAsr(t, { ASR_ON_RATE_LIMIT: true });

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(META_WITH_EN_CAPTIONS) };
    if (args.includes('--write-subs')) throw new ytdlp.MediaError('yt-dlp failed: HTTP Error 429: Too Many Requests');
    if (args.includes('-x')) {
      await fsp.writeFile(path.join(outDirFromArgs(args), 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => ({ text: 'asr despite the 429', language: 'en' }));

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'asr');
  assert.match(result.text, /asr despite the 429/);
});

test('transcribeYoutube: a metadata 429 also blocks ASR, and captions are still attempted', async (t) => {
  withAsr(t);
  let audioAttempts = 0;
  let captionCalls = 0;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) throw new ytdlp.MediaError('yt-dlp failed: HTTP Error 429: Too Many Requests');
    if (args.includes('--write-subs')) {
      captionCalls += 1;
      throw new ytdlp.MediaError('yt-dlp failed: HTTP Error 429: Too Many Requests');
    }
    if (args.includes('-x')) {
      audioAttempts += 1;
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 429);
      assert.strictEqual(err.retryable, true);
      return true;
    },
  );
  assert.strictEqual(captionCalls, 1, 'a metadata 429 leaves caption availability unknown, so still try');
  assert.strictEqual(audioAttempts, 0);
});

test('transcribeYoutube: no caption tracks in metadata skips the caption fetch entirely', async (t) => {
  withAsr(t);
  let sawCaptionCall = false;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'No Subs', id: 'abc', duration: 60, subtitles: {}, automatic_captions: {} }) };
    }
    if (args.includes('--write-subs')) {
      sawCaptionCall = true;
      return { stdout: '' };
    }
    if (args.includes('-x')) {
      await fsp.writeFile(path.join(outDirFromArgs(args), 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async () => ({ text: 'asr, no captions existed', language: 'en' }));

  const result = await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(result.source, 'asr');
  assert.strictEqual(sawCaptionCall, false, 'requesting captions we know do not exist is a wasted request');
});

test('transcribeYoutube: audio longer than ASR_MAX_DURATION_SEC is refused before downloading', async (t) => {
  withAsr(t);
  let audioAttempts = 0;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'Long', id: 'abc', duration: 5000, subtitles: {}, automatic_captions: {} }) };
    }
    if (args.includes('-x')) {
      audioAttempts += 1;
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      assert.match(err.message, /ASR_MAX_DURATION_SEC/);
      assert.match(err.message, /captions skipped/);
      return true;
    },
  );
  assert.strictEqual(audioAttempts, 0, 'no point downloading audio we cannot transcribe in time');
});

test('transcribeYoutube: Whisper gets the caption-derived language, not "auto"', async (t) => {
  withAsr(t);
  let opts = null;

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return {
        stdout: JSON.stringify({
          title: 'Auto captioned',
          id: 'abc',
          duration: 120,
          automatic_captions: { 'en-orig': json3(`${TIMEDTEXT}&kind=asr&lang=en`) },
        }),
      };
    }
    if (args.includes('--write-auto-subs')) {
      assert.strictEqual(args[args.indexOf('--sub-langs') + 1], 'en-orig');
      return { stdout: '' }; // nothing lands on disk -> fall through to ASR
    }
    if (args.includes('-x')) {
      await fsp.writeFile(path.join(outDirFromArgs(args), 'vid.wav'), 'fake-wav');
      return { stdout: '' };
    }
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });
  t.mock.method(whisper, 'transcribeAudio', async (wav, dir, o) => {
    opts = o;
    return { text: 'asr with a language hint', language: 'en' };
  });

  await transcribeYoutube('https://www.youtube.com/watch?v=abc');
  assert.deepStrictEqual(opts, { lang: 'en', durationSec: 120 });
});

test('transcribeYoutube: audio download retries under a fallback player client on format error', async (t) => {
  withAsr(t);

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
  withAsr(t);

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

test('transcribeYoutube: a rate-limited audio download reports 429, not a permanent 422', async (t) => {
  withAsr(t);

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) {
      return { stdout: JSON.stringify({ title: 'My Video', id: 'abc', duration: 60, subtitles: {}, automatic_captions: {} }) };
    }
    if (args.includes('-x')) throw new ytdlp.MediaError('yt-dlp failed: HTTP Error 429: Too Many Requests');
    throw new Error(`unexpected runYtDlp args: ${JSON.stringify(args)}`);
  });

  await assert.rejects(
    () => transcribeYoutube('https://www.youtube.com/watch?v=abc'),
    (err) => {
      assert.strictEqual(err.statusCode, 429);
      assert.strictEqual(err.retryable, true);
      return true;
    },
  );
});

test('transcribeYoutube: identical failures across every stage collapse into one reason', async (t) => {
  withAsr(t);

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
  withAsr(t);

  t.mock.method(ytdlp, 'runYtDlp', async (args) => {
    if (args.includes('--dump-single-json')) return { stdout: JSON.stringify(META_WITH_EN_CAPTIONS) };
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
