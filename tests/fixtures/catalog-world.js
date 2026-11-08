'use strict';
// A complete little world for the catalog server tests: the real tables (base schema + migration 002), the real grants of the application role, synthetic data, the two administrators,
// and drivers that RECORD every statement and can FAIL on demand at any position of a transaction. Everything runs as kaspchem_app, in memory (PGlite). Nothing touches the network.
const fs = require('fs');
const path = require('path');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const db = require('../../netlify/functions/_kaspchem/db');
const entry = require('../../netlify/functions/_kaspchem/admin-entry.js');
const store = require('../../netlify/functions/_kaspchem/catalog-store.js');
const opsAlert = require('../../netlify/functions/_kaspchem/ops-alert.js');

const ROOT = path.join(__dirname, '..', '..');
const DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const M002 = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8');
const GRANTS = fs.readFileSync(path.join(ROOT, 'db', 'grants', 'm1-app-grants.sql'), 'utf8');
const TODAY = `GRANT INSERT, SELECT, UPDATE ON applicants, consents, outcomes, pricing, professionals, revenues, services, settings, treatment_requests TO kaspchem_app;
  GRANT INSERT, SELECT ON audit_log, request_notes TO kaspchem_app; GRANT DELETE, INSERT, SELECT, UPDATE ON questionnaire_versions TO kaspchem_app; GRANT DELETE, INSERT, SELECT ON rate_limits TO kaspchem_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kaspchem_app;`;   // what kaspchem_app really has on the base tables today
process.env.KASPCHEM_ADMIN_EMAILS = 'yosi@example.test,avi@example.test';
delete process.env.KASPCHEM_REQUIRE_ROLE;
const OPEN = new Set();
class PGlite extends PGliteBase { constructor(...a) { super(...a); OPEN.add(this); const close = this.close.bind(this); this.close = async () => { OPEN.delete(this); return close(); }; } }
const closeAll = async () => { for (const d of [...OPEN]) { try { await d.close(); } catch (e) { /* already closed */ } } };

const YOSI = 'yosi@example.test', AVI = 'avi@example.test', STRANGER = 'stranger@example.test';
const NOW = new Date('2026-11-08T10:00:00Z');
const SEED = `
  INSERT INTO services (id, name, topic, description) VALUES (11, 'בדיקת זכאות להחזר מס', 'מיסים', 'בדיקה של החזרי מס לשכירים'), (12, 'ייעוץ משכנתא', 'נדל"ן', NULL), (13, 'הגשת ערר ארנונה', 'מיסים', NULL), (14, 'תכנון צוואה', NULL, NULL);
  INSERT INTO service_settings (service_id, code, finding_tags, topics, legal_cleared, legal_cleared_by, legal_cleared_at, legal_note) VALUES (11, 'tax-refund-check', '{t1}', '{}', true, 'yosi@example.test', '2026-11-01T00:00:00Z', 'אושר בכתב');
  INSERT INTO professionals (id, name) VALUES (21, 'דנה לבני'), (22, 'רועי שמש'), (23, 'מיכל פז'), (24, 'נועה אדלר');
  INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email) VALUES (21, 'לבני מס', '0501234567', 'dana@example.test'), (22, NULL, '0521112233', NULL);
  INSERT INTO pricing (id, service_id, professional_id, label, price, cost, commission, notes, approved, approved_by, approved_at) VALUES
    (7, 11, 21, 'בדיקת החזר', 1200, 31337.31, 41414.14, 'NOTE-SECRET-XYZ', true, 'yosi@example.test', now()), (8, 12, NULL, 'מחיר כללי למשכנתא', 900, NULL, NULL, NULL, false, NULL, NULL), (9, 13, NULL, 'מחיר לא מאושר', 300, NULL, NULL, NULL, false, NULL, NULL);
  INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id, external_ref, terms_note, updated_by) VALUES
    (21, 11, 'pending', 'negotiating', 'draft', 'fixed', 7, 'TX-01', 'שוחחנו בטלפון', 'import:owner'), (22, 12, 'draft', 'none', 'not_discussed', 'tbd', NULL, 'RE-01', NULL, 'import:owner');
  INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, status, recorded_by) VALUES (21, 11, 'unclassified', 'fixed', 1200, 'recorded', 'import:owner');
  INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, payer_note, recorded_by) VALUES (21, 11, 'percent', 77.77, 'PAYER-SECRET', 'owner@example.test');`;

