/**
 * YouTube processing: keyword search + transcript. Transcript prefers yt-dlp
 * captions; whenever they're missing — no subtitles, or yt-dlp/metadata itself
 * failed (bot-detection, geo-block, transient errors, etc.) — and ASR is
 * enabled, it falls back to downloading the audio and running Whisper.
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

/** Pick the best caption file by language preference. */
function pickBestCaption(files) {
  for (const pref of cfg.SUB_LANGS) {
    const prefLower = pref.toLowerCase();
    const match = files.find((f) => f.lang.toLowerCase().startsWith(prefLower));
    if (match) return match;
  }
  return files[0] || null;
}

/** Keyword search → [{ url, title }] via yt-dlp ytsearch (no API key). */
async function searchYoutube(keyword, max = 15) {
  if (!keyword || !String(keyword).trim()) return [];
  const n = Math.max(1, Math.min(Number(max) || 15, 50));
  const { stdout } = await ytdlp.runYtDlp([`ytsearch${n}:${keyword}`, '--dump-json', '--flat-playlist', ...commonArgs()]);
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

/** Fetch metadata + captions (with Whisper ASR fallback) for one video URL. */
async function transcribeYoutube(url) {
  // 1. Metadata — best-effort. Captions/ASR below only need the URL, so a
  // metadata failure (e.g. bot-detection) shouldn't abort the whole attempt.
  let meta = {};
  let metaError = null;
  try {
    const { stdout: metaJson } = await ytdlp.runYtDlp(['--dump-single-json', '--skip-download', ...commonArgs(), url]);
    try {
      meta = JSON.parse(metaJson);
    } catch (err) {
      throw new MediaError('Could not parse yt-dlp metadata output.', { statusCode: 502, cause: err });
    }
  } catch (err) {
    metaError = err.message;
    console.warn(`[media] metadata fetch failed for ${url}: ${err.message}`);
  }
  const title = meta.title || '';
  const description = meta.description || '';

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mi-media-'));
  let transcript = '';
  let language = null;
  let source = 'captions';
  let captionError = null;
  let asrError = null;
  let asrAttempted = false;

  try {
    // 2. Captions
    try {
      await ytdlp.runYtDlp([
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        cfg.SUB_LANGS.join(','),
        '--sub-format',
        'json3',
        '--sleep-subtitles',
        String(cfg.SLEEP_SUBTITLES),
        ...commonArgs(),
        '-o',
        path.join(tmpDir, '%(id)s.%(ext)s'),
        url,
      ]);
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
      }
    } catch (err) {
      captionError = err.message;
      console.warn(`[media] caption fetch failed for ${url}: ${err.message}`);
    }

    // 3. ASR fallback — attempt whenever we still have no transcript, whether
    // that's because captions are genuinely missing or because yt-dlp itself
    // failed to fetch them (bot-detection, geo-block, transient errors, ...).
    if (!transcript.trim() && cfg.ASR_ENABLED) {
      asrAttempted = true;
      console.log(`[media] no transcript yet for ${url}; attempting Whisper ASR`);
      try {
        const ffmpegArgs = cfg.FFMPEG_PATH && cfg.FFMPEG_PATH !== 'ffmpeg' ? ['--ffmpeg-location', cfg.FFMPEG_PATH] : [];
        await ytdlp.runYtDlp([
          '-x',
          '--audio-format',
          'wav',
          '--postprocessor-args',
          'ffmpeg:-ar 16000 -ac 1',
          ...ffmpegArgs,
          ...commonArgs(),
          '-o',
          path.join(tmpDir, '%(id)s.%(ext)s'),
          url,
        ]);
        const wav = (await fsp.readdir(tmpDir)).find((n) => n.endsWith('.wav'));
        if (!wav) throw new MediaError('Audio extraction produced no WAV file.', { statusCode: 502 });
        const asr = await whisper.transcribeAudio(path.join(tmpDir, wav), tmpDir);
        if (asr.text.trim()) {
          transcript = asr.text;
          language = asr.language || 'asr';
          source = 'asr';
        }
      } catch (err) {
        asrError = err.message;
        console.warn(`[media] Whisper ASR failed for ${url}: ${err.message}`);
      }
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Hard-fail (422) when we still have no transcript — report everything
  // that was tried so operators can tell "yt-dlp is blocked everywhere" (check
  // cookies) apart from "this video really has no usable audio/captions".
  if (!transcript.trim()) {
    const reasons = [];
    if (metaError) reasons.push(`metadata fetch failed: ${metaError}`);
    if (captionError) reasons.push(`captions failed: ${captionError}`);
    if (asrError) reasons.push(`ASR failed: ${asrError}`);
    else if (asrAttempted) reasons.push('ASR produced no text');
    else if (!cfg.ASR_ENABLED) reasons.push('ASR disabled');
    throw new MediaError(`No usable transcript — ${reasons.join('; ')}`, { statusCode: 422 });
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

module.exports = { searchYoutube, transcribeYoutube, parseJson3, pickBestCaption };
