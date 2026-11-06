'use strict';
// Impact counter, simple model. The owners type ONE starting point (families helped, shekels saved or obtained) and switch the counter on or off.
// From then on a treatment marked "done" in the dashboard with an amount is added automatically. Everything below is the hidden logic that makes
// that add up correctly; none of it is shown in the dashboard. Totals are computed when read; nothing is stored as a running total, and reading
// never writes anything.
//
//   reference point = the cutoff date (settings private.impact_baseline_cutoff). It is FIXED: written once, when the starting numbers are saved for the
//                     first time (today), and never moved by later saves. Editing the starting numbers later changes only the starting part; the
//                     automatic part does not depend on them. Together with it, private.impact_reference_at (the exact moment of that first save) is
//                     written once; data created before this key existed simply has no such moment.
//   starting point  = every non-voided baseline row in `outcomes` (normally exactly one): its family_count and amount, summed as they are
//   automatic part  = outcomes of treatments whose request is still in status 'done'; an outcome counts if it is documented, amount > 0, not voided and
//                     AFTER the reference: completed_on > cutoff, or completed_on = cutoff and the row was created after the reference moment (only when
//                     that moment exists; otherwise strictly after the date). ALL counted outcomes of one request are summed (a request may hold more
//                     than one: old data allowed one per kind), so nothing recorded is ever dropped and nothing is added twice.
//   families        = starting families + NEW applicants of the automatic part. An applicant is new unless they have earlier evidence of being counted
//                     already: another request of theirs in status 'done' that predates the reference (an outcome that is before the reference, or, for a
//                     request without any outcome, a creation date on or before the cutoff). The same applicant with many treatments counts once.
//                     Families that are inside the typed starting number but have no record in the system cannot be recognised and are counted again.
//   amount          = starting amount + automatic amounts, ALL kinds summed (the kind column is internal and never shown)
//   shown publicly  = the switch (settings public.counter_enabled) is true AND (families > 0 OR amount > 0)
// If baseline rows exist but no cutoff was ever saved, the automatic part is not counted (the typed numbers may already contain it).
const db = require('./db');
const { HttpError } = require('./http');

const KEY = { flag: 'public.counter_enabled', cutoff: 'private.impact_baseline_cutoff', approval: 'private.impact_baseline_approval', reference: 'private.impact_reference_at' };
const MANAGED_KEYS = [KEY.flag, KEY.cutoff, KEY.approval, KEY.reference]; // changed only through the impact routes, never through the generic settings route
const AUTO_KIND = 'located_funds';                           // hidden default kind of new automatic outcomes
const START_NOTE = 'מספרי התחלה שהוזנו בדשבורד';
const AUTO_NOTE = 'סכום שנרשם בסימון הושלם';

// ---- dates ('YYYY-MM-DD' strings, Israel time) and money in agorot ----------------------------------------------
function todayIL(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date()); }
function isDate(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
const cents = (v) => Math.round(Number(v) * 100);

// ---- loading (read only) ----------------------------------------------------------------------------------------
async function loadRows() {
  return db.query(
    `SELECT o.id, o.source, o.kind, o.amount::text AS amount, o.amount_basis, o.request_id, o.family_count, to_char(o.completed_on, 'YYYY-MM-DD') AS completed_on, o.created_at,
            (o.voided_at IS NOT NULL) AS voided, r.status AS request_status, r.applicant_id
     FROM outcomes o LEFT JOIN treatment_requests r ON r.id = o.request_id ORDER BY o.id`);
}
async function loadConfig() {
  const rows = await db.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [MANAGED_KEYS]);
  const m = {}; rows.forEach((r) => { m[r.key] = r.value; });
  let ref = m[KEY.reference] ? new Date(m[KEY.reference]) : null;
  if ((!ref || isNaN(ref)) && isDate(m[KEY.cutoff])) {
    // Data whose cutoff was saved before the exact moment was kept in settings: the moment the cutoff was set is in the audit log. READ ONLY: the
    // derived moment is used for the calculation and is never written anywhere (the owners' data stays exactly as it is).
    const a = await db.query("SELECT created_at FROM audit_log WHERE action = 'impact.baseline.cutoff' OR (action = 'impact.start.save' AND detail->>'cutoff_set' = 'true') ORDER BY id DESC LIMIT 1");
    if (a.length) ref = new Date(a[0].created_at);
  }
  return { flag: m[KEY.flag] === true, cutoff: isDate(m[KEY.cutoff]) ? m[KEY.cutoff] : null, referenceAt: ref && !isNaN(ref) ? ref : null };
}
// Requests in status 'done' (used only to recognise a returning family; tiny table).
async function loadDoneRequests() {
  return db.query("SELECT id, applicant_id, to_char(created_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS created_on FROM treatment_requests WHERE status = 'done'");
}

