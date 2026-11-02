'use strict';
// Stage 3: impact outcomes and the public counter. ALL figures below are clearly fake round TEST DATA (1000 / 2000 / 3000 and small family counts);
// no real figure of the organisation appears anywhere in this repository.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./dev-server');
const db = require('../netlify/functions/_kaspchem/db');
const impact = require('../netlify/functions/_kaspchem/impact');

let srv, base, phoneSeq = 0, realDriver;
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const STRANGER = { 'x-test-user': 'stranger@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) {}
  return { status: r.status, body: j, headers: r.headers, text };
};
const adm = (m, u, b) => call(m, A + u, b, ADMIN);
const pub = () => call('GET', '/api/kaspchem/impact');
const lead = (phone, name) => ({ topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: name || 'נבדק פיקטיבי', phone, email: '', consentContact: true, consentMarketing: false });
const nextPhone = () => '05299' + String(10000 + ++phoneSeq);
// a treatment request marked done; `phone` lets two requests belong to the same applicant
async function doneRequest(phone, status) {
  const r = await call('POST', '/api/kaspchem/lead', lead(phone || nextPhone()));
  assert.equal(r.status, 200, 'lead created');
  if (status !== 'new') assert.equal((await adm('PATCH', '/requests/' + r.body.ref, { status: status || 'done' })).status, 200);
  return r.body.ref;
}
const pad = (n) => String(n).padStart(2, '0');
const shiftDays = (n) => { const d = new Date(impact.todayIL() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = () => impact.todayIL();
const refund = (over) => Object.assign({ kind: 'one_time_refund', amount: '1000', amount_basis: 'documented', evidence_note: 'נתוני בדיקה' }, over || {});
const ongoing = (over) => Object.assign({ kind: 'ongoing_saving', amount: '2000', amount_basis: 'documented', evidence_note: 'נתוני בדיקה' }, over || {});
const baseRow = (over) => Object.assign({ kind: 'located_funds', amount: '3000', family_count: 2, amount_basis: 'documented', evidence_note: 'נתוני בדיקה' }, over || {});
async function reset() {
  await srv.pg.exec("DELETE FROM outcomes; DELETE FROM settings WHERE key IN ('public.counter_enabled','private.impact_baseline_cutoff','private.impact_baseline_approval'); DELETE FROM audit_log WHERE action LIKE 'impact.%' OR action = 'outcome.none'");
}
const on = async () => assert.equal((await adm('POST', '/impact/counter', { enabled: true })).status, 200);

test.before(async () => {
  process.env.KASPCHEM_RATE_MAX = '1000'; process.env.KASPCHEM_RATE_GLOBAL = '1000';
  srv = await start(0); base = 'http://localhost:' + srv.server.address().port;
  realDriver = (t, p) => srv.pg.query(t, p).then((r) => r.rows);
});
test.after(async () => { srv.server.close(); delete process.env.KASPCHEM_RATE_MAX; delete process.env.KASPCHEM_RATE_GLOBAL; });
test.beforeEach(reset);

test('date helpers: months are calendar months, month ends are clamped', () => {
  assert.equal(impact.addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(impact.addMonths('2026-11-02', -12), '2025-11-02');
  assert.equal(impact.addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(impact.addMonths('2026-01-15', -2), '2025-11-15');
  assert.ok(impact.isDate('2026-02-28')); assert.ok(!impact.isDate('2026-02-30')); assert.ok(!impact.isDate('26-1-1'));
});

test('the counter is OFF by default: no numbers at all, even when counted outcomes exist', async () => {
  const id = await doneRequest();
  assert.equal((await adm('POST', `/requests/${id}/outcomes`, refund())).status, 200);
  const r = await pub();
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, enabled: false });
  assert.match(r.headers.get('cache-control'), /public/); assert.match(r.headers.get('cache-control'), /s-maxage=60\b/);
  await adm('POST', '/impact/counter', { enabled: false });
  assert.deepEqual((await pub()).body, { ok: true, enabled: false });
});

test('enabled but nothing to show yet: no zeros are claimed', async () => {
  await on();
  assert.deepEqual((await pub()).body, { ok: true, enabled: false });
});

test('a documented outcome of a completed treatment counts; the response is exactly the aggregate (no combined total)', async () => {
  const id = await doneRequest();
  await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }));
  await on();
  const r = await pub();
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['active_now', 'amounts', 'as_of', 'enabled', 'families_helped', 'ok']);
  assert.deepEqual(Object.keys(r.body.amounts).sort(), ['located_funds', 'one_time_refund', 'ongoing_saving']);
  assert.deepEqual(r.body.amounts, { ongoing_saving: 0, one_time_refund: 1000, located_funds: 0 });
  assert.equal(r.body.families_helped, 1); assert.equal(r.body.active_now, 0); // a one-time refund is never "active now"
  assert.ok(!isNaN(Date.parse(r.body.as_of)) && r.body.as_of.endsWith('Z'));
  assert.match(r.headers.get('cache-control'), /public/); assert.match(r.headers.get('cache-control'), /s-maxage=3600/); assert.match(r.headers.get('cache-control'), /max-age=\d+/);
  assert.ok(!/total|sum|combined/i.test(r.text));
});

