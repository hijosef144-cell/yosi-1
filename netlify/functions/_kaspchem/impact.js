'use strict';
// Impact counter (stage 3): ONE place that decides what counts. Used by the public endpoint (aggregates only) and by the dashboard (the same
// computation, plus the reason every row does or does not count). Nothing is stored as a running total: everything is computed from rows when read.
//
// A row COUNTS only if ALL of these hold:
//   - it is not voided
//   - amount_basis = 'documented' and amount > 0                      (estimates are stored, never counted, never public)
//   - system rows: the treatment request is still in status 'done' and completed_on is AFTER the baseline cutoff (when one is set)
//   - baseline rows: the owners approved the opening data in its current form
// Per kind: 'ongoing_saving' amounts are per year and are shown only while ACTIVE (see isActive); the other two kinds are shown in full.
// families_helped = baseline family_count (counted rows) + distinct applicants with a counted system row of any kind.
// active_now      = baseline family_count of ACTIVE ongoing_saving rows + distinct applicants with an ACTIVE counted system ongoing_saving row.
const crypto = require('crypto');
const db = require('./db');
const { HttpError } = require('./http');
const { cleanText } = require('./validate');

const KINDS = ['ongoing_saving', 'one_time_refund', 'located_funds'];
const BASES = ['documented', 'estimate'];
const KEY = { flag: 'public.counter_enabled', cutoff: 'private.impact_baseline_cutoff', approval: 'private.impact_baseline_approval' };
const MANAGED_KEYS = [KEY.flag, KEY.cutoff, KEY.approval]; // changed only through the impact routes (validated and audited), never through the generic settings route
const VERIFY_MONTHS = 12;   // an ongoing saving drops out of the public numbers when it was not re-verified for this long
const WARN_MONTHS = 11;     // the dashboard starts listing it one month earlier

// ---- dates (calendar dates as 'YYYY-MM-DD' strings, Israel time) ------------------------------------------------
function todayIL(now) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date()); }
function isDate(s) { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
function addMonths(s, n) {
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)) - 1, d = Number(s.slice(8, 10));
  const t = y * 12 + m + n, ny = Math.floor(t / 12), nm = t - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return ny + '-' + String(nm + 1).padStart(2, '0') + '-' + String(Math.min(d, last)).padStart(2, '0');
}
const cents = (v) => Math.round(Number(v) * 100);

// ---- loading ----------------------------------------------------------------------------------------------------
const D = (c) => "to_char(o." + c + ", 'YYYY-MM-DD') AS " + c;
async function loadRows(forAdmin) {
  return db.query(
    `SELECT o.id, o.source, o.kind, o.amount::text AS amount, o.amount_basis, o.request_id, o.family_count, ${D('completed_on')}, ${D('starts_on')}, ${D('ends_on')}, ${D('last_verified_at')},
            (o.voided_at IS NOT NULL) AS voided` +
    (forAdmin ? `, o.evidence_note, o.entered_by, o.void_reason, o.created_at, o.updated_at` : '') + `,
            r.status AS request_status, r.applicant_id` + (forAdmin ? ', r.topic' : '') + `
     FROM outcomes o LEFT JOIN treatment_requests r ON r.id = o.request_id ORDER BY o.id`);
}
async function loadConfig() {
  const rows = await db.query('SELECT key, value FROM settings WHERE key = ANY($1::text[])', [MANAGED_KEYS]);
  const m = {}; rows.forEach((r) => { m[r.key] = r.value; });
  return { flag: m[KEY.flag] === true, cutoff: isDate(m[KEY.cutoff]) ? m[KEY.cutoff] : null, approval: m[KEY.approval] && typeof m[KEY.approval] === 'object' ? m[KEY.approval] : null };
}

// What the owners approve is the opening data AS IT IS NOW (which rows, their kinds, amounts, family counts, basis, and the cutoff). Any change to those makes the approval
// stale and the opening data non-public again until it is approved again. The verified date is routine upkeep and is not part of the fingerprint.
function fingerprint(rows, cutoff) {
  const base = rows.filter((r) => r.source === 'baseline' && !r.voided).map((r) => [r.id, r.kind, cents(r.amount), r.family_count, r.amount_basis]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify({ cutoff: cutoff || null, base })).digest('hex');
}

// ---- the rules --------------------------------------------------------------------------------------------------
function classify(r, cfg, today, approvalValid) {
  const out = { counted: false, reason: null, active: false, inactive_reason: null };
  if (r.voided) out.reason = 'voided';
  else if (r.amount_basis !== 'documented') out.reason = 'estimate';
  else if (!(cents(r.amount) > 0)) out.reason = 'no_amount';
  else if (r.source === 'system') {
    if (r.request_status !== 'done') out.reason = 'not_done';
    else if (cfg.cutoff && !(r.completed_on > cfg.cutoff)) out.reason = 'before_cutoff';
  } else if (!approvalValid) out.reason = 'baseline_unapproved';
  if (out.reason) return out;
  out.counted = true;
  if (r.kind === 'ongoing_saving') {
    const limit = addMonths(today, -VERIFY_MONTHS);
    if (r.source === 'system' && !r.starts_on) out.inactive_reason = 'missing_dates';
    else if (r.source === 'system' && r.starts_on > today) out.inactive_reason = 'not_started';
    else if (r.ends_on && !(r.ends_on > today)) out.inactive_reason = 'ended';
    else if (!r.last_verified_at) out.inactive_reason = 'missing_dates';
    else if (r.last_verified_at < limit) out.inactive_reason = 'verification_expired';
    else out.active = true;
  }
  return out;
}