// ---- the rules (pure) -------------------------------------------------------------------------------------------
function evaluate(rows, cfg, doneReqs) {
  const start = rows.filter((r) => r.source === 'baseline' && !r.voided);
  const startFamilies = start.reduce((s, r) => s + (r.family_count || 0), 0);
  const startCents = start.reduce((s, r) => s + cents(r.amount), 0);
  const refMs = cfg.referenceAt ? cfg.referenceAt.getTime() : null;
  // is this outcome after the reference point? (false = it is inside the typed starting numbers)
  const after = (r) => !cfg.cutoff || r.completed_on > cfg.cutoff || (r.completed_on === cfg.cutoff && refMs !== null && new Date(r.created_at).getTime() > refMs);
  const byReq = new Map();
  rows.filter((r) => r.source === 'system' && !r.voided).forEach((r) => { const k = String(r.request_id); if (!byReq.has(k)) byReq.set(k, []); byReq.get(k).push(r); });
  const countAuto = !(start.length && !cfg.cutoff);
  let autoCents = 0; const applicants = new Set();
  if (countAuto) byReq.forEach((outs) => {
    if (outs[0].request_status !== 'done') return;
    const sum = outs.filter((r) => r.amount_basis === 'documented' && cents(r.amount) > 0 && after(r)).reduce((s, r) => s + cents(r.amount), 0);
    if (sum > 0) { autoCents += sum; applicants.add(String(outs[0].applicant_id)); }
  });
  // returning families: an applicant with another done request that predates the reference is already inside the starting number
  const known = new Set();
  if (cfg.cutoff) (doneReqs || []).forEach((q) => {
    const outs = byReq.get(String(q.id)) || [];
    if (outs.length ? outs.some((r) => !after(r)) : q.created_on <= cfg.cutoff) known.add(String(q.applicant_id));
  });
  const autoFamilies = [...applicants].filter((a) => !known.has(a)).length;
  return {
    start: { families: startFamilies, amount: startCents / 100, rows: start.length },
    auto: { families: autoFamilies, amount: autoCents / 100 },
    families: startFamilies + autoFamilies, amount: (startCents + autoCents) / 100,
  };
}
const visible = (ev, cfg) => cfg.flag === true && (ev.families > 0 || ev.amount > 0);

// The public endpoint: only ever the two totals and when they were computed.
async function publicSummary(now) {
  now = now || new Date();
  const cfg = await loadConfig();
  if (!cfg.flag) return { enabled: false };           // switch off: do not even read the rows
  const [rows, done] = await Promise.all([loadRows(), loadDoneRequests()]);
  const ev = evaluate(rows, cfg, done);
  return visible(ev, cfg) ? { enabled: true, families: ev.families, amount: ev.amount, as_of: now.toISOString() } : { enabled: false };
}

// ---- input (dashboard) ------------------------------------------------------------------------------------------
const bad = (code) => new HttpError(400, code);
// Accepts a number or a string such as "12,345.00" or "₪ 12.5"; at most 2 decimals, at most 9 integer digits.
function parseAmount(v, allowZero) {
  const s = String(v == null ? '' : v).replace(/[\s,₪]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s) || (!allowZero && !(Number(s) > 0))) throw bad('bad_amount');
  return s;
}
function parseFamilies(v) {
  const s = String(v == null ? '' : v).replace(/[\s,]/g, '');
  if (!/^\d{1,6}$/.test(s)) throw bad('bad_families');
  return Number(s);
}

module.exports = { KEY, MANAGED_KEYS, AUTO_KIND, START_NOTE, AUTO_NOTE, todayIL, isDate, cents, loadRows, loadConfig, loadDoneRequests, evaluate, visible, publicSummary, parseAmount, parseFamilies };