test('estimates and zero amounts are stored but never counted and never public', async () => {
  const a = await doneRequest(), b = await doneRequest();
  assert.equal((await adm('POST', `/requests/${a}/outcomes`, refund({ amount_basis: 'estimate', amount: '5000', evidence_note: undefined }))).status, 200);
  await adm('POST', `/requests/${b}/outcomes`, refund({ amount: '1000' }));
  await on();
  const r = await pub();
  assert.equal(r.body.amounts.one_time_refund, 1000); assert.equal(r.body.families_helped, 1);
  assert.ok(!r.text.includes('5000'));
  // a zero amount cannot be recorded at all (and is refused by the API before the database)
  assert.equal((await adm('POST', `/requests/${b}/outcomes`, refund({ kind: 'located_funds', amount: '0' }))).body.error, 'bad_amount');
  // the estimate is visible to the owners, with its reason
  const ov = (await adm('GET', '/impact')).body;
  const est = ov.outcomes.find((o) => o.request_id === a);
  assert.equal(est.counted, false); assert.equal(est.reason, 'estimate');
});

test('voiding removes the amount at once; the same treatment can then be entered again', async () => {
  const id = await doneRequest();
  const c = await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }));
  await on();
  assert.equal((await pub()).body.amounts.one_time_refund, 1000);
  assert.equal((await adm('POST', `/impact/outcomes/${c.body.id}/void`, { reason: 'הוזן בטעות' })).status, 200);
  assert.deepEqual((await pub()).body, { ok: true, enabled: false }); // nothing left to show
  assert.equal((await adm('POST', `/impact/outcomes/${c.body.id}/void`, {})).status, 409);
  assert.equal((await adm('PATCH', `/impact/outcomes/${c.body.id}`, { amount: '5' })).status, 409); // a voided row is not edited
  assert.equal((await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1500' }))).status, 200);
  assert.equal((await pub()).body.amounts.one_time_refund, 1500);
});

test('moving the request out of "done" removes it from the totals immediately, and back in again restores it', async () => {
  const keep = await doneRequest(), id = await doneRequest();
  await adm('POST', `/requests/${keep}/outcomes`, refund({ amount: '1000' }));
  await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '2000' }));
  await on();
  assert.equal((await pub()).body.amounts.one_time_refund, 3000);
  await adm('PATCH', '/requests/' + id, { status: 'in_progress' });
  let r = (await pub()).body;
  assert.equal(r.amounts.one_time_refund, 1000); assert.equal(r.families_helped, 1);
  assert.equal((await adm('GET', '/impact')).body.outcomes.find((o) => o.request_id === id).reason, 'not_done');
  await adm('PATCH', '/requests/' + id, { status: 'done' });
  r = (await pub()).body; assert.equal(r.amounts.one_time_refund, 3000); assert.equal(r.families_helped, 2);
  // an outcome cannot be added to a request that is not done
  const open = await doneRequest(null, 'new');
  assert.equal((await adm('POST', `/requests/${open}/outcomes`, refund())).body.error, 'request_not_done');
  assert.equal((await adm('POST', `/requests/${open}/outcome-none`, {})).body.error, 'request_not_done');
});