// Pure: rows + config + today -> numbers. `forceApproval` lets the dashboard show the draft figures as they would be once approved.
function evaluate(rows, cfg, today, forceApproval) {
  const fp = fingerprint(rows, cfg.cutoff);
  const baselineExists = rows.some((r) => r.source === 'baseline' && !r.voided);
  const approvalValid = !!(cfg.approval && cfg.approval.fp === fp);
  const eff = forceApproval ? true : approvalValid;
  const cents_ = { ongoing_saving: 0, one_time_refund: 0, located_funds: 0 };
  let baseFamilies = 0, baseActive = 0; const fam = new Set(), act = new Set();
  const detail = rows.map((r) => {
    const c = classify(r, cfg, today, eff);
    if (c.counted) {
      if (r.kind !== 'ongoing_saving' || c.active) cents_[r.kind] += cents(r.amount);
      if (r.source === 'baseline') { baseFamilies += r.family_count || 0; if (c.active) baseActive += r.family_count || 0; }
      else { fam.add(String(r.applicant_id)); if (c.active) act.add(String(r.applicant_id)); }
    }
    return Object.assign({ id: r.id }, c);
  });
  return {
    amounts: { ongoing_saving: cents_.ongoing_saving / 100, one_time_refund: cents_.one_time_refund / 100, located_funds: cents_.located_funds / 100 },
    families_helped: baseFamilies + fam.size, active_now: baseActive + act.size,
    baselineExists, approvalValid, fingerprint: fp, detail
  };
}

// What the public may see. Null reason = shown. The counter is shown only when ALL hold: the flag is on; the opening data (if any) is approved
// in its current form and has a cutoff date (otherwise earlier activity could be counted twice); there is something real to show.
function publicDecision(ev, cfg) {
  if (!cfg.flag) return 'flag_off';
  if (ev.baselineExists && !cfg.cutoff) return 'no_cutoff';
  if (ev.baselineExists && !ev.approvalValid) return 'baseline_unapproved';
  if (!ev.families_helped && !KINDS.some((k) => ev.amounts[k] > 0)) return 'empty';
  return null;
}
const aggregate = (ev, now) => ({ amounts: ev.amounts, families_helped: ev.families_helped, active_now: ev.active_now, as_of: now.toISOString() });

// The public endpoint: only ever aggregates. Everything else (names, request numbers, rows) stays inside this module.
async function publicSummary(now) {
  now = now || new Date();
  const cfg = await loadConfig();
  if (!cfg.flag) return { enabled: false };           // flag off: do not even read the rows
  const ev = evaluate(await loadRows(false), cfg, todayIL(now), false);
  return publicDecision(ev, cfg) ? { enabled: false } : Object.assign({ enabled: true }, aggregate(ev, now));
}

// ---- input validation (dashboard) -------------------------------------------------------------------------------
const bad = (code) => new HttpError(400, code);
function amountOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s) || !(Number(s) > 0)) throw bad('bad_amount');
  return s;
}
function dateOf(v, code, max) {
  if (v == null || v === '') return null;
  if (!isDate(v) || (max && v > max)) throw bad(code);
  return v;
}
// Validates a complete outcome (create, or an edit merged over the stored row) and returns the column values.
function normalize(source, b, today) {
  const kind = String(b.kind || ''); if (!KINDS.includes(kind)) throw bad('bad_kind');
  const basis = String(b.amount_basis || ''); if (!BASES.includes(basis)) throw bad('bad_basis');
  const amount = amountOf(b.amount);
  let evidence = null;
  if (b.evidence_note != null && b.evidence_note !== '') { evidence = cleanText(b.evidence_note, 2, 500); if (!evidence) throw bad('bad_evidence'); }
  if (basis === 'documented' && !evidence) throw bad('evidence_required'); // a documented figure needs its internal source on record
  const v = { source, kind, amount, amount_basis: basis, evidence_note: evidence, completed_on: null, starts_on: null, ends_on: null, last_verified_at: null, family_count: null };
  const ongoing = kind === 'ongoing_saving';
  if (source === 'system') {
    v.completed_on = dateOf(b.completed_on, 'bad_date', today) || today;
    if (ongoing) {
      v.starts_on = dateOf(b.starts_on, 'bad_date') || v.completed_on;
      v.ends_on = dateOf(b.ends_on, 'bad_date');
      v.last_verified_at = dateOf(b.last_verified_at, 'bad_date', today) || today; // documenting a saving is itself a verification
      if (v.ends_on && v.ends_on < v.starts_on) throw bad('bad_date');
    }
  } else {
    const n = Number(b.family_count);
    if (!Number.isInteger(n) || n < 1 || n > 100000) throw bad('bad_family_count');
    v.family_count = n;
    if (ongoing) v.last_verified_at = dateOf(b.last_verified_at, 'bad_date', today); // opening data: the owners' own verified date, none = not active
  }
  return v;
}
const DAY = (s) => (s ? String(s).slice(0, 10) : null);

module.exports = { KINDS, BASES, KEY, MANAGED_KEYS, WARN_MONTHS, VERIFY_MONTHS, todayIL, isDate, addMonths, cents, loadRows, loadConfig, fingerprint, classify, evaluate, publicDecision, aggregate, publicSummary, normalize, DAY };
