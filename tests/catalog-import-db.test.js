'use strict';
// The catalog logic against the REAL tables (migration 002 on an in-memory Postgres, PGlite; never a real database).
// Three questions: (1) does the database accept everything the importer produces, and does a second import of the same file then find nothing to do;
// (2) does the code's copy of the database rules (validateLayer, dbRuleViolations) agree with the database, case by case; (3) does a failing plan leave nothing behind.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const OPEN = new Set();
class PGlite extends PGliteBase { constructor(...a) { super(...a); OPEN.add(this); const close = this.close.bind(this); this.close = async () => { OPEN.delete(this); return close(); }; } }
test.after(async () => { for (const db of [...OPEN]) { try { await db.close(); } catch (e) { /* already closed */ } } });

const I = require('../netlify/functions/_kaspchem/catalog/import.js');
const P = require('../netlify/functions/_kaspchem/catalog/pricing.js');
const S = require('../netlify/functions/_kaspchem/catalog/states.js');
const F = require('./fixtures/catalog-demo.js');
const SIM = require('./fixtures/catalog-sim.js');

const ROOT = path.join(__dirname, '..');
const DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const M002 = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8');
async function freshDb() { const pg = new PGlite(); await pg.exec(DDL); await pg.exec(M002); return pg; }
const scalar = async (pg, sql) => Object.values((await pg.query(sql)).rows[0])[0];

// Put what F.existing() describes into the real tables, with the same ids.
async function seed(pg) {
  const ex = F.existing();
  for (const s of ex.services) await pg.query('INSERT INTO services (id, name, topic, description) VALUES ($1,$2,$3,$4)', [s.id, s.name, s.topic, s.description]);
  for (const p of ex.providers) { await pg.query('INSERT INTO professionals (id, name) VALUES ($1,$2)', [p.id, p.name]); await pg.query('INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email) VALUES ($1,$2,$3,$4)', [p.id, p.business_name, p.contact_phone, p.contact_email]); }
  await pg.exec("SELECT setval(pg_get_serial_sequence('services','id'), 100); SELECT setval(pg_get_serial_sequence('professionals','id'), 100);");
  for (const e of ex.engagements) {
    await pg.query('INSERT INTO provider_services (professional_id, service_id, external_ref, activation, contact_state, agreement_state, pricing_model, terms_note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [e.professional_id, e.service_id, e.external_ref, e.activation, e.contact_state, e.agreement_state, e.pricing_model, e.terms_note, e.updated_by]);
    for (const l of e.layers) await pg.query('INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, terms_text, status, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [e.professional_id, e.service_id, l.kind, l.model, l.amount, l.terms_text, l.status, l.recorded_by]);
  }
}
const approveAll = (p, o) => { const opt = o || {}, rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: r.changes.filter((c) => !c.manual).map((c) => c.id), acceptManual: opt.manual ? r.changes.filter((c) => c.manual).map((c) => c.id) : [], confirmed: r.needsConfirmation }; } return { rows }; };

test('what the importer produces, the real tables accept: the demo file into an empty database, then again into the same database (nothing left to do)', async () => {
  const pg = await freshDb();
  const p1 = I.buildPreview({ csv: F.FILE, existing: await SIM.readSnapshot(pg) }), r1 = I.planApply(p1, approveAll(p1), await SIM.readSnapshot(pg));
  assert.equal(r1.ok, true); await SIM.runOps(pg, r1.operations);
  assert.equal(await scalar(pg, 'SELECT count(*)::int FROM provider_services'), 8); assert.equal(await scalar(pg, 'SELECT count(*)::int FROM provider_service_prices'), 8); assert.equal(await scalar(pg, 'SELECT count(*)::int FROM services'), 9); assert.equal(await scalar(pg, 'SELECT count(*)::int FROM professionals'), 6);
  // R1, R2, R3, R6 as the database holds them
  assert.equal(await scalar(pg, "SELECT count(*)::int FROM provider_services WHERE activation NOT IN ('draft','pending') OR contact_state = 'active' OR agreement_state IN ('signed','ended') OR pricing_model = 'fixed' OR pricing_id IS NOT NULL"), 0);
  assert.equal(await scalar(pg, "SELECT count(*)::int FROM provider_service_prices WHERE kind = 'provider_offer' OR status <> 'recorded'"), 0);
  assert.equal(await scalar(pg, 'SELECT count(*)::int FROM pricing'), 0, 'no approved-price row'); assert.equal(await scalar(pg, 'SELECT count(*)::int FROM provider_service_compensation'), 0, 'no commission record');
  assert.equal(await scalar(pg, 'SELECT count(*)::int FROM services WHERE active'), 0, 'every imported service starts inactive'); assert.equal(await scalar(pg, 'SELECT count(*)::int FROM service_settings'), 0, 'nothing is cleared or offered');
  const row = (await pg.query("SELECT model, percent_low::float8 AS lo, percent_high::float8 AS hi, terms_text FROM provider_service_prices pr JOIN provider_services ps USING (professional_id, service_id) WHERE ps.external_ref = 'FA-01'")).rows[0];
  assert.deepEqual([row.model, row.lo, row.hi, row.terms_text], ['percent_of_result', 5, 8, 'בין 5-8% מהסכום שנחסך\nלפי היקף התיק'], 'the wording went in verbatim');
  // the second time, read back from the database itself
  const again = I.buildPreview({ csv: F.FILE, existing: await SIM.readSnapshot(pg) });
  assert.deepEqual(again.rows.filter((r) => r.status !== 'skipped').map((r) => r.status), Array(9).fill('unchanged'), JSON.stringify(again.rows.filter((r) => r.status !== 'unchanged' && r.status !== 'skipped').map((r) => [r.rowNumber, r.status, r.changes.map((c) => c.id), r.problems.map((x) => x.code), r.decisions.map((d) => d.type)])));
  assert.equal(again.decisionsNeeded, 0); await pg.close();
});

