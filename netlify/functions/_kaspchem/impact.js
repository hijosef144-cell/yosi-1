'use strict';
// Impact counter, simple model. The owners type ONE starting point (families helped, shekels saved or obtained) and switch the counter on or off.
// From then on a treatment marked "done" in the dashboard with an amount is added automatically. Everything below is the hidden logic that makes
// that add up correctly; none of it is shown in the dashboard. Totals are computed when read; nothing is stored as a running total, and reading
// never writes anything.
//
//   starting point  = every non-voided baseline row in `outcomes` (normally exactly one): its family_count and amount, summed as they are
//   automatic part  = system outcomes that count: the request is still in status 'done', amount_basis 'documented', amount > 0, not voided,
//                     and completed_on is strictly AFTER the cutoff (the day the starting point was saved: everything completed up to
//                     and including that day is assumed to be inside the typed numbers). ONE outcome per request counts: if old data holds
//                     more than one for a request, only the newest counts, so a treatment is never added twice.
//   families        = starting families + distinct applicants of the automatic part
//   amount          = starting amount + automatic amounts, ALL kinds summed (the kind column is internal and never shown)
//   shown publicly  = the switch (settings public.counter_enabled) is true AND (families > 0 OR amount > 0)
// If baseline rows exist but no cutoff was ever saved, the automatic part is not counted (the typed numbers may already contain it).
const db = require('./db');
const { HttpError } = require('./http');

const KEY = { flag: 'public.counter_enabled', cutoff: 'private.impact_baseline_cutoff', approval: 'private.impact_baseline_approval' };
const MANAGED_KEYS = [KEY.flag, KEY.cutoff, KEY.approval]; // changed only through the impact routes, never through the generic settings route
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
    `SELECT o.id, o.source, o.kind, o.amount::text AS amount, o.amount_basis, o.request_id, o.family_count, to_char(o.completed_on, 'YYYY-MM-DD') AS completed_on,
            (o.voided_at IS NOT NULL) AS voided, r.status AS request_status, r.applicant_id
     FROM outcomes o LEFT JOIN treatment_requests r ON r.id = o.request_id ORDER BY o.id`);
}
async function loadConfig() {
  const rows = await db.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [MANAGED_KEYS]);
  const m = {}; rows.forEach((r) => { m[r.key] = r.value; });
  return { flag: m[KEY.flag] === true, cutoff: isDate(m[KEY.cutoff]) ? m[KEY.cutoff] : null };
}

// ---- the rules (pure) -------------------------------------------------------------------------------------------
function evaluate(rows, cfg) {
  const start = rows.filter((r) => r.source === 'baseline' && !r.voided);
  const startFamilies = start.reduce((s, r) => s + (r.family_count || 0), 0);
  const startCents = start.reduce((s, r) => s + cents(r.amount), 0);
  // the automatic part: newest non-voided outcome per request, then the counting rules
  const newest = new Map();
  rows.filter((r) => r.source === 'system' && !r.voided).forEach((r) => { const k = String(r.request_id); if (!newest.has(k) || r.id > newest.get(k).id) newest.set(k, r); });
  const countAuto = !(start.length && !cfg.cutoff);
  const counted = !countAuto ? [] : [...newest.values()].filter((r) => r.request_status === 'done' && r.amount_basis === 'documented' && cents(r.amount) > 0 && (!cfg.cutoff || r.completed_on > cfg.cutoff));
  const autoCents = counted.reduce((s, r) => s + cents(r.amount), 0);
  const autoFamilies = new Set(counted.map((r) => String(r.applicant_id))).size;
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
  const ev = evaluate(await loadRows(), cfg);
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

module.exports = { KEY, MANAGED_KEYS, AUTO_KIND, START_NOTE, AUTO_NOTE, todayIL, isDate, cents, loadRows, loadConfig, evaluate, visible, publicSummary, parseAmount, parseFamilies };
