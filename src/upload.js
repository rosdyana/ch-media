/**
 * Multipart upload handling for POST /audio/transcribe — multer disk storage
 * (one mkdtemp'd tmp dir per request) + format validation.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const multer = require('multer');
const cfg = require('./config');
const { MediaError } = require('./ytdlp');

/** Extension whitelist is authoritative; mimetype is a secondary cross-check
 * with an escape hatch for generic/missing client-supplied content types. */
function assertAllowedFile(originalname, mimetype) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (!cfg.UPLOAD_ALLOWED_EXTENSIONS.includes(ext)) {
    throw new MediaError(
      `Unsupported file extension "${ext || '(none)'}" — allowed: ${cfg.UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`,
      { statusCode: 415 },
    );
  }
  const mt = (mimetype || '').toLowerCase();
  const mimeOk = !mt || mt === 'application/octet-stream' || cfg.UPLOAD_ALLOWED_MIMETYPES.includes(mt);
  if (!mimeOk) {
    throw new MediaError(`Unsupported content type "${mimetype}" for extension "${ext}"`, { statusCode: 415 });
  }
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      if (!req.uploadTmpDir) {
        req.uploadTmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mi-upload-'));
      }
      cb(null, req.uploadTmpDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    cb(null, `source${path.extname(file.originalname || '')}`);
  },
});

function fileFilter(req, file, cb) {
  try {
    assertAllowedFile(file.originalname, file.mimetype);
    cb(null, true);
  } catch (err) {
    cb(err);
  }
}

const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: { fileSize: cfg.UPLOAD_MAX_BYTES, files: 1 },
}).single('audio');

/** Promisified multer middleware, mapping its errors onto MediaError so callers can
 * `await` it inside the existing `handle()` route wrapper. */
function runUpload(req, res) {
  return new Promise((resolve, reject) => {
    uploadMiddleware(req, res, (err) => {
      if (!err) return resolve();
      if (err instanceof MediaError) return reject(err);
      if (err instanceof multer.MulterError) {
        const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `File exceeds the ${cfg.UPLOAD_MAX_BYTES}-byte upload limit`
            : `Upload error: ${err.message}`;
        return reject(new MediaError(message, { statusCode, cause: err }));
      }
      reject(new MediaError(`Upload failed: ${err.message}`, { cause: err }));
    });
  });
}

module.exports = { assertAllowedFile, runUpload };