test('updates that were approved reach the real tables and nothing else moves: an existing database, a changed price, a corrected phone, a hand-made state left alone', async () => {
  const pg = await freshDb(); await seed(pg);
  const before = await SIM.readSnapshot(pg), edited = F.FILE.replace('"1,200"', '"1,350"');
  const p = I.buildPreview({ csv: edited, existing: before });
  assert.deepEqual(p.rows.filter((r) => r.status === 'changed').map((r) => r.rowNumber), [2, 4]);
  const r = I.planApply(p, approveAll(p, { manual: true }), before); assert.equal(r.ok, true); await SIM.runOps(pg, r.operations);
  assert.equal(await scalar(pg, "SELECT amount::float8 FROM provider_service_prices WHERE kind = 'unclassified' AND professional_id = 21 AND service_id = 11"), 1350);
  assert.equal(await scalar(pg, 'SELECT contact_phone FROM provider_profiles WHERE professional_id = 22'), '0521112233');
  assert.equal(await scalar(pg, "SELECT activation FROM provider_services WHERE external_ref = 'RE-01'"), 'pending'); assert.equal(await scalar(pg, "SELECT updated_by LIKE 'import:%' FROM provider_services WHERE external_ref = 'RE-01'"), true);
  const after = await SIM.readSnapshot(pg);
  assert.deepEqual(after.engagements.find((e) => e.external_ref === 'TX-01').layers[0].recorded_by, 'import:' + 'import', 'the changed price says who changed it');
  assert.equal(I.buildPreview({ csv: edited, existing: after }).rows.filter((x) => x.status === 'changed').length, 0, 'applied means nothing left to do');
  await pg.close();
});

