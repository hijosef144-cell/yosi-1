'use strict';
// F1 + F2 of the G2 plan: TIMEOUTS and ERROR HANDLING of the catalog write path. Local only: in-memory Postgres (PGlite) with the real tables and grants, synthetic data, and, for the
// driver contract, the REAL Neon driver talking to a fake `fetch` (no network: the host is a reserved name that cannot resolve).
//
// What is proved here, and what is deliberately NOT claimed:
//   * every write batch starts with lock_timeout and statement_timeout (SET LOCAL), chosen only from two fixed pairs; a caller cannot set, lengthen or remove them; they do not leak out of the
//     transaction (PGlite is real Postgres code for that);
//   * a failure with ANY of the codes that timeouts and locks produce (55P03, 57014, 25P04, 40P01, 40001), at EVERY position of an import and of single writes, leaves nothing behind, and the batch
//     is sent exactly once (no automatic retry);
//   * a lost request/reply is "result unknown" (never "not saved"), and what is logged is a fixed label, never the driver's text;
//   * NOT claimed: that the timeouts bound the whole batch (they do not: see db.js), or that the database really enforces them. PGlite is one connection and does not enforce statement_timeout,
//     so the real behaviour (waiting, timing out, deadlock, the shape of the error from Neon) is what the G2 gate on the temporary branch is for.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
const F = require('./fixtures/catalog-demo.js');
const db = require('../netlify/functions/_kaspchem/db');
const W = require('../netlify/functions/_kaspchem/catalog-writes.js');
const { HttpError } = require('../netlify/functions/_kaspchem/http.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const csvOf = (rows, opts) => F.csv(rows.map((r) => F.row(r)), opts);
const IMPORT = '/catalog/imports';
const preview = async (w, csv) => { const r = await w.call('POST', IMPORT + '/preview', YOSI, j({ csv })); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200)); return r.body.preview; };
function approvals(p) {
  const rows = {};
  for (const r of p.rows) {
    if (['skipped', 'problem', 'unchanged'].includes(r.status) || (r.decisions || []).length) continue;
    rows[r.rowNumber] = { apply: true, accept: r.changes.filter((c) => !c.manual && !c.blocked).map((c) => c.id), acceptManual: [], confirmed: r.needsConfirmation };
  }
  return { rows };
}
const DATA = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'audit_log'];
// capture what reaches the log
function captureLog() { const lines = [], orig = console.error; console.error = (...a) => { lines.push(a.map(String).join(' ')); }; return { lines, stop: () => { console.error = orig; } }; }

