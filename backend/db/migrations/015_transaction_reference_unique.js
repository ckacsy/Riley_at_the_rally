// Migration 015: add a UNIQUE partial index on transactions(reference_id, type)
// so that for any given session reference there can be at most one hold,
// one release, and one deduct — preventing duplicate money operations.
module.exports = function (db) {
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_ref_type ' +
      'ON transactions(reference_id, type) ' +
      'WHERE reference_id IS NOT NULL'
    );
  } catch (e) {
    // Index may already exist on an upgraded DB — ignore
    if (!e.message || !e.message.includes('already exists')) {
      throw e;
    }
  }
};
