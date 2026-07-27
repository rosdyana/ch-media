/**
 * Direct audio upload transcription: convert to 16 kHz mono WAV, then run
 * whisper.cpp. No fallback chain (unlike youtube.js) — ASR is the only path.
 */

const path = require('path');
const { convertToWav16kMono } = require('./ffmpeg');
const { transcribeAudio } = require('./whisper');

async function transcribeUploadedAudio(inputPath, tmpDir) {
  const wavPath = path.join(tmpDir, 'converted.wav');
  await convertToWav16kMono(inputPath, wavPath);
  const { text, language } = await transcribeAudio(wavPath, tmpDir);
  return { text, language };
}

module.exports = { transcribeUploadedAudio };