// ---- 1. the timeouts themselves: fixed pairs, first in every write batch, not settable by a caller ---------------------------------------------------------------------------
test('F1: the two timeouts are fixed pairs, go first in EVERY write batch, cannot be set, lengthened or removed by a caller, and are not part of the rows returned', async () => {
  const sent = []; db.setTransactionDriver(async (stmts, o) => { sent.push([stmts, o]); return stmts.map((_, i) => [{ i }]); });
  assert.deepEqual(db.WRITE_TIMEOUTS, { single: { lockMs: 1500, statementMs: 4000 }, import: { lockMs: 2000, statementMs: 5000 } });
  assert.ok(Object.isFrozen(db.WRITE_TIMEOUTS) && Object.isFrozen(db.WRITE_TIMEOUTS.single) && Object.isFrozen(db.WRITE_TIMEOUTS.import), 'the table cannot be changed at run time');
  assert.deepEqual(db.timeoutStatements('single').map((s) => s.text), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"]);
  assert.deepEqual(db.timeoutStatements('import').map((s) => s.text), ["SET LOCAL lock_timeout = '2000ms'", "SET LOCAL statement_timeout = '5000ms'"]);
  for (const bad of ['', 'x', 'IMPORT', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, 0, 5, {}, [], ['import']]) assert.throws(() => db.timeoutStatements(bad), /bad_timeout_profile/, String(bad));
  const ok = 'INSERT INTO audit_log (actor, action) VALUES ($1, $2)';
  // the default is the single-record pair; the result lines up with the caller's statements, not with the two added ones
  let out = await db.writeTransaction([{ text: ok, params: ['a', 'b'] }, { text: ok, params: ['c', 'd'] }]);
  assert.deepEqual(sent[0][0].map((s) => s.text).slice(0, 2), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"]); assert.equal(sent[0][0].length, 4); assert.deepEqual(out, [[{ i: 2 }], [{ i: 3 }]]);
  await db.writeTransaction([{ text: ok, params: ['a', 'b'] }], { profile: 'import' }); assert.deepEqual(sent[1][0].map((s) => s.text).slice(0, 2), ["SET LOCAL lock_timeout = '2000ms'", "SET LOCAL statement_timeout = '5000ms'"]);
  // a caller can choose between the two fixed pairs and nothing else
  for (const bad of ['x', '__proto__', null, 7]) { sent.length = 0; await assert.rejects(() => db.writeTransaction([{ text: ok, params: ['a', 'b'] }], { profile: bad }), /bad_timeout_profile/); assert.equal(sent.length, 0, 'nothing was sent'); }
  sent.length = 0; await db.writeTransaction([{ text: ok, params: ['a', 'b'] }], { profile: 'single', lockMs: 1, statementMs: 999999, lockTimeoutMs: 1, statementTimeoutMs: 0, timeouts: ['SET LOCAL statement_timeout = 0'], transactionTimeoutMs: 1 });
  assert.deepEqual(sent[0][0].slice(0, 2).map((s) => s.text), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"], 'other options are ignored, never honoured');
  // a timeout statement from a caller is refused: the values are this layer\'s own. (transaction_timeout is not used at all: nothing is to be assumed from it before the feasibility test)
  const own = ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'", "SET LOCAL lock_timeout = '2000ms'", "SET LOCAL statement_timeout = '5000ms'", "SET LOCAL lock_timeout = '1ms'", "SET LOCAL statement_timeout = '999999ms'", 'SET LOCAL statement_timeout = 0', "SET LOCAL statement_timeout = '0'",
    "SET LOCAL transaction_timeout = '7000ms'", "SET statement_timeout = '4000ms'", "SET SESSION statement_timeout = '4000ms'", "SET LOCAL idle_in_transaction_session_timeout = '1000ms'", 'RESET statement_timeout', "SELECT set_config('statement_timeout', '0', true)", "SELECT set_config('lock_timeout', '0', true)"];
  for (const text of own) { sent.length = 0; await assert.rejects(() => db.writeTransaction([{ text }]), /write_statement_not_allowed|write_target_not_allowed/, text); assert.equal(sent.length, 0, 'refused before sending: ' + text); }
  // and a timeout statement hidden among real ones does not get through either
  sent.length = 0; await assert.rejects(() => db.writeTransaction([{ text: ok, params: ['a', 'b'] }, { text: "SET LOCAL statement_timeout = '0ms'" }]), /write_statement_not_allowed/); assert.equal(sent.length, 0);
  assert.ok(!db.timeoutStatements('single').concat(db.timeoutStatements('import')).some((s) => /transaction_timeout/.test(s.text)), 'transaction_timeout is not used (F3 is on hold)');
  // the statement count limit is on the caller\'s statements, so the two added ones never push a legal batch over
  sent.length = 0; await db.writeTransaction(Array.from({ length: db.MAX_WRITE_STATEMENTS }, () => ({ text: ok, params: ['a', 'b'] })), { profile: 'import' }); assert.equal(sent[0][0].length, db.MAX_WRITE_STATEMENTS + 2);
  await assert.rejects(() => db.writeTransaction(Array.from({ length: db.MAX_WRITE_STATEMENTS + 1 }, () => ({ text: ok, params: ['a', 'b'] }))), /bad_statements/);
});

// ---- 2. what the database really holds while the batch runs, and after it ------------------------------------------------------------------------------------------------------
test('F1: inside a single-record write the database holds 1500 ms / 4 s, inside an import 2 s / 5 s; both are gone after COMMIT and after ROLLBACK (SET LOCAL does not leak into the next use of the connection)', async () => {
  const w = await world({ seed: false }); await w.open(); const csv = csvOf([F.ROWS.fixed, F.ROWS.percent]); w.txs.length = 0;
  const session = async () => (await w.pg.query("SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows[0];
  const base = await session();
  assert.equal((await w.call('POST', '/catalog/services', YOSI, j({ name: 'שירות לבדיקת מגבלות' }))).status, 200);
  assert.deepEqual(w.txs.filter((t) => !t.readOnly).pop().timeouts, { lock: '1500ms', statement: '4s' }, 'a single-record write'); assert.deepEqual(await session(), base, 'gone after COMMIT');
  w.failAt = 3; const bad = await w.call('POST', '/catalog/services', YOSI, j({ name: 'תכנון פרישה מוקדמת' })); w.failAt = null; assert.equal(bad.status, 500); assert.deepEqual(await session(), base, 'gone after ROLLBACK');
  const p2 = await preview(w, csv);   // the single writes above moved the data, so the first preview is (rightly) stale: a new one
  assert.equal((await w.call('POST', IMPORT + '/apply', YOSI, j({ csv, previewId: p2.previewId, approvals: approvals(p2) }))).status, 200);
  assert.deepEqual(w.txs.filter((t) => !t.readOnly).pop().timeouts, { lock: '2s', statement: '5s' }, 'an import'); assert.deepEqual(await session(), base, 'gone after the import too');
  assert.deepEqual(w.txs.filter((t) => t.readOnly).map((t) => t.timeouts), w.txs.filter((t) => t.readOnly).map(() => undefined), 'reads are not given these timeouts'); await w.pg.close();
});

// ---- 3. no partial write, one attempt, for every code a timeout or a lock can produce -----------------------------------------------------------------------------------------
const CODES = [['55P03', 409, 'busy_retry'], ['57014', 503, 'write_timeout'], ['25P04', 503, 'write_timeout'], ['40P01', 409, 'conflict_retry'], ['40001', 409, 'conflict_retry']];
const SCENARIOS = [
  { name: 'service create', run: (w) => w.call('POST', '/catalog/services', YOSI, j({ name: 'שירות חדש לבדיקת זמן' })) },
  { name: 'service update', run: (w) => w.call('PATCH', '/catalog/services/13', YOSI, j({ changes: { description: 'x' }, expected: { description: null } })) },
  { name: 'engagement create', run: (w) => w.call('POST', '/catalog/engagements', YOSI, j({ provider_id: 23, service_id: 13 })) },
  { name: 'import', seed: false, prepare: async (w) => { const csv = csvOf([F.ROWS.fixed, F.ROWS.percent, F.ROWS.noProvider]), p = await preview(w, csv); return { csv, p, a: approvals(p) }; }, run: (w, x) => w.call('POST', IMPORT + '/apply', YOSI, j({ csv: x.csv, previewId: x.p.previewId, approvals: x.a })) },
];
async function statementsOf(sc) {   // how many statements the real batch has, found by one clean run in a world of its own
  const w = await world({ seed: sc.seed }); await w.open(); const x = sc.prepare ? await sc.prepare(w) : null; w.txs.length = 0;
  const r = await sc.run(w, x); assert.equal(r.status, 200, sc.name + ' ' + JSON.stringify(r.body)); const n = w.txs.filter((t) => !t.readOnly).pop().statements; await w.pg.close(); return n;
}
for (const sc of SCENARIOS) {
  test('F1+F2: ' + sc.name + ': 55P03, 57014, 25P04, 40P01 and 40001 at EVERY statement (the two timeouts included) leave nothing behind, answer the right code, and the batch is sent once', async () => {
    const n = await statementsOf(sc), w = await world({ seed: sc.seed }); await w.open(); const x = sc.prepare ? await sc.prepare(w) : null; const before = await w.fingerprint(DATA), log = captureLog(); let tried = 0;
    try {
      for (const [code, status, error] of CODES) {
        for (let k = 0; k < n; k++) {
          const txs = w.txs.filter((t) => !t.readOnly).length; w.failAt = k; w.failWith = { code }; const r = await sc.run(w, x); w.failAt = null; w.failWith = null;
          assert.deepEqual([r.status, r.body.error], [status, error], sc.name + ' ' + code + ' @' + k);
          assert.deepEqual(await w.fingerprint(DATA), before, sc.name + ' ' + code + ' @' + k + ': something was left behind');
          assert.equal(w.txs.filter((t) => !t.readOnly).length, txs + 1, sc.name + ' ' + code + ' @' + k + ': the batch must be sent exactly once, never retried'); tried++;
        }
      }
    } finally { log.stop(); }
    assert.equal(tried, CODES.length * n); assert.ok(n >= 4);
    assert.ok(!log.lines.some((l) => /injected|statement \d/.test(l)), 'the log carries labels, never the error text');
    const r = await sc.run(w, x); assert.equal(r.status, 200, 'and the same request goes through once the trouble is over: ' + JSON.stringify(r.body)); assert.notDeepEqual(await w.fingerprint(DATA), before, 'and it saves'); await w.pg.close();
  });
}

test('F2: a reply or request lost on the way is "result unknown", never "not saved": at every position nothing is left behind here, but the caller is told to look before saving again; after a commit whose reply is lost the data is there ONCE and a retry is refused by the data itself', async () => {
  const lost = { code: null, name: 'NeonDbError', message: 'Error connecting to database: TypeError: fetch failed', sourceError: new TypeError('fetch failed') };
  for (const sc of SCENARIOS) {
    const n = await statementsOf(sc), w = await world({ seed: sc.seed }); await w.open(); const x = sc.prepare ? await sc.prepare(w) : null; const before = await w.fingerprint(DATA), log = captureLog();
    try {
      for (let k = 0; k < n; k++) {
        const txs = w.txs.filter((t) => !t.readOnly).length; w.failAt = k; w.failWith = lost; const r = await sc.run(w, x); w.failAt = null; w.failWith = null;
        assert.deepEqual([r.status, r.body.error], [502, 'result_unknown'], sc.name + ' @' + k); assert.deepEqual(await w.fingerprint(DATA), before, sc.name + ' @' + k); assert.equal(w.txs.filter((t) => !t.readOnly).length, txs + 1, 'sent once');
      }
      // the reply is lost AFTER the commit
      w.failAfterCommit = true; w.failWith = lost; const r = await sc.run(w, x); w.failAfterCommit = false; w.failWith = null; assert.deepEqual([r.status, r.body.error], [502, 'result_unknown'], sc.name + ' after commit');
    } finally { log.stop(); }
    const saved = await w.fingerprint(DATA); assert.notDeepEqual(saved, before, sc.name + ': the commit happened');
    assert.ok(log.lines.length >= n && log.lines.every((l) => /unknown_outcome_/.test(l)), 'logged as a fixed label: ' + log.lines[0]); assert.ok(!log.lines.some((l) => /fetch failed|Error connecting|TypeError/.test(l)), 'the driver text is never logged');
    const again = await sc.run(w, x); assert.ok(again.status >= 400 && again.status < 500, sc.name + ' the retry is refused, not doubled: ' + JSON.stringify(again.body)); assert.deepEqual(await w.fingerprint(DATA), saved, sc.name + ': a second attempt changed nothing'); await w.pg.close();
  }
});

// ---- 4. the mapping table, error by error ---------------------------------------------------------------------------------------------------------------------------------------
test('F2: what each error code means (nothing saved / not known), and the log never carries the driver text', () => {
  const log = captureLog();
  try {
    const err = (o) => Object.assign(new Error(o.message || 'x'), o);
    const rows = [
      // inside the transaction: the whole batch was rolled back
      [{ code: 'P0001', message: 'snapshot_changed' }, 409, 'preview_stale'], [{ code: 'P0001', message: 'no_rows' }, 409, 'conflict'], [{ code: 'P0001', message: 'price_not_valid_for_active_engagement' }, 409, 'seen_changed'], [{ code: 'P0001', message: 'price_linked_to_active_engagement' }, 409, 'seen_changed'],[{ code: '55P03', message: 'canceling statement due to lock timeout' }, 409, 'busy_retry'],
      [{ code: '57014', message: 'canceling statement due to statement timeout' }, 503, 'write_timeout'], [{ code: '25P04', message: 'terminating connection due to transaction timeout' }, 503, 'write_timeout'],
      [{ code: '40P01', message: 'deadlock detected' }, 409, 'conflict_retry'], [{ code: '40001', message: 'could not serialize access' }, 409, 'conflict_retry'],
      [{ code: '23505', message: 'duplicate key', constraint: 'x_key' }, 409, 'duplicate'], [{ code: '23503', message: 'fk' }, 422, 'bad_reference'], [{ code: '23514', message: 'check', constraint: 'c' }, 422, 'rule_violation'],
      [{ code: 'XX000', message: 'internal' }, 500, 'server_error'], [{ code: '42501', message: 'permission denied for table pricing' }, 500, 'server_error'], [{ code: '25006', message: 'read-only transaction' }, 500, 'server_error'],
      [{ code: '57P03', message: 'the database system is starting up' }, 500, 'server_error'], [{ code: '53300', message: 'too many connections' }, 500, 'server_error'],
      // the connection broke or the service failed: not known
      [{ code: '08006', message: 'connection failure' }, 502, 'result_unknown'], [{ code: '57P01', message: 'terminating connection due to administrator command' }, 502, 'result_unknown'], [{ code: '57P02', message: 'crash' }, 502, 'result_unknown'],
      [{ name: 'NeonDbError', message: 'Error connecting to database: TypeError: fetch failed' }, 502, 'result_unknown'], [{ name: 'NeonDbError', message: 'x', sourceError: new Error('socket') }, 502, 'result_unknown'],
      [{ message: 'Server error (HTTP status 500): oops' }, 502, 'result_unknown'], [{ message: 'Server error (HTTP status 502): <html>Bad Gateway</html>' }, 502, 'result_unknown'], [{ message: 'Server error (HTTP status 503): busy' }, 502, 'result_unknown'], [{ message: 'Server error (HTTP status 504): timeout' }, 502, 'result_unknown'],
      [{ name: 'AbortError', message: 'The operation was aborted' }, 502, 'result_unknown'], [{ name: 'TimeoutError', message: 'timed out' }, 502, 'result_unknown'], [{ message: 'read ECONNRESET' }, 502, 'result_unknown'], [{ message: 'fetch failed' }, 502, 'result_unknown'],
      // refused before anything was sent (the request never reached the service)
      [{ message: 'Server error (HTTP status 401): unauthorized' }, 500, 'server_error'], [{ message: 'Server error (HTTP status 403): forbidden' }, 500, 'server_error'], [{ message: 'Server error (HTTP status 429): slow down' }, 500, 'server_error'],
      [{ message: 'write_statement_not_allowed' }, 500, 'server_error'], [{ message: 'db_not_configured' }, 500, 'server_error'], [{ message: 'bad_statements' }, 500, 'server_error'], [{ message: 'bad_timeout_profile' }, 500, 'server_error'],
      [{ message: 'Database connection string provided to neon() is not a valid URL (connection string: postgresql://u:SECRET-PW@h/d)' }, 500, 'server_error'],
    ];
    for (const [o, status, code] of rows) {
      const m = W.mapError(err(o)); assert.ok(m instanceof HttpError, JSON.stringify(o)); assert.deepEqual([m.status, m.code], [status, code], JSON.stringify(o).slice(0, 120));
      if (o.code === 'P0001' && o.message === 'no_rows') assert.equal(m.noRows, true);
      if (o.constraint) assert.equal(m.constraint, o.constraint);
    }
    for (const odd of [null, undefined, 'a string', 42, {}, { code: 7 }, { message: { not: 'text' } }]) assert.deepEqual([W.mapError(odd).status, W.mapError(odd).code], [500, 'server_error'], String(odd));
    const http = new HttpError(409, 'engagement_exists'); assert.equal(W.mapError(http), http, 'an answer the application already decided passes through untouched');
    // the user-facing texts say what happened to the data
    assert.match(W.mapError(err({ code: '55P03' })).userMessage, /לא נשמר דבר/); assert.match(W.mapError(err({ code: '57014' })).userMessage, /לא נשמר דבר/); assert.match(W.mapError(err({ code: '40P01' })).userMessage, /לא נשמר דבר/);
    assert.match(W.mapError(err({ message: 'fetch failed' })).userMessage, /לא ידוע אם/); assert.doesNotMatch(W.mapError(err({ message: 'fetch failed' })).userMessage, /לא נשמר דבר/, 'unknown must never say "not saved"');
  } finally { log.stop(); }
  const all = log.lines.join('\n'); assert.ok(!/SECRET-PW|postgresql:|canceling statement|Bad Gateway|oops|fetch failed|ECONNRESET|socket|permission denied|duplicate key/.test(all), 'nothing but fixed labels is logged: ' + all.slice(0, 300));
  assert.match(all, /unknown_outcome_sqlstate_08006/); assert.match(all, /unknown_outcome_http_502/); assert.match(all, /sqlstate_XX000/); assert.match(all, /write_statement_not_allowed/); assert.match(all, /unclassified/);
});

// ---- 5. the REAL Neon driver, against a fake fetch ------------------------------------------------------------------------------------------------------------------------------
test('F2: the real driver (1.2.0): the request is one POST with the batch headers and the two timeouts first; a database error carries its SQLSTATE, a lost request or a 5xx has none, and each maps as above; nothing is retried; a bad connection string never reaches the log', async () => {
  const neon = require('@neondatabase/serverless'), cfg = neon.neonConfig, saved = { fetchFunction: cfg.fetchFunction }, calls = [], REAL_ENV = process.env.KASPCHEM_DATABASE_URL;
  const PW = 'FAKE-PASSWORD-9f3a', HOST = 'ep-fake-g2test.neon.invalid';
  process.env.KASPCHEM_DATABASE_URL = 'postgresql://fake_user:' + PW + '@' + HOST + '/fakedb?sslmode=require';
  db.setDriver(null); db.setTransactionDriver(null);
  let reply = null;
  cfg.fetchFunction = async (url, init) => { calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return reply(); };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (n) => json(200, { results: Array.from({ length: n }, () => ({ fields: [], rows: [], rowCount: 0, command: 'SET' })) });
  const stmts = [{ text: 'INSERT INTO audit_log (actor, action) VALUES ($1, $2)', params: ['g2@example.test', 'x'] }];
  const log = captureLog();
  try {
    reply = () => ok(3); const rows = await W.run(stmts, 'import'); assert.equal(rows.length, 1, 'one result per statement of the caller');
    assert.equal(calls.length, 1, 'one batch = one request'); const c = calls[0];
    // what the driver really does (found by this test): the request goes to `api.<the rest of the host>` and the ENDPOINT is named only in the header Neon-Connection-String. So "which database" is
    // decided by that header, and a safety check that looked at the request URL alone would not see the endpoint at all (the G2 tool checks the header).
    assert.equal(new URL(c.url).hostname, 'api.neon.invalid'); assert.equal(new URL(c.url).pathname, '/sql'); assert.equal(new URL(c.headers['Neon-Connection-String']).hostname, HOST, 'the endpoint is in the connection-string header');
    assert.equal(c.headers['Neon-Batch-Isolation-Level'], 'ReadCommitted'); assert.equal(c.headers['Neon-Batch-Read-Only'], 'false');
    assert.deepEqual(c.body.queries.map((q) => q.query), ["SET LOCAL lock_timeout = '2000ms'", "SET LOCAL statement_timeout = '5000ms'", stmts[0].text]);
    // a failing statement: HTTP 400 with the SQLSTATE in the body
    const expectMap = async (rep, status, code, label) => { calls.length = 0; reply = rep; await assert.rejects(() => W.run(stmts), (e) => e instanceof HttpError && e.status === status && e.code === code, label); assert.equal(calls.length, 1, label + ': sent once, never retried'); };
    await expectMap(() => json(400, { message: 'canceling statement due to lock timeout', severity: 'ERROR', code: '55P03' }), 409, 'busy_retry', '55P03');
    await expectMap(() => json(400, { message: 'canceling statement due to statement timeout', severity: 'ERROR', code: '57014' }), 503, 'write_timeout', '57014');
    await expectMap(() => json(400, { message: 'terminating connection due to transaction timeout', severity: 'FATAL', code: '25P04' }), 503, 'write_timeout', '25P04');
    await expectMap(() => json(400, { message: 'deadlock detected', severity: 'ERROR', code: '40P01' }), 409, 'conflict_retry', '40P01');
    await expectMap(() => json(400, { message: 'snapshot_changed', severity: 'ERROR', code: 'P0001' }), 409, 'preview_stale', 'guard');
    await expectMap(() => json(400, { message: 'duplicate key value violates unique constraint', severity: 'ERROR', code: '23505', constraint: 'services_name_key' }), 409, 'duplicate', '23505');
    // no answer from the database: the request fails, or the service answers with a 5xx
    await expectMap(() => { throw new TypeError('fetch failed'); }, 502, 'result_unknown', 'network failure');
    await expectMap(() => new Response('<html>Bad Gateway</html>', { status: 502 }), 502, 'result_unknown', 'HTTP 502');
    await expectMap(() => new Response('upstream timed out', { status: 504 }), 502, 'result_unknown', 'HTTP 504');
    await expectMap(() => new Response('unauthorized', { status: 401 }), 500, 'server_error', 'HTTP 401 (rejected: nothing ran)');
    // a connection string that is not a URL: the driver puts the WHOLE string into its error text; the log must not
    process.env.KASPCHEM_DATABASE_URL = 'not a url with ' + PW; db.setTransactionDriver(null); calls.length = 0;
    await assert.rejects(() => W.run(stmts), (e) => e instanceof HttpError && e.status === 500 && e.code === 'server_error'); assert.equal(calls.length, 0, 'nothing was sent');
  } finally { log.stop(); cfg.fetchFunction = saved.fetchFunction; if (REAL_ENV === undefined) delete process.env.KASPCHEM_DATABASE_URL; else process.env.KASPCHEM_DATABASE_URL = REAL_ENV; db.setDriver(null); db.setTransactionDriver(null); }
  const all = log.lines.join('\n'); assert.ok(!all.includes(PW) && !all.includes(HOST) && !/postgresql:|fake_user|not a url/.test(all), 'no part of the connection string reaches the log: ' + all.slice(0, 300));
  assert.match(all, /unknown_outcome_http_502/); assert.match(all, /unknown_outcome_http_504/); assert.match(all, /timeout_57014/); assert.match(all, /unclassified/);
});
