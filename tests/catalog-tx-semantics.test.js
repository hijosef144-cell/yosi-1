'use strict';
// What the INSTALLED Neon driver (@neondatabase/serverless) really sends for a transaction, and how an advisory lock behaves inside one. Two questions stage 4b depends on.
// Nothing here connects to anything: the driver's `fetch` is replaced by a recorder, the connection string is made up (host ending in .invalid), and the database is in memory (PGlite).
// LIMIT, stated plainly: a single in-memory connection cannot show two sessions waiting for the same lock, nor the pooler's behaviour. That part needs the temporary Neon branch (gate G2).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const OPEN = new Set();
class PGlite extends PGliteBase { constructor(...a) { super(...a); OPEN.add(this); const close = this.close.bind(this); this.close = async () => { OPEN.delete(this); return close(); }; } }
test.after(async () => { for (const db of [...OPEN]) { try { await db.close(); } catch (e) { /* already closed */ } } });

const { neonConfig } = require('@neondatabase/serverless');
const DB_PATH = require.resolve('../netlify/functions/_kaspchem/db');
const FAKE_URL = 'postgresql://fake_user:fake_password_not_real@ep-fake-0000.invalid/fakedb?sslmode=require';

// A fresh copy of the db module (its drivers are created lazily and cached) whose real driver path runs against the recorder.
function freshDb() { delete require.cache[DB_PATH]; process.env.KASPCHEM_DATABASE_URL = FAKE_URL; return require(DB_PATH); }
function recorder(reply) {
  const calls = [];
  neonConfig.fetchFunction = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.invalid\/sql$/, 'only ever the made-up host (the driver turns ep-fake-0000.invalid into api.invalid for its HTTP endpoint)');
    const body = JSON.parse(init.body); calls.push({ url: String(url), method: init.method, headers: init.headers, body });
    const one = () => ({ fields: [{ name: 'v', dataTypeID: 25 }], rows: [['x']], rowCount: 1, command: 'SELECT' });
    return { ok: true, status: 200, json: async () => (reply ? reply(body) : (body.queries ? { results: body.queries.map(one) } : one())), text: async () => '' };
  };
  return calls;
}
test.afterEach(() => { delete neonConfig.fetchFunction; delete process.env.KASPCHEM_DATABASE_URL; delete require.cache[DB_PATH]; });

test('isolation levels: the installed driver accepts exactly ReadUncommitted, ReadCommitted, RepeatableRead and Serializable, passes the name through in the header "Neon-Batch-Isolation-Level" without checking it, and sends read-only in "Neon-Batch-Read-Only"', async () => {
  const types = require('fs').readFileSync(path.join(__dirname, '..', 'node_modules', '@neondatabase', 'serverless', 'index.d.ts'), 'utf8');
  assert.match(types, /isolationLevel\?: 'ReadUncommitted' \| 'ReadCommitted' \| 'RepeatableRead' \| 'Serializable';/); assert.match(types, /`ReadUncommitted` actually gets you `ReadCommitted`/); assert.match(types, /readOnly\?: boolean/); assert.match(types, /deferrable\?: boolean/);
  assert.equal(JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'node_modules', '@neondatabase', 'serverless', 'package.json'), 'utf8')).version, '1.2.0', 'the version this was checked against');
  const db = freshDb(), calls = recorder();
  const out = await db.transaction([{ text: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['kaspchem.catalog.import'] }, { text: 'SELECT $1::int AS n', params: [7] }], { readOnly: true, isolationLevel: 'Serializable' });
  assert.equal(calls.length, 1, 'both statements travel in ONE request (that is what makes them one transaction)');
  const c = calls[0]; assert.equal(c.method, 'POST'); assert.equal(c.url, 'https://api.invalid/sql');
  assert.equal(c.headers['Neon-Batch-Isolation-Level'], 'Serializable'); assert.equal(c.headers['Neon-Batch-Read-Only'], 'true'); assert.equal(c.headers['Neon-Batch-Deferrable'], undefined, 'deferrable is not used');
  assert.deepEqual(c.body, { queries: [{ query: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['kaspchem.catalog.import'] }, { query: 'SELECT $1::int AS n', params: ['7'] }] }, 'statements keep their order; parameters stay parameters (the driver sends every value as text, a number 7 as "7")');
  assert.deepEqual(out, [[{ v: 'x' }], [{ v: 'x' }]], 'one array of rows per statement, rows as objects');
  for (const level of ['ReadCommitted', 'RepeatableRead']) { calls.length = 0; await db.transaction([{ text: 'SELECT 1' }], { readOnly: true, isolationLevel: level }); assert.equal(calls[0].headers['Neon-Batch-Isolation-Level'], level); }
  calls.length = 0; await db.transaction([{ text: 'SELECT 1' }], { readOnly: true }); assert.equal(calls[0].headers['Neon-Batch-Isolation-Level'], undefined, 'no level given: the server default (ReadCommitted)'); assert.equal(calls[0].headers['Neon-Batch-Read-Only'], 'true');
  // the driver itself does NOT validate the name, so our wrapper must (and does): a misspelt level never leaves the process
  calls.length = 0; for (const bad of ['serializable', 'SERIALIZABLE', 'Serializable; DROP TABLE x', 'ReadUncommitted', 'snapshot']) await assert.rejects(() => db.transaction([{ text: 'SELECT 1' }], { readOnly: true, isolationLevel: bad }), /bad_isolation_level/, bad);
  assert.equal(calls.length, 0, 'nothing refused was sent'); assert.ok(!JSON.stringify(calls).includes('fake_password'), 'the recorder never keeps the made-up password');
});

