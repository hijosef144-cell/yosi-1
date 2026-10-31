'use strict';
const crypto = require('crypto');
const { json, fail, HttpError, parseBody, sameOrigin, clientIp, header, logError } = require('./_kaspchem/http');
const { normalizePhone, cleanText, cleanEmail } = require('./_kaspchem/validate');
const content = require('./_kaspchem/content');
const db = require('./_kaspchem/db');
const engine = require('../../kaspchem/assets/engine.js');

const CONSENT_VERSION = 'consent-2026-10-v1'; // bump whenever the on-screen consent wording changes
const MAX_PER_HOUR = () => Number(process.env.KASPCHEM_RATE_MAX) || 5;

const ipHash = (ip) => crypto.createHash('sha256').update((process.env.KASPCHEM_HASH_SALT || 'dev-salt') + '|' + ip).digest('hex').slice(0, 32);

async function notify() {
  // Privacy: the notification contains NO personal details, only that something arrived.
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD || !process.env.KASPCHEM_NOTIFY_EMAILS) return;
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    await t.sendMail({
      from: process.env.GMAIL_USER, to: process.env.KASPCHEM_NOTIFY_EMAILS,
      subject: 'כספכם: התקבלה פנייה חדשה',
      text: 'התקבלה פנייה חדשה. הפרטים זמינים בדשבורד: https://matzpenkalkali.com/admin/kaspchem/'
    });
  } catch (e) { logError('notify', e); }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'method_not_allowed');
  try {
    if (!sameOrigin(event)) throw new HttpError(403, 'bad_origin');
    const b = parseBody(event, 20000);

    // Honeypot: real users never fill the hidden field. Respond as if it worked so bots learn nothing.
    if (b.website) return json(200, { ok: true });

    // Launch gate: leads are accepted only after an admin confirms the legal texts were approved by counsel.
    const gate = await db.query("SELECT value FROM settings WHERE key = 'public.legal_approved'");
    if (!gate.length || gate[0].value !== true) throw new HttpError(403, 'not_open', 'השארת פרטים תיפתח בקרוב.');

    const topic = await content.loadTopic(String(b.topic || ''));
    if (!topic) throw new HttpError(400, 'bad_topic');

    const name = cleanText(b.name, 2, 80);
    const phone = normalizePhone(b.phone);
    const email = cleanEmail(b.email);
    if (!name) throw new HttpError(400, 'bad_name', 'נא להזין שם');
    if (!phone) throw new HttpError(400, 'bad_phone', 'נא להזין מספר טלפון תקין');
    if (email === null) throw new HttpError(400, 'bad_email', 'כתובת הדוא״ל אינה תקינה');
    if (b.consentContact !== true) throw new HttpError(400, 'consent_required', 'נדרש אישור לחזרה אליכם בנושא הבדיקה');

    // The outcome is recomputed here from the stored rules; whatever the browser claims is ignored.
    const answers = b.answers;
    if (!engine.validateAnswers(topic, answers)) throw new HttpError(400, 'bad_answers');
    const result = engine.evaluate(topic, answers);

    const hash = ipHash(clientIp(event));
    if (db.configured()) {
      const recent = await db.query("SELECT count(*)::int AS n FROM rate_limits WHERE bucket = 'lead' AND ip_hash = $1 AND hit_at > now() - interval '1 hour'", [hash]);
      if (recent[0].n >= MAX_PER_HOUR()) throw new HttpError(429, 'rate_limited', 'בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר.');
    }
    await db.query("INSERT INTO rate_limits (bucket, ip_hash) VALUES ('lead', $1)", [hash]);
    await db.query("DELETE FROM rate_limits WHERE hit_at < now() - interval '1 day'");

    const rows = await db.query(
      `WITH a AS (
         INSERT INTO applicants (name, phone, email) VALUES ($1, $2, NULLIF($3, ''))
         ON CONFLICT (phone) DO UPDATE SET email = COALESCE(applicants.email, EXCLUDED.email)
         RETURNING id),
       r AS (
         INSERT INTO treatment_requests (applicant_id, topic, questionnaire_id, questionnaire_ver, answers, outcome, findings, consent_contact, consent_marketing)
         SELECT id, $4, $5::bigint, $6, $7::jsonb, $8, $9::jsonb, true, $10::boolean FROM a
         RETURNING id, applicant_id),
       c AS (
         INSERT INTO consents (applicant_id, request_id, kind, granted, text_version, ip_hash)
         SELECT applicant_id, id, 'contact', true, $11, $12 FROM r
         UNION ALL
         SELECT applicant_id, id, 'marketing', $10::boolean, $11, $12 FROM r
         RETURNING 1)
       SELECT id FROM r`,
      [name, phone, email, topic.id, topic.questionnaireId, topic.versionLabel, JSON.stringify(answers), result.outcome,
        JSON.stringify(result.findings.map((f) => f.id)), b.consentMarketing === true, CONSENT_VERSION, hash]);

    await notify();
    return json(200, { ok: true, ref: Number(rows[0].id) });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.userMessage);
    logError('lead', e);
    return fail(500, 'server_error', 'משהו השתבש בקליטת הפנייה. נסו שוב בעוד רגע.');
  }
};
exports.CONSENT_VERSION = CONSENT_VERSION;
