'use strict';
// P1: the older PATCH /pricing/:id does not change a price that is linked to an ACTIVE engagement of the provider catalog (it would leave the engagement active with a price that no longer fits). Everything else about the
// older pricing routes is exactly what it was. In-memory Postgres (PGlite) with the real tables, running as kaspchem_app; synthetic data; no network, no Neon.
// What this file cannot prove: a concurrent ACTIVATION in the very same moment (one connection here). That window is documented and stays a blocker for a real activation (docs/research/raw/PROVIDER-M1-PRICING-FIX-PLAN.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').split('\r\n').join('\n');
const j = (b) => ({ body: b });
const patch = (w, id, body) => w.call('PATCH', '/pricing/' + id, YOSI, j(body));
const BASE = { service_id: 11, professional_id: 21, label: 'בדיקת החזר', price: 1200, cost: 0, commission: 0, notes: null };
// the four changes that break the rule of the catalog, and one that keeps the price valid in the eyes of the rule but is still an edit (it always takes the approval away)
const CHANGES = [['the amount', { price: 1300 }], ['moved to another service', { service_id: 12 }], ['moved to another provider', { professional_id: 22 }], ['without an amount', { price: '' }], ['only the label', { label: 'תווית חדשה' }]];
const setEng = (w, sets, p, s) => w.owner('UPDATE provider_services SET ' + sets + ' WHERE professional_id = ' + (p || 21) + ' AND service_id = ' + (s || 11));
const STATES = [['active', "activation = 'active', agreement_state = 'signed', contact_state = 'active'", true], ['pending', "activation = 'pending'", false], ['paused', "activation = 'paused', paused_reason = 'חופשה'", false], ['draft', "activation = 'draft'", false],
  ['retired', "activation = 'retired', retired_reason = 'עזב', retired_at = '2026-11-01T10:00:00Z'", false]];
const priceRow = async (w, id) => (await w.owner('SELECT service_id, professional_id, label, price::float8 AS price, approved, approved_by, public FROM pricing WHERE id = ' + id))[0];
const pricingAudits = (w) => w.audits("action LIKE 'pricing.%'");

test('a price linked to an ACTIVE engagement is not changed by the older PATCH: refused with 409 and a sentence in words, the row is exactly as it was (still approved), nothing is written to the journal; for every kind of change', async () => {
  for (const [name, change] of CHANGES) {
    const w = await world(); await w.open(); await setEng(w, STATES[0][1]);
    const before = await priceRow(w, 7), fp = await w.fingerprint(['pricing']), audits = (await pricingAudits(w)).length;
    const r = await patch(w, 7, Object.assign({}, BASE, change));
    assert.deepEqual([r.status, r.body.error], [409, 'price_linked_to_active_engagement'], name);
    assert.match(r.body.message, /המחיר משויך להתקשרות פעילה בקטלוג הספקים/); assert.match(r.body.message, /יש להשהות אותה בקטלוג לפני שינוי המחיר/); assert.match(r.body.message, /לא נשמר דבר/);
    assert.deepEqual(await priceRow(w, 7), before, name + ': the price row is untouched (still approved)'); assert.equal(before.approved, true);
    assert.deepEqual(await w.fingerprint(['pricing']), fp, name + ': nothing in the table moved'); assert.equal((await pricingAudits(w)).length, audits, name + ': no journal row for a change that did not happen');
    assert.equal((await w.owner("SELECT activation FROM provider_services WHERE professional_id = 21 AND service_id = 11"))[0].activation, 'active', 'the engagement is as it was');
  }
});

