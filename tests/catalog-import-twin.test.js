'use strict';
// The STRUCTURE TWIN of the owners' real sheet: tests/fixtures/catalog-sheet-structure-twin.csv holds INVENTED data in exactly the structure the real sheet has (22 service rows, 21 with a provider, 3 providers
// with 11/5/5 rows, 15 phones stored as numbers that lost their zero, 10% commission in every row, the same prices/wordings and the two internal domains), so that what the import makes of it can be counted:
//   3 providers, 22 services, 21 engagements, 21 reported prices. Nothing active, nothing approved, no commission, no phone completed without an explicit confirmation.
// Pure engine plus the in-memory database. No network, nothing real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../netlify/functions/_kaspchem/catalog/import.js');
const F = require('./fixtures/catalog-demo.js');
const { INTERNAL_TOPICS } = require('../netlify/functions/_kaspchem/catalog/internal-topics.js');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const TWIN = fs.readFileSync(path.join(__dirname, 'fixtures', 'catalog-sheet-structure-twin.csv'), 'utf8');
const TOPICS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8')).topics.map((t) => ({ id: t.id, name: t.name })).concat(INTERNAL_TOPICS.map((t) => ({ id: t.id, name: t.name })));
const preview = (csv, existing) => I.buildPreview({ csv, existing: existing || F.EMPTY(), topics: TOPICS, maxRows: 300 });
const NEW = { service: { use: 'new' } };
const approvals = (p, o) => { const rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: [], acceptManual: [], confirmed: (o && o.noConfirm) ? [] : r.needsConfirmation, decisions: (r.decisions || []).length ? NEW : undefined }; } return { rows }; };

test('THE TWIN IN NUMBERS: 22 new rows, 3 providers, 22 services, 21 engagements, 21 reported prices (3 market, 18 unclassified), 0 problems, 1 question (the two mortgage refinancing services stay apart), 15 phones to confirm', () => {
  const p = preview(TWIN);
  assert.equal(p.ok, true); assert.deepEqual(p.fileProblems, []); assert.deepEqual(p.warnings, []); assert.equal(p.headerNumber, 4);
  assert.deepEqual(p.summary, { rows_total: 27, new: 22, changed: 0, unchanged: 0, skipped: 5, problem: 0 });
  assert.deepEqual(p.unknownColumns.map((u) => u.text), ['הערות תמחור'], 'the one column that is not read is named');
  assert.equal(p.decisionsNeeded, 1); const q = p.rows.filter((r) => (r.decisions || []).length); assert.deepEqual(q.map((r) => [r.decisions[0].type, r.service.name || r.record.service.name]), [['similar_service', '[דמו] מחזור משכנתא חיצוני']]);
  const plan = I.planApply(p, approvals(p), F.EMPTY()); assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.summary, { create_service: 22, create_provider: 3, create_engagement: 21, create_layer: 21 });
  const kinds = {}; plan.operations.filter((o) => o.op === 'create_layer').forEach((o) => { kinds[o.layer.kind] = (kinds[o.layer.kind] || 0) + 1; assert.equal(o.layer.status, 'recorded', 'a price of the sheet is only reported'); }); assert.deepEqual(kinds, { unclassified: 18, market: 3 });
  const eng = plan.operations.filter((o) => o.op === 'create_engagement').map((o) => o.set); assert.equal(eng.length, 21);
  eng.forEach((e) => { assert.equal(e.activation, 'pending'); assert.ok(['none', 'contacted', 'negotiating'].includes(e.contact_state)); assert.ok(['not_discussed', 'draft'].includes(e.agreement_state)); assert.ok(!('pricing_id' in e), 'no price is linked, no price is approved'); });
  plan.operations.filter((o) => o.op === 'create_service').forEach((o) => assert.equal(o.active, false));
  const doms = {}; plan.operations.filter((o) => o.op === 'create_service').forEach((o) => { doms[o.topic] = (doms[o.topic] || 0) + 1; }); assert.equal(doms.business, 2); assert.equal(doms['savings-investments'], 3, 'the two internal domains keep their five services'); assert.equal(Object.values(doms).reduce((a, b) => a + b, 0), 22);
  assert.equal(JSON.stringify(plan).includes('commission'), false, 'the commission (10% in every row) is not imported');
});

test('NO PHONE IS COMPLETED BY ITSELF: a phone that lost its leading zero is only a proposal; without the explicit confirmation of its row nothing of that row can be saved; the list of corrections names rows and codes, never a contact detail', () => {
  const p = preview(TWIN), restored = p.rows.filter((r) => r.flags.includes('phone_restored'));
  assert.equal(restored.length, 15); restored.forEach((r) => assert.deepEqual(r.needsConfirmation, ['phone_restored']));
  const plan = I.planApply(p, approvals(p, { noConfirm: true }), F.EMPTY()); assert.equal(plan.ok, false, 'approving without confirming the phones is refused'); assert.equal(plan.reason, 'rows_refused');
  assert.equal(plan.refused.filter((r) => /confirm/.test(r.reason)).length, 15, 'exactly the fifteen rows'); assert.deepEqual(plan.operations, [], 'and nothing at all is saved');
  assert.equal(typeof I.correctionList, 'function'); const list = I.correctionList(p);
  assert.equal(list.length, 15, 'fifteen rows need something: the one question is asked on a row whose phone also needs its confirmation');
  assert.equal(list.filter((x) => x.codes.includes('confirm:phone_restored')).length, 15); assert.deepEqual(list.filter((x) => x.codes.some((c) => c.startsWith('decision:'))).map((x) => x.codes.filter((c) => c.startsWith('decision:'))), [['decision:similar_service']]);
  const text = JSON.stringify(list); for (const secret of ['500000101', '500000303', '0500000202', 'twin-a@', 'twin-b@', 'אביגיל', 'בנימין', 'גילי']) assert.equal(text.includes(secret), false, 'the list holds no contact detail or name: ' + secret);
  list.forEach((x) => { assert.ok(Number.isInteger(x.row)); x.codes.forEach((c) => assert.match(c, /^(problem|confirm|decision):[a-z_]+(:[a-z_]+)?$/)); });
});

