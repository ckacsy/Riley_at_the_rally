'use strict';

/**
 * Helper for writing entries to the admin_audit_log table.
 *
 * All parameters except `db`, `adminId`, `action`, and `targetType` are
 * optional.  Missing optional fields are stored as NULL and will not cause
 * the function to throw.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   adminId: number,
 *   action: string,
 *   targetType: string,
 *   targetId?: number|null,
 *   details?: object|null,
 *   ipAddress?: string|null,
 *   userAgent?: string|null,
 * }} data
 */
function logAdminAudit(db, data) {
  const { adminId, action, targetType, targetId, details, ipAddress, userAgent } = data || {};
  try {
    const detailsJson = details != null ? JSON.stringify(details) : null;
    db.prepare(
      `INSERT INTO admin_audit_log
         (admin_id, action, target_type, target_id, details_json, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      adminId,
      action,
      targetType,
      targetId != null ? targetId : null,
      detailsJson,
      ipAddress || null,
      userAgent || null,
    );
  } catch (e) {
    console.error('[adminAudit] Failed to write audit log:', e.message);
  }
}

module.exports = { logAdminAudit };
