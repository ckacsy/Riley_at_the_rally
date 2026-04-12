'use strict';

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const metrics = require('../metrics');

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'avatar-' + req.session.userId + '-' + Date.now() + ext);
  },
});

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    // Reject filenames containing null bytes (can bypass extension checks on some systems)
    if (file.originalname.includes('\0')) {
      return cb(new Error('Invalid filename'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error('Invalid file type'));
    }
    cb(null, true);
  },
});

// Magic byte signatures for each allowed image type.
// Checked after multer writes the file to disk.
const IMAGE_MAGIC = [
  { bytes: [0xFF, 0xD8, 0xFF] },                                              // JPEG
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },              // PNG
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },                           // GIF87a
  { bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },                           // GIF89a
  // WebP: "RIFF" at bytes 0-3 and "WEBP" at bytes 8-11
  { webp: true },
];

function matchesMagic(buf, sig) {
  if (sig.webp) {
    return (
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50  // WEBP
    );
  }
  if (buf.length < sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[i] === b);
}

/**
 * Middleware to verify the magic bytes of an uploaded file after multer has
 * written it to disk.  Must be placed immediately after `upload.single(...)`.
 * Deletes the file and returns 400 if the signature does not match any allowed
 * image format.
 */
function validateMagicBytes(req, res, next) {
  if (!req.file) return next();

  // Resolve and validate the path stays within uploadsDir (defense-in-depth)
  const resolvedUploadsDir = path.resolve(uploadsDir);
  const resolvedPath = path.resolve(req.file.path);
  if (!resolvedPath.startsWith(resolvedUploadsDir + path.sep)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Файл не загружен или неверный формат' });
  }

  let buf;
  try {
    buf = Buffer.alloc(12);
    const fd = fs.openSync(resolvedPath, 'r');
    try {
      fs.readSync(fd, buf, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    metrics.log('warn', 'validateMagicBytes: failed to read file', { path: resolvedPath, err: err.message });
    fs.unlink(resolvedPath, () => {});
    return res.status(400).json({ error: 'Файл не загружен или неверный формат' });
  }

  if (!IMAGE_MAGIC.some((sig) => matchesMagic(buf, sig))) {
    fs.unlink(resolvedPath, () => {});
    return res.status(400).json({ error: 'Файл не загружен или неверный формат' });
  }
  next();
}

module.exports = { upload, uploadsDir, validateMagicBytes };
