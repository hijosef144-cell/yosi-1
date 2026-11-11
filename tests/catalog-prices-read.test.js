'use strict';
// Stage 5b-3, the READ side of the prices: GET /catalog/prices (one line per engagement: its layers, the linked price, whether that price fits) and GET /catalog/pricing-rows (the rows of the older pricing table
// that can be linked, and whether each one fits a named engagement). Reads only; no cost, commission or note of a price in any answer; the rule of "fits" is the rule of the linking route and of the activation.
// In-memory Postgres (PGlite) running as kaspchem_app; synthetic data; no network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { world, closeAll, YOSI, AVI, STRANGER } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const get = (w, p, who) => w.call('GET', p, who === undefined ? YOSI : who);
const LEAK = /NOTE-SECRET|PAYER-SECRET|31337|41414|77\.77|commission|compensation|"cost"/i;
// [what happened to price 7 (approved, 1200, service 11, provider 21), the SQL, does it still fit the engagement 21/11]: the very cases of tests/catalog-lifecycle.test.js
const CASES = [['as linked', null, true], ['moved to another service', 'UPDATE pricing SET service_id = 12 WHERE id = 7', false], ['moved to another provider', 'UPDATE pricing SET professional_id = 22 WHERE id = 7', false], ['without an amount', 'UPDATE pricing SET price = NULL WHERE id = 7', false],
  ['no longer approved', 'UPDATE pricing SET approved = false, approved_by = NULL, approved_at = NULL, public = false WHERE id = 7', false], ['a general price of the same service', 'UPDATE pricing SET professional_id = NULL WHERE id = 7', true], ['a general price of another service', 'UPDATE pricing SET professional_id = NULL, service_id = 12 WHERE id = 7', false]];

test('prices.list: one line per engagement with its three layers kept apart, the linked price with its approval and whether it fits; the filters; nothing confidential', async () => {
  const w = await world(); await w.open();
  const r = await get(w, '/catalog/prices'); assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.prices.map((x) => [x.provider_id, x.service_id]), [[21, 11], [22, 12]].sort((a, b) => 0), 'both engagements, by provider and service name');
  const a = r.body.prices.find((x) => x.provider_id === 21);
  assert.deepEqual(Object.keys(a).sort(), ['activation', 'layers', 'linked', 'pricing_model', 'provider_id', 'provider_name', 'service_id', 'service_name']);
  assert.deepEqual(Object.keys(a.layers), ['unclassified']); assert.deepEqual(a.layers.unclassified, { model: 'fixed', amount: 1200, percent_low: null, percent_high: null, minimum_amount: null, status: 'recorded', basis_missing: false });
  assert.deepEqual(a.linked, { id: 7, label: 'בדיקת החזר', price: 1200, approved: true, public: false, fits: true });
  const b = r.body.prices.find((x) => x.provider_id === 22); assert.deepEqual([b.layers, b.linked], [{}, null], 'no layer and no link: empty, not invented');
  assert.doesNotMatch(JSON.stringify(r.body), LEAK);
  // the three layers of one engagement, each in its place
  await w.owner("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, status, recorded_by) VALUES (21, 11, 'provider_offer', 'percent_of_result', NULL, 8, 10, 'awaiting_response', 'avi@example.test'), (21, 11, 'market', 'fixed', 1100, NULL, NULL, 'recorded', 'avi@example.test')");
  const full = (await get(w, '/catalog/prices?provider_id=21')).body.prices[0]; assert.deepEqual(Object.keys(full.layers).sort(), ['market', 'provider_offer', 'unclassified']);
  assert.deepEqual([full.layers.provider_offer.percent_low, full.layers.provider_offer.percent_high, full.layers.provider_offer.status, full.layers.market.amount], [8, 10, 'awaiting_response', 1100]);
  // the filters
  const f = async (q) => (await get(w, '/catalog/prices?filter=' + q)).body.prices.map((x) => x.provider_id);
  assert.deepEqual([await f('no_price'), await f('unclassified'), await f('offer'), await f('awaiting_answer'), await f('linked'), await f('linked_problem')], [[22], [21], [21], [21], [21], []]);
  assert.deepEqual((await get(w, '/catalog/prices?q=' + encodeURIComponent('דנה'))).body.prices.map((x) => x.provider_id), [21]); assert.equal((await get(w, '/catalog/prices?q=' + encodeURIComponent('%'))).body.total, 0, 'a % is a literal, not a pattern');
  assert.deepEqual((await get(w, '/catalog/prices?service_id=12')).body.prices.map((x) => x.provider_id), [22]);
  // paging and bad input
  const p1 = (await get(w, '/catalog/prices?limit=1&offset=1')).body; assert.deepEqual([p1.total, p1.limit, p1.offset, p1.prices.length], [2, 1, 1, 1]);
  for (const bad of ['?filter=nope', '?provider_id=abc', '?limit=0', '?limit=201', '?unknown=1']) assert.equal((await get(w, '/catalog/prices' + bad)).status, 400, bad);
  assert.equal(JSON.stringify((await get(w, '/catalog/prices?limit=1000')).body.error), '"bad_query"');
});

