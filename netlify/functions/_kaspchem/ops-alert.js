'use strict';
// Operational and security alerts by email to everyone in KASPCHEM_NOTIFY_EMAILS (both owners).
// Rules: short, never any personal data about applicants or visitors; a failure to send never breaks the request that triggered it.
// Tests inject a recorder with setSender().
const { logError } = require('./http');

let sender = null;
function setSender(fn) { sender = fn; }

async function deliver(subject, text) {
  if (sender) return sender({ subject, text });
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.KASPCHEM_NOTIFY_EMAILS) return;
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }, connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 5000 });
  await t.sendMail({ from: process.env.GMAIL_USER, to: process.env.KASPCHEM_NOTIFY_EMAILS, subject, text });
}

// An alert may take at most a few seconds: a stuck mail server must not hold up the visitor or the admin whose request triggered it (the lead is already saved by then).
async function opsAlert(subject, text) {
  const limit = Number(process.env.KASPCHEM_ALERT_TIMEOUT_MS) || 4000; let timer;
  try {
    await Promise.race([
      deliver('כספכם: ' + subject, String(text || '') + '\n\nדשבורד: https://matzpenkalkali.com/admin/kaspchem/'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('alert timed out')), limit); }),
    ]);
  } catch (e) { logError('opsAlert', e); } finally { clearTimeout(timer); }
}

module.exports = { opsAlert, setSender };