test('one treatment is never counted twice for the same kind; two kinds on one request count one family', async () => {
  const id = await doneRequest();
  assert.equal((await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }))).status, 200);
  const dup = await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }));
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'outcome_exists');
  assert.equal((await adm('POST', `/requests/${id}/outcomes`, ongoing({ amount: '2000' }))).status, 200);
  await on();
  const r = (await pub()).body;
  assert.equal(r.amounts.one_time_refund, 1000); assert.equal(r.amounts.ongoing_saving, 2000); // shown separately, never added together
  assert.equal(r.families_helped, 1); assert.equal(r.active_now, 1);
  await assert.rejects(srv.pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, entered_by) VALUES ('system','one_time_refund',5,'documented',$1,CURRENT_DATE,'x')", [id])); // the database refuses it too
  // editing a row into a duplicate is refused as well
  const rows = (await adm('GET', '/impact')).body.outcomes.filter((o) => o.request_id === id);
  const second = rows.find((o) => o.kind === 'ongoing_saving');
  assert.equal((await adm('PATCH', `/impact/outcomes/${second.id}`, { kind: 'one_time_refund' })).body.error, 'outcome_exists');
});

test('a correction changes the totals immediately and leaves an audit trail without the evidence text', async () => {
  const id = await doneRequest();
  const c = await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000', evidence_note: 'טקסט פנימי סודי' }));
  await on();
  assert.equal((await pub()).body.amounts.one_time_refund, 1000);
  assert.equal((await adm('PATCH', `/impact/outcomes/${c.body.id}`, { amount: '1234.56' })).status, 200);
  assert.equal((await pub()).body.amounts.one_time_refund, 1234.56); // exact, not rounded
  assert.equal((await adm('PATCH', `/impact/outcomes/${c.body.id}`, { amount_basis: 'estimate' })).status, 200);
  assert.deepEqual((await pub()).body, { ok: true, enabled: false });
  assert.equal((await adm('PATCH', `/impact/outcomes/${c.body.id}`, {})).body.error, 'nothing_to_update');
  const log = (await srv.pg.query("SELECT action, detail FROM audit_log WHERE entity = 'outcome' AND entity_id = $1 ORDER BY id", [String(c.body.id)])).rows;
  assert.deepEqual(log.map((l) => l.action), ['impact.outcome.create', 'impact.outcome.update', 'impact.outcome.update']);
  assert.deepEqual(log[1].detail.before, { kind: 'one_time_refund', amount: 1000, basis: 'documented', family_count: null });
  assert.equal(log[1].detail.after.amount, 1234.56);
  assert.ok(!JSON.stringify(log).includes('סודי'), 'evidence text is never copied to the log');
});

test('exact amounts: cents add up exactly', async () => {
  const a = await doneRequest(), b = await doneRequest();
  await adm('POST', `/requests/${a}/outcomes`, refund({ amount: '0.10' }));
  await adm('POST', `/requests/${b}/outcomes`, refund({ amount: '0.20' }));
  await on();
  assert.equal((await pub()).body.amounts.one_time_refund, 0.3);
});

test('input is validated: amounts, kinds, basis, evidence, dates, family counts', async () => {
  const id = await doneRequest();
  const bad = async (over, code) => { const r = await adm('POST', `/requests/${id}/outcomes`, Object.assign(refund(), over)); assert.equal(r.status, 400, JSON.stringify(over)); assert.equal(r.body.error, code, JSON.stringify(over)); };
  await bad({ amount: '-5' }, 'bad_amount'); await bad({ amount: '10.123' }, 'bad_amount'); await bad({ amount: 'abc' }, 'bad_amount'); await bad({ amount: '' }, 'bad_amount'); await bad({ amount: '9999999999' }, 'bad_amount');
  await bad({ kind: 'total' }, 'bad_kind'); await bad({ amount_basis: 'guess' }, 'bad_basis'); await bad({ amount_basis: undefined }, 'bad_basis');
  await bad({ evidence_note: '' }, 'evidence_required'); await bad({ evidence_note: undefined }, 'evidence_required');
  await bad({ completed_on: '2026-02-30' }, 'bad_date'); await bad({ completed_on: shiftDays(3) }, 'bad_date');
  await bad({ kind: 'ongoing_saving', starts_on: '2026-05-01', ends_on: '2026-04-01' }, 'bad_date');
  assert.equal((await adm('POST', '/impact/baseline', baseRow({ family_count: 0 }))).body.error, 'bad_family_count');
  assert.equal((await adm('POST', '/impact/baseline', baseRow({ family_count: 1.5 }))).body.error, 'bad_family_count');
  assert.equal((await adm('POST', '/impact/baseline', baseRow({ family_count: undefined }))).body.error, 'bad_family_count');
  assert.equal((await srv.pg.query('SELECT count(*)::int n FROM outcomes')).rows[0].n, 0, 'nothing was stored');
  // the database enforces the shape too
  const ins = (cols, vals) => srv.pg.query(`INSERT INTO outcomes (${cols}, entered_by) VALUES (${vals}, 'x')`);
  await assert.rejects(ins('source, kind, amount, amount_basis, completed_on', "'system','located_funds',5,'documented',CURRENT_DATE"), 'system row needs a request');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count', "'baseline','located_funds',5,'documented',NULL"), 'baseline row needs family_count');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count, request_id', `'baseline','located_funds',5,'documented',1,${id}`), 'baseline row has no request');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count', "'baseline','located_funds',-5,'documented',1"), 'negative amount');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count', "'baseline','everything',5,'documented',1"), 'unknown kind');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count', "'baseline','located_funds',5,'sure',1"), 'unknown basis');
  await assert.rejects(ins('source, kind, amount, amount_basis, family_count', "'other','located_funds',5,'documented',1"), 'unknown source');
});