test('every other state of the engagement, and a price with no link, behave exactly as before: the edit goes through, takes the approval and the publication away, and writes its journal row', async () => {
  for (const [state, sets, blocked] of STATES.slice(1)) {
    const w = await world(); await w.open(); await setEng(w, sets);
    for (const [name, change] of CHANGES) {
      await w.owner("UPDATE pricing SET service_id = 11, professional_id = 21, label = 'בדיקת החזר', price = 1200, approved = true, approved_by = 'yosi@example.test', approved_at = now(), public = true WHERE id = 7"); const audits0 = (await pricingAudits(w)).length;
      const r = await patch(w, 7, Object.assign({}, BASE, change));
      assert.deepEqual([r.status, r.body], [200, { ok: true }], state + ' / ' + name);
      const after = await priceRow(w, 7); assert.deepEqual([after.approved, after.approved_by, after.public], [false, null, false], 'the older meaning: an edit takes the approval away');
      const expected = Object.assign({}, BASE, change); assert.deepEqual([after.service_id, after.professional_id, after.price], [expected.service_id, expected.professional_id, expected.price === '' ? null : expected.price]);
      assert.equal((await pricingAudits(w)).length - audits0, 1, 'one journal row'); assert.equal(blocked, false);
    }
  }
  // a price that no engagement links to (8, general), and one that does not exist: as ever
  const w = await world(); await w.open(); await setEng(w, STATES[0][1]);
  assert.deepEqual([(await patch(w, 8, { service_id: 12, professional_id: '', label: 'כללי', price: 950, cost: 0, commission: 0 })).status], [200]); assert.equal((await priceRow(w, 8)).price, 950);
  const none = await patch(w, 99999, BASE); assert.deepEqual([none.status, none.body], [200, { ok: true }], 'a price that does not exist has always answered ok');
  // linked to an active AND a pending engagement: blocked; linked to a pending one only: allowed
  await w.owner("UPDATE provider_services SET activation = 'pending', pricing_model = 'fixed', pricing_id = 7 WHERE professional_id = 22 AND service_id = 12"); assert.equal((await patch(w, 7, BASE)).status, 409);
  await setEng(w, "activation = 'pending', agreement_state = 'draft', contact_state = 'contacted'"); assert.equal((await patch(w, 7, BASE)).status, 200, 'the same price once nothing active links to it');
});

test('the other older pricing routes are untouched, even for a price linked to an active engagement: approve, publish, withdraw from the public and create work exactly as before', async () => {
  const w = await world(); await w.open(); await setEng(w, STATES[0][1]);
  assert.deepEqual([(await w.call('POST', '/pricing/7/approve', YOSI, j({ public: false }))).status], [200]);
  assert.deepEqual([(await w.call('POST', '/pricing/7/approve', YOSI, j({ public: true }))).status], [200]); assert.equal((await priceRow(w, 7)).public, true);
  assert.deepEqual([(await w.call('POST', '/pricing/7/unpublish', YOSI, j({}))).status], [200]); assert.equal((await priceRow(w, 7)).public, false);
  const created = await w.call('POST', '/pricing', YOSI, j(Object.assign({}, BASE, { label: 'חדש' }))); assert.equal(created.status, 200); assert.ok(Number.isInteger(created.body.id) && created.body.id >= 1);
  const row = await priceRow(w, 7); assert.deepEqual([row.approved, row.service_id, row.professional_id, row.price], [true, 11, 21, 1200], 'the linked price is as valid as ever');
  assert.equal((await w.call('GET', '/pricing', YOSI)).status, 200);
  // the activation switch and the catalog switch do not decide anything here: closed or open, the guard is the same
  const w2 = await world(); await setEng(w2, STATES[0][1]); assert.equal((await patch(w2, 7, BASE)).status, 409, 'the catalog closed');
  // the permissions are those of every older route
  assert.equal((await w.call('PATCH', '/pricing/7', null, j(BASE))).status, 401); assert.equal((await w.call('PATCH', '/pricing/7', 'stranger@example.test', j(BASE))).status, 403);
  assert.equal((await w.call('PATCH', '/pricing/7', YOSI, { body: BASE, noCsrf: true })).status, 403);
});

