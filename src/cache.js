/**
 * Long-lived cache of finished YouTube transcripts, one Redis key per video id.
 *
 * Deliberately not just BullMQ's job retention: BullMQ trims its whole
 * `completed` set by the age of whichever job just finished, so keeping YouTube
 * results for a year there would mean keeping *every* job's result for a year
 * (uploaded-audio transcripts included) — or having the next short-retention
 * job wipe them. A plain key with a native EXPIRE has neither problem, and
 * JOB_RETENTION_MS stays short.
 *
 * Every function is best-effort: a Redis or JSON hiccup degrades to a cache
 * miss (or a skipped write) rather than failing the request/job around it.
 * With TRANSCRIPT_CACHE_TTL_SEC <= 0 the cache is off and all of them no-op.
 */

const cfg = require('./config');
const { getConnection } = require('./queue');

const key = (videoId) => `ch-media:yt-cache:${videoId}`;
const enabled = () => cfg.TRANSCRIPT_CACHE_TTL_SEC > 0;

async function hasCachedTranscript(videoId, redis = getConnection()) {
  if (!enabled()) return false;
  try {
    return (await redis.exists(key(videoId))) === 1;
  } catch (err) {
    console.warn(`[media] transcript cache lookup failed for ${videoId}: ${err.message}`);
    return false;
  }
}

async function getCachedTranscript(videoId, redis = getConnection()) {
  if (!enabled()) return null;
  try {
    const raw = await redis.get(key(videoId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`[media] transcript cache read failed for ${videoId}: ${err.message}`);
    return null;
  }
}

async function setCachedTranscript(videoId, result, redis = getConnection()) {
  if (!enabled()) return;
  try {
    await redis.set(key(videoId), JSON.stringify(result), 'EX', cfg.TRANSCRIPT_CACHE_TTL_SEC);
  } catch (err) {
    console.warn(`[media] transcript cache write failed for ${videoId}: ${err.message}`);
  }
}

async function deleteCachedTranscript(videoId, redis = getConnection()) {
  try {
    await redis.del(key(videoId));
  } catch (err) {
    console.warn(`[media] transcript cache delete failed for ${videoId}: ${err.message}`);
  }
}

module.exports = { hasCachedTranscript, getCachedTranscript, setCachedTranscript, deleteCachedTranscript };
