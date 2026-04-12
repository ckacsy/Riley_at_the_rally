'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, DEFAULT_PRAGMAS } = require('../../db/connection');

describe('openDatabase', () => {
  it('applies default PRAGMA to in-memory database', () => {
    const db = openDatabase(':memory:');

    // foreign_keys must be ON
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.strictEqual(fk, 1, 'foreign_keys should be enabled');

    // busy_timeout should be set
    const bt = db.pragma('busy_timeout', { simple: true });
    assert.strictEqual(bt, 5000, 'busy_timeout should be 5000');

    // synchronous should be NORMAL (1)
    const sync = db.pragma('synchronous', { simple: true });
    assert.strictEqual(sync, 1, 'synchronous should be NORMAL (1)');

    db.close();
  });

  it('applies PRAGMA to file-based database', () => {
    const path = require('path');
    const fs = require('fs');
    const crypto = require('crypto');
    const tmpPath = path.join(require('os').tmpdir(), `test-riley-${crypto.randomBytes(8).toString('hex')}.sqlite`);

    try {
      const db = openDatabase(tmpPath);

      const jm = db.pragma('journal_mode', { simple: true });
      assert.strictEqual(jm, 'wal', 'journal_mode should be WAL');

      const fk = db.pragma('foreign_keys', { simple: true });
      assert.strictEqual(fk, 1, 'foreign_keys should be enabled');

      const bt = db.pragma('busy_timeout', { simple: true });
      assert.strictEqual(bt, 5000);

      const sync = db.pragma('synchronous', { simple: true });
      assert.strictEqual(sync, 1);

      db.close();
    } finally {
      // Cleanup: remove DB file and WAL/SHM files
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpPath + suffix); } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
    }
  });

  it('allows PRAGMA overrides', () => {
    const db = openDatabase(':memory:', {}, { busy_timeout: 10000 });

    const bt = db.pragma('busy_timeout', { simple: true });
    assert.strictEqual(bt, 10000, 'busy_timeout should be overridden to 10000');

    // Other defaults still apply
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.strictEqual(fk, 1);

    db.close();
  });
});
