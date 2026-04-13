'use strict';

const path = require('path');

module.exports = function mountPageRoutes(app, deps) {
  const { frontendDir, createRateLimiter } = deps;
  const pageRateLimit = createRateLimiter({ max: 60 });

  app.get('/', pageRateLimit, (req, res) => {
    res.redirect(302, '/garage');
  });

  app.get('/leaderboard', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'leaderboard.html'));
  });

  app.get('/control', pageRateLimit, (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(frontendDir, 'control.html'));
  });

  app.get('/register', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'register.html'));
  });

  app.get('/login', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'login.html'));
  });

  app.get('/profile', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'profile.html'));
  });

  app.get('/verify-email', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'verify-email.html'));
  });

  app.get('/forgot-password', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'forgot-password.html'));
  });

  app.get('/reset-password', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'reset-password.html'));
  });

  app.get('/magic-link', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'magic-link.html'));
  });

  app.get('/garage', pageRateLimit, (req, res) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(frontendDir, 'garage.html'));
  });

  app.get('/broadcast', pageRateLimit, (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(frontendDir, 'broadcast.html'));
  });

  app.get('/track', pageRateLimit, (req, res) => {
    if (!req.session.userId) return res.redirect('/login?redirect=/track');
    res.redirect('/broadcast');
  });

  app.get('/admin', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin.html'));
  });

  app.get('/admin-users', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-users.html'));
  });

  app.get('/admin-news', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-news.html'));
  });

  app.get('/admin-audit', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-audit.html'));
  });

  app.get('/admin-sessions', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-sessions.html'));
  });

  app.get('/admin-transactions', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-transactions.html'));
  });

  app.get('/admin-analytics', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-analytics.html'));
  });

  app.get('/admin-cars', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-cars.html'));
  });

  app.get('/admin-investigation', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-investigation.html'));
  });

  app.get('/admin-chat', pageRateLimit, (req, res) => {
    res.sendFile(path.join(frontendDir, 'admin-chat.html'));
  });
};