test('opening data (baseline) is NOT public until approved, and approval needs a cutoff', async () => {
  const b1 = await adm('POST', '/impact/baseline', baseRow({ kind: 'located_funds', amount: '3000', family_count: 2 }));
  assert.equal(b1.status, 200);
  await on();
  assert.deepEqual((await pub()).body, { ok: true, enabled: false }, 'flag on, opening data unapproved: nothing public');
  let ov = (await adm('GET', '/impact')).body;
  assert.equal(ov.blocked_reason, 'no_cutoff'); assert.equal(ov.preview.public_now.enabled, false);
  assert.equal(ov.preview.draft.amounts.located_funds, 3000); assert.equal(ov.preview.draft.families_helped, 2); // the owners can see the draft figures
  assert.equal(ov.baseline[0].reason, 'baseline_unapproved');
  assert.equal((await adm('POST', '/impact/approve-baseline', { confirm: true })).body.error, 'cutoff_required');
  assert.equal((await adm('PUT', '/impact/baseline-cutoff', { date: shiftDays(5) })).body.error, 'bad_date'); // not in the future
  assert.equal((await adm('PUT', '/impact/baseline-cutoff', { date: 'tomorrow' })).body.error, 'bad_date');
  assert.equal((await adm('PUT', '/impact/baseline-cutoff', { date: '2026-06-30' })).status, 200);
  assert.deepEqual((await pub()).body, { ok: true, enabled: false }, 'cutoff alone does not publish');
  assert.equal((await adm('GET', '/impact')).body.blocked_reason, 'baseline_unapproved');
  assert.equal((await adm('POST', '/impact/approve-baseline', {})).body.error, 'confirm_required'); // an explicit action
  assert.equal((await adm('POST', '/impact/approve-baseline', { confirm: true })).status, 200);
  let r = (await pub()).body;
  assert.equal(r.enabled, true); assert.equal(r.amounts.located_funds, 3000); assert.equal(r.families_helped, 2); assert.equal(r.active_now, 0);
  assert.equal((await adm('POST', '/impact/approve-baseline', { confirm: true })).body.error, 'already_approved'); // one-time
  // changing the opening data afterwards makes the approval stale: public again shows nothing until it is re-approved
  const rid = (await adm('GET', '/impact')).body.baseline[0].id;
  assert.equal((await adm('PATCH', `/impact/outcomes/${rid}`, { amount: '3500' })).status, 200);
  assert.deepEqual((await pub()).body, { ok: true, enabled: false });
  ov = (await adm('GET', '/impact')).body; assert.equal(ov.config.approval_valid, false); assert.equal(ov.blocked_reason, 'baseline_unapproved');
  assert.equal((await adm('POST', '/impact/approve-baseline', { confirm: true })).status, 200);
  assert.equal((await pub()).body.amounts.located_funds, 3500);
  // adding another row or moving the cutoff makes it stale as well
  await adm('POST', '/impact/baseline', baseRow({ kind: 'one_time_refund', amount: '1000', family_count: 1 }));
  assert.equal((await pub()).body.enabled, false);
  await adm('POST', '/impact/approve-baseline', { confirm: true });
  assert.equal((await pub()).body.enabled, true);
  await adm('PUT', '/impact/baseline-cutoff', { date: '2026-07-01' });
  assert.equal((await pub()).body.enabled, false);
  // the approval is in the audit log with the approved figures
  const log = (await srv.pg.query("SELECT actor, detail FROM audit_log WHERE action = 'impact.baseline.approve' ORDER BY id")).rows;
  assert.equal(log.length, 3); assert.equal(log[0].actor, 'yosi@example.test');
  assert.deepEqual(log[0].detail.figures, [{ kind: 'located_funds', amount: 3000, family_count: 2, basis: 'documented' }]);
});