test('a plan that fails in the middle leaves nothing behind (one transaction)', async () => {
  const pg = await freshDb();
  const op = (n) => [{ op: 'create_service', ref: 's' + n, name: 'שירות ' + n, topic: null, description: null, active: false, source_row: n }, { op: 'create_provider', ref: 'p' + n, name: 'ספק ' + n, business_name: null, contact_phone: null, contact_email: null, source_row: n },
    { op: 'create_engagement', provider: { ref: 'p' + n }, service: { ref: 's' + n }, set: { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', external_ref: 'SAME', terms_note: null }, updated_by: 'import:t', source_row: n }];
  await assert.rejects(SIM.runOps(pg, op(1).concat(op(2))), /unique|duplicate/i);
  for (const t of ['services', 'professionals', 'provider_profiles', 'provider_services']) assert.equal(await scalar(pg, `SELECT count(*)::int FROM ${t}`), 0, t + ' is empty: the first half of the plan was rolled back');
  await pg.close();
});

test('the code and the database agree on every price layer: 900+ combinations of model, numbers, kind and status are accepted by the table exactly when validateLayer accepts them', async () => {
  const pg = await freshDb();
  await pg.exec("INSERT INTO professionals (id, name) VALUES (50, 'ספק לבדיקה'); INSERT INTO services (id, name) VALUES (50, 'שירות לבדיקה'); INSERT INTO provider_services (professional_id, service_id) VALUES (50, 50);");
  const grid = [];
  for (const model of P.MODELS) for (const amount of [null, 100]) for (const low of [null, 10]) for (const high of [null, 20, 5]) for (const minimum of [null, 500]) for (const kind of P.KINDS) for (const status of ['recorded', 'awaiting_response']) grid.push({ kind, model, status, amount, percent_low: low, percent_high: high, minimum_amount: minimum, terms_text: null, basis_missing: false, source_note: null, source_date: null });
  const extras = [{ percent_low: 0 }, { percent_low: 101 }, { percent_low: 10, percent_high: 101 }, { amount: -1 }, { minimum_amount: -5 }, { terms_text: 'ש'.repeat(600) }, { terms_text: 'ש'.repeat(601) }, { source_note: 'ש'.repeat(601) }, { model: 'free' }, { kind: 'official' }, { status: 'maybe' }, { source_date: '2026-10-20' }];
  const base = { kind: 'market', model: 'variable', status: 'recorded', amount: null, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, basis_missing: false, source_note: null, source_date: null };
  extras.forEach((x) => grid.push(Object.assign({}, base, x)));
  const mismatches = []; let accepted = 0;
  for (const l of grid) {
    let dbOk = true;
    try { await pg.query('INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, status, basis_missing, source_note, source_date, recorded_by) VALUES (50,50,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [l.kind, l.model, l.amount, l.percent_low, l.percent_high, l.minimum_amount, l.terms_text, l.status, l.basis_missing, l.source_note, l.source_date, 'import:t']); await pg.query("DELETE FROM provider_service_prices WHERE kind = $1 AND recorded_by = 'import:t'", [l.kind]); accepted++; } catch (e) { dbOk = false; }
    const codeOk = P.validateLayer(l).length === 0;
    if (dbOk !== codeOk) mismatches.push({ layer: l, db: dbOk, code: codeOk });
  }
  assert.deepEqual(mismatches.slice(0, 3), [], mismatches.length + ' disagreements of ' + grid.length);
  assert.ok(grid.length > 850 && accepted > 20 && accepted < grid.length / 2, 'the grid has both accepted and refused cases: ' + accepted + ' of ' + grid.length);
  await pg.close();
});

test('the code and the database agree on every engagement row: activation x contact x agreement x pricing model x price link, accepted exactly when dbRuleViolations finds nothing', async () => {
  const pg = await freshDb(); await seed(pg);
  await pg.exec("INSERT INTO professionals (id, name) VALUES (50, 'ספק לבדיקה'); INSERT INTO services (id, name) VALUES (50, 'שירות לבדיקה'); INSERT INTO pricing (id, service_id, label, price) VALUES (50, 50, 'מחיר לבדיקה', 100);");
  const grid = [];
  for (const activation of S.ACTIVATION) for (const contact_state of S.CONTACT) for (const agreement_state of S.AGREEMENT) for (const pricing_model of S.PRICING_MODELS) for (const pricing_id of [null, 50]) for (const retired_at of (activation === 'retired' ? [null, '2026-11-01T00:00:00Z'] : [null])) grid.push({ activation, contact_state, agreement_state, pricing_model, pricing_id, retired_at });
  [{ activation: 'live' }, { contact_state: 'called' }, { agreement_state: 'verbal' }, { pricing_model: 'free' }].forEach((x) => grid.push(Object.assign({ activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, retired_at: null }, x)));
  const mismatches = []; let accepted = 0, activeAccepted = 0;
  for (const e of grid) {
    let dbOk = true;
    try { await pg.query('INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id, retired_at) VALUES (50,50,$1,$2,$3,$4,$5,$6)', [e.activation, e.contact_state, e.agreement_state, e.pricing_model, e.pricing_id, e.retired_at]); await pg.query('DELETE FROM provider_services WHERE professional_id = 50 AND service_id = 50'); accepted++; if (e.activation === 'active') activeAccepted++; } catch (err) { dbOk = false; }
    const codeOk = S.dbRuleViolations(e).length === 0;
    if (dbOk !== codeOk) mismatches.push({ row: e, db: dbOk, code: codeOk });
  }
  assert.deepEqual(mismatches.slice(0, 3), [], mismatches.length + ' disagreements of ' + grid.length);
  assert.equal(activeAccepted, 1, 'exactly one combination can be active: signed agreement, active collaboration, a fixed price with a linked price row');
  assert.ok(grid.length > 1400, 'the grid is large: ' + grid.length);
  await pg.close();
});

test('the database itself refuses what the importer is forbidden to write: even a hand-made plan with "active" or a signed state fails at the table', async () => {
  const pg = await freshDb(); await seed(pg);
  const mk = (set) => [{ op: 'create_service', ref: 's', name: 'שירות בדיקה', topic: null, description: null, active: false, source_row: 2 }, { op: 'create_provider', ref: 'p', name: 'ספק בדיקה', business_name: null, contact_phone: null, contact_email: null, source_row: 2 },
    { op: 'create_engagement', provider: { ref: 'p' }, service: { ref: 's' }, set: Object.assign({ activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', external_ref: 'ZZ-1', terms_note: null }, set), updated_by: 'import:t', source_row: 2 }];
  for (const set of [{ activation: 'active' }, { activation: 'active', agreement_state: 'signed', contact_state: 'active' }, { activation: 'active', agreement_state: 'signed', contact_state: 'active', pricing_model: 'fixed' }]) {
    assert.throws(() => I.assertSafe(mk(set)), /unsafe/, 'the importer refuses it first'); await assert.rejects(SIM.runOps(pg, mk(set)), /check|violat/i, 'and the table would refuse it too: ' + JSON.stringify(set));
  }
  assert.equal(await scalar(pg, "SELECT count(*)::int FROM provider_services WHERE external_ref = 'ZZ-1'"), 0); await pg.close();
});
