'use strict';

const nodemailer = require('nodemailer');

/**
 * Whether to skip actual email sending.
 * Enabled when NODE_ENV=test or DISABLE_EMAIL=true.
 */
const MAIL_DISABLED =
  process.env.NODE_ENV === 'test' || process.env.DISABLE_EMAIL === 'true';

/**
 * Lazy-initialised SMTP transporter (only created when email is enabled).
 */
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'localhost',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
      : undefined,
  });
  return _transporter;
}

/**
 * Send an email.
 *
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 * @returns {Promise<void>}
 */
async function sendMail({ to, subject, text, html }) {
  if (MAIL_DISABLED) {
    console.log('\n=== [MAIL DISABLED] Would send email ===');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('========================================\n');
    return;
  }

  const from = process.env.MAIL_FROM || '"Riley RC" <noreply@rileyrc.com>';
  await getTransporter().sendMail({ from, to, subject, text, html });
}

module.exports = { sendMail };