test('system outcomes count only for treatments completed AFTER the cutoff; opening data stays separate', async () => {
  await adm('POST', '/impact/baseline', baseRow({ kind: 'one_time_refund', amount: '2000', family_count: 3 }));
  await adm('PUT', '/impact/baseline-cutoff', { date: '2026-01-15' });
  await adm('POST', '/impact/approve-baseline', { confirm: true });
  const before = await doneRequest(), same = await doneRequest(), after = await doneRequest();
  await adm('POST', `/requests/${before}/outcomes`, refund({ amount: '100', completed_on: '2026-01-14' }));
  await adm('POST', `/requests/${same}/outcomes`, refund({ amount: '200', completed_on: '2026-01-15' }));
  await adm('POST', `/requests/${after}/outcomes`, refund({ amount: '1000', completed_on: '2026-01-16' }));
  await on();
  const r = (await pub()).body;
  assert.equal(r.amounts.one_time_refund, 3000);   // 2000 opening + 1000 system; the two on/before the cutoff are in the opening data already
  assert.equal(r.families_helped, 4);              // 3 opening families + 1 system family
  const ov = (await adm('GET', '/impact')).body;
  assert.equal(ov.outcomes.find((o) => o.request_id === before).reason, 'before_cutoff');
  assert.equal(ov.outcomes.find((o) => o.request_id === same).reason, 'before_cutoff'); // the cutoff day itself belongs to the opening data
  assert.equal(ov.outcomes.find((o) => o.request_id === after).counted, true);
  assert.equal(ov.baseline.length, 1); assert.equal(ov.outcomes.length, 3); // opening data and system outcomes are different lists
});

test('active_now is not families_helped: only an ONGOING saving that is started, not ended and verified within 12 months', async () => {
  const mk = async (over, phone) => { const id = await doneRequest(phone); const r = await adm('POST', `/requests/${id}/outcomes`, ongoing(over)); assert.equal(r.status, 200, JSON.stringify(r.body)); return id; };
  await mk({ amount: '1000' });                                                                                  // active
  await mk({ amount: '100', last_verified_at: impact.addMonths(TODAY(), -12), starts_on: impact.addMonths(TODAY(), -20) }); // exactly 12 months ago: still inside
  await mk({ amount: '200', last_verified_at: impact.addMonths(shiftDays(-1), -12), starts_on: impact.addMonths(TODAY(), -20) }); // a day older: out until re-verified
  await mk({ amount: '300', starts_on: shiftDays(10) });                                                           // not started yet
  await mk({ amount: '400', starts_on: shiftDays(-30), ends_on: shiftDays(-1) });                                  // ended
  await mk({ amount: '500', starts_on: shiftDays(-30), ends_on: shiftDays(1) });                                  // ends tomorrow: active today
  await mk({ amount: '600', starts_on: shiftDays(-30), ends_on: TODAY() });                                       // ends today: not active
  const refundOnly = await doneRequest(); await adm('POST', `/requests/${refundOnly}/outcomes`, refund({ amount: '700' }));
  await on();
  const r = (await pub()).body;
  assert.equal(r.families_helped, 8, 'everyone ever helped');
  assert.equal(r.active_now, 3, 'only the 1000, the 100 and the 500 savings');
  assert.equal(r.amounts.ongoing_saving, 1600, 'the per-year saving shown is the one still active');
  assert.equal(r.amounts.one_time_refund, 700);
  const reasons = (await adm('GET', '/impact')).body.outcomes.filter((o) => o.kind === 'ongoing_saving').map((o) => o.inactive_reason || 'active').sort();
  assert.deepEqual(reasons, ['active', 'active', 'active', 'ended', 'ended', 'not_started', 'verification_expired']);
});

test('active_now counts families, not rows: one applicant with two ongoing savings is one family', async () => {
  const phone = nextPhone();
  const a = await doneRequest(phone); const b = await doneRequest(phone);
  await adm('POST', `/requests/${a}/outcomes`, ongoing({ amount: '1000' }));
  await adm('POST', `/requests/${b}/outcomes`, ongoing({ amount: '2000' }));
  await on();
  const r = (await pub()).body;
  assert.equal(r.active_now, 1); assert.equal(r.families_helped, 1); assert.equal(r.amounts.ongoing_saving, 3000);
});

