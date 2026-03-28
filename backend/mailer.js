'use strict';

const nodemailer = require('nodemailer');

/**
 * Whether to skip actual email sending.
 * Enabled when NODE_ENV=test or DISABLE_EMAIL=true.
 */
const MAIL_DISABLED =
  process.env.NODE_ENV === 'test' || process.env.DISABLE_EMAIL === 'true';

if (MAIL_DISABLED) {
  console.log('[Mailer] Email sending is DISABLED (NODE_ENV=test or DISABLE_EMAIL=true). Verification links will be printed to server console instead.');
} else if (!process.env.SMTP_HOST) {
  console.warn('[Mailer] WARNING: SMTP_HOST is not set; defaulting to localhost. Email delivery will likely fail. Set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in .env to enable email sending.');
}

/**
 * Lazy-initialised SMTP transporter (only created when email is enabled).
 */
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const smtpHost = process.env.SMTP_HOST || 'localhost';
  const tlsOpts = { rejectUnauthorized: true };
  if (process.env.SMTP_TLS_SERVERNAME) {
    tlsOpts.servername = process.env.SMTP_TLS_SERVERNAME;
  }
  _transporter = nodemailer.createTransport({
    host: smtpHost,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
    tls: tlsOpts,
  });
  return _transporter;
}

/**
 * Verify the SMTP connection.  Call once at startup for an early warning if
 * SMTP is misconfigured.  Resolves silently on success; logs a warning on
 * failure (does NOT throw).
 *
 * @returns {Promise<void>}
 */
async function verifyConnection() {
  if (MAIL_DISABLED) return;
  try {
    await getTransporter().verify();
    console.log('[Mailer] SMTP connection verified successfully.');
  } catch (err) {
    console.warn('[Mailer] WARNING: SMTP connection verification failed:', err.message);
    console.warn('[Mailer] Check SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in your .env file.');
  }
}

/**
 * Send an email.
 *
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 * @returns {Promise<void>}
 */
async function sendMail({ to, subject, text, html }) {
  if (MAIL_DISABLED) {
    console.log('\n=== [MAIL DISABLED] Email not sent — printing to console instead ===');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('=====================================================================\n');
    return;
  }

  const from = process.env.MAIL_FROM || '"Riley RC" <noreply@rileyrc.com>';
  try {
    await getTransporter().sendMail({ from, to, subject, text, html });
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Mailer] Email sent successfully to ${to} (subject: "${subject}")`);
    }
  } catch (err) {
    console.error('[Mailer] Failed to send email to', to, '—', err.message);
    throw err;
  }
}

module.exports = { sendMail, verifyConnection };
