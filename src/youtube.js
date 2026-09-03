/**
 * YouTube processing: keyword search + transcript.
 *
 * Transcript prefers yt-dlp captions and falls back to Whisper ASR, but the
 * decision between them is made from the *metadata* — which languages actually
 * exist — rather than from whether the caption fetch happened to succeed. A
 * rate limit says nothing about whether a video has captions, so treating one
 * as "captions missing" used to download the audio and grind Whisper for the
 * full ASR_TIMEOUT_MS on a video whose English captions were fine.
 */

const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const cfg = require('./config');
const ytdlp = require('./ytdlp');
const whisper = require('./whisper');
const { MediaError, commonArgs } = ytdlp;

/** Parse a yt-dlp json3 caption file into plain transcript text. */
function parseJson3(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return '';
  }
  if (!Array.isArray(parsed?.events)) return '';
  const parts = [];
  for (const event of parsed.events) {
    if (!Array.isArray(event.segs)) continue;
    const line = event.segs
      .map((seg) => seg.utf8 || '')
      .join('')
      .replace(/\n+/g, ' ')
      .trim();
    if (line) parts.push(line);
  }
  return parts.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Directional BCP-47 prefix match: a preference matches a code that is that
 * language or a subtag of it. 'zh' matches 'zh-Hant', 'en' matches 'en-orig' —
 * but 'en' must not match 'enm' (Middle English), which a bare startsWith would.
 */
function langMatches(pref, langCode) {
  const p = String(pref || '').toLowerCase();
  const l = String(langCode || '').toLowerCase();
  if (!p || !l) return false;
  return l === p || l.startsWith(`${p}-`);
}

/** Pick the best caption file by language preference. */
function pickBestCaption(files) {
  for (const pref of cfg.SUB_LANGS) {
    const match = files.find((f) => langMatches(pref, f.lang));
    if (match) return match;
  }
  return files[0] || null;
}

/**
 * Flatten meta.subtitles + meta.automatic_captions into the caption tracks we
 * could actually use.
 *
 * Three filters, each of which a naive "is this language a key?" check gets
 * wrong:
 *  - json3 only — parseJson3 is the only caption format this service reads.
 *  - `live_chat` dropped — on chat-replay videos yt-dlp advertises it under
 *    `subtitles` as a pseudo-track, which would make "this video has captions"
 *    true for every one of them.
 *  - auto entries whose URL carries `tlang=` are machine *translations*, not
 *    transcripts. YouTube offers those for ~150 languages (one ordinary English
 *    video returned 157 automatic_captions keys against 30 real manual ones), so
 *    raw key membership is close to meaningless. Picking a translation over the
 *    original would both degrade the transcript and poison the Whisper language
 *    hint derived from it.
 * @returns {{ lang: string, kind: 'manual'|'auto', translated: boolean }[]}
 */
function listCaptionTracks(meta) {
  const out = [];
  for (const [kind, map] of [
    ['manual', meta?.subtitles],
    ['auto', meta?.automatic_captions],
  ]) {
    if (!map || typeof map !== 'object') continue;
    for (const [lang, entries] of Object.entries(map)) {
      if (lang === 'live_chat' || !Array.isArray(entries)) continue;
      const json3 = entries.filter((e) => e && e.ext === 'json3');
      if (!json3.length) continue;
      out.push({ lang, kind, translated: json3.every((e) => /[?&]tlang=/.test(e.url || '')) });
    }
  }
  return out;
}

/**
 * The single caption language to request, or null when nothing we'd accept
 * exists. Tiers, best first: a human-written track beats YouTube's own ASR,
 * which beats a machine translation of that ASR.
 *
 * Tier 3 is what preserves the old behaviour for a foreign-language video —
 * asking for `en` on a Korean upload already returned a machine-translated
 * track, just at five times the request cost.
 */