async function world(opts) {
  const o = opts || {};
  const pg = new PGlite();
  await pg.exec(DDL); await pg.exec('CREATE ROLE kaspchem_app NOLOGIN'); await pg.exec(TODAY); await pg.exec(M002); await pg.exec(GRANTS);
  if (o.seed !== false) { await pg.exec(SEED); await pg.exec("SELECT setval(pg_get_serial_sequence('services', 'id'), 1000); SELECT setval(pg_get_serial_sequence('professionals', 'id'), 1000)"); }
  const w = { pg, rec: [], txs: [], failAt: null, failAfterCommit: false, failSwitch: false, alerts: [] };
  w.asApp = () => pg.exec('SET SESSION AUTHORIZATION kaspchem_app'); w.asOwner = () => pg.exec('SET SESSION AUTHORIZATION postgres');
  db.setDriver(async (text, params) => {
    w.rec.push({ kind: 'query', text, params });
    if (w.failSwitch && /FROM settings WHERE key = \$1/.test(text) && params && params[0] === 'private.catalog_enabled') throw new Error('simulated outage');
    return (await pg.query(text, params)).rows;
  });
  db.setTransactionDriver(async (stmts, options) => {
    const level = { ReadCommitted: 'READ COMMITTED', RepeatableRead: 'REPEATABLE READ', Serializable: 'SERIALIZABLE' }[options.isolationLevel] || 'READ COMMITTED';
    await pg.exec('BEGIN ISOLATION LEVEL ' + level + (options.readOnly ? ' READ ONLY' : ''));
    const txRec = { readOnly: options.readOnly, iso: options.isolationLevel, statements: stmts.length }; w.txs.push(txRec);
    // An injected failure looks like XX000 unless w.failWith says otherwise: { code, message, name, sourceError } is what the error is made of (a database error has a SQLSTATE `code`;
    // a lost request or reply has none and carries the driver's own text).
    const injected = (text) => { const f = w.failWith || {}, err = new Error(f.message === undefined ? text : f.message); if (f.name) err.name = f.name; if (f.sourceError) err.sourceError = f.sourceError; if (f.code !== null) err.code = f.code === undefined ? 'XX000' : f.code; return err; };
    try {
      // EVERY write batch starts with the two timeouts (db.js adds them): checked here so that every write test of the suite also proves it, and what the database really holds is recorded
      if (!options.readOnly && !(/^SET LOCAL lock_timeout = '\d+ms'$/.test(stmts[0].text) && /^SET LOCAL statement_timeout = '\d+ms'$/.test(stmts[1].text))) throw new Error('fixture: a write batch did not start with the two timeouts');
      const out = [];
      for (let i = 0; i < stmts.length; i++) {
        if (!options.readOnly && w.failAt === i) throw injected('injected failure at statement ' + i);
        w.rec.push({ kind: 'tx', text: stmts[i].text, params: stmts[i].params, readOnly: options.readOnly, iso: options.isolationLevel, index: i });
        out.push((await pg.query(stmts[i].text, stmts[i].params)).rows);
        if (!options.readOnly && i === 1) { const t = (await pg.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0]; txRec.timeouts = t; }
      }
      if (!options.readOnly && w.failAt === 'commit') throw injected('injected failure before commit');
      await pg.exec('COMMIT');
      if (!options.readOnly && w.failAfterCommit) throw injected('connection lost after commit');
      return out;
    } catch (e) { await pg.exec('ROLLBACK').catch(() => {}); throw e; }
  });
  store.setClock(() => NOW);
  opsAlert.setSender(async (m) => { w.alerts.push(m); });
  w.setSetting = async (key, value) => { await w.asOwner(); await pg.exec("DELETE FROM settings WHERE key = '" + key + "'"); if (value !== undefined) await pg.query('INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)', [key, JSON.stringify(value), 'test']); await w.asApp(); };
  w.open = () => w.setSetting('private.catalog_enabled', true);
  w.owner = async (sql, params) => {   // runs as the database owner; several statements in one string are allowed when there are no parameters
    await w.asOwner();
    try { if (params === undefined && /;\s*\S/.test(sql)) { const res = await pg.exec(sql); return (res[res.length - 1] || { rows: [] }).rows; } return (await pg.query(sql, params)).rows; } finally { await w.asApp(); }
  };
  w.call = async (method, p, who, over) => {
    const x = over || {}, headers = { host: 'localhost', 'content-type': 'application/json' };
    if (method !== 'GET' && !x.noCsrf) headers['x-kaspchem'] = '1';
    const body = method === 'GET' ? undefined : (x.raw !== undefined ? x.raw : JSON.stringify(x.body === undefined ? {} : x.body));
    const res = await entry.run(new Request('http://localhost/api/kaspchem/admin' + p, { method, headers, body }), async () => (who ? { email: who, roles: ['admin'] } : null));
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const TABLES = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'settings', 'audit_log', 'applicants', 'treatment_requests', 'revenues', 'outcomes'];
  w.fingerprint = async (tables) => { const out = {}; for (const t of tables || TABLES) out[t] = (await w.owner(`SELECT count(*)::int AS c, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`))[0]; return out; };
  w.count = async (t) => (await w.owner(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  w.audits = async (where) => w.owner('SELECT actor, action, entity, entity_id, detail FROM audit_log ' + (where ? 'WHERE ' + where + ' ' : '') + 'ORDER BY id');
  w.publicPrices = async () => JSON.parse((await require('../../netlify/functions/kaspchem-config.js').handler({ httpMethod: 'GET', queryStringParameters: {} })).body).prices;
  await w.asApp();
  return w;
}
module.exports = { world, closeAll, YOSI, AVI, STRANGER, NOW, SEED, DDL, M002, GRANTS, TODAY };
