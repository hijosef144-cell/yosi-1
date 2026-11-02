'use strict';
const crypto = require('crypto');
const { json, fail, HttpError, parseBody, sameOrigin, clientIp, header, logError } = require('./_kaspchem/http');
const { normalizePhone, cleanText, cleanEmail } = require('./_kaspchem/validate');
const content = require('./_kaspchem/content');
const db = require('./_kaspchem/db');
const { opsAlert } = require('./_kaspchem/ops-alert');
const engine = require('../../kaspchem/assets/engine.js');

const CONSENT_VERSION = 'consent-2026-10-v1'; // bump whenever the on-screen consent wording changes
const MAX_PER_HOUR = () => Number(process.env.KASPCHEM_RATE_MAX) || 5;

const ipHash = (ip) => crypto.createHash('sha256').update((process.env.KASPCHEM_HASH_SALT || 'dev-salt') + '|' + ip).digest('hex').slice(0, 32);


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
      const recent = await db.query("SELECT count(*) FILTER (WHERE ip_hash = $1)::int AS n, count(*)::int AS total FROM rate_limits WHERE bucket = 'lead' AND hit_at > now() - interval '1 hour'", [hash]);
      // per-IP cap, plus a global cap so a botnet can't flood the inbox from many addresses
      const globalCap = Number(process.env.KASPCHEM_RATE_GLOBAL) || 60;
      if (recent[0].total >= globalCap) {
        // many different senders at once: possible flood. One alert per hour (a marker row in the same throttle table).
        const seen = await db.query("SELECT count(*)::int AS n FROM rate_limits WHERE bucket = 'alert-flood' AND hit_at > now() - interval '1 hour'");
        if (!seen[0].n) { await db.query("INSERT INTO rate_limits (bucket, ip_hash) VALUES ('alert-flood', 'global')"); await opsAlert('חריגה ממגבלת הפניות הכללית (חשד לספאם)', 'מספר הפניות בשעה האחרונה הגיע למגבלה (' + globalCap + '). בדקו את הדשבורד.'); }
      }
      if (recent[0].n >= MAX_PER_HOUR() || recent[0].total >= globalCap) throw new HttpError(429, 'rate_limited', 'בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר.');
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

    // Every successfully received lead alerts everyone in KASPCHEM_NOTIFY_EMAILS. Only a request number and the field of the check: no name, phone, e-mail or answers.
    await opsAlert('התקבלה פנייה חדשה', 'התקבלה פנייה חדשה בתחום "' + topic.name + '" (מספר פנייה ' + rows[0].id + '). הפרטים זמינים בדשבורד בלבד.');
    return json(200, { ok: true, ref: Number(rows[0].id) });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.userMessage);
    logError('lead', e);
    await opsAlert('תקלה בקליטת פנייה', 'אירעה שגיאת שרת בקליטת פנייה (קוד: ' + String((e && (e.code || e.name)) || 'unknown').slice(0, 40) + '). ייתכן שפונה לא הצליח להשאיר פרטים.');
    return fail(500, 'server_error', 'משהו השתבש בקליטת הפנייה. נסו שוב בעוד רגע.');
  }
};
exports.CONSENT_VERSION = CONSENT_VERSION;
