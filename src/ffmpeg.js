/**
 * ffmpeg subprocess wrapper for converting an arbitrary uploaded audio file
 * into the 16 kHz mono WAV that whisper.cpp expects (see src/whisper.js).
 */

const cfg = require('./config');
const { MediaError, execRaw } = require('./ytdlp');

async function convertToWav16kMono(inputPath, outputPath, timeoutMs = cfg.UPLOAD_FFMPEG_TIMEOUT_MS) {
  try {
    await execRaw(cfg.FFMPEG_PATH, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', outputPath], timeoutMs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new MediaError(`ffmpeg not found (looked for "${cfg.FFMPEG_PATH}"). Install it or set FFMPEG_PATH.`);
    }
    throw new MediaError(`ffmpeg conversion failed: ${err.stderr || err.message}`, { cause: err });
  }
  return outputPath;
}

module.exports = { convertToWav16kMono };
