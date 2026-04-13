'use strict';

const createAuthHelpers = require('../lib/auth-helpers');
const setupLogin = require('./auth-login');
const setupRegister = require('./auth-register');
const setupMagicLink = require('./auth-magic-link');
const setupPassword = require('./auth-password');
const setupProfile = require('./auth-profile');

module.exports = function mountAuthRoutes(app, db, deps) {
  const helpers = createAuthHelpers(db, deps);

  setupLogin(app, db, helpers, deps);
  setupRegister(app, db, helpers, deps);
  setupMagicLink(app, db, helpers, deps);
  setupPassword(app, db, helpers, deps);
  setupProfile(app, db, helpers, deps);

  const {
    requireAuth,
    requireActiveUser,
    loadCurrentUser,
    requireRole,
    invalidateUserSessions,
    _devVerificationLinks,
    _devMagicLinks,
    _devResetLinks,
  } = helpers;

  return { requireAuth, requireActiveUser, loadCurrentUser, requireRole, invalidateUserSessions, _devVerificationLinks, _devMagicLinks, _devResetLinks };
};