test('THE THREE STATES of the database: before migration 002 the older route is exactly what it was; after 002 and before the grants (the tables exist, the application role cannot read them) it is STILL exactly what it was, with no permission error; after the grants the guard applies', async () => {
  const REVOKES = require('../scripts/kaspchem-grants.js').loadStatements('rollback');   // the three REVOKEs of db/grants/m1-app-grants.rollback.sql: they put kaspchem_app back to "no privilege on the catalog tables"
  const canRead = async (w) => (await w.owner("SELECT has_table_privilege('kaspchem_app', 'public.provider_services', 'SELECT') AS x"))[0].x;
  // 1. before 002: no catalog tables at all, and nothing about them in the way
  const w1 = await world(); await w1.open();
  await w1.owner('DROP TRIGGER IF EXISTS kc_pricing_guard ON pricing');   // a database before the catalog tables cannot have migration 003 (its trigger needs provider_services): only matters when the world has the guard
  await w1.owner('DROP TABLE provider_service_prices, provider_service_compensation, provider_services CASCADE');
  const r1 = await patch(w1, 7, Object.assign({}, BASE, { price: 1400 })); assert.deepEqual([r1.status, r1.body], [200, { ok: true }]); assert.equal((await priceRow(w1, 7)).price, 1400);
  // 2. after 002, before the grants: the tables exist and kaspchem_app has no privilege on them. The route used to answer 500 here although nothing was wrong; now it is what it was, journal row included
  const w2 = await world(); await w2.open(); for (const s of REVOKES) await w2.owner(s);
  assert.equal(await canRead(w2), false, 'the role cannot read the catalog table in this state');
  const audits0 = (await pricingAudits(w2)).length, r2 = await patch(w2, 7, Object.assign({}, BASE, { price: 1450 }));
  assert.deepEqual([r2.status, r2.body], [200, { ok: true }], 'no permission error: the older route behaves as before'); assert.equal((await priceRow(w2, 7)).price, 1450); assert.equal((await pricingAudits(w2)).length - audits0, 1, 'one journal row');
  const missing = await patch(w2, 99999, BASE); assert.deepEqual([missing.status, missing.body], [200, { ok: true }], 'a price that does not exist has always answered ok');
  // 3. after the grants: the guard applies (the application role can read the table, an ACTIVE engagement blocks the edit)
  const w3 = await world(); await w3.open(); await setEng(w3, STATES[0][1]); assert.equal(await canRead(w3), true);
  const fp3 = await w3.fingerprint(['pricing']), r3 = await patch(w3, 7, BASE); assert.deepEqual([r3.status, r3.body.error], [409, 'price_linked_to_active_engagement']); assert.deepEqual(await w3.fingerprint(['pricing']), fp3, 'nothing changed');
  // the corner: the grants taken back while an engagement is active. The application check is skipped (the role cannot read), and with migration 003 in place the DATABASE refuses the edit, mapped to the same 409
  const w4 = await world({ guard003: true }); await w4.open(); await setEng(w4, STATES[0][1]); for (const s of REVOKES) await w4.owner(s);
  const fp4 = await w4.fingerprint(['pricing']), r4 = await patch(w4, 7, BASE); assert.deepEqual([r4.status, r4.body.error], [409, 'price_linked_to_active_engagement'], 'the trigger of 003 still protects'); assert.deepEqual(await w4.fingerprint(['pricing']), fp4); assert.equal((await priceRow(w4, 7)).approved, true);
});

test('the guard is part of the UPDATE itself and the screen says it in words; the route keeps its shape for everything else', () => {
  const R = read('netlify', 'functions', '_kaspchem', 'admin-router.js'), A = read('admin', 'kaspchem', 'admin.js'), G = read('netlify', 'functions', '_kaspchem', 'catalog-price-guard.js');
  const sec = R.slice(R.indexOf("on('PATCH', '/pricing/(\\\\d+)'"), R.indexOf("on('POST', '/pricing/(\\\\d+)/approve'"));
  assert.ok(sec.length > 400 && sec.includes("' AND NOT ' + priceGuard.ACTIVE_LINK : '') + ' RETURNING id'"), 'the condition is in the UPDATE statement, with RETURNING id');
  assert.ok(G.includes("const ACTIVE_LINK = \"EXISTS (SELECT 1 FROM provider_services ps WHERE ps.pricing_id = pricing.id AND ps.activation = 'active')\";"), 'only an ACTIVE engagement blocks');
  assert.ok(sec.includes('const guarded = await priceGuard.catalogTablesExist();') && sec.includes('if (guarded && !rows.length)'), 'before the migration the route is the old one');
  assert.ok(sec.indexOf('throw new HttpError(409') < sec.indexOf("await audit(c.me.email, 'pricing.update'"), 'the journal row is written only after a change');
  const msg = /LINKED_TO_ACTIVE = '([^']+)'/.exec(G)[1]; assert.match(msg, /[֐-׿]/); assert.ok(sec.includes("'price_linked_to_active_engagement', priceGuard.LINKED_TO_ACTIVE"));
  assert.ok(A.includes("price_linked_to_active_engagement: '" + msg + "'"), 'the older screen has the very same sentence for the code');
  assert.equal((R.replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '').match(/\bactive\b/g) || []).length, 2, 'the older router still mentions "active" only where it always did (the active mark of a service), not an engagement state: the catalog file does');
  assert.equal((R.match(/on\('(POST|PATCH)', '\/pricing/g) || []).length, 4, 'still the same four older pricing routes that write (create, edit, approve, unpublish)');
});