test('prices.list and pricing.rows follow the rule of the linking route and of the activation for "fits", on every case, and agree with each other', async () => {
  for (const [name, sql, fits] of CASES) {
    const w = await world(); await w.open(); if (sql) await w.owner(sql);
    const list = (await get(w, '/catalog/prices?provider_id=21')).body.prices[0], rows = (await get(w, '/catalog/pricing-rows?for_provider_id=21&for_service_id=11')).body.pricing_rows.find((x) => x.id === 7);
    assert.equal(list.linked.fits, fits, name + ' (the list)'); assert.equal(rows.fits_engagement, fits, name + ' (the rows)');
    assert.deepEqual(((await get(w, '/catalog/prices?filter=linked_problem')).body.prices.map((x) => x.provider_id)), fits ? [] : [21], name + ' (the filter of a linked price that does not fit)');
    // and the linking route itself says the same (the one rule): a PENDING engagement is linked to price 7 again only when it fits
    await w.owner('UPDATE provider_services SET pricing_id = NULL, pricing_model = \'tbd\' WHERE professional_id = 21 AND service_id = 11');
    const link = await w.call('POST', '/catalog/engagements/21/11/link-price', YOSI, { body: { pricing_id: 7, expected_pricing_id: null } });
    assert.equal(link.status === 200, fits, name + ' (the linking route): ' + link.status + ' ' + (link.body && link.body.error));
  }
  // the same on the source: one text of the rule, in the two places that decide, and the one of the reads
  const writes = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_kaspchem', 'admin-catalog-writes.js'), 'utf8'), prices = require('../netlify/functions/_kaspchem/catalog-prices-store.js');
  const rule = (s) => s.replace(/\bps\.|\bprovider_services\./g, 'E.').replace(/\s+/g, ' ').trim();
  assert.equal(rule(prices.FITS), rule(/const PRICE_FITS = '([^']+)'/.exec(writes)[1]), 'the read side asks exactly what the write side asks');
});

test('pricing.rows: the rows of the older pricing table that can be linked, with their state, their owner, how many engagements link them, and (for a named engagement) whether each fits; no cost, commission or note', async () => {
  const w = await world(); await w.open();
  const r = await get(w, '/catalog/pricing-rows'); assert.equal(r.status, 200);
  assert.deepEqual(r.body.pricing_rows.map((x) => x.id), [9, 8, 7], 'newest first');
  const row7 = r.body.pricing_rows.find((x) => x.id === 7); assert.deepEqual(Object.keys(row7).sort(), ['approved', 'fits_engagement', 'id', 'label', 'linked_count', 'linked_working', 'price', 'provider_id', 'provider_name', 'public', 'service_id', 'service_name']);
  assert.deepEqual([row7.label, row7.price, row7.approved, row7.public, row7.service_id, row7.provider_id, row7.provider_name, row7.linked_count, row7.linked_working, row7.fits_engagement], ['בדיקת החזר', 1200, true, false, 11, 21, 'דנה לבני', 1, 0, null], 'without a named engagement nothing says "fits"');
  assert.deepEqual(r.body.pricing_rows.find((x) => x.id === 8).provider_id, null, 'a general price has no provider'); assert.doesNotMatch(JSON.stringify(r.body), LEAK);
  const forService = (await get(w, '/catalog/pricing-rows?service_id=11&for_provider_id=21&for_service_id=11')).body.pricing_rows; assert.deepEqual(forService.map((x) => [x.id, x.fits_engagement]), [[7, true]]);
  const other = (await get(w, '/catalog/pricing-rows?service_id=12&for_provider_id=22&for_service_id=12')).body.pricing_rows; assert.deepEqual(other.map((x) => [x.id, x.fits_engagement]), [[8, false]], 'a general price of the service, but not approved');
  assert.deepEqual((await get(w, '/catalog/pricing-rows?q=' + encodeURIComponent('כללי'))).body.pricing_rows.map((x) => x.id), [8]); assert.equal((await get(w, '/catalog/pricing-rows?q=' + encodeURIComponent('_'))).body.total, 0, 'an underscore is a literal');
  // a working engagement is counted
  await w.owner("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11");
  const r2 = (await get(w, '/catalog/pricing-rows?service_id=11')).body.pricing_rows[0]; assert.deepEqual([r2.linked_count, r2.linked_working], [1, 1]);
  for (const bad of ['?for_provider_id=0', '?service_id=abc', '?limit=201', '?x=1']) assert.equal((await get(w, '/catalog/pricing-rows' + bad)).status, 400, bad);
});

test('who may read: the owners only, and only while the catalog is open; the same answer for every route while it is closed; the answer filter is on', async () => {
  const w = await world();
  for (const p of ['/catalog/prices', '/catalog/pricing-rows']) { const closed = await get(w, p); assert.equal(closed.status, 403, p + ' closed'); assert.equal(closed.body.error, 'catalog_disabled'); }
  await w.open();
  for (const p of ['/catalog/prices', '/catalog/pricing-rows']) { assert.equal((await get(w, p, null)).status, 401, p); assert.equal((await get(w, p, STRANGER)).status, 403, p); assert.equal((await get(w, p, AVI)).status, 200, p); assert.equal((await w.call('POST', p, YOSI, { body: {} })).status, 404, 'no write on a read route'); assert.equal((await w.call('DELETE', p, YOSI)).status, 404); }
  // they write nothing at all: not a row of the journal, not a change in any table
  const before = await w.fingerprint(); const audits = (await w.audits()).length;
  await get(w, '/catalog/prices'); await get(w, '/catalog/pricing-rows?for_provider_id=21&for_service_id=11'); assert.deepEqual(await w.fingerprint(), before); assert.equal((await w.audits()).length, audits);
  // the source: only SELECTs with listed columns and $n parameters, no star, no interpolation of input
  const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', '_kaspchem', 'catalog-prices-store.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /select\s+\*|\b\w+\.\*|\$\{|\b(INSERT|UPDATE|DELETE)\b\s+(INTO|\w+\s+SET|FROM)/i); assert.doesNotMatch(src, /pr\.(cost|commission|notes)|\bcost\b|commission/i);
});
