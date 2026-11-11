'use strict';
// Catalog server, stage 4a (READ ONLY): the switch, who may ask, what may be read, that nothing is written, and the change-detection mechanism that stage 4b will rely on.
// Everything runs on an in-memory Postgres (PGlite) with the real tables (migration 002), the real grants of the application role and synthetic data. The server code runs AS kaspchem_app,
// so a privilege the read side does not have would fail here. Nothing touches Neon, Netlify or the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const OPEN = new Set();
class PGlite extends PGliteBase { constructor(...a) { super(...a); OPEN.add(this); const close = this.close.bind(this); this.close = async () => { OPEN.delete(this); return close(); }; } }
test.after(async () => { for (const db of [...OPEN]) { try { await db.close(); } catch (e) { /* already closed */ } } });

const db = require('../netlify/functions/_kaspchem/db');
const entry = require('../netlify/functions/_kaspchem/admin-entry.js');
const router = require('../netlify/functions/_kaspchem/admin-catalog-router.js');
const guards = require('../netlify/functions/_kaspchem/catalog-guards.js');
const store = require('../netlify/functions/_kaspchem/catalog-store.js');
const Imp = require('../netlify/functions/_kaspchem/catalog/import.js');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'netlify', 'functions');
const DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const M002 = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8');
const GRANTS = fs.readFileSync(path.join(ROOT, 'db', 'grants', 'm1-app-grants.sql'), 'utf8');
const TODAY = `GRANT INSERT, SELECT, UPDATE ON applicants, consents, outcomes, pricing, professionals, revenues, services, settings, treatment_requests TO kaspchem_app;
  GRANT INSERT, SELECT ON audit_log, request_notes TO kaspchem_app; GRANT DELETE, INSERT, SELECT, UPDATE ON questionnaire_versions TO kaspchem_app; GRANT DELETE, INSERT, SELECT ON rate_limits TO kaspchem_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kaspchem_app;`;   // what kaspchem_app really has on the base tables today
process.env.KASPCHEM_ADMIN_EMAILS = 'yosi@example.test,avi@example.test';
delete process.env.KASPCHEM_REQUIRE_ROLE;
const YOSI = 'yosi@example.test', AVI = 'avi@example.test', STRANGER = 'stranger@example.test';
const NOW = new Date('2026-11-08T10:00:00Z');

// ---- the world: schema, grants, synthetic data, a recording driver ------------------------------------------------------------------------------------------------------------------
const SEED = `
  INSERT INTO services (id, name, topic, description) VALUES (11, 'בדיקת זכאות להחזר מס', 'מיסים', 'בדיקה של החזרי מס לשכירים'), (12, 'ייעוץ משכנתא', 'נדל"ן', NULL), (13, 'ייעוץ משכנתאות', 'נדל"ן', NULL), (14, 'שירות ללא התקשרות', NULL, NULL), (15, 'חבילה 100% מקצועית', 'מיסים', NULL);
  INSERT INTO service_settings (service_id, code, finding_tags, topics, legal_cleared, legal_cleared_by, legal_cleared_at, legal_note) VALUES (11, 'tax-refund-check', '{t1}', '{}', true, 'yosi@example.test', '2026-11-01T00:00:00Z', 'אושר בכתב');
  INSERT INTO professionals (id, name, contact, agreement_notes) VALUES (21, 'דנה לבני', 'CONTACT-OLD-FIELD', 'AGREEMENT-NOTES-SECRET'), (22, 'רועי שמש', NULL, NULL), (23, 'מיכל פז', NULL, NULL), (24, 'נועה אדלר', NULL, NULL);
  INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email, internal_notes, archived_at, paused_until) VALUES
    (21, 'לבני מס', '0501234567', 'dana@example.test', 'NOTE-INTERNAL', NULL, NULL), (22, NULL, '0521112233', NULL, NULL, NULL, NULL), (23, NULL, NULL, NULL, NULL, '2026-10-01T00:00:00Z', NULL), (24, 'אדלר ושות', NULL, NULL, NULL, NULL, now() + interval '30 days');
  INSERT INTO pricing (id, service_id, professional_id, label, price, cost, commission, notes, approved, approved_by, approved_at) VALUES (7, 11, 21, 'בדיקת החזר', 1200, 31337.31, 41414.14, 'NOTE-SECRET-XYZ', true, 'yosi@example.test', now());
  INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id, external_ref, terms_note, updated_by) VALUES
    (21, 11, 'pending', 'negotiating', 'draft', 'fixed', 7, 'TX-01', 'שוחחנו בטלפון', 'import:owner'), (22, 12, 'draft', 'none', 'not_discussed', 'tbd', NULL, 'RE-01', NULL, 'import:owner'), (21, 12, 'paused', 'contacted', 'not_discussed', 'percent_of_result', NULL, NULL, NULL, 'owner@example.test');
  INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, status, source_note, source_date, terms_text, recorded_by) VALUES
    (21, 11, 'market', 'fixed', 1100, 'recorded', 'אתר הספק', '2026-10-20', NULL, 'import:owner'), (21, 11, 'provider_offer', 'fixed', 1000, 'awaiting_response', NULL, NULL, NULL, 'owner@example.test'), (21, 11, 'unclassified', 'fixed', 1200, 'recorded', NULL, NULL, 'מחיר קבוע', 'import:owner');
  INSERT INTO provider_service_prices (professional_id, service_id, kind, model, percent_low, status, terms_text, recorded_by) VALUES (22, 12, 'unclassified', 'percent_of_result', 10, 'recorded', '10% מהחיסכון', 'import:owner');
  INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, payer_note, recorded_by) VALUES (21, 11, 'percent', 77.77, 'PAYER-SECRET', 'owner@example.test');
  INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, problems, imported_by) VALUES ('csv', repeat('a', 64), 11, 9, 0, 2, '[{"row":4,"code":"price_not_numeric"}]', 'yosi@example.test');`;