test('opening ongoing savings count in active_now only with their own verified date inside 12 months', async () => {
  await adm('POST', '/impact/baseline', baseRow({ kind: 'ongoing_saving', amount: '1000', family_count: 2, last_verified_at: shiftDays(-30) }));
  await adm('POST', '/impact/baseline', baseRow({ kind: 'one_time_refund', amount: '2000', family_count: 3 }));
  await adm('PUT', '/impact/baseline-cutoff', { date: '2026-01-01' });
  await adm('POST', '/impact/approve-baseline', { confirm: true });
  await on();
  let r = (await pub()).body;
  assert.equal(r.active_now, 2); assert.equal(r.families_helped, 5); assert.equal(r.amounts.ongoing_saving, 1000);
  // an old verified date drops it out (editing the verified date is routine upkeep and does not need a new approval)
  const row = (await adm('GET', '/impact')).body.baseline.find((x) => x.kind === 'ongoing_saving');
  assert.equal((await adm('PATCH', `/impact/outcomes/${row.id}`, { last_verified_at: impact.addMonths(TODAY(), -13) })).status, 200);
  r = (await pub()).body;
  assert.equal(r.enabled, true); assert.equal(r.active_now, 0); assert.equal(r.families_helped, 5); assert.equal(r.amounts.ongoing_saving, 0);
  // without any verified date it is not active either
  await adm('PATCH', `/impact/outcomes/${row.id}`, { last_verified_at: '' });
  assert.equal((await pub()).body.active_now, 0);
  // the dashboard lists it as expired
  await adm('PATCH', `/impact/outcomes/${row.id}`, { last_verified_at: impact.addMonths(TODAY(), -13) });
  const ex = (await adm('GET', '/impact')).body.expiring;
  assert.equal(ex.length, 1); assert.equal(ex[0].expired, true); assert.equal(ex[0].source, 'baseline');
});

test('verification list: savings not verified for 11+ months are listed before they drop out; re-verifying brings them back', async () => {
  const fresh = await doneRequest(), soon = await doneRequest(), gone = await doneRequest();
  await adm('POST', `/requests/${fresh}/outcomes`, ongoing({ amount: '100' }));
  const s = await adm('POST', `/requests/${soon}/outcomes`, ongoing({ amount: '200', last_verified_at: impact.addMonths(TODAY(), -11), starts_on: impact.addMonths(TODAY(), -30) }));
  const g = await adm('POST', `/requests/${gone}/outcomes`, ongoing({ amount: '300', last_verified_at: impact.addMonths(TODAY(), -14), starts_on: impact.addMonths(TODAY(), -30) }));
  let ex = (await adm('GET', '/impact')).body.expiring;
  assert.deepEqual(ex.map((e) => [e.id, e.expired]).sort(), [[s.body.id, false], [g.body.id, true]].sort());
  assert.equal(ex.find((e) => e.id === s.body.id).expires_on, impact.addMonths(TODAY(), 1));
  await on();
  assert.equal((await pub()).body.active_now, 2); // fresh + soon
  assert.equal((await adm('PATCH', `/impact/outcomes/${g.body.id}`, { last_verified_at: TODAY() })).status, 200);
  assert.equal((await pub()).body.active_now, 3);
  assert.equal((await adm('GET', '/impact')).body.expiring.length, 1);
  assert.equal((await adm('PATCH', `/impact/outcomes/${g.body.id}`, { last_verified_at: shiftDays(2) })).body.error, 'bad_date'); // cannot verify in the future
});