test('a write transaction is refused in 4a before anything is sent; the existing single-statement path (db.query) is unchanged: one statement per request, no batch headers', async () => {
  const db = freshDb(), calls = recorder();
  for (const opts of [undefined, {}, { readOnly: false }, { readOnly: false, isolationLevel: 'Serializable' }]) await assert.rejects(() => db.transaction([{ text: 'SELECT 1' }], opts), /write_transactions_not_enabled/);
  for (const text of ['INSERT INTO t VALUES (1)', 'DO $$ BEGIN END $$', "SELECT 1; DELETE FROM t".replace('SELECT 1; ', '')]) await assert.rejects(() => db.transaction([{ text }], { readOnly: true }), /read_only_statements_only/);
  assert.equal(calls.length, 0);
  const rows = await db.query('SELECT $1::text AS v', ['a']); assert.deepEqual(rows, [{ v: 'x' }]);
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body, { query: 'SELECT $1::text AS v', params: ['a'] }); assert.equal(Object.keys(calls[0].headers).some((h) => /Batch/.test(h)), false, 'a single query carries no batch headers');
});

test('advisory lock inside a transaction: allowed even in a READ ONLY transaction, held until COMMIT or ROLLBACK (also after an error), re-entrant for the same session, and only the transaction-scoped variant is released automatically', async () => {
  const pg = new PGlite(), held = async () => (await pg.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted")).rows[0].n;
  const KEY = 'kaspchem.catalog.import';
  assert.equal(await held(), 0);
  await pg.exec('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY');
  await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]);
  assert.equal(await held(), 1, 'taken inside the transaction'); assert.equal((await pg.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]); assert.equal(await held(), 1, 'the same session asking again is not blocked');
  assert.equal((await pg.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [KEY])).rows[0].ok, true);
  await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['another.key']); assert.equal(await held(), 2, 'a different key is a different lock');
  await pg.exec('COMMIT'); assert.equal(await held(), 0, 'released by COMMIT');
  await pg.exec('BEGIN'); await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]); assert.equal(await held(), 1); await pg.exec('ROLLBACK'); assert.equal(await held(), 0, 'released by ROLLBACK');
  await pg.exec('BEGIN'); await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', [KEY]); await assert.rejects(() => pg.query('SELECT 1/0')); await pg.exec('ROLLBACK'); assert.equal(await held(), 0, 'released after a failing statement and the rollback it forces');
  // why only the xact variant: the session-level one outlives the transaction (and, behind a pooler, would stay on a connection other requests reuse)
  await pg.exec('BEGIN'); await pg.query('SELECT pg_advisory_lock(hashtext($1))', [KEY]); await pg.exec('COMMIT'); assert.equal(await held(), 1, 'a SESSION lock is still held after COMMIT'); await pg.query('SELECT pg_advisory_unlock_all()'); assert.equal(await held(), 0);
  assert.equal((await pg.query('SELECT hashtext($1) = hashtext($1) AS same, hashtext($1) <> hashtext($2) AS differ', [KEY, 'x'])).rows[0].same, true);
  await pg.close();
});

test('the exact batch that stage 4b will send for a guarded write can be assembled from allowed statements in 4a form: lock, pass the expected fingerprint into the transaction, compare it, in one request', async () => {
  const db = freshDb(), calls = recorder();
  const store = require('../netlify/functions/_kaspchem/catalog-store.js');
  const batch = [{ text: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: ['kaspchem.catalog.import'] }, { text: "SELECT set_config('kaspchem.expect', $1, true)", params: ['0'.repeat(32)] },
    { text: 'SELECT (' + store.FINGERPRINT_EXPR + ") = current_setting('kaspchem.expect', true) AS unchanged" }];
  await db.transaction(batch, { readOnly: true, isolationLevel: 'Serializable' });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].body.queries.map((q) => ['SELECT pg_advisory_xact_lock(', "SELECT set_config('kaspchem.expect'", 'SELECT (md5(coalesce(('].findIndex((p) => q.query.startsWith(p))), [0, 1, 2], 'lock, then the expected value, then the comparison, in that order');
  assert.deepEqual(calls[0].body.queries[1].params, ['0'.repeat(32)], 'the expected value travels as a parameter, never inside SQL text');
  // and the same statements, run for real on an in-memory database, behave as the guard needs: equal -> true, different -> false
  const fs = require('fs'); const ROOT = path.join(__dirname, '..');
  const pg = new PGlite(); await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8')); await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8'));
  const fp = (await pg.query(store.FINGERPRINT_SQL)).rows[0].fingerprint;
  const run = async (expect) => { await pg.exec('BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY'); try { await pg.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['k']); await pg.query("SELECT set_config('kaspchem.expect', $1, true)", [expect]); return (await pg.query(batch[2].text)).rows[0].unchanged; } finally { await pg.exec('ROLLBACK'); } };
  assert.equal(await run(fp), true); assert.equal(await run('f'.repeat(32)), false);
  assert.equal((await pg.query("SELECT current_setting('kaspchem.expect', true) AS v")).rows[0].v, '', 'the value was local to the transaction and is gone afterwards (no leak to the next request on the same connection)');
  await pg.close();
});