async function world() {
  const pg = new PGlite();
  await pg.exec(DDL); await pg.exec('CREATE ROLE kaspchem_app NOLOGIN'); await pg.exec(TODAY); await pg.exec(M002); await pg.exec(GRANTS); await pg.exec(SEED);
  await pg.exec("SELECT setval(pg_get_serial_sequence('services', 'id'), 1000); SELECT setval(pg_get_serial_sequence('professionals', 'id'), 1000)");   // the seed used explicit ids
  const w = { pg, rec: [], failSwitch: false };
  w.asApp = () => pg.exec('SET SESSION AUTHORIZATION kaspchem_app'); w.asOwner = () => pg.exec('SET SESSION AUTHORIZATION postgres');
  db.setDriver(async (text, params) => {
    w.rec.push({ kind: 'query', text, params });
    if (w.failSwitch && /FROM settings WHERE key = \$1/.test(text) && params && params[0] === guards.SWITCH_KEY) throw new Error('simulated outage');
    return (await pg.query(text, params)).rows;
  });
  db.setTransactionDriver(async (stmts, o) => {
    const level = { ReadCommitted: 'READ COMMITTED', RepeatableRead: 'REPEATABLE READ', Serializable: 'SERIALIZABLE' }[o.isolationLevel] || 'READ COMMITTED';
    await pg.exec('BEGIN ISOLATION LEVEL ' + level + (o.readOnly ? ' READ ONLY' : ''));
    try { const out = []; for (const s of stmts) { w.rec.push({ kind: 'tx', text: s.text, params: s.params, readOnly: o.readOnly, iso: o.isolationLevel }); out.push((await pg.query(s.text, s.params)).rows); } await pg.exec('COMMIT'); return out; }
    catch (e) { await pg.exec('ROLLBACK').catch(() => {}); throw e; }
  });
  store.setClock(() => NOW);
  w.setSwitch = async (v) => { await w.asOwner(); await pg.exec("DELETE FROM settings WHERE key = 'private.catalog_enabled'"); if (v !== undefined) await pg.query("INSERT INTO settings (key, value, updated_by) VALUES ('private.catalog_enabled', $1::jsonb, 'test')", [JSON.stringify(v)]); await w.asApp(); };
  w.call = async (method, p, who, over) => {
    const o = over || {}, headers = { host: 'localhost', 'content-type': 'application/json' };
    if (method !== 'GET' && !o.noCsrf) headers['x-kaspchem'] = '1';
    const req = new Request('http://localhost/api/kaspchem/admin' + p, { method, headers, body: method === 'GET' ? undefined : (o.body || '{}') });
    const res = await entry.run(req, async () => (who ? { email: who, roles: ['admin'] } : null));
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  w.fingerprint = async () => { await w.asOwner(); const out = {}; for (const t of ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'settings', 'applicants', 'treatment_requests', 'revenues', 'outcomes']) out[t] = (await pg.query(`SELECT count(*)::int AS c, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0]; await w.asApp(); return out; };
  await w.asApp();
  return w;
}
const PATHS = ['/catalog/overview', '/catalog/services', '/catalog/services/11', '/catalog/providers', '/catalog/providers/21', '/catalog/engagements', '/catalog/engagements/21/11', '/catalog/imports', '/catalog/similar/services'];

test('the read routes are exactly these ten GETs and the write routes exactly these sixteen (POST, PUT, PATCH); no route uses any other method', () => {
  assert.deepEqual(router.ROUTES.map((r) => r.name), ['overview', 'services.list', 'services.get', 'providers.list', 'providers.get', 'engagements.list', 'engagements.get', 'imports.list', 'history', 'similar.services']);
  assert.deepEqual(router.ROUTES.map((r) => r.sample).sort(), ['/catalog/engagements', '/catalog/engagements/1/1', '/catalog/history', '/catalog/imports', '/catalog/overview', '/catalog/providers', '/catalog/providers/1', '/catalog/services', '/catalog/services/1', '/catalog/similar/services'].sort());
  assert.ok(router.ROUTES.every((r) => typeof r.run === 'function' && r.re instanceof RegExp));
  assert.deepEqual(router.WRITE_ROUTES.map((r) => r.method + ' ' + r.name), ['POST services.create', 'PATCH services.update', 'PUT services.settings', 'POST services.clearance', 'POST providers.create', 'PATCH providers.update', 'POST providers.state', 'POST engagements.create', 'PATCH engagements.update',
    'POST engagements.action', 'PUT prices.put', 'POST prices.classify', 'POST prices.link', 'POST prices.unlink', 'POST imports.preview', 'POST imports.apply']);
  assert.ok(router.WRITE_ROUTES.every((r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && typeof r.run === 'function' && r.re instanceof RegExp && r.sample && r.sample.path && r.sample.body), 'no DELETE, and every route has a sample for the tests');
  assert.deepEqual(router.WRITE_ROUTES.filter((r) => r.maxBytes > 65536).map((r) => r.name), ['imports.preview', 'imports.apply'], 'only the import routes may carry a file');
  assert.equal(router.isCatalogPath('/catalog'), true); assert.equal(router.isCatalogPath('/catalog/x'), true); assert.equal(router.isCatalogPath('/catalogue'), false); assert.equal(router.isCatalogPath('/services'), false);
});

test('the switch private.catalog_enabled is closed by default and every catalog path is protected: missing, false, wrong types and a failing lookup all stay closed', async () => {
  const w = await world();
  const everywhere = async (label) => {
    for (const who of [YOSI, AVI]) {
      for (const p of PATHS.concat(['/catalog', '/catalog/', '/catalog/nothing', '/catalog/services/999', '/catalog/services/abc'])) { const r = await w.call('GET', p, who); assert.deepEqual([r.status, r.body.error], [403, 'catalog_disabled'], label + ' GET ' + p + ' ' + who); }
      for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const p of ['/catalog/services', '/catalog/services/11', '/catalog/imports/apply', '/catalog/engagements/21/11/actions/activate']) { const r = await w.call(m, p, who); assert.deepEqual([r.status, r.body.error], [403, 'catalog_disabled'], label + ' ' + m + ' ' + p); }
    }
  };
  await everywhere('no setting at all');                                     // the default: nothing is stored, the catalog is closed
  for (const v of [false, 'true', 'yes', 1, 0, null, {}, [], [true], { enabled: true }]) { await w.setSwitch(v); await everywhere('value ' + JSON.stringify(v)); }
  await w.setSwitch(undefined); w.failSwitch = true;                         // the lookup itself fails: closed, with a different code, never open
  for (const p of PATHS) { const r = await w.call('GET', p, YOSI); assert.deepEqual([r.status, r.body.error], [503, 'catalog_unavailable'], p); }
  w.failSwitch = false;
  await w.setSwitch(true);
  for (const p of PATHS) assert.equal((await w.call('GET', p, YOSI)).status, 200, 'open: ' + p);
  await w.setSwitch(false); assert.equal((await w.call('GET', '/catalog/overview', YOSI)).status, 403, 'closing it takes effect at once (nothing is cached)');
  // the switch is private: the public configuration only ever reads keys that start with "public."
  await w.setSwitch(true);
  const cfg = await require('../netlify/functions/kaspchem-config.js').handler({ httpMethod: 'GET', queryStringParameters: {} });
  assert.equal(JSON.stringify(JSON.parse(cfg.body).settings).includes('catalog'), false); await w.pg.close();
});

test('who may ask: not signed in 401, signed in but not on the list 403 (switch open or closed), both administrators get identical answers, owner role is checked, CSRF still applies', async () => {
  const w = await world(); await w.setSwitch(true);
  for (const p of PATHS) {
    assert.equal((await w.call('GET', p, null)).status, 401, 'anonymous ' + p);
    const s = await w.call('GET', p, STRANGER); assert.deepEqual([s.status, s.body.error], [403, 'forbidden'], 'stranger ' + p);
    const a = await w.call('GET', p, YOSI), b = await w.call('GET', p, AVI);
    assert.equal(a.status, 200); assert.deepEqual(a.body, b.body, 'both administrators see the same ' + p);
    assert.equal(a.headers.get('cache-control'), 'no-store'); assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
  }
  await w.setSwitch(false);
  assert.equal((await w.call('GET', '/catalog/overview', STRANGER)).body.error, 'forbidden', 'a stranger gets "forbidden", never a hint about the switch');
  await w.setSwitch(true);
  assert.deepEqual([guards.requireOwner({ email: 'a@b.c' }).email, guards.requireOwner({ email: 'a@b.c', role: 'owner' }).email], ['a@b.c', 'a@b.c']);
  for (const bad of [{ email: 'a@b.c', role: 'ops' }, { email: 'a@b.c', role: 'admin' }, { email: 'a@b.c', role: '' }]) assert.throws(() => guards.requireOwner(bad), (e) => e.status === 403, JSON.stringify(bad));
  assert.throws(() => guards.requireOwner(null), (e) => e.status === 401); assert.throws(() => guards.requireOwner({}), (e) => e.status === 401);
  await assert.rejects(() => guards.gate({ email: 'a@b.c', role: 'ops' }), (e) => e.status === 403 && e.code === 'forbidden');
  const noCsrf = await w.call('POST', '/catalog/services', YOSI, { noCsrf: true }); assert.deepEqual([noCsrf.status, noCsrf.body.error], [403, 'csrf'], 'the existing cross-site protection comes first');
  await w.pg.close();
});

test('there is no way to write: with the switch open every POST, PUT, PATCH and DELETE (on any catalog path) and every unknown path is "not found"; ids and queries are validated', async () => {
  const w = await world(); await w.setSwitch(true); const before = await w.fingerprint();
  const writeSamples = router.WRITE_ROUTES.map((r) => r.sample.path), every = PATHS.concat(writeSamples), isWrite = (m, p) => router.WRITE_ROUTES.some((r) => r.method === m && r.re.test(p));
  for (const p of every) { const r = await w.call('DELETE', p, YOSI); assert.deepEqual([r.status, r.body.error], [404, 'not_found'], 'DELETE ' + p); }   // there is no delete of any kind
  for (const m of ['POST', 'PUT', 'PATCH']) for (const p of every) {   // a write method on a path that has no such write route is "not found"; on one that has, a body smuggling approval, publication or activation is refused field by field
    const r = await w.call(m, p, YOSI, { body: JSON.stringify({ name: 'x', approved: true, public: true, activation: 'active', pricing_id: 7, offered: true }) });
    assert.deepEqual([r.status, r.body.error], isWrite(m, p) ? [400, 'unknown_field'] : [404, 'not_found'], m + ' ' + p);
  }
  for (const p of ['/catalog', '/catalog/', '/catalog/nothing', '/catalog/services/11/extra', '/catalog/engagements/21', '/catalog/imports/1']) assert.equal((await w.call('GET', p, YOSI)).status, 404, p);
  for (const [p, code] of [['/catalog/services/0', 'bad_id'], ['/catalog/services/99999999999999999999', 'bad_id'], ['/catalog/engagements/21/0', 'bad_id'], ['/catalog/services?limit=0', 'bad_query'], ['/catalog/services?limit=201', 'bad_query'], ['/catalog/services?limit=abc', 'bad_query'], ['/catalog/services?offset=-1', 'bad_query'], ['/catalog/services?active=maybe', 'bad_query'],
    ['/catalog/services?sort=name', 'bad_query'], ['/catalog/services?q=' + 'x'.repeat(81), 'bad_query'], ['/catalog/providers?state=banana', 'bad_query'], ['/catalog/engagements?activation=live', 'bad_query'], ['/catalog/engagements?pricing_model=free', 'bad_query'], ['/catalog/engagements?provider_id=1;DROP', 'bad_query']]) {
    const r = await w.call('GET', p, YOSI); assert.deepEqual([r.status, r.body.error], [400, code], p);
  }
  for (const p of ['/catalog/services/999', '/catalog/providers/999', '/catalog/engagements/21/14', '/catalog/engagements/999/11']) assert.equal((await w.call('GET', p, YOSI)).status, 404, p);
  assert.deepEqual(await w.fingerprint(), before, 'none of it changed a single row'); await w.pg.close();
});

test('read only, proved by recording every statement: only SELECTs (plus the one audit row for a provider card), every transaction READ ONLY, nothing touches the confidential or the price tables', async () => {
  const w = await world(); await w.setSwitch(true); w.rec.length = 0; const before = await w.fingerprint();
  for (const p of PATHS.concat(['/catalog/services?q=%25', '/catalog/providers?state=paused', '/catalog/engagements?activation=pending&provider_id=21', '/catalog/imports?limit=1'])) assert.equal((await w.call('GET', p, YOSI)).status, 200, p);
  await w.call('GET', '/catalog/services/999', YOSI); await w.call('GET', '/catalog/services/x', YOSI); await w.call('POST', '/catalog/services', YOSI);
  const audits = w.rec.filter((r) => r.text === store.AUDIT_VIEW), others = w.rec.filter((r) => r.text !== store.AUDIT_VIEW && !(r.kind === 'query' && /FROM settings WHERE key = \$1/.test(r.text)));
  assert.equal(audits.length, 1, 'one provider card was opened, one audit row'); assert.deepEqual(audits[0].params, [YOSI, 'catalog.provider.view', 'provider', '21', '{}']);
  assert.ok(others.length > 15 && others.every((r) => /^\s*(select|with)\b/i.test(r.text)), 'every other statement is a SELECT: ' + others.filter((r) => !/^\s*(select|with)\b/i.test(r.text)).map((r) => r.text.slice(0, 60)).join(' | '));
  const tx = w.rec.filter((r) => r.kind === 'tx'); assert.ok(tx.length > 10 && tx.every((r) => r.readOnly === true && r.iso === 'RepeatableRead'), 'every grouped read is a READ ONLY transaction on one snapshot');
  assert.equal(w.rec.some((r) => /provider_service_compensation|\bcommission\b|\bcost\b/i.test(r.text)), false, 'no statement names the commission table or the price cost/commission columns');
  assert.equal(w.rec.some((r) => /(insert\s+into|update|delete\s+from)\s+(pricing|settings)\b/i.test(r.text)), false, 'nothing writes the price or settings tables');
  const after = await w.fingerprint(); assert.deepEqual(after, before, 'the data tables are identical before and after (the audit log is the only thing that grew)');
  await w.asOwner(); assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n, 1); await w.pg.close();
});

test('db.transaction in stage 4a: read-only only, SELECT statements only, a bounded list, a known isolation level; a write is refused before anything is sent', async () => {
  const sent = []; db.setTransactionDriver(async (s, o) => { sent.push([s, o]); return s.map(() => []); });
  const ok = await db.transaction([{ text: 'SELECT 1' }, { text: ' with a as (select 1) select * from a', params: [] }], { readOnly: true, isolationLevel: 'Serializable' }); assert.equal(ok.length, 2); assert.equal(sent.length, 1); assert.deepEqual(sent[0][1], { readOnly: true, isolationLevel: 'Serializable' });
  const bad = [[[{ text: 'SELECT 1' }], undefined], [[{ text: 'SELECT 1' }], {}], [[{ text: 'SELECT 1' }], { readOnly: false }], [[{ text: 'SELECT 1' }], { readOnly: 'true' }], [[{ text: 'INSERT INTO t VALUES (1)' }], { readOnly: true }], [[{ text: 'SELECT 1' }, { text: 'UPDATE t SET a = 1' }], { readOnly: true }],
    [[{ text: 'DELETE FROM t' }], { readOnly: true }], [[{ text: 'DO $$ BEGIN END $$' }], { readOnly: true }], [[{ text: 'SELECT 1' }], { readOnly: true, isolationLevel: 'ReadUncommitted' }], [[{ text: 'SELECT 1' }], { readOnly: true, isolationLevel: 'serializable' }],
    [[], { readOnly: true }], [Array(51).fill({ text: 'SELECT 1' }), { readOnly: true }], [null, { readOnly: true }], [[{ text: 5 }], { readOnly: true }], [[null], { readOnly: true }]];
  for (const [stmts, opts] of bad) await assert.rejects(() => db.transaction(stmts, opts), /write_transactions_not_enabled|read_only_statements_only|bad_isolation_level|bad_statements/, JSON.stringify([stmts && stmts.length, opts]));
  assert.equal(sent.length, 1, 'nothing refused was ever sent'); assert.deepEqual(db.ISOLATION_LEVELS, ['ReadCommitted', 'RepeatableRead', 'Serializable']);
});

test('provider cards: the list carries no contact detail; the card does; every card view is audited with who and which provider, and the audit never holds a contact detail', async () => {
  const w = await world(); await w.setSwitch(true);
  const list = await w.call('GET', '/catalog/providers', YOSI); const text = JSON.stringify(list.body);
  assert.deepEqual(Object.fromEntries(list.body.providers.map((p) => [p.id, p.state])), { 21: 'available', 22: 'available', 23: 'archived', 24: 'paused' });
  for (const secret of ['0501234567', 'dana@example', '0521112233', 'NOTE-INTERNAL', 'CONTACT-OLD-FIELD', 'AGREEMENT-NOTES-SECRET', 'contact_phone', 'contact_email']) assert.equal(text.includes(secret), false, 'not in the list: ' + secret);
  await w.asOwner(); assert.equal((await w.pg.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 0, 'a list is not audited'); await w.asApp();
  const card = await w.call('GET', '/catalog/providers/21', AVI);
  assert.deepEqual([card.body.provider.contact_phone, card.body.provider.contact_email, card.body.provider.business_name, card.body.provider.internal_notes], ['0501234567', 'dana@example.test', 'לבני מס', 'NOTE-INTERNAL']);
  assert.equal(JSON.stringify(card.body).includes('CONTACT-OLD-FIELD'), false, 'the old free-text contact field and the agreement notes of the older table are not part of the catalog card'); assert.equal(JSON.stringify(card.body).includes('AGREEMENT-NOTES-SECRET'), false);
  assert.deepEqual(card.body.engagements.map((e) => [e.service_id, e.activation]).sort(), [[11, 'pending'], [12, 'paused']]);
  await w.asOwner(); const rows = (await w.pg.query('SELECT actor, action, entity, entity_id, detail FROM audit_log ORDER BY id')).rows; await w.asApp();
  assert.deepEqual(rows, [{ actor: AVI, action: 'catalog.provider.view', entity: 'provider', entity_id: '21', detail: {} }]);
  assert.equal(JSON.stringify(rows).match(/0501234567|dana@example|NOTE-INTERNAL/), null, 'no contact detail in the log');
  await w.call('GET', '/catalog/providers/21', YOSI); await w.call('GET', '/catalog/providers/22', YOSI); await w.call('GET', '/catalog/providers/999', YOSI);
  await w.asOwner(); assert.equal((await w.pg.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n, 3, 'each view is one row; a card that does not exist is not'); await w.asApp();
  // if the record cannot be written, nothing is shown
  await w.asOwner(); await w.pg.exec('REVOKE INSERT ON audit_log FROM kaspchem_app'); await w.asApp();
  const refused = await w.call('GET', '/catalog/providers/21', YOSI); assert.deepEqual([refused.status, refused.body.error], [500, 'server_error']); assert.equal(JSON.stringify(refused.body).includes('0501234567'), false); await w.pg.close();
});

test('confidential data never appears: the commission table, the cost and commission of a price, the older notes: not in any answer, for any route or filter; the application role cannot read the commission table at all', async () => {
  const w = await world(); await w.setSwitch(true);
  const bodies = [];
  for (const p of PATHS.concat(['/catalog/services?limit=1&offset=1', '/catalog/engagements?pricing_model=fixed', '/catalog/providers?q=%25'])) bodies.push(JSON.stringify((await w.call('GET', p, YOSI)).body));
  const all = bodies.join('\n');
  for (const secret of ['31337.31', '41414.14', 'NOTE-SECRET-XYZ', '77.77', 'PAYER-SECRET', 'percent_recorded', 'payer_note', 'commission', 'compensation']) assert.equal(all.includes(secret), false, secret);
  await w.asApp(); await assert.rejects(() => w.pg.query('SELECT * FROM provider_service_compensation'), /permission denied/);
  for (const k of ['commission', 'commission_percent', 'compensation', 'payer', 'payer_note', 'cost', 'unit_cost', 'password', 'client_secret', 'access_token', 'Authorization', 'connection_string']) assert.throws(() => guards.assertNoSecrets({ ok: true, rows: [{ deep: { [k]: 1 } }] }), /secret_in_response/, k);
  for (const k of ['price', 'price_label', 'priority', 'terms_text', 'recorded_by', 'documented_only']) assert.doesNotThrow(() => guards.assertNoSecrets({ [k]: 1 }), k);
  guards.assertNoSecrets({ when: new Date(), list: [], none: null }); await w.pg.close();
});

test('engagement card: three price layers kept apart, the linked approved price shows only id, label, price and flags, and the "what is missing" list is computed live', async () => {
  const w = await world(); await w.setSwitch(true);
  const r = (await w.call('GET', '/catalog/engagements/21/11', YOSI)).body;
  assert.deepEqual([r.price_layers.market.amount, r.price_layers.provider_offer.amount, r.price_layers.provider_offer.status, r.price_layers.unclassified.amount, r.price_layers.market.source_note, r.price_layers.market.source_date], [1100, 1000, 'awaiting_response', 1200, 'אתר הספק', '2026-10-20']);
  assert.deepEqual(r.approved_price, { id: 7, label: 'בדיקת החזר', price: 1200, approved: true, public: false }); assert.deepEqual(Object.keys(r.approved_price).sort(), ['approved', 'id', 'label', 'price', 'public']);
  assert.deepEqual([r.engagement.activation, r.engagement.contact_state, r.engagement.agreement_state, r.engagement.pricing_model, r.engagement.external_ref], ['pending', 'negotiating', 'draft', 'fixed', 'TX-01']);
  assert.deepEqual(r.checklist.missing, ['agreement_signed', 'collaboration_active']); assert.equal(r.checklist.can_activate, false); assert.equal(r.checklist.documented_only, false);
  assert.deepEqual(r.checklist.items.filter((i) => i.ok).map((i) => i.key), ['fixed_price_linked', 'service_cleared', 'provider_available', 'price_approved']); assert.equal(r.checklist.items.length, 7);
  const none = (await w.call('GET', '/catalog/engagements/22/12', YOSI)).body;   // no price row linked, a percentage layer only
  assert.deepEqual([none.approved_price, none.price_layers.market, none.price_layers.provider_offer, none.price_layers.unclassified.model, none.price_layers.unclassified.percent_low], [null, null, null, 'percent_of_result', 10]);
  assert.ok(none.checklist.missing.includes('fixed_price_linked') && none.checklist.missing.includes('price_approved') && none.checklist.missing.includes('service_cleared'));
  const pct = (await w.call('GET', '/catalog/engagements/21/12', YOSI)).body; assert.equal(pct.checklist.documented_only, true, 'a percentage can be documented but never activated (D15)'); assert.ok(pct.checklist.missing.includes('fixed_price_linked'));
  // the live part: archive the provider and the item flips; an unapproved linked price flips another
  await w.asOwner(); await w.pg.exec("UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 21; UPDATE pricing SET approved = false WHERE id = 7"); await w.asApp();
  const flipped = (await w.call('GET', '/catalog/engagements/21/11', YOSI)).body; assert.deepEqual(flipped.checklist.missing, ['agreement_signed', 'collaboration_active', 'provider_available', 'price_approved']); assert.equal(flipped.approved_price.approved, false);
  await w.pg.close();
});

test('lists: filters, ordering, paging, literal search text (a percent sign is not a wildcard), and nothing leaks across entities', async () => {
  const w = await world(); await w.setSwitch(true); const get = async (p) => (await w.call('GET', p, YOSI)).body;
  const s = await get('/catalog/services'); assert.deepEqual(s.services.map((x) => x.id), [11, 15, 12, 13, 14]); assert.equal(s.total, 5);
  assert.deepEqual([s.services[0].code, s.services[0].legal_cleared, s.services[0].engagements, s.services[2].engagements, s.services[1].legal_cleared, s.services[4].topic], ['tax-refund-check', true, 1, 2, false, null]);
  assert.deepEqual((await get('/catalog/services?q=%25')).services.map((x) => x.id), [15], 'a percent sign in the search is a literal percent sign'); assert.deepEqual((await get('/catalog/services?q=_')).services, []);
  assert.deepEqual((await get('/catalog/services?q=משכנתא')).services.map((x) => x.id), [12, 13]); assert.deepEqual((await get('/catalog/services?topic=מיסים')).services.map((x) => x.id), [11, 15]); assert.deepEqual((await get('/catalog/services?limit=2&offset=1')).services.map((x) => x.id), [15, 12]);
  assert.deepEqual([(await get('/catalog/services?limit=2&offset=1')).total, (await get('/catalog/services?offset=50')).services.length], [5, 0]);
  const one = await get('/catalog/services/11'); assert.deepEqual([one.settings.code, one.settings.legal_cleared_by, one.settings.offered, one.settings.finding_tags, one.engagements.map((e) => e.provider_name)], ['tax-refund-check', YOSI, false, ['t1'], ['דנה לבני']]);
  const near = await get('/catalog/services/12'); assert.deepEqual(near.similar_services.map((m) => m.id), [13]); assert.ok(near.similar_services[0].score >= 0.7);
  assert.deepEqual((await get('/catalog/providers?state=paused')).providers.map((p) => p.id), [24]); assert.deepEqual((await get('/catalog/providers?q=לבני')).providers.map((p) => p.id), [21]); assert.deepEqual((await get('/catalog/providers?q=אדלר')).providers.map((p) => p.id), [24], 'the business name is searched too');
  assert.deepEqual((await get('/catalog/engagements?activation=pending')).engagements.map((e) => [e.provider_id, e.service_id]), [[21, 11]]); assert.deepEqual((await get('/catalog/engagements?provider_id=22')).engagements.map((e) => e.external_ref), ['RE-01']);
  assert.deepEqual((await get('/catalog/engagements?pricing_model=fixed')).engagements.map((e) => [e.price_linked, e.price_layers]), [[true, ['market', 'provider_offer', 'unclassified']]]); assert.equal((await get('/catalog/engagements')).total, 3);
  const imp = await get('/catalog/imports'); assert.deepEqual([imp.imports.length, imp.imports[0].file_sha256, imp.imports[0].problems, imp.imports[0].imported_by], [1, 'a'.repeat(64), [{ row: 4, code: 'price_not_numeric' }], YOSI]);
  const ov = await get('/catalog/overview'); assert.deepEqual(ov.services, { total: 5, active: 5, not_cleared: 4 }); assert.deepEqual(ov.providers, { total: 4, paused: 1, archived: 1 }); assert.deepEqual(ov.engagements.by_activation, { draft: 1, paused: 1, pending: 1 }); assert.deepEqual(ov.engagements.by_pricing_model, { fixed: 1, percent_of_result: 1, tbd: 1 }); assert.equal(ov.last_import.id, 1);
  const sim = await get('/catalog/similar/services'); assert.deepEqual(sim.similar.map((p) => [p.a.id, p.b.id]), [[12, 13]]); assert.deepEqual([sim.same, sim.services_compared], [[], 5]);
  await w.asOwner(); await w.pg.exec("INSERT INTO services (name) SELECT 'שירות מספר ' || g || ' ' || md5(g::text) FROM generate_series(1, 400) g"); await w.asApp();
  const big = await w.call('GET', '/catalog/similar/services', YOSI); assert.deepEqual([big.status, big.body.error], [422, 'too_many_services_to_compare'], 'refused rather than slow'); assert.equal((await w.call('GET', '/catalog/services', YOSI)).status, 200); await w.pg.close();
});

test('existing administration is untouched: the same routes, the same answers for both administrators, with the catalog switch closed or open; the files that decide access are pinned', async () => {
  const src = fs.readFileSync(path.join(FN, '_kaspchem', 'admin-router.js'), 'utf8');
  const defined = [...src.matchAll(/^on\('([A-Z]+)', '([^']+)'/gm)].map((m) => m[1] + ' ' + m[2].split('\\\\').join('\\'));   // the source text has "\\d"; the recorded list below uses the one-backslash form
  assert.deepEqual(defined, ['GET /me', 'GET /stats', 'GET /requests', 'GET /requests/(\\d+)', 'PATCH /requests/(\\d+)', 'POST /requests/(\\d+)/notes', 'POST /applicants/(\\d+)/erase', 'GET /applicants/(\\d+)/export', 'PATCH /applicants/(\\d+)', 'GET /services', 'POST /services', 'PATCH /services/(\\d+)', 'GET /professionals', 'POST /professionals', 'PATCH /professionals/(\\d+)', 'GET /pricing', 'POST /pricing', 'PATCH /pricing/(\\d+)', 'POST /pricing/(\\d+)/approve', 'POST /pricing/(\\d+)/unpublish', 'POST /requests/(\\d+)/revenues', 'POST /revenues/(\\d+)/decide', 'GET /questionnaires', 'GET /questionnaires/([a-z-]+)', 'PUT /questionnaires/([a-z-]+)/draft', 'POST /questionnaires/([a-z-]+)/publish', 'POST /questionnaires/([a-z-]+)/rollback', 'POST /questionnaires/([a-z-]+)/discard', 'GET /impact', 'PUT /impact', 'POST /impact/counter', 'PUT /requests/(\\d+)/outcome', 'POST /requests/(\\d+)/outcome/remove', 'GET /settings', 'GET /deep/readiness', 'PUT /settings', 'GET /audit'], 'the existing route table is exactly the one recorded');
  const lf = src.split('\r\n').join('\n'), p1s = lf.indexOf('// P1: a price that the provider catalog links'), p1e = lf.indexOf('\n});\n', lf.indexOf("on('PATCH', '/pricing/(\\\\d+)'", p1s)) + 5;   // the guarded PATCH /pricing handler (P1) is pinned in production-files-pinned.test.js, byte for byte; here it is left out
  assert.ok(p1s > 0 && p1e > p1s);
  const hook = (lf.slice(0, p1s) + lf.slice(p1e)).split('\n').filter((l) => /catalog/.test(l)).map((l) => l.trim().replace(/\s*\/\/.*$/, ''));
  assert.deepEqual(hook, ["const catalog = require('./admin-catalog-router');", "const catalogOwnedWrites = [['POST', /^\\/services$/], ['PATCH', /^\\/services\\/\\d+$/], ['POST', /^\\/professionals$/], ['PATCH', /^\\/professionals\\/\\d+$/]];", "const priceGuard = require('./catalog-price-guard');", "if (catalog.touchesSwitch(c.body)) throw new HttpError(400, 'use_catalog_switch', 'מתגי הקטלוג משתנים רק בהחלטה נפרדת של הבעלים, לא מכאן.');", "if (catalog.isCatalogPath(path)) return await catalog.handle(event, me, path);", "if (catalogOwnedWrites.some(([om, ore]) => om === method && ore.test(path.replace(/\\/$/, '') || '/'))) await catalog.refuseOldWrite();"], 'the whole change to the existing router is these lines: the require, the catalog hook, and the catalog lock (the list of older write routes, the check before them, the refusal of the switches at the start of the settings route)');
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(FN, '_kaspchem', f))).digest('hex');
  assert.deepEqual([sha('auth.js'), sha('admin-entry.js')].map((h) => h.slice(0, 16)), PINNED, 'auth.js and admin-entry.js (who may use the administration) are unchanged; if you change them on purpose, update this pin in the same commit');
  const w = await world(); const same = ['/me', '/stats', '/services', '/professionals', '/pricing', '/settings', '/audit', '/questionnaires', '/impact'];
  const run = async (who) => { const out = {}; for (const p of same) { const r = await w.call('GET', p, who); out[p] = [r.status, JSON.stringify(r.body).replace(/"(created_at|updated_at|approved_at|as_of)":"[^"]*"/g, '"$1":"-"')]; } return out; };
  const closed = await run(YOSI); await w.setSwitch(true); const open = await run(YOSI), avi = await run(AVI);
  assert.deepEqual(open[ '/services' ], closed['/services']);
  for (const p of same.filter((x) => x !== '/audit' && x !== '/me' && x !== '/settings')) assert.deepEqual(open[p], closed[p], p + ' is the same with the catalog switch closed or open');
  assert.deepEqual(JSON.parse(open['/settings'][1]).settings.map((s) => s.key), ['private.catalog_enabled'], 'the one difference in the settings list is the switch row itself'); assert.deepEqual(JSON.parse(closed['/settings'][1]).settings, []);
  assert.equal(JSON.parse(closed['/me'][1]).email, YOSI); assert.equal(JSON.parse(avi['/me'][1]).email, AVI);
  for (const p of same.filter((x) => x !== '/me' && x !== '/audit')) assert.deepEqual(avi[p], open[p], p + ': both administrators get the same');
  for (const p of same) assert.equal((await w.call('GET', p, null)).status, 401, p); for (const p of same) assert.equal((await w.call('GET', p, STRANGER)).status, 403, p);
  assert.equal((await w.call('POST', '/pricing', YOSI, { noCsrf: true })).status, 403); await w.pg.close();
});
const PINNED = ['2cf4296569ff3876', '9c049b96dba2ec58'];

test('no catalog answer, statement or module can approve a price or make one public: the only code in the whole project that writes the price table is the existing pricing screen, and the catalog never touches settings', async () => {
  const w = await world(); await w.setSwitch(true);
  // 1. the database rule that backs it: a price can never be public without approval
  await w.asOwner(); await assert.rejects(() => w.pg.query("UPDATE pricing SET public = true, approved = false WHERE id = 7"), /check/i); await w.asApp();
  // 2. what the public site shows is only "approved AND public"; the catalog tables are not part of it
  const publicPrices = async () => JSON.parse((await require('../netlify/functions/kaspchem-config.js').handler({ httpMethod: 'GET', queryStringParameters: {} })).body).prices;
  const before = await publicPrices(); assert.deepEqual(before, []);
  for (const p of PATHS) await w.call('GET', p, YOSI); for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) await w.call(m, '/catalog/engagements/21/11/link-price', YOSI, { body: JSON.stringify({ pricing_id: 7, approved: true, public: true }) });
  assert.deepEqual(await publicPrices(), before, 'after every catalog request the public price list is unchanged'); await w.asOwner();
  assert.deepEqual((await w.pg.query('SELECT approved, public FROM pricing WHERE id = 7')).rows, [{ approved: true, public: false }]); await w.asApp();
  // 3. the whole project: every statement that writes the price table or its approval/public flags, and every writer of settings, outside the catalog
  const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(js|mjs)$/.test(e.name)) files.push(f); } })(FN);
  const writers = []; for (const f of files) { const t = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, ''); const rel = path.relative(FN, f).replace(/\\/g, '/'); for (const m of t.matchAll(/(INSERT\s+INTO\s+pricing\b|UPDATE\s+pricing\b|DELETE\s+FROM\s+pricing\b|approved\s*=\s*true)/gi)) writers.push(rel + ' :: ' + m[0].replace(/\s+/g, ' ').toUpperCase()); }
  assert.deepEqual(writers.sort(), ['_kaspchem/admin-router.js :: APPROVED = TRUE', '_kaspchem/admin-router.js :: INSERT INTO PRICING', '_kaspchem/admin-router.js :: UPDATE PRICING', '_kaspchem/admin-router.js :: UPDATE PRICING', '_kaspchem/admin-router.js :: UPDATE PRICING'].sort(), 'a new place that writes the price table must be reviewed on purpose');
  for (const f of ['admin-catalog-router.js', 'catalog-store.js', 'catalog-guards.js']) { const t = fs.readFileSync(path.join(FN, '_kaspchem', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); assert.equal(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+|create\s+(table|index|role)|grant\s+|revoke\s+)/i.test(t.replace(/INSERT INTO audit_log \(actor, action, entity, entity_id, detail\) VALUES \(\$1, \$2, \$3, \$4, \$5::jsonb\)/, '')), false, f + ' (a reading module) contains a write statement'); }
  // the writing modules: every table they INSERT into or UPDATE is one of the catalog's own, and there is no DELETE / TRUNCATE / structure statement in them
  for (const f of ['catalog-writes.js', 'admin-catalog-writes.js']) { const t = fs.readFileSync(path.join(FN, '_kaspchem', f), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, ''); const targets = [...t.matchAll(/(?<!\bdo\s)\b(?:insert\s+into|update)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase()).filter((x) => x !== 'set'); assert.ok(targets.length > 10, f); for (const x of targets) assert.ok(db.WRITE_TARGETS.has(x), f + ' writes ' + x); assert.equal(/\b(delete\s+from|truncate|alter\s+table|drop\s+|create\s+(table|index|role)|grant\s+|revoke\s+)/i.test(t), false, f); }
  await w.pg.close();
});

test('the catalog read modules are clean by construction: no SELECT *, no string-built SQL, no commission or cost, no network, no clock of their own except the injectable one, one write statement in total (the audit row)', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const read = (f) => fs.readFileSync(path.join(FN, '_kaspchem', f), 'utf8');
  for (const f of ['catalog-store.js', 'admin-catalog-router.js']) { const t = strip(read(f)); assert.equal(/select\s+\*|\b\w+\.\*/i.test(t), false, f + ': SELECT *'); assert.equal(/\$\{/.test(t), false, f + ': template interpolation'); assert.equal(/commission|compensation|\bcost\b|fetch\(|require\('(fs|http|https|child_process)'\)|process\.env/i.test(t), false, f); }
  const store_ = strip(read('catalog-store.js'));
  assert.deepEqual([...store_.matchAll(/INSERT\s+INTO\s+(\w+)/gi)].map((m) => m[1]), ['audit_log'], 'the only INSERT in the read store is the audit row');
  assert.equal(/new Date\(\)/.test(store_), true); assert.equal((store_.match(/new Date\(\)/g) || []).length, 2, 'only the default of the injectable clock');
  assert.deepEqual([...strip(read('admin-catalog-router.js')).matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./admin-catalog-writes', './catalog-guards', './catalog-store', './http']);
  assert.deepEqual([...store_.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(), ['./catalog/import.js', './catalog/similarity.js', './catalog/states.js', './db', './http', './service-guard']);
});

test('change detection (what stage 4b relies on): the snapshot and its two fingerprints change when ANYTHING the import reads changes, and do not change for what it does not read', async () => {
  const w = await world(); const snap = () => store.readSnapshot();
  const base = await snap(); w.rec.length = 0; const again = await snap();
  assert.deepEqual([again.fingerprint, again.digest], [base.fingerprint, base.digest], 'reading twice gives the same fingerprints'); assert.match(base.fingerprint, /^[0-9a-f]{32}$/); assert.match(base.digest, /^[0-9a-f]{64}$/);
  assert.ok(w.rec.length === 5 && w.rec.every((r) => r.kind === 'tx' && r.readOnly && r.iso === 'RepeatableRead'), 'one READ ONLY snapshot transaction: four reads and the fingerprint');
  assert.deepEqual([base.snapshot.services.length, base.snapshot.providers.length, base.snapshot.engagements.length, base.snapshot.engagements[0].layers.length], [5, 4, 3, 3]);
  assert.equal(Imp.snapshotDigest(base.snapshot), base.digest, 'the digest is the importer\'s own');
  const pre = Imp.buildPreview({ csv: '"תחום","השירות המדויק","שם הספק","מזהה שירות"\r\n"מיסים","בדיקת זכאות להחזר מס","דנה לבני","TX-01"\r\n', existing: base.snapshot });
  assert.equal(pre.existingDigest, base.digest, 'a preview built from the snapshot carries the snapshot\'s digest');
  const relevant = [
    ['service name', "UPDATE services SET name = 'שם אחר' WHERE id = 14", "UPDATE services SET name = 'שירות ללא התקשרות' WHERE id = 14"], ['service topic', "UPDATE services SET topic = 'x' WHERE id = 14", "UPDATE services SET topic = NULL WHERE id = 14"], ['service description', "UPDATE services SET description = 'x' WHERE id = 14", "UPDATE services SET description = NULL WHERE id = 14"],
    ['service added', "INSERT INTO services (id, name) VALUES (99, 'חדש')", 'DELETE FROM services WHERE id = 99'], ['service removed', 'DELETE FROM services WHERE id = 14', "INSERT INTO services (id, name) VALUES (14, 'שירות ללא התקשרות')"],
    ['provider name', "UPDATE professionals SET name = 'אחר' WHERE id = 22", "UPDATE professionals SET name = 'רועי שמש' WHERE id = 22"], ['provider added', "INSERT INTO professionals (id, name) VALUES (98, 'חדש')", 'DELETE FROM professionals WHERE id = 98'],
    ['business name', "UPDATE provider_profiles SET business_name = 'x' WHERE professional_id = 22", 'UPDATE provider_profiles SET business_name = NULL WHERE professional_id = 22'], ['phone', "UPDATE provider_profiles SET contact_phone = '0539999999' WHERE professional_id = 22", "UPDATE provider_profiles SET contact_phone = '0521112233' WHERE professional_id = 22"],
    ['e-mail', "UPDATE provider_profiles SET contact_email = 'a@b.co' WHERE professional_id = 22", 'UPDATE provider_profiles SET contact_email = NULL WHERE professional_id = 22'], ['phone cleared', 'UPDATE provider_profiles SET contact_phone = NULL WHERE professional_id = 22', "UPDATE provider_profiles SET contact_phone = '0521112233' WHERE professional_id = 22"],
    ['engagement external_ref', "UPDATE provider_services SET external_ref = 'ZZ' WHERE professional_id = 22", "UPDATE provider_services SET external_ref = 'RE-01' WHERE professional_id = 22"], ['engagement activation', "UPDATE provider_services SET activation = 'pending' WHERE professional_id = 22", "UPDATE provider_services SET activation = 'draft' WHERE professional_id = 22"],
    ['contact_state', "UPDATE provider_services SET contact_state = 'contacted' WHERE professional_id = 22", "UPDATE provider_services SET contact_state = 'none' WHERE professional_id = 22"], ['agreement_state', "UPDATE provider_services SET agreement_state = 'draft' WHERE professional_id = 22", "UPDATE provider_services SET agreement_state = 'not_discussed' WHERE professional_id = 22"],
    ['pricing_model', "UPDATE provider_services SET pricing_model = 'quote' WHERE professional_id = 22", "UPDATE provider_services SET pricing_model = 'tbd' WHERE professional_id = 22"], ['pricing_id', 'UPDATE provider_services SET pricing_id = NULL WHERE professional_id = 21 AND service_id = 11', 'UPDATE provider_services SET pricing_id = 7 WHERE professional_id = 21 AND service_id = 11'],
    ['terms_note', "UPDATE provider_services SET terms_note = 'x' WHERE professional_id = 22", 'UPDATE provider_services SET terms_note = NULL WHERE professional_id = 22'], ['updated_by', "UPDATE provider_services SET updated_by = 'someone' WHERE professional_id = 22", "UPDATE provider_services SET updated_by = 'import:owner' WHERE professional_id = 22"],
    ['engagement added', "INSERT INTO provider_services (professional_id, service_id) VALUES (22, 13)", 'DELETE FROM provider_services WHERE professional_id = 22 AND service_id = 13'], ['engagement removed', 'DELETE FROM provider_services WHERE professional_id = 21 AND service_id = 12', "INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, updated_by) VALUES (21, 12, 'paused', 'contacted', 'not_discussed', 'percent_of_result', 'owner@example.test')"],
    ['layer amount', "UPDATE provider_service_prices SET amount = 1201 WHERE kind = 'unclassified' AND professional_id = 21", "UPDATE provider_service_prices SET amount = 1200 WHERE kind = 'unclassified' AND professional_id = 21"], ['layer percent', "UPDATE provider_service_prices SET percent_low = 11 WHERE professional_id = 22", "UPDATE provider_service_prices SET percent_low = 10 WHERE professional_id = 22"],
    ['layer percent high', "UPDATE provider_service_prices SET percent_high = 12 WHERE professional_id = 22", "UPDATE provider_service_prices SET percent_high = NULL WHERE professional_id = 22"], ['layer minimum', "UPDATE provider_service_prices SET minimum_amount = 5, model = 'percent_with_minimum' WHERE professional_id = 22", "UPDATE provider_service_prices SET minimum_amount = NULL, model = 'percent_of_result' WHERE professional_id = 22"],
    ['layer wording', "UPDATE provider_service_prices SET terms_text = 'אחר' WHERE professional_id = 22", "UPDATE provider_service_prices SET terms_text = '10% מהחיסכון' WHERE professional_id = 22"], ['layer status', "UPDATE provider_service_prices SET status = 'received' WHERE kind = 'provider_offer'", "UPDATE provider_service_prices SET status = 'awaiting_response' WHERE kind = 'provider_offer'"],
    ['layer basis_missing', 'UPDATE provider_service_prices SET basis_missing = true WHERE professional_id = 22', 'UPDATE provider_service_prices SET basis_missing = false WHERE professional_id = 22'], ['layer source note', "UPDATE provider_service_prices SET source_note = 'x' WHERE professional_id = 22", 'UPDATE provider_service_prices SET source_note = NULL WHERE professional_id = 22'],
    ['layer source date', "UPDATE provider_service_prices SET source_date = '2026-01-01' WHERE professional_id = 22", 'UPDATE provider_service_prices SET source_date = NULL WHERE professional_id = 22'], ['layer recorded_by', "UPDATE provider_service_prices SET recorded_by = 'owner@example.test' WHERE professional_id = 22", "UPDATE provider_service_prices SET recorded_by = 'import:owner' WHERE professional_id = 22"],
    ['layer added', "INSERT INTO provider_service_prices (professional_id, service_id, kind, model, recorded_by) VALUES (22, 12, 'market', 'tbd', 'x')", "DELETE FROM provider_service_prices WHERE professional_id = 22 AND kind = 'market'"], ['layer removed', "DELETE FROM provider_service_prices WHERE kind = 'market' AND professional_id = 21", "INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, status, source_note, source_date, recorded_by) VALUES (21, 11, 'market', 'fixed', 1100, 'recorded', 'אתר הספק', '2026-10-20', 'import:owner')"],
  ];
  const irrelevant = [
    ['provider agreement notes (older table)', "UPDATE professionals SET agreement_notes = 'x' WHERE id = 22", "UPDATE professionals SET agreement_notes = NULL WHERE id = 22"], ['service active flag', 'UPDATE services SET active = false WHERE id = 14', 'UPDATE services SET active = true WHERE id = 14'],
    ['profile internal notes', "UPDATE provider_profiles SET internal_notes = 'x' WHERE professional_id = 22", 'UPDATE provider_profiles SET internal_notes = NULL WHERE professional_id = 22'], ['engagement priority', 'UPDATE provider_services SET priority = 5 WHERE professional_id = 22', 'UPDATE provider_services SET priority = 100 WHERE professional_id = 22'],
    ['price cost (older table)', 'UPDATE pricing SET cost = 1 WHERE id = 7', 'UPDATE pricing SET cost = 31337.31 WHERE id = 7'], ['a setting', "INSERT INTO settings (key, value, updated_by) VALUES ('private.x', '1', 't')", "DELETE FROM settings WHERE key = 'private.x'"], ['an audit row', "INSERT INTO audit_log (actor, action) VALUES ('t', 't')", "DELETE FROM audit_log WHERE actor = 't'"],
    ['the commission record', 'UPDATE provider_service_compensation SET percent_recorded = 5', 'UPDATE provider_service_compensation SET percent_recorded = 77.77'], ['the import log', "INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES ('csv', 'b', 0, 0, 0, 0, 'x')", "DELETE FROM catalog_imports WHERE file_sha256 = 'b'"],
  ];
  const flips = [];
  for (const [name, change, restore] of relevant) { await w.asOwner(); await w.pg.exec(change); await w.asApp(); const s = await snap(); await w.asOwner(); await w.pg.exec(restore); await w.asApp(); if (s.fingerprint === base.fingerprint || s.digest === base.digest) flips.push('NOT DETECTED: ' + name + (s.fingerprint === base.fingerprint ? ' [sql]' : '') + (s.digest === base.digest ? ' [js]' : '')); const back = await snap(); if (back.fingerprint !== base.fingerprint || back.digest !== base.digest) flips.push('NOT RESTORED: ' + name); }
  for (const [name, change, restore] of irrelevant) { await w.asOwner(); await w.pg.exec(change); await w.asApp(); const s = await snap(); await w.asOwner(); await w.pg.exec(restore); await w.asApp(); if (s.fingerprint !== base.fingerprint || s.digest !== base.digest) flips.push('FALSE ALARM: ' + name); }
  assert.deepEqual(flips, [], flips.join('; ')); assert.ok(relevant.length >= 30 && irrelevant.length >= 8, 'cases: ' + relevant.length + ' + ' + irrelevant.length);
  // a stale preview is recognised by the very same mechanism: apply planning refuses when the data moved
  const approvals = { rows: { 2: { apply: true, accept: [], confirmed: [] } } };
  await w.asOwner(); await w.pg.exec("INSERT INTO services (id, name) VALUES (97, 'נוסף אחרי התצוגה')"); await w.asApp(); const moved = await snap();
  assert.notEqual(moved.digest, pre.existingDigest); assert.equal(Imp.planApply(pre, approvals, moved.snapshot).reason, 'snapshot_changed');
  await w.pg.close();
});

test('the fingerprint does not depend on the order rows were stored in, only on their content', async () => {
  const a = await world(); const fa = await store.readSnapshot(); await a.pg.close();
  const b = new PGlite(); await b.exec(DDL); await b.exec('CREATE ROLE kaspchem_app NOLOGIN'); await b.exec(TODAY); await b.exec(M002); await b.exec(GRANTS);
  const reversed = SEED.split(/;\n/).map((s) => s.trim()).filter(Boolean);
  const inserts = reversed.filter((s) => /INSERT INTO (services|professionals) /.test(s)).reverse().concat(reversed.filter((s) => !/INSERT INTO (services|professionals) /.test(s)));   // the base rows go in a different order
  for (const s of inserts) await b.exec(s);
  db.setDriver(async (t, p) => (await b.query(t, p)).rows);
  db.setTransactionDriver(async (stmts, o) => { await b.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); try { const out = []; for (const s of stmts) out.push((await b.query(s.text, s.params)).rows); await b.exec('COMMIT'); return out; } catch (e) { await b.exec('ROLLBACK'); throw e; } });
  const fb = await store.readSnapshot(); assert.deepEqual([fb.fingerprint, fb.digest], [fa.fingerprint, fa.digest]); await b.close();
});

test('the answer filter is really in the path: a handler that returns a forbidden key produces a plain server error and nothing of the content leaves', async () => {
  const w = await world(); await w.setSwitch(true);
  const original = store.overview; store.overview = async () => ({ services: 1, commission_percent: 12.5, note: 'LEAKED-VALUE' });
  try { const r = await w.call('GET', '/catalog/overview', YOSI); assert.deepEqual([r.status, r.body.error], [500, 'server_error']); assert.equal(JSON.stringify(r.body).includes('LEAKED-VALUE'), false); }
  finally { store.overview = original; }
  assert.equal((await w.call('GET', '/catalog/overview', YOSI)).status, 200, 'and the real handler is back to normal');
  await w.pg.close();
});

test('a limit above the maximum, ids at the edge of what a number can hold, and a request for page 1,000,001 are refused rather than sent to the database', async () => {
  const w = await world(); await w.setSwitch(true); w.rec.length = 0;
  for (const p of ['/catalog/services?limit=1000', '/catalog/services?limit=100000', '/catalog/services?offset=1000001', '/catalog/engagements/9007199254740992/1', '/catalog/services/9007199254740993']) assert.equal((await w.call('GET', p, YOSI)).status, 400, p);
  assert.equal((await w.call('GET', '/catalog/services/9007199254740991', YOSI)).status, 404, 'the largest safe id is a normal "not found"');
  assert.equal(w.rec.filter((r) => /FROM services s LEFT JOIN service_settings/.test(r.text) && r.params && r.params.includes(1000)).length, 0); await w.pg.close();
});

test('a service card lists other services with the same name first (score 1) and then the near ones, and never lists the service itself', async () => {
  const w = await world(); await w.setSwitch(true);
  await w.asOwner(); await w.pg.exec("INSERT INTO services (id, name) VALUES (96, '  ייעוץ   משכנתא '), (95, 'ייעוץ משכנתא.')"); await w.asApp();
  const r = (await w.call('GET', '/catalog/services/12', YOSI)).body.similar_services;
  assert.deepEqual(r.map((m) => [m.id, m.score]), [[95, 1], [96, 1], [13, r[2].score]], 'the same name twice (after cleaning) first, then the near name'); assert.ok(r[2].score < 1 && r[2].score >= 0.7);
  assert.equal(r.some((m) => m.id === 12), false, 'never itself'); assert.deepEqual((await w.call('GET', '/catalog/services/95', YOSI)).body.similar_services.map((m) => m.id).sort(), [12, 13, 96]);
  await w.pg.close();
});