test('THE TWIN ON THE DATABASE: saving it makes exactly 3 providers, 22 services, 21 engagements and 21 reported prices; every service is off and every engagement pending; no price, no commission; the log holds no cell of the file; the same save again is refused', async () => {
  const w = await world({ seed: false }); await w.open();
  const call = async (csv, extra) => w.call('POST', '/catalog/imports/' + (extra ? 'apply' : 'preview'), YOSI, { body: Object.assign({ csv }, extra || {}) });
  const pv = await call(TWIN); assert.equal(pv.status, 200, JSON.stringify(pv.body)); const p = pv.body.preview;
  assert.deepEqual(p.summary, { rows_total: 27, new: 22, changed: 0, unchanged: 0, skipped: 5, problem: 0 });
  const bad = await call(TWIN, { previewId: p.previewId, approvals: approvals(p, { noConfirm: true }) }); assert.deepEqual([bad.status, bad.body.error], [422, 'rows_refused'], 'the phones are not confirmed: nothing is saved');
  const n = async (sql) => (await w.owner(sql))[0].n, count = async (t) => n('SELECT count(*)::int AS n FROM ' + t);
  assert.deepEqual([await count('services'), await count('professionals'), await count('provider_services'), await count('provider_service_prices'), await count('catalog_imports')], [0, 0, 0, 0, 0], 'a refused save writes nothing');
  const res = await call(TWIN, { previewId: p.previewId, approvals: approvals(p) }); assert.equal(res.status, 200, JSON.stringify(res.body)); assert.equal(res.body.applied, true);
  assert.deepEqual([await count('professionals'), await count('services'), await count('provider_services'), await count('provider_service_prices')], [3, 22, 21, 21]);
  assert.equal(await n('SELECT count(*)::int AS n FROM services WHERE active'), 0, 'every service is off');
  assert.equal(await n("SELECT count(*)::int AS n FROM provider_services WHERE activation <> 'pending'"), 0, 'every engagement waits for approval');
  assert.equal(await n("SELECT count(*)::int AS n FROM provider_services WHERE agreement_state IN ('signed', 'ended') OR contact_state IN ('active', 'stopped') OR pricing_id IS NOT NULL OR pricing_model = 'fixed'"), 0, 'nothing signed, nothing active, no price linked, no fixed price model');
  assert.equal(await n("SELECT count(*)::int AS n FROM provider_service_prices WHERE status <> 'recorded' OR kind NOT IN ('market', 'unclassified')"), 0, 'every price is only reported');
  assert.deepEqual([await count('pricing'), await count('provider_service_compensation'), await count('service_settings')], [0, 0, 0], 'no approved price, no commission, no service setting');
  const topics = (await w.owner('SELECT topic, count(*)::int AS n FROM services GROUP BY topic ORDER BY topic')).map((r) => r.topic);
  assert.ok(topics.includes('business') && topics.includes('savings-investments') && topics.every((t) => t && !/[א-ת]/.test(t)), 'topics are ids, internal domains included');
  assert.deepEqual((await w.owner("SELECT contact_phone FROM provider_profiles ORDER BY contact_phone")).map((r) => r.contact_phone), ['0500000101', '0500000202', '0500000303'], 'the confirmed phones have their zero');
  const logs = JSON.stringify(await w.owner('SELECT detail::text AS d FROM audit_log')) + JSON.stringify(await w.owner('SELECT c::text AS d FROM catalog_imports c'));
  for (const secret of ['0500000101', '500000101', 'twin-a@', 'אביגיל', 'מחזור משכנתא', 'TW-01']) assert.equal(logs.includes(secret), false, 'the audit and the import log hold no cell of the file: ' + secret);
  const again = await call(TWIN, { previewId: p.previewId, approvals: approvals(p) }); assert.deepEqual([again.status, again.body.error], [409, 'preview_stale'], 'the same save again is refused');
  assert.deepEqual([await count('professionals'), await count('services'), await count('provider_services'), await count('provider_service_prices'), await count('catalog_imports')], [3, 22, 21, 21, 1]);
  const pv2 = await call(TWIN); assert.equal(pv2.body.preview.summary.new, 0, 'a new preview finds nothing new'); assert.equal(pv2.body.preview.summary.unchanged, 22);
  await w.pg.close();
});
