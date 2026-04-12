module.exports = function(db) {
  const cols = new Set(db.pragma('table_info(rental_sessions)').map(c => c.name));
  if (!cols.has('termination_reason')) {
    db.exec('ALTER TABLE rental_sessions ADD COLUMN termination_reason TEXT');
  }
};
