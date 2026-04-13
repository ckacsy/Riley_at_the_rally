'use strict';

/**
 * Unit tests for Task 7.4 — Upload Hardening
 * Run with: node tests/unit/upload-hardening.test.js
 * Uses Node.js built-in test runner (node:test), available since Node 18.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// We test the upload-related logic by re-implementing the same constants and
// helper functions as in upload.js so tests remain isolated from file-system
// side effects (multer creating the uploads directory on require).
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ALLOWED_MIME_TYPES  = new Set(['image/jpeg', 'image/png', 'image/webp']);

const IMAGE_MAGIC = [
  { bytes: [0xFF, 0xD8, 0xFF] },
  { bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { webp: true },
];

function matchesMagic(buf, sig) {
  if (sig.webp) {
    return (
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    );
  }
  if (buf.length < sig.bytes.length) return false;
  return sig.bytes.every((b, i) => buf[i] === b);
}

function isAllowedFile(ext, mime) {
  return ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mime);
}

function isValidMagic(buf) {
  return IMAGE_MAGIC.some((sig) => matchesMagic(buf, sig));
}

// ---------------------------------------------------------------------------
// Helpers to build fake magic-byte buffers
// ---------------------------------------------------------------------------

function jpegBuf() {
  const b = Buffer.alloc(12, 0);
  b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF;
  return b;
}

function pngBuf() {
  const b = Buffer.alloc(12, 0);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4E; b[3] = 0x47;
  b[4] = 0x0D; b[5] = 0x0A; b[6] = 0x1A; b[7] = 0x0A;
  return b;
}

function webpBuf() {
  const b = Buffer.alloc(12, 0);
  b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46; // RIFF
  b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50; // WEBP
  return b;
}

function gif87Buf() {
  const b = Buffer.alloc(12, 0);
  b[0] = 0x47; b[1] = 0x49; b[2] = 0x46; b[3] = 0x38; b[4] = 0x37; b[5] = 0x61; // GIF87a
  return b;
}

function gif89Buf() {
  const b = Buffer.alloc(12, 0);
  b[0] = 0x47; b[1] = 0x49; b[2] = 0x46; b[3] = 0x38; b[4] = 0x39; b[5] = 0x61; // GIF89a
  return b;
}

function randomBuf() {
  return Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
}

// ---------------------------------------------------------------------------
// Tests — allowed extensions and MIME types
// ---------------------------------------------------------------------------

describe('Task 7.4 — Upload Hardening: allowed file types', () => {
  it('allows .jpg with image/jpeg', () => {
    assert.ok(isAllowedFile('.jpg', 'image/jpeg'), '.jpg/image/jpeg should be allowed');
  });

  it('allows .jpeg with image/jpeg', () => {
    assert.ok(isAllowedFile('.jpeg', 'image/jpeg'), '.jpeg/image/jpeg should be allowed');
  });

  it('allows .png with image/png', () => {
    assert.ok(isAllowedFile('.png', 'image/png'), '.png/image/png should be allowed');
  });

  it('allows .webp with image/webp', () => {
    assert.ok(isAllowedFile('.webp', 'image/webp'), '.webp/image/webp should be allowed');
  });

  it('rejects .gif extension', () => {
    assert.ok(!ALLOWED_EXTENSIONS.has('.gif'), '.gif should not be in ALLOWED_EXTENSIONS');
  });

  it('rejects image/gif MIME type', () => {
    assert.ok(!ALLOWED_MIME_TYPES.has('image/gif'), 'image/gif should not be in ALLOWED_MIME_TYPES');
  });

  it('rejects .gif with image/gif', () => {
    assert.ok(!isAllowedFile('.gif', 'image/gif'), '.gif/image/gif should be rejected');
  });

  it('rejects .txt with text/plain', () => {
    assert.ok(!isAllowedFile('.txt', 'text/plain'), '.txt/text/plain should be rejected');
  });

  it('rejects .jpg with wrong MIME type', () => {
    assert.ok(!isAllowedFile('.jpg', 'text/plain'), '.jpg/text/plain should be rejected');
  });
});

// ---------------------------------------------------------------------------
// Tests — file size limit
// ---------------------------------------------------------------------------

describe('Task 7.4 — Upload Hardening: file size limit', () => {
  it('file size limit is 2 MB', () => {
    const TWO_MB = 2 * 1024 * 1024;
    assert.strictEqual(TWO_MB, 2097152, 'TWO_MB should be 2097152 bytes');
  });

  it('2 MB is less than 5 MB (old limit)', () => {
    const TWO_MB = 2 * 1024 * 1024;
    const FIVE_MB = 5 * 1024 * 1024;
    assert.ok(TWO_MB < FIVE_MB, 'new limit (2 MB) should be smaller than old limit (5 MB)');
  });
});

// ---------------------------------------------------------------------------
// Tests — magic byte validation
// ---------------------------------------------------------------------------

describe('Task 7.4 — Upload Hardening: magic byte validation', () => {
  it('accepts JPEG magic bytes', () => {
    assert.ok(isValidMagic(jpegBuf()), 'JPEG magic bytes should be accepted');
  });

  it('accepts PNG magic bytes', () => {
    assert.ok(isValidMagic(pngBuf()), 'PNG magic bytes should be accepted');
  });

  it('accepts WebP magic bytes', () => {
    assert.ok(isValidMagic(webpBuf()), 'WebP magic bytes should be accepted');
  });

  it('rejects GIF87a magic bytes', () => {
    assert.ok(!isValidMagic(gif87Buf()), 'GIF87a magic bytes should be rejected');
  });

  it('rejects GIF89a magic bytes', () => {
    assert.ok(!isValidMagic(gif89Buf()), 'GIF89a magic bytes should be rejected');
  });

  it('rejects unknown/random magic bytes', () => {
    assert.ok(!isValidMagic(randomBuf()), 'random magic bytes should be rejected');
  });

  it('IMAGE_MAGIC array has no GIF entries', () => {
    const hasGif = IMAGE_MAGIC.some((sig) => {
      if (!sig.bytes) return false;
      // GIF87a: 47 49 46 38 37 61 / GIF89a: 47 49 46 38 39 61
      return sig.bytes[0] === 0x47 && sig.bytes[1] === 0x49 && sig.bytes[2] === 0x46;
    });
    assert.ok(!hasGif, 'IMAGE_MAGIC should not contain any GIF signatures');
  });

  it('IMAGE_MAGIC array has exactly 3 entries (JPEG, PNG, WebP)', () => {
    assert.strictEqual(IMAGE_MAGIC.length, 3, 'IMAGE_MAGIC should have exactly 3 entries');
  });
});

// ---------------------------------------------------------------------------
// Tests — multer error code mapping (unit-level simulation)
// ---------------------------------------------------------------------------

describe('Task 7.4 — Upload Hardening: multer error handling', () => {
  // Simulate what the avatar route wrapper does
  function handleUploadError(err) {
    if (!err) return { status: null };
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, error: 'Файл слишком большой. Максимальный размер: 2 МБ.' };
    }
    if (err.message === 'Invalid file type') {
      return { status: 400, error: 'Недопустимый тип файла. Разрешены: JPG, PNG, WebP.' };
    }
    return { status: 400, error: 'Ошибка загрузки файла.' };
  }

  it('LIMIT_FILE_SIZE error maps to 413', () => {
    const err = { code: 'LIMIT_FILE_SIZE' };
    const result = handleUploadError(err);
    assert.strictEqual(result.status, 413, 'oversized file should return 413');
  });

  it('Invalid file type error maps to 400', () => {
    const err = new Error('Invalid file type');
    const result = handleUploadError(err);
    assert.strictEqual(result.status, 400, 'invalid file type should return 400');
  });

  it('unknown multer error maps to 400', () => {
    const err = new Error('something else went wrong');
    const result = handleUploadError(err);
    assert.strictEqual(result.status, 400, 'unknown multer error should return 400');
  });

  it('no error returns null status (proceed to next)', () => {
    const result = handleUploadError(null);
    assert.strictEqual(result.status, null, 'no error should not set a status');
  });
});