function pickCaptionLanguage(meta, prefs = cfg.SUB_LANGS) {
  const tracks = listCaptionTracks(meta);
  if (!tracks.length) return null;
  const tiers = [
    (t) => t.kind === 'manual',
    (t) => t.kind === 'auto' && !t.translated,
    (t) => t.kind === 'auto' && t.translated,
  ];
  for (const inTier of tiers) {
    for (const pref of prefs) {
      const hit = tracks.find((t) => inTier(t) && langMatches(pref, t.lang));
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * yt-dlp args for the caption stage. Pure, so the "exactly one language"
 * contract is testable without a subprocess.
 *
 * `--ignore-no-formats-error` for the same reason as metadata: subtitles are
 * separate from media formats, so an unplayable video can still have perfectly
 * downloadable captions.
 *
 * `track === null` means we never learned what exists (metadata failed), so we
 * fall back to the original shape — every preferred language, manual and auto.
 * That is up to ~10 timedtext requests, i.e. exactly the 429 pressure the
 * metadata-driven path removes.
 */
function captionArgs({ track, tmpDir, url, commonFlags = [] }) {
  // yt-dlp treats --sub-langs values as regexes; observed YouTube keys are all
  // [\w-]+, but fall back to the full list rather than feed it anything odd.
  const single = track && /^[\w-]+$/.test(track.lang) ? track : null;
  return [
    '--skip-download',
    // Only the flag matching the track we chose: passing both would have yt-dlp
    // fetch the manual *and* the auto version of the same language.
    ...(single ? [single.kind === 'manual' ? '--write-subs' : '--write-auto-subs'] : ['--write-subs', '--write-auto-subs']),
    '--sub-langs',
    single ? single.lang : cfg.SUB_LANGS.join(','),
    '--sub-format',
    'json3',
    '--sleep-subtitles',
    String(cfg.SLEEP_SUBTITLES),
    '--ignore-no-formats-error',
    ...commonFlags,
    '-o',
    path.join(tmpDir, '%(id)s.%(ext)s'),
    url,
  ];
}

// whisper.cpp's fixed language table (verified against its cli.cpp). A
// whitelist rather than a shape check, because an unrecognised `-l` is worse
// than an error: whisper-cli prints "error: unknown language 'xx'", dumps its
// usage and exits *zero* without transcribing, so the only symptom is a missing
// output file. Passing a code through unchecked would turn "slow ASR" into "no
// ASR at all", diagnosed by nothing.
const WHISPER_LANGS = new Set(
  ('en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml ' +
    'cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu ' +
    'am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue').split(' '),
);
// YouTube still serves ISO-639-1's superseded codes, plus `fil` for Tagalog.
const WHISPER_LANG_ALIASES = { iw: 'he', in: 'id', ji: 'yi', fil: 'tl' };

/** A caption/metadata language code as whisper.cpp's `-l`, or cfg.ASR_LANG. */
function toWhisperLang(code) {
  const base = String(code || '')
    .toLowerCase()
    .split('-')[0];
  const mapped = WHISPER_LANG_ALIASES[base] || base;
  return WHISPER_LANGS.has(mapped) ? mapped : cfg.ASR_LANG;
}

/**
 * Best language hint for Whisper.
 *
 * An untranslated auto-caption track *is* YouTube's own detection of this
 * audio — free, and the most reliable signal available. Manual subtitle
 * languages are deliberately ignored: uploaded subs are frequently translations,
 * so they describe the file rather than the speech.
 */
function asrLangHint(meta, tracks) {
  const original = (tracks || []).find((t) => t.kind === 'auto' && !t.translated);
  return toWhisperLang(original?.lang || meta?.language || cfg.ASR_LANG);
}

/** Keyword search → [{ url, title }] via yt-dlp ytsearch (no API key). */
async function searchYoutube(keyword, max = 15) {
  if (!keyword || !String(keyword).trim()) return [];
  const n = Math.max(1, Math.min(Number(max) || 15, 50));
  const { stdout } = await ytdlp.runYtDlp([
    `ytsearch${n}:${keyword}`,
    '--dump-json',
    '--flat-playlist',
    ...(await commonArgs()),
  ]);
  const out = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const j = JSON.parse(trimmed);
      if (!j.id) continue;
      out.push({ url: j.webpage_url || `https://www.youtube.com/watch?v=${j.id}`, title: j.title || null });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * runYtDlp classifies its stderr at the source and stamps the verdict on the
 * error, so these read the flag rather than re-grepping a message that
 * tailStderr may have clipped. The string fallback matters: errors constructed
 * elsewhere (and in tests) carry no flags.
 */
function wasRateLimited(err) {
  return err?.rateLimited ?? ytdlp.isRateLimited(err?.message);
}
function wasFormatUnavailable(err) {
  return err?.formatUnavailable ?? ytdlp.isFormatUnavailable(err?.message);
}

/**
 * Download the audio track as 16 kHz mono WAV for ASR.
 *
 * Unlike metadata/captions this genuinely needs a playable format, so
 * --ignore-no-formats-error would only turn a clear error into a confusing
 * "produced no WAV file". Instead, when YouTube refuses to hand this client a
 * usable format we retry under each PLAYER_CLIENT_FALLBACKS client in turn —
 * which of YouTube's clients get real (non-SABR) formats shifts over time, so a
 * single hardcoded client is exactly what leaves us stuck. Any other failure
 * (429, bot-detection, geo-block) rethrows immediately: switching client won't
 * help and each retry is another request against a host that's already blocked.
 */
async function downloadAudioWithClientFallback(url, tmpDir, ffmpegArgs) {
  // undefined = whatever cfg.PLAYER_CLIENT says (yt-dlp's default when unset).
  const candidates = [undefined, ...cfg.PLAYER_CLIENT_FALLBACKS.filter((c) => c !== cfg.PLAYER_CLIENT)];
  let lastError;
  for (const [i, playerClient] of candidates.entries()) {
    try {
      return await ytdlp.runYtDlp([
        '-x',
        '--audio-format',
        'wav',
        '--postprocessor-args',
        'ffmpeg:-ar 16000 -ac 1',
        ...ffmpegArgs,
        ...(await commonArgs({ playerClient })),
        '-o',
        path.join(tmpDir, '%(id)s.%(ext)s'),
        url,
      ]);
    } catch (err) {
      lastError = err;
      if (!wasFormatUnavailable(err) || i === candidates.length - 1) throw err;
      console.warn(
        `[media] no usable audio format for ${url} via ${playerClient || 'default'} client; ` +
          `retrying as "${candidates[i + 1]}"`,
      );
    }
  }
  throw lastError;
}

/** Fetch metadata + captions (with Whisper ASR fallback) for one video URL. */
async function transcribeYoutube(url) {
  // 1. Metadata — best-effort, but now load-bearing: it tells us which caption
  // languages exist and how long the audio is, which is what lets steps 2 and 3
  // avoid pointless requests. A failure here degrades to the old behaviour
  // rather than aborting, since captions/ASR only need the URL.
  // --ignore-no-formats-error: we're only reading the info JSON, so a video
  // whose formats YouTube won't serve us still has perfectly good metadata.
  // Without it yt-dlp hard-errors with "Requested format is not available".
  let meta = {};
  let metaError = null;
  let metaRateLimited = false;
  try {
    const { stdout: metaJson } = await ytdlp.runYtDlp([
      '--dump-single-json',
      '--skip-download',
      '--ignore-no-formats-error',
      ...(await commonArgs()),
      url,
    ]);
    try {
      meta = JSON.parse(metaJson);
    } catch (err) {
      throw new MediaError('Could not parse yt-dlp metadata output.', { statusCode: 502, cause: err });
    }
  } catch (err) {
    metaError = err.message;
    metaRateLimited = wasRateLimited(err);
    console.warn(`[media] metadata fetch failed for ${url}: ${err.message}`);
  }
  const title = meta.title || '';
  const description = meta.description || '';
  const durationSec = Number.isFinite(meta.duration) ? meta.duration : NaN;

  // What the metadata says about captions: 'yes' (a track we'd accept exists),
  // 'no' (metadata parsed cleanly and there is none), or 'unknown'. A metadata
  // 429 counts as unknown — an empty caption map from a throttled request is not
  // evidence of anything.
  const tracks = listCaptionTracks(meta);
  const track = pickCaptionLanguage(meta, cfg.SUB_LANGS);
  const captionEvidence =
    metaError || metaRateLimited || !cfg.TRUST_CAPTION_METADATA ? 'unknown' : track ? 'yes' : 'no';

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mi-media-'));
  let transcript = '';
  let language = null;
  let source = 'captions';
  let captionError = null;
  let captionRateLimited = false;
  let captionSkipped = false;
  let asrError = null;
  let asrRateLimited = false;
  let asrSkipReason = null;
  let asrAttempted = false;

  try {
    // 2. Captions — one request for one language when we know what exists.
    if (captionEvidence === 'no') {
      captionSkipped = true;
      console.log(`[media] no usable caption track in metadata for ${url}; skipping caption fetch`);
    } else {
      try {
        await ytdlp.runYtDlp(
          captionArgs({
            track: captionEvidence === 'yes' ? track : null,
            tmpDir,
            url,
            commonFlags: await commonArgs(),
          }),
        );
      } catch (err) {
        captionError = err.message;
        captionRateLimited = wasRateLimited(err);
        console.warn(`[media] caption fetch failed for ${url}: ${err.message}`);
      }
    }

    // Read whatever landed on disk *even if the command above failed*, and do it
    // before classifying that failure: the degraded multi-language path asks for
    // several languages in one run, so a mid-run failure (commonly a 429 on the
    // 2nd/3rd language) still leaves earlier languages written out. One usable
    // file is all we need, and discarding it would send us to ASR — or to a
    // 429/422 — while a complete transcript sits in the temp dir.
    try {
      const entries = await fsp.readdir(tmpDir);
      const captionFiles = entries
        .filter((name) => name.endsWith('.json3'))
        .map((name) => {
          const m = /\.([\w-]+)\.json3$/.exec(name);
          return { lang: m ? m[1] : 'unknown', file: path.join(tmpDir, name) };
        });
      const best = pickBestCaption(captionFiles);
      if (best) {
        transcript = parseJson3(await fsp.readFile(best.file, 'utf8'));
        language = best.lang;
        if (captionError && transcript.trim()) {
          console.log(`[media] salvaged ${best.lang} captions for ${url} despite: ${captionError}`);
        }
      }
    } catch (err) {
      console.warn(`[media] reading caption files failed for ${url}: ${err.message}`);
    }

    // 3. A rate limit is not evidence that captions are missing. Falling through
    // to ASR here is what made one throttled request cost an audio download plus
    // the full ASR_TIMEOUT_MS of CPU and still return nothing — while the video's
    // captions were fine. Fail fast and retryably instead; the caller re-queues.
    if (!transcript.trim() && (captionRateLimited || metaRateLimited) && !cfg.ASR_ON_RATE_LIMIT) {
      const audioNote = Number.isFinite(durationSec)
        ? `transcribing ${Math.round(durationSec)}s of audio`
        : 'falling back to audio transcription';
      throw new MediaError(
        `Rate-limited by YouTube while fetching ${captionEvidence === 'yes' ? `${track.lang} ` : ''}captions` +
          `${captionEvidence === 'yes' ? ' (this video does have captions)' : ''} — retry later rather than ` +
          `${audioNote}. ${captionError || metaError}`,
        { statusCode: 429, retryable: true },
      );
    }

    // 4. ASR fallback — attempt whenever we still have no transcript and captions
    // are genuinely unavailable, whether that's because none exist or because
    // yt-dlp failed for a reason a retry wouldn't fix (bot-detection, geo-block).
    if (!transcript.trim() && cfg.ASR_ENABLED) {
      // Check feasibility *before* downloading: audio we can't finish costs the
      // whole timeout and yields nothing, so the download is pure waste too.
      const feasible = whisper.asrFeasibility(durationSec);
      if (!feasible.ok) {
        asrSkipReason = feasible.reason;
        console.warn(`[media] skipping Whisper ASR for ${url}: ${feasible.reason}`);
      } else {
        asrAttempted = true;
        console.log(`[media] no transcript yet for ${url}; attempting Whisper ASR`);
        try {
          const ffmpegArgs = cfg.FFMPEG_PATH && cfg.FFMPEG_PATH !== 'ffmpeg' ? ['--ffmpeg-location', cfg.FFMPEG_PATH] : [];
          await downloadAudioWithClientFallback(url, tmpDir, ffmpegArgs);
          const wav = (await fsp.readdir(tmpDir)).find((n) => n.endsWith('.wav'));
          if (!wav) throw new MediaError('Audio extraction produced no WAV file.', { statusCode: 502 });
          const asr = await whisper.transcribeAudio(path.join(tmpDir, wav), tmpDir, {
            lang: asrLangHint(meta, tracks),
            durationSec: Number.isFinite(durationSec) ? durationSec : undefined,
          });
          if (asr.text.trim()) {
            transcript = asr.text;
            language = asr.language || 'asr';
            source = 'asr';
          }
        } catch (err) {
          asrError = err.message;
          asrRateLimited = wasRateLimited(err);
          console.warn(`[media] Whisper ASR failed for ${url}: ${err.message}`);
        }
      }
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 5. Hard-fail when we still have no transcript — report everything that was
  // tried so operators can tell "yt-dlp is blocked everywhere" (check cookies)
  // apart from "this video really has no usable audio/captions".
  if (!transcript.trim()) {
    const stages = [];
    if (metaError) stages.push(['metadata fetch failed', metaError]);
    if (captionError) stages.push(['captions failed', captionError]);
    if (asrError) stages.push(['ASR failed', asrError]);

    // Every stage is a separate yt-dlp call, so one root cause (blocked IP,
    // unusable format list) prints the same sentence three times. Collapse it —
    // "all three failed identically" is itself the useful signal.
    const reasons =
      stages.length > 1 && new Set(stages.map(([, msg]) => msg)).size === 1
        ? [`${stages.map(([label]) => label).join(' + ')} — all with the same error: ${stages[0][1]}`]
        : stages.map(([label, msg]) => `${label}: ${msg}`);

    if (captionSkipped) reasons.unshift('captions skipped (no usable caption track in metadata)');
    if (asrSkipReason) reasons.push(`ASR skipped: ${asrSkipReason}`);
    else if (!asrError && asrAttempted) reasons.push('ASR produced no text');
    else if (!asrError && !cfg.ASR_ENABLED) reasons.push('ASR disabled');

    // Point operators at the fix instead of making them re-derive it.
    if (stages.some(([, msg]) => ytdlp.isFormatUnavailable(msg))) {
      reasons.push(
        'yt-dlp could not resolve a playable format — update yt-dlp and ensure a JS runtime ' +
          'is available (YTDLP_JS_RUNTIMES); see README troubleshooting',
      );
    }

    // A 429 anywhere means "try again later", not "this video is unusable" —
    // including a rate-limited audio download, which used to surface as a
    // permanent 422 and invite no retry.
    const rateLimited = metaRateLimited || captionRateLimited || asrRateLimited;
    throw new MediaError(`No usable transcript — ${reasons.join('; ')}`, {
      statusCode: rateLimited ? 429 : 422,
      retryable: rateLimited,
    });
  }

  const text = [title && `Title: ${title}`, description && `Description: ${description}`, `Transcript:\n${transcript}`]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, cfg.MAX_TRANSCRIPT_CHARS);

  return {
    url,
    title,
    text,
    language,
    source,
    meta: {
      description,
      uploader: meta.uploader || meta.channel || null,
      channelId: meta.channel_id || null,
      viewCount: meta.view_count ?? null,
      likeCount: meta.like_count ?? null,
      duration: meta.duration ?? null,
      uploadDate: meta.upload_date || null,
      videoId: meta.id || null,
      captionLanguage: language,
      hasTranscript: true,
      transcriptSource: source,
    },
  };
}

module.exports = {
  searchYoutube,
  transcribeYoutube,
  parseJson3,
  pickBestCaption,
  langMatches,
  listCaptionTracks,
  pickCaptionLanguage,
  captionArgs,
  toWhisperLang,
  asrLangHint,
};
