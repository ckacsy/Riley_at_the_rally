'use strict';

/**
 * Role and status constants, weights, and helpers for RBAC.
 *
 * Roles are ordered by ascending privilege weight:
 *   user (10) < moderator (20) < admin (30)
 *
 * Unknown roles are assigned weight 0 and are treated as having no privileges.
 */

const ROLE_WEIGHTS = {
  user: 10,
  moderator: 20,
  admin: 30,
};

const STATUSES = {
  pending: 'pending',
  active: 'active',
  banned: 'banned',
  deleted: 'deleted',
};

/**
 * Returns the numeric weight for a given role string.
 * Unknown roles return 0.
 *
 * @param {string} role
 * @returns {number}
 */
function getRoleWeight(role) {
  return ROLE_WEIGHTS[role] || 0;
}

/**
 * Returns true if `role` is one of the recognised role strings.
 *
 * @param {string} role
 * @returns {boolean}
 */
function isKnownRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_WEIGHTS, role);
}

/**
 * Returns true if `status` is one of the recognised status strings.
 *
 * @param {string} status
 * @returns {boolean}
 */
function isKnownStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUSES, status);
}

/**
 * Returns true when `userRole` satisfies at least one of `allowedRoles`
 * (i.e. the user's weight is >= the minimum weight among allowedRoles).
 *
 * @param {string} userRole
 * @param {string[]} allowedRoles
 * @returns {boolean}
 */
function hasRequiredRole(userRole, allowedRoles) {
  const userWeight = getRoleWeight(userRole);
  if (userWeight === 0) return false;
  // The user meets the requirement if their weight is >= the weight of any
  // allowed role (which means their role is at least as privileged).
  return allowedRoles.some((r) => userWeight >= getRoleWeight(r));
}

/**
 * Returns null if the given status allows access, or an error descriptor
 * object if access should be blocked.  Uses an allow-list approach: only
 * 'active' users are permitted; every other status is explicitly rejected.
 *
 * @param {string} status
 * @returns {null | { code: string, message: string }}
 */
function getAccessBlockReason(status) {
  if (status === 'active') return null;
  if (status === 'pending') return { code: 'pending_verification', message: 'Подтвердите email для доступа к этой функции.' };
  if (status === 'banned')  return { code: 'account_banned',       message: 'Аккаунт заблокирован.' };
  if (status === 'deleted') return { code: 'account_deleted',      message: 'Аккаунт недоступен.' };
  return { code: 'account_inactive', message: 'Аккаунт недоступен.' };
}

/**
 * Returns true when `actor` may perform privileged actions on `target`.
 * An actor can only act on users whose role weight is strictly lower than
 * their own.  Unknown or missing roles on either side are treated as weight 0
 * and therefore denied.
 *
 * @param {{ role?: string }} actor
 * @param {{ role?: string }} target
 * @returns {boolean}
 */
function canActOn(actor, target) {
  if (!actor || !target) return false;
  if (!actor.role || !target.role) return false; // missing role ⇒ no privilege
  const actorWeight = getRoleWeight(actor.role);
  if (actorWeight === 0) return false;
  const targetWeight = getRoleWeight(target.role);
  return actorWeight > targetWeight;
}

module.exports = {
  ROLE_WEIGHTS,
  STATUSES,
  getRoleWeight,
  isKnownRole,
  isKnownStatus,
  hasRequiredRole,
  canActOn,
  getAccessBlockReason,
};