test('"completed without an amount" is flagged until an outcome is recorded or the admin says there is nothing to count', async () => {
  const a = await doneRequest(), b = await doneRequest(), c = await doneRequest(), notDone = await doneRequest(null, 'in_progress');
  let miss = (await adm('GET', '/impact')).body.missing_amount.map((m) => m.id);
  assert.ok([a, b, c].every((x) => miss.includes(x))); assert.ok(!miss.includes(notDone));
  await adm('POST', `/requests/${a}/outcomes`, refund());
  assert.equal((await adm('POST', `/requests/${b}/outcome-none`, {})).status, 200);
  miss = (await adm('GET', '/impact')).body.missing_amount.map((m) => m.id);
  assert.ok(!miss.includes(a)); assert.ok(!miss.includes(b)); assert.ok(miss.includes(c));
  assert.equal((await srv.pg.query("SELECT count(*)::int n FROM audit_log WHERE action = 'outcome.none' AND entity_id = $1", [String(b)])).rows[0].n, 1);
  // a voided outcome puts the request back on the list
  const o = (await adm('GET', '/impact')).body.outcomes.find((x) => x.request_id === a);
  await adm('POST', `/impact/outcomes/${o.id}/void`, {});
  assert.ok((await adm('GET', '/impact')).body.missing_amount.map((m) => m.id).includes(a));
});

test('the request detail shows its outcomes (for the dashboard dialog)', async () => {
  const id = await doneRequest();
  await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }));
  const d = (await adm('GET', '/requests/' + id)).body;
  assert.equal(d.outcomes.length, 1); assert.equal(d.outcomes[0].kind, 'one_time_refund'); assert.equal(d.outcomes[0].amount, 1000);
});

test('the public endpoint leaks nothing personal and nothing per-record', async () => {
  const phone = nextPhone();
  const id = await doneRequest(phone);
  await adm('POST', `/requests/${id}/outcomes`, ongoing({ amount: '1000', evidence_note: 'מקור פנימי מזהה' }));
  await adm('POST', '/impact/baseline', baseRow({ evidence_note: 'הערת פתיחה פנימית' }));
  await adm('PUT', '/impact/baseline-cutoff', { date: '2026-01-01' }); await adm('POST', '/impact/approve-baseline', { confirm: true }); await on();
  const r = await pub();
  assert.equal(r.body.enabled, true);
  for (const bad of ['נבדק פיקטיבי', phone, 'מקור פנימי', 'הערת פתיחה', 'yosi@', 'request', 'applicant', 'evidence', 'outcomes', 'baseline', String(id) + ',']) assert.ok(!r.text.includes(bad), 'leaks: ' + bad);
  assert.equal(typeof r.body.families_helped, 'number');
  // methods other than GET are refused; the admin API is not reachable from the public path
  assert.equal((await call('POST', '/api/kaspchem/impact', {})).status, 405);
  assert.equal((await call('GET', '/api/kaspchem/admin/impact')).status, 401);
});

test('a database failure gives a minimal failure with no detail and nothing is cached', async () => {
  await on();
  db.setDriver(async () => { throw new Error('secret connection string postgres://user:pw@host/db'); });
  const orig = console.error; const logged = []; console.error = (...a) => logged.push(a.join(' '));
  let r; try { r = await pub(); } finally { console.error = orig; db.setDriver(realDriver); }
  assert.equal(r.status, 503); assert.deepEqual(r.body, { ok: false });
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.ok(!r.text.includes('secret') && !r.text.includes('postgres'));
  assert.ok(logged.some((l) => l.includes('impact')) && logged.every((l) => !l.includes('postgres://')), 'logged by route name only, without the message');
  assert.equal((await pub()).status, 200); // recovers
});

test('the admin impact API is admin-only, needs the CSRF header, and the generic settings route cannot touch the counter keys', async () => {
  const id = await doneRequest(); await adm('POST', `/requests/${id}/outcomes`, refund());
  const oid = (await adm('GET', '/impact')).body.outcomes[0].id;
  const routes = [['GET', '/impact'], ['POST', `/requests/${id}/outcomes`, refund({ kind: 'located_funds' })], ['POST', `/requests/${id}/outcome-none`, {}], ['POST', '/impact/baseline', baseRow()],
    ['PATCH', `/impact/outcomes/${oid}`, { amount: '5' }], ['POST', `/impact/outcomes/${oid}/void`, {}], ['PUT', '/impact/baseline-cutoff', { date: '2026-01-01' }], ['POST', '/impact/approve-baseline', { confirm: true }], ['POST', '/impact/counter', { enabled: true }]];
  for (const [m, u, b] of routes) {
    assert.equal((await call(m, A + u, b, { 'x-kaspchem': '1' })).status, 401, 'anonymous ' + m + u);
    assert.equal((await call(m, A + u, b, STRANGER)).status, 403, 'not allow-listed ' + m + u);
    if (m !== 'GET') assert.equal((await call(m, A + u, b, { 'x-test-user': 'yosi@example.test|admin' })).status, 403, 'no CSRF header ' + m + u);
  }
  process.env.KASPCHEM_REQUIRE_ROLE = '1';
  assert.equal((await call('POST', A + '/impact/counter', { enabled: true }, { 'x-test-user': 'yosi@example.test|', 'x-kaspchem': '1' })).status, 403, 'role enforced when required');
  delete process.env.KASPCHEM_REQUIRE_ROLE;
  assert.equal((await srv.pg.query("SELECT count(*)::int n FROM settings WHERE key = 'public.counter_enabled'")).rows[0].n, 0, 'every refused call changed nothing');
  assert.equal((await srv.pg.query('SELECT count(*)::int n FROM outcomes')).rows[0].n, 1);
  for (const key of ['public.counter_enabled', 'private.impact_baseline_cutoff', 'private.impact_baseline_approval']) {
    const r = await adm('PUT', '/settings', { key, value: true });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'use_impact_api');
  }
  assert.equal((await adm('POST', '/impact/counter', { enabled: 'yes' })).body.error, 'bad_value');
  assert.equal((await adm('POST', '/impact/outcomes/999999/void', {})).status, 404);
  assert.equal((await adm('PATCH', '/impact/outcomes/999999', { amount: '5' })).status, 404);
});

