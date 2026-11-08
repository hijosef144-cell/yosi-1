'use strict';
// The LAST fence, in db.writeTransaction: whatever a bug above it might produce, only a few shapes of statement can reach the database, and none of them can touch the price table, the settings,
// the commission table, the migration history or any older table; none can delete, change structure or permissions, or change the session. Pure checks: nothing here needs a database.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../netlify/functions/_kaspchem/db');
const W = require('../netlify/functions/_kaspchem/catalog-writes.js');

const sent = [];
db.setTransactionDriver(async (stmts, o) => { sent.push([stmts, o]); return stmts.map(() => []); });
const refuses = async (stmts, pattern, label) => { sent.length = 0; await assert.rejects(() => db.writeTransaction(stmts), pattern, label || JSON.stringify(stmts).slice(0, 140)); assert.equal(sent.length, 0, 'nothing refused was ever sent: ' + (label || '')); };
const one = (text, params) => [{ text, params: params || [] }];

test('every statement the catalog itself builds passes the fence, in every shape (the import has one of each kind of operation)', async () => {
  const ids = new Map([['s1', '1001'], ['p1', '1002']]);
  const ops = [
    { op: 'create_service', ref: 's1', name: 'x', topic: 'y', description: null, active: false, source_row: 2 }, { op: 'update_service', id: '5', set: { topic: 'z' }, source_row: 3 }, { op: 'update_service', id: '5', set: { description: 'z' }, source_row: 3 },
    { op: 'create_provider', ref: 'p1', name: 'p', business_name: null, contact_phone: '0501234567', contact_email: null, source_row: 2 }, { op: 'update_provider', id: '7', set: { contact_phone: '0521111111' }, source_row: 3 },
    { op: 'create_engagement', provider: { ref: 'p1' }, service: { ref: 's1' }, set: { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', external_ref: 'A-1', terms_note: null }, updated_by: 'import:x', source_row: 2 },
    { op: 'update_engagement', key: { professional_id: '7', service_id: '5' }, set: { activation: 'pending' }, updated_by: 'import:x', source_row: 3 },
    { op: 'create_layer', engagement: { provider: { ref: 'p1' }, service: { ref: 's1' } }, layer: { kind: 'market', model: 'fixed', amount: 5, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, status: 'recorded', basis_missing: false, source_note: null, source_date: null }, recorded_by: 'import:x', source_row: 2 },
    { op: 'update_layer', engagement: { professional_id: '7', service_id: '5' }, kind: 'market', set: { model: 'fixed', amount: 6, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, basis_missing: false }, recorded_by: 'import:x', source_row: 3 },
  ];
  const batch = W.importBatch(ops, ids, { expect: 'a'.repeat(32), actor: 'x@y.z', fileSha256: 'f'.repeat(64), summary: {}, rowsApplied: [2, 3], log: { source: 'csv', file_sha256: 'f'.repeat(64), rows_total: 3, rows_created: 1, rows_updated: 1, rows_skipped: 1, problems: [], imported_by: 'x@y.z' } });
  assert.ok(batch.length > 15); batch.forEach((s) => assert.doesNotThrow(() => db.checkWriteStatement(s), s.text.slice(0, 90)));
  const own = [W.counted('UPDATE services s SET name = $1::text WHERE s.id = $2::bigint', ['a', '1']), W.counted('INSERT INTO provider_service_prices (professional_id) SELECT $1::bigint ON CONFLICT (professional_id, service_id, kind) DO NOTHING', ['1'])].flat().concat([W.audit('a', 'catalog.x', 'e', 1, {})]);
  own.forEach((s) => assert.doesNotThrow(() => db.checkWriteStatement(s), s.text.slice(0, 90)));
  assert.deepEqual(await db.writeTransaction(batch), batch.map(() => [])); assert.deepEqual(sent[0][1], { readOnly: false, isolationLevel: 'ReadCommitted' }, 'a write transaction is READ COMMITTED unless told otherwise, and never read-only');
});

test('tables a catalog write may never touch: the price table, the settings, the commission table, the migration history and every older table, however the name is written or hidden', async () => {
  const bad = ['pricing', 'settings', 'provider_service_compensation', 'schema_migrations', 'applicants', 'treatment_requests', 'consents', 'request_notes', 'revenues', 'outcomes', 'questionnaire_versions', 'rate_limits'];
  for (const t of bad) {
    for (const text of ['INSERT INTO ' + t + ' (a) VALUES ($1)', 'UPDATE ' + t + ' SET a = $1', 'update ' + t + ' set a = $1', 'UPDATE ONLY ' + t + ' SET a = $1', 'UPDATE public.' + t + ' SET a = $1', 'UPDATE "' + t + '" SET a = $1', 'INSERT INTO "public"."' + t + '" (a) VALUES ($1)', 'UPDATE ' + t + ' AS x SET a = $1', 'UPDATE\n\t' + t + '\nSET a = $1',
      "WITH u AS (UPDATE " + t + " SET a = $1 RETURNING 1) SELECT set_config('kaspchem.rows', (SELECT count(*) FROM u)::text, true)", 'INSERT INTO services (name) VALUES ($1) ; UPDATE ' + t + ' SET a = 1', 'UPDATE services SET name = $1 WHERE id IN (SELECT 1); INSERT INTO ' + t + ' (a) VALUES (1)'])
      await refuses(one(text, ['x']), /write_target_not_allowed|write_statement_not_allowed/, text);
  }
  await refuses(one('UPDATE pricing SET approved = true, public = true WHERE id = $1', ['7']), /write_target_not_allowed/, 'approving a price');
  await refuses(one("UPDATE settings SET value = 'true' WHERE key = 'private.catalog_enabled'"), /write_target_not_allowed/, 'flipping the switch from the catalog');
});

test('hiding a word from the check does not work: comments, look-alike letters, odd spacing, a second statement, SELECT INTO, locking, functions with side effects, a changed session or role', async () => {
  const cases = [
    'UPDATE/**/pricing SET a = 1', 'UPDATE pricing/* x */SET a = 1', 'UPDATE services SET name = $1 -- UPDATE x', 'UPDATE services SET name = $1 /* ok */', 'UPDATE \u0440ricing SET a = 1', 'UPDATE servic\u0435s SET name = $1', 'INSERT INTO audit_log (actor) VALUES ($1); DELETE FROM audit_log', 'UPDATE services SET name = $1; SELECT 1',
    'SELECT * INTO newtable FROM services', 'INSERT INTO audit_log (actor) SELECT actor INTO x FROM audit_log', 'SELECT pg_sleep(30)', 'INSERT INTO audit_log (actor) SELECT pg_read_file($1)', "INSERT INTO audit_log (actor) SELECT current_setting('role')", "UPDATE services SET name = set_config('role', 'postgres', false)", "INSERT INTO audit_log (actor) SELECT nextval('services_id_seq')::text",
    'INSERT INTO audit_log (actor) SELECT version()', 'INSERT INTO audit_log (actor) SELECT current_user', "INSERT INTO audit_log (actor) SELECT lo_import('/etc/passwd')::text", "INSERT INTO audit_log (actor) SELECT dblink('x','y')", "INSERT INTO audit_log (actor) SELECT txid_current()::text",
    'UPDATE services SET name = $1 WHERE id IN (SELECT id FROM services FOR UPDATE)', 'UPDATE services SET name = E\'\\x41\'', 'DELETE FROM services', 'DELETE FROM audit_log WHERE true', 'TRUNCATE services', 'TRUNCATE TABLE pricing CASCADE', 'DROP TABLE services', 'ALTER TABLE services ADD COLUMN x int', 'CREATE TABLE x (a int)', 'CREATE INDEX i ON services (name)', 'GRANT ALL ON services TO PUBLIC', 'REVOKE ALL ON services FROM kaspchem_app',
    'COPY services TO STDOUT', 'MERGE INTO services USING x ON true WHEN MATCHED THEN DELETE', 'VACUUM services', 'REINDEX TABLE services', 'COMMENT ON TABLE services IS \'x\'', 'SELECT 1', 'SELECT name FROM services', 'SELECT nextval(\'services_id_seq\')', "SELECT set_config('role', 'postgres', false)", "SELECT set_config('kaspchem.other', 'x', true)", "SELECT set_config('kaspchem.expect', 'x', false)", 'SELECT pg_advisory_lock(1)',
    'SET ROLE postgres', 'SET SESSION AUTHORIZATION postgres', 'SET LOCAL ROLE postgres', 'RESET ALL', 'RESET ROLE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'LISTEN x', 'NOTIFY x', 'PREPARE p AS SELECT 1', 'EXECUTE p', 'CALL x()', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET LOCAL statement_timeout = 0',
    "SET LOCAL lock_timeout = '999999ms'", "SET LOCAL lock_timeout = '0ms'", "SET LOCAL lock_timeout = '4000ms'; SET ROLE postgres", 'LOCK TABLE pricing IN ACCESS EXCLUSIVE MODE', 'LOCK TABLE services IN ACCESS EXCLUSIVE MODE', 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices, pricing IN SHARE ROW EXCLUSIVE MODE', 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN ACCESS EXCLUSIVE MODE',
    'DO $$ BEGIN DELETE FROM services; END $$', "DO $guard$ BEGIN DELETE FROM services; IF true THEN RAISE EXCEPTION 'snapshot_changed' USING ERRCODE = 'P0001'; END IF; END $guard$", "DO $guard$ BEGIN IF true THEN RAISE EXCEPTION 'other' USING ERRCODE = 'P0001'; END IF; END $guard$", "DO $guard$ BEGIN PERFORM pg_sleep(9); IF true THEN RAISE EXCEPTION 'no_rows' USING ERRCODE = 'P0001'; END IF; END $guard$", "DO $guard$ BEGIN EXECUTE 'drop table services'; IF true THEN RAISE EXCEPTION 'no_rows' USING ERRCODE = 'P0001'; END IF; END $guard$",
    "WITH u AS (DELETE FROM services RETURNING 1) SELECT set_config('kaspchem.rows', (SELECT count(*) FROM u)::text, true)", "WITH u AS (UPDATE services SET name = $1 RETURNING 1) SELECT * FROM u", "WITH u AS (UPDATE services SET name = $1 RETURNING 1) SELECT set_config('kaspchem.rows', '5', true)", "WITH u AS (SELECT 1) SELECT set_config('kaspchem.rows', (SELECT count(*) FROM u)::text, true)", '', '   ', ';',
  ];
  for (const text of cases) await refuses(one(text), /bad_statement|write_statement_not_allowed|write_target_not_allowed/, text.slice(0, 100));
});

test('the parameters, the list and the level: only plain values, a bounded list, known levels; a write transaction can never be sent as read-only by accident, and the read-only function still refuses a write', async () => {
  const ok = 'UPDATE services SET name = $1 WHERE id = $2::bigint';
  for (const p of [[{}], [() => 1], [[1, 2]], [Symbol('x')], [undefined], ['a', { toString() { return 'x'; } }], [new Date()], 'x']) await refuses([{ text: ok, params: p }], /bad_params/, 'params of kind ' + typeof p + (Array.isArray(p) ? ' array' : ''));
  assert.deepEqual(await db.writeTransaction([{ text: ok, params: ['x', '1'] }, { text: 'UPDATE services SET topic = $1 WHERE id = $2::bigint', params: [null, 1] }, { text: 'INSERT INTO service_settings (service_id, code, finding_tags) VALUES ($1::bigint, $2, $3::text[])', params: ['1', 'ab', ['t1', 't2']] }]).then((r) => r.length), 3, 'strings, numbers, booleans, null and arrays of strings are fine');
  for (const stmts of [[], null, undefined, 'UPDATE services SET name = 1', {}, Array(3001).fill({ text: ok, params: ['x', '1'] })]) await refuses(stmts, /bad_statements/, 'list ' + String(stmts && stmts.length));
  sent.length = 0; for (const level of ['ReadUncommitted', 'serializable', 'Snapshot', '', null]) await assert.rejects(() => db.writeTransaction(one(ok, ['x', '1']), { isolationLevel: level }), /bad_isolation_level/, String(level)); assert.equal(sent.length, 0);
  for (const level of ['ReadCommitted', 'RepeatableRead', 'Serializable']) { sent.length = 0; await db.writeTransaction(one(ok, ['x', '1']), { isolationLevel: level, readOnly: true }); assert.deepEqual(sent[0][1], { readOnly: false, isolationLevel: level }, 'a caller cannot turn "read-only" on for a write, or off for a read'); }
  sent.length = 0; for (const text of [ok, 'INSERT INTO services (name) VALUES ($1)', 'DELETE FROM services']) await assert.rejects(() => db.transaction(one(text, ['x']), { readOnly: true }), /read_only_statements_only/); assert.equal(sent.length, 0);
  await assert.rejects(() => db.transaction(one('SELECT 1'), {}), /write_transactions_not_enabled/); await assert.rejects(() => db.transaction(one('SELECT 1'), { readOnly: false }), /write_transactions_not_enabled/);
});

test('fuzz: 2,000 variations of real statements with a forbidden table put in, a forbidden word added, or a character changed are never let through', async () => {
  let seed = 31337; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296, pick = (a) => a[Math.floor(rnd() * a.length)];
  const real = [
    'INSERT INTO provider_services (professional_id, service_id, activation) VALUES ($1::bigint, $2::bigint, $3)', 'UPDATE provider_services SET activation = $1::text, updated_at = now() WHERE professional_id = $2::bigint', 'UPDATE services s SET topic = $1::text WHERE s.id = $2::bigint',
    "WITH u AS (UPDATE provider_profiles SET paused_until = $2::timestamptz WHERE professional_id = $1::bigint RETURNING 1) SELECT set_config('kaspchem.rows', (SELECT count(*) FROM u)::text, true)", 'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)',
  ];
  const tables = ['pricing', 'settings', 'provider_service_compensation', 'schema_migrations', 'applicants', 'treatment_requests', 'revenues', 'outcomes', 'consents'], words = ['DELETE FROM x', 'TRUNCATE x', 'DROP TABLE x', 'GRANT ALL ON x TO y', 'COPY x TO STDOUT', 'pg_sleep(1)', 'nextval(\'q\')', '-- c', '/* c */', '; SELECT 1', ';DELETE FROM services', 'INTO t'];
  const names = ['provider_services', 'services', 'provider_profiles', 'audit_log']; let refused = 0, passed = 0;
  for (let i = 0; i < 2000; i++) {
    let t = pick(real), kind = Math.floor(rnd() * 3);
    if (kind === 0) { const name = names.find((n) => t.includes(n)); t = t.replace(new RegExp('\\b' + name + '\\b'), () => pick(tables)); }
    else if (kind === 1) { const at = Math.floor(rnd() * t.length); t = t.slice(0, at) + ' ' + pick(words) + ' ' + t.slice(at); }
    else { const at = Math.floor(rnd() * t.length); t = t.slice(0, at) + pick(['\u0440', '\u0435', '\u200b', '\\', '\u0000', '"']) + t.slice(at + 1); }
    let ok = true; try { db.checkWriteStatement({ text: t, params: ['x', 'y', 'z', 'w', '{}'] }); } catch (e) { ok = false; }
    if (ok) passed++; else refused++;
    if (ok && kind !== 2) assert.fail('let through: ' + t);   // a forbidden table or a forbidden word must never pass; a single odd character may (it is only a typo in a column name the database will reject)
  }
  assert.ok(refused > 1200, 'refused ' + refused + ', passed ' + passed);
  for (let i = 0; i < 500; i++) {
    const base = pick(real), t = base.replace(/ /g, () => pick([' ', '  ', '\t', '\n', '\r\n'])), counted = /^WITH u AS/.test(base);
    if (counted && t !== base) assert.throws(() => db.checkWriteStatement({ text: t, params: ['x', 'y', 'z', 'w', '{}'] }), /write_statement_not_allowed/, 'the counted wrapper is only accepted exactly as the catalog builds it');
    else assert.doesNotThrow(() => db.checkWriteStatement({ text: t, params: ['x', 'y', 'z', 'w', '{}'] }), 'odd spacing of a good INSERT / UPDATE is fine');
  }
});