test('every create, edit, void, cutoff, approval and switch is in the audit log (ids and figures only)', async () => {
  const id = await doneRequest();
  const o = await adm('POST', `/requests/${id}/outcomes`, refund({ amount: '1000' }));
  await adm('PATCH', `/impact/outcomes/${o.body.id}`, { amount: '1100' });
  await adm('POST', `/impact/outcomes/${o.body.id}/void`, { reason: 'x' });
  const b = await adm('POST', '/impact/baseline', baseRow());
  await adm('PATCH', `/impact/outcomes/${b.body.id}`, { family_count: 4 });
  await adm('PUT', '/impact/baseline-cutoff', { date: '2026-01-01' });
  await adm('POST', '/impact/approve-baseline', { confirm: true });
  await adm('POST', '/impact/counter', { enabled: true });
  await adm('POST', '/impact/counter', { enabled: false });
  await adm('POST', '/impact/outcomes/' + b.body.id + '/void', {});
  const actions = (await srv.pg.query("SELECT action FROM audit_log WHERE action LIKE 'impact.%' ORDER BY id")).rows.map((r) => r.action);
  assert.deepEqual(actions, ['impact.outcome.create', 'impact.outcome.update', 'impact.outcome.void', 'impact.baseline.create', 'impact.baseline.update', 'impact.baseline.cutoff', 'impact.baseline.approve', 'impact.counter.enable', 'impact.counter.disable', 'impact.baseline.void']);
  const all = (await srv.pg.query("SELECT actor, detail FROM audit_log WHERE action LIKE 'impact.%'")).rows;
  assert.ok(all.every((r) => r.actor === 'yosi@example.test'));
  assert.ok(!JSON.stringify(all).includes('נתוני בדיקה'), 'no evidence text in the log');
  assert.ok(!JSON.stringify(all).includes('נבדק פיקטיבי'), 'no names in the log');
});

test('alerts are untouched: the impact routes send no notification', async () => {
  const ops = require('../netlify/functions/_kaspchem/ops-alert'); const sent = []; ops.setSender(async (m) => { sent.push(m); });
  try {
    const id = await doneRequest(); sent.length = 0;
    await adm('POST', `/requests/${id}/outcomes`, refund()); await on(); await adm('POST', '/impact/counter', { enabled: false }); await pub();
    assert.deepEqual(sent, []);
  } finally { ops.setSender(null); }
});

test('no real or example figure is shipped in code or pages, and sentence 3 has no typed number', () => {
  const root = path.join(__dirname, '..');
  const files = ['netlify/functions/_kaspchem/impact.js', 'netlify/functions/kaspchem-impact.js', 'kaspchem/assets/impact.js', 'kaspchem/assets/headline.js', 'kaspchem/index.html', 'admin/kaspchem/admin.js', 'db/kaspchem-schema.sql'];
  for (const f of files) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/83[,.]?885/.test(s), f + ' contains the owners\' example figure');
    assert.ok(!/setThird\(\s*\d/.test(s), f + ' types a number into sentence 3');
    assert.ok(!/ברגע זה יש \d/.test(s), f + ' has a typed number in sentence 3');
  }
});
