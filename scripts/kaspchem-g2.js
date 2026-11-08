'use strict';
// G2 test tool for the catalog write path (M1). It is run by the OWNER, in his own terminal, against a CHILD branch of the temporary Neon branch, as the application role (kaspchem_app).
// Nothing is run by this file unless it is told to, and it is built so that the wrong database, a leaked secret, or an operation nobody approved cannot happen by accident:
//
//   node scripts/kaspchem-g2.js --list                                       the stages, what each one does, which are locked (no network)
//   node scripts/kaspchem-g2.js --plan=<stage>                               what a stage would do, in words (no network)
//   KASPCHEM_G2_DATABASE_URL=... node scripts/kaspchem-g2.js --run=<stage> --expect-endpoint=ep-... --expect-env=test --marker=<token> --approved-stages=<a,b,...> [--allow-writes]
//
// THE BRANCH IS VERIFIED BEFORE ANY STATEMENT, by independent proofs (any one failing stops everything, nothing is sent):
//   1. the connection string (only from KASPCHEM_G2_DATABASE_URL, never from the command line) names the application role and an endpoint EQUAL to --expect-endpoint;
//   2. that endpoint, and the endpoints of every database URL found in this shell's environment (the production and test settings), are NOT in the forbidden list: the temporary branch itself
//      and the other branches are refused even if named by mistake. Writes go to the CHILD branch only;
//   3. once connected, the first and only statement allowed is the identity read: the role, the database name, settings.meta.environment (must equal --expect-env and never "production"), the
//      Neon endpoint id when the server reports one, and the MARKER: a comment on the database that the owner put on the CHILD branch only (the parent does not have it). No marker, no run.
// EVERY REQUEST is checked again, just before it leaves, by a guard on the HTTP layer (the driver's fetch): the endpoint in the request must be the verified one, the headers must be the known
// ones, and every statement must be one the stage was approved to send (the product's own write fence for writes; read-only batches only SELECT/WITH/SHOW; a short list of exact constants).
// SECRETS: the connection string, its password, the host, tokens and e-mail addresses (other than @example.test) never reach the screen, the state file or an error message: all output goes
// through one redactor, errors are reduced to a SQLSTATE and a redacted, short text, and no request header other than the batch options is ever recorded.
// APPROVAL: a stage runs only if it is listed in --approved-stages; stages that write also need --allow-writes; locked stages (timeouts, concurrency, disconnect, size, race) cannot run at all
// until a later change unlocks them. A stage runs only after the stage before it has PASSED on the same endpoint and marker (the state file), so the small checks come first and the
// 300-row import is not even reachable. All synthetic data is named g2-<run id>-... and uses @example.test addresses.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const db = require('../netlify/functions/_kaspchem/db.js'), W = require('../netlify/functions/_kaspchem/catalog-writes.js'), store = require('../netlify/functions/_kaspchem/catalog-store.js'), Imp = require('../netlify/functions/_kaspchem/catalog/import.js');
const ROLE = 'kaspchem_app';
const ACTOR = 'g2@example.test';
const FORBIDDEN_ENDPOINTS = ['ep-temp-branch-aaaaaa'];                                  // the temporary branch: G2 never talks to it, only to its child
const FORBIDDEN_BRANCHES = ['br-temp-baseline-aaaaaa', 'br-test-branch-bbbbbb'];   // the temporary branch and `test`
const AMBIENT_URL_VARS = ['KASPCHEM_DATABASE_URL', 'DATABASE_URL', 'NETLIFY_DATABASE_URL', 'NEON_DATABASE_URL', 'POSTGRES_URL', 'DATABASE_URL_UNPOOLED'];
const MAX_REQUESTS = 80;
const DEFAULT_STATE = path.join(ROOT, 'docs', 'research', 'raw', 'g2-state.json');

class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

// ---- connection string: parsed here, by hand, so that no error can ever carry it ---------------------------------------------------------------------------------------------------------
function parseConnection(raw) {
  let u; try { u = new URL(String(raw)); } catch (e) { refuse('KASPCHEM_G2_DATABASE_URL is not a valid connection string (it is not shown).'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) refuse('KASPCHEM_G2_DATABASE_URL must be a postgres:// connection string.');
  const host = u.hostname.toLowerCase(), first = host.split('.')[0], pooler = /-pooler$/.test(first), endpoint = first.replace(/-pooler$/, '');
  if (!/^ep-[a-z0-9-]{3,60}$/.test(endpoint) || !/\.neon\.tech$/.test(host)) refuse('the host of the connection string is not a Neon endpoint (ep-....neon.tech).');
  if (decodeURIComponent(u.username) !== ROLE) refuse('the connection string must use the application role ' + ROLE + ', nothing else.');
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(db)) refuse('the connection string must name one database.');
  return { host, endpoint, pooler, db, password: decodeURIComponent(u.password), apiHost: 'api.' + host.split('.').slice(1).join('.') };
}
function endpointOf(raw) { try { const h = new URL(String(raw)).hostname.toLowerCase().split('.')[0]; return h.replace(/-pooler$/, ''); } catch (e) { return null; } }

// ---- the redactor ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function makeRedactor(secrets) {
  const list = Array.from(new Set((secrets || []).filter((s) => typeof s === 'string' && s.length >= 4))).sort((a, b) => b.length - a.length);
  return function redact(text) {
    let s = String(text);
    for (const x of list) { s = s.split(x).join('<secret>'); const enc = encodeURIComponent(x); if (enc !== x) s = s.split(enc).join('<secret>'); }
    return s.replace(/postgres(?:ql)?:\/\/[^\s'"<>`]+/gi, '<connection-string>').replace(/\bnpg_[A-Za-z0-9_]{6,}/g, '<token>').replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <token>')
      .replace(/[A-Za-z0-9._%+-]+@(?!example\.test\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>');
  };
}

// ---- the guard on the HTTP layer -------------------------------------------------------------------------------------------------------------------------------------------------
// Wraps the driver's fetch. It knows the verified endpoint and the statements the current stage may send; a request that is not exactly that is thrown away BEFORE it is sent.
function makeGuard(opts) {
  const { conn, baseFetch } = opts, records = [], state = { raw: new Set(), requests: 0, blocked: 0, phase: 'identify' };
  const timeoutTexts = new Set([].concat(db.timeoutStatements('single'), db.timeoutStatements('import')).map((s) => s.text));
  const RESERVE = /^SELECT nextval\('(?:services_id_seq|professionals_id_seq)'\) AS id FROM generate_series\(1, \$1::int\)$/;
  const READ = /^\s*(select|with|show)\b/i, DANGEROUS_READ = /\b(nextval|setval|set_config|pg_sleep|pg_terminate_backend|pg_cancel_backend|lo_[a-z_]+|dblink[a-z_]*|pg_read_[a-z_]+|pg_ls_[a-z_]+|copy)\b/i;
  function allowedStatement(q, readOnly, single) {
    const text = String(q.query || '').trim();
    if (state.raw.has(text)) return true;                                        // the constants the running stage registered (and nothing else of its own)
    if (state.phase === 'identify') return false;                                // before the identity is proved, only the identity read
    if (RESERVE.test(text)) return true;
    if (single) return READ.test(text) && !/;/.test(text.replace(/;\s*$/, '')) && !DANGEROUS_READ.test(text);   // a single request is a plain read, never a write
    if (readOnly) return READ.test(text) && !/;/.test(text.replace(/;\s*$/, '')) && !DANGEROUS_READ.test(text);
    if (timeoutTexts.has(text)) return true;
    try { db.checkWriteStatement({ text, params: q.params }); return true; } catch (e) { return false; }
  }
  async function guarded(url, init) {
    const block = (why) => { state.blocked++; throw new Error('blocked_by_g2_guard: ' + why); };
    state.requests++; if (state.requests > MAX_REQUESTS) block('too many requests in one run');
    let u; try { u = new URL(String(url)); } catch (e) { block('bad request url'); }
    if (init.method !== 'POST' || u.protocol !== 'https:' || u.hostname.toLowerCase() !== conn.apiHost || u.pathname !== '/sql') block('request is not to the verified endpoint');
    const h = init.headers || {}, keys = Object.keys(h);
    if (keys.some((k) => !/^(neon-connection-string|neon-raw-text-output|neon-array-mode|neon-batch-isolation-level|neon-batch-read-only)$/i.test(k))) block('unexpected request header');
    let cs; try { cs = new URL(h['Neon-Connection-String']); } catch (e) { block('no connection string header'); }
    if (cs.hostname.toLowerCase() !== conn.host || decodeURIComponent(cs.username) !== ROLE || decodeURIComponent(cs.pathname.replace(/^\//, '')) !== conn.db) block('the request names another endpoint, role or database');
    let body; try { body = JSON.parse(init.body); } catch (e) { block('bad request body'); }
    const readOnly = String(h['Neon-Batch-Read-Only']) === 'true', list = Array.isArray(body.queries) ? body.queries : [body];
    if (!list.length || list.length > db.MAX_WRITE_STATEMENTS + 2) block('bad statement list');
    for (const q of list) if (!q || typeof q.query !== 'string' || !allowedStatement(q, readOnly, !Array.isArray(body.queries))) block('a statement that this stage was not approved to send');
    const t0 = Date.now(); let res;
    try { res = await baseFetch(url, init); } finally { records.push({ kind: Array.isArray(body.queries) ? 'batch' : 'single', statements: list.length, bytes: Buffer.byteLength(init.body), readOnly: Array.isArray(body.queries) ? readOnly : null, isolation: h['Neon-Batch-Isolation-Level'] || null, first: list.slice(0, 2).map((q) => String(q.query).slice(0, 48)), ms: Date.now() - t0 }); }
    records[records.length - 1].status = res && res.status;
    return res;
  }
  return { fetch: guarded, state, records };
}

// ---- stage helpers ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const TABLES = ['services', 'professionals', 'provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'pricing', 'catalog_imports', 'audit_log', 'settings'];
const COUNTS_SQL = 'SELECT ' + TABLES.map((t) => '(SELECT count(*) FROM ' + t + ')::int AS ' + t).join(', ');
const IDENTITY_SQL = "SELECT current_user AS cu, session_user AS su, current_database() AS db, version() AS v, (SELECT value #>> '{}' FROM settings WHERE key = 'meta.environment') AS env, (SELECT shobj_description(d.oid, 'pg_database') FROM pg_database d WHERE d.datname = current_database()) AS marker, current_setting('neon.endpoint_id', true) AS neon_endpoint";
const PRIV_SQL = "SELECT t.name, p.priv, has_table_privilege(current_user, 'public.' || t.name, p.priv) AS has FROM (VALUES " + ['services', 'professionals', 'provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'pricing', 'settings', 'catalog_imports', 'audit_log', 'provider_service_compensation', 'schema_migrations'].map((t) => "('" + t + "')").join(', ') + ") t(name) CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv) ORDER BY 1, 2";
const GUC_SQL = "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('statement_timeout') AS statement_timeout, current_setting('deadlock_timeout') AS deadlock_timeout, current_setting('transaction_timeout', true) AS transaction_timeout, current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout";
const ROLCONFIG_SQL = 'SELECT rolconfig::text AS cfg FROM pg_roles WHERE rolname = current_user';
const DBROLE_SQL = 'SELECT count(*)::int AS n FROM pg_db_role_setting';
const LOCK5 = 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN SHARE ROW EXCLUSIVE MODE';
const LOCK_CATALOG_IMPORTS = 'LOCK TABLE catalog_imports IN SHARE ROW EXCLUSIVE MODE';
const SHOW_ISO = 'SHOW transaction_isolation', SHOW_RO = 'SHOW transaction_read_only', NEXTVAL_PROBE = "SELECT nextval('services_id_seq')";
const wantedPriv = (table, priv) => {
  if (['provider_service_compensation', 'schema_migrations'].includes(table)) return false;
  if (['TRUNCATE', 'DELETE'].includes(priv)) return false;
  if (['catalog_imports', 'audit_log'].includes(table)) return priv === 'SELECT' || priv === 'INSERT';
  return true;
};

// a stage gets: ctx.q (one read), ctx.tx (a raw batch), ctx.product (the application's own code), ctx.check, ctx.note, ctx.guard
function newChecks() { const checks = [], notes = {}; return { checks, notes, check: (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: ok ? undefined : detail }); return !!ok; }, note: (k, v) => { notes[k] = v; } }; }
const sameCounts = (a, b) => TABLES.every((t) => a[t] === b[t]);
const delta = (a, b) => Object.fromEntries(TABLES.map((t) => [t, b[t] - a[t]]));
const errInfo = (e) => ({ code: e && /^[0-9A-Z]{5}$/.test(String(e.code)) ? e.code : null, name: e && e.name, constraint: e && e.constraint || null });
async function attempt(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: e }; } }

// ---- the stages ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const STAGES = {};
const stage = (id, def) => { STAGES[id] = Object.assign({ id, needs: [], status: 'ready', plan: [], raw: [] }, def); };

stage('identity', { kind: 'read', raw: [PRIV_SQL, GUC_SQL, ROLCONFIG_SQL, DBROLE_SQL, COUNTS_SQL, store.FINGERPRINT_SQL], title: 'who am I talking to (read only)', plan: ['one read for the identity (role, database, environment, marker)', 'the privilege matrix of kaspchem_app against the approved one (table by table)', 'the timeouts the role actually has, role-level settings, table counts and the data fingerprint', 'the host class (direct or pooler)'],
  async run(c) {
    const priv = await c.q(PRIV_SQL), wrong = priv.filter((r) => r.has !== wantedPriv(r.name, r.priv)).map((r) => r.name + ':' + r.priv);
    c.check('privileges equal the approved matrix (' + priv.length + ' pairs)', wrong.length === 0, 'different: ' + wrong.join(', '));
    const g = (await c.q(GUC_SQL))[0]; c.note('timeouts_in_effect', g);
    const rc = await attempt(() => c.q(ROLCONFIG_SQL)); c.note('role_level_settings', rc.ok ? (rc.value[0] && rc.value[0].cfg) || null : 'unreadable');
    const dr = await attempt(() => c.q(DBROLE_SQL)); c.note('db_role_settings_rows', dr.ok ? dr.value[0].n : 'unreadable');
    const counts = (await c.q(COUNTS_SQL))[0]; c.note('counts', counts); c.note('fingerprint', (await c.q(c.product.store.FINGERPRINT_SQL))[0].fingerprint);
    c.note('host_class', c.conn.pooler ? 'pooler' : 'direct'); c.note('server', c.identity.v.split(' ').slice(0, 2).join(' ')); c.note('neon_endpoint_reported', c.identity.neon_endpoint ? 'yes' : 'no');
    if (c.args.expectFingerprint) c.check('the data fingerprint equals --expect-fingerprint', c.notes.fingerprint === c.args.expectFingerprint, 'the data is not what the baseline recorded');
  } });

stage('headers', { kind: 'read', raw: [SHOW_ISO, SHOW_RO, NEXTVAL_PROBE], needs: ['identity'], title: 'batch headers, isolation levels, read-only (nothing is written)', plan: ['a READ ONLY / REPEATABLE READ batch: the server reports those levels, and the request carries the batch headers', 'a write attempt inside a READ ONLY batch (nextval) is refused with 25006', 'a normal batch is READ COMMITTED and not read-only', 'each batch is exactly one request'],
  async run(c) {
    const n0 = c.guard.records.length;
    const ro = await c.tx([SHOW_ISO, SHOW_RO], { readOnly: true, isolationLevel: 'RepeatableRead' });
    c.check('READ ONLY batch reports repeatable read / on', ro[0][0].transaction_isolation === 'repeatable read' && ro[1][0].transaction_read_only === 'on', JSON.stringify([ro[0][0], ro[1][0]]));
    const r1 = c.guard.records[c.guard.records.length - 1]; c.check('that batch was ONE request with the read-only headers', c.guard.records.length === n0 + 1 && r1.kind === 'batch' && r1.readOnly === true && r1.isolation === 'RepeatableRead', JSON.stringify(r1));
    const w = await attempt(() => c.tx([NEXTVAL_PROBE], { readOnly: true, isolationLevel: 'RepeatableRead' })); c.check('a write inside a READ ONLY batch is refused (25006)', !w.ok && errInfo(w.error).code === '25006', w.ok ? 'it was accepted' : JSON.stringify(errInfo(w.error)));
    const rw = await c.tx([SHOW_ISO, SHOW_RO], { readOnly: false, isolationLevel: 'ReadCommitted' }); c.check('a normal batch is read committed / off', rw[0][0].transaction_isolation === 'read committed' && rw[1][0].transaction_read_only === 'off', JSON.stringify([rw[0][0], rw[1][0]]));
    const r3 = c.guard.records[c.guard.records.length - 1]; c.check('and carries read-only=false', r3.readOnly === false && r3.isolation === 'ReadCommitted', JSON.stringify(r3));
  } });

stage('lock-probe', { kind: 'probe', raw: [COUNTS_SQL, LOCK5, LOCK_CATALOG_IMPORTS, 'SELECT 1/0', 'SELECT 1 AS ok'].concat(db.timeoutStatements('import').map((x) => x.text)), needs: ['headers'], title: 'the table lock of the import, taken and rolled back (no data is written)', plan: ['LOCK the five catalog tables in SHARE ROW EXCLUSIVE mode, then fail on purpose (1/0): the server must roll everything back', 'LOCK catalog_imports the same way: it must be refused (permission denied) - the approved limit of the role', 'LOCK the five tables and commit without writing anything: the role may take that lock', 'table counts equal before and after'],
  async run(c) {
    const T1 = db.timeoutStatements('import').map((s) => s.text);
    const before = (await c.q(COUNTS_SQL))[0], run = (list) => attempt(() => c.tx(T1.concat(list), { readOnly: false, isolationLevel: 'ReadCommitted' }));
    let r = await run([LOCK5, 'SELECT 1/0']); c.check('lock + deliberate failure: the server answers 22012 (division by zero)', !r.ok && errInfo(r.error).code === '22012', r.ok ? 'it succeeded' : JSON.stringify(errInfo(r.error)));
    r = await run([LOCK_CATALOG_IMPORTS]); c.check('LOCK catalog_imports is refused: 42501 (the approved limit of the role)', !r.ok && errInfo(r.error).code === '42501', r.ok ? 'it was allowed' : JSON.stringify(errInfo(r.error)));
    r = await run([LOCK5, 'SELECT 1 AS ok']); c.check('the five-table lock is allowed and commits without writing', r.ok, r.ok ? '' : JSON.stringify(errInfo(r.error)));
    c.check('table counts are the same as before', sameCounts(before, (await c.q(COUNTS_SQL))[0]), 'a count changed');
  } });

const svcInsert = 'INSERT INTO services (id, name, topic, description, active) VALUES ($1::bigint, $2, $3, $4, false)';
stage('atomic-control', { kind: 'write', raw: [COUNTS_SQL], needs: ['lock-probe'], title: 'a first, ordinary write: one service and its audit row in one batch', plan: ['reserve one service id', 'one batch: INSERT a service named g2-<run>-control + its audit row (profile "single")', 'counts: services +1, audit_log +1, nothing else', 'the request is one POST, READ COMMITTED, not read-only, with the two single-record timeouts first'],
  async run(c) {
    const { W } = c.product, before = (await c.q(COUNTS_SQL))[0], [sid] = await W.reserve('service', 1), name = c.runId + '-control';
    await W.run([{ text: svcInsert, params: [sid, name, 'g2', null] }, W.audit(ACTOR, 'g2.control', 'service', sid, { run: c.runId })]);
    const r = c.guard.records[c.guard.records.length - 1];   // the write itself: taken before any other request is made
    const d = delta(before, (await c.q(COUNTS_SQL))[0]); c.check('services +1, audit_log +1, nothing else changed', Object.entries(d).every(([t, n]) => n === (t === 'services' || t === 'audit_log' ? 1 : 0)), JSON.stringify(d));
    c.check('one write request: 4 statements, READ COMMITTED, not read-only', r.kind === 'batch' && r.statements === 4 && r.readOnly === false && r.isolation === 'ReadCommitted', JSON.stringify(r));
    c.check('the first statements are the single-record timeouts', r.first[0] === "SET LOCAL lock_timeout = '1500ms'" && r.first[1] === "SET LOCAL statement_timeout = '4000ms'", JSON.stringify(r.first));
    c.note('created', { service_id: sid, name });
  } });

stage('atomic-rollback', { kind: 'write', raw: [COUNTS_SQL], needs: ['atomic-control'], title: 'a failing batch leaves nothing: duplicate key, the no-row guard, and a failure after thirty inserts', plan: ['2 inserts + the same id again: 23505, nothing kept', 'an insert + an UPDATE of a row that does not exist (the guard): P0001 no_rows, nothing kept', '30 inserts + a duplicate as the LAST statement: nothing kept', 'the raw error carries a SQLSTATE `code`, and the application maps it'],
  async run(c) {
    const { W, db } = c.product, ins = (id, n) => ({ text: svcInsert, params: [id, c.runId + '-' + n, 'g2', null] });
    const fails = async (list, label, code, mapped) => {
      const before = (await c.q(COUNTS_SQL))[0], r = await attempt(() => db.writeTransaction(list)); const info = r.ok ? null : errInfo(r.error);
      c.check(label + ': the server answers ' + code, !r.ok && info.code === code, r.ok ? 'it succeeded' : JSON.stringify(info));
      if (!r.ok) { const m = W.mapError(r.error); c.check(label + ': mapped to ' + mapped.status + ' ' + mapped.code, m.status === mapped.status && m.code === mapped.code, m.status + ' ' + m.code); c.note('error_shape_' + code, { has_code: typeof r.error.code === 'string', name: r.error.name, has_constraint: !!r.error.constraint }); }
      c.check(label + ': nothing was kept (counts equal)', sameCounts(before, (await c.q(COUNTS_SQL))[0]), 'a count changed: ' + JSON.stringify(delta(before, (await c.q(COUNTS_SQL))[0])));
    };
    let ids = await W.reserve('service', 2);
    await fails([ins(ids[0], 'rb1a'), ins(ids[1], 'rb1b'), ins(ids[0], 'rb1c'), W.audit(ACTOR, 'g2.rollback', 'service', ids[0], {})], 'duplicate key', '23505', { status: 409, code: 'duplicate' });
    ids = await W.reserve('service', 1);
    await fails([ins(ids[0], 'rb2'), ...W.counted('UPDATE services SET description = $1::text WHERE id = $2::bigint', ['g2', '9223372036854775000']), W.audit(ACTOR, 'g2.rollback', 'service', ids[0], {})], 'no-row guard', 'P0001', { status: 409, code: 'conflict' });
    ids = await W.reserve('service', 30);
    await fails(ids.map((id, i) => ins(id, 'rb3-' + i)).concat([ins(ids[0], 'rb3-dup')]), 'duplicate after 30 inserts', '23505', { status: 409, code: 'duplicate' });
  } });

const importCtx = (c, rows, expect) => ({ expect, actor: ACTOR, fileSha256: crypto.createHash('sha256').update(c.runId + 'x').digest('hex'), summary: {}, rowsApplied: rows, log: { source: 'csv', file_sha256: crypto.createHash('sha256').update(c.runId + 'x').digest('hex'), rows_total: rows.length, rows_created: rows.length, rows_updated: 0, rows_skipped: 0, problems: [], imported_by: ACTOR } });
stage('atomic-guard', { kind: 'write', raw: [COUNTS_SQL], needs: ['atomic-rollback'], title: 'the import guard: a wrong fingerprint stops the import and nothing is written', plan: ['build the import batch for one new service with a fingerprint that is NOT the data\'s', 'the batch takes the table lock, the guard raises snapshot_changed (P0001): the whole batch is rolled back', 'counts equal; a normal write still works afterwards (the lock is not left behind)'],
  async run(c) {
    const { W, db } = c.product, ids = new Map([['s1', (await W.reserve('service', 1))[0]]]);
    const batch = W.importBatch([{ op: 'create_service', ref: 's1', name: c.runId + '-guard', topic: 'g2', description: null, active: false, source_row: 2 }], ids, importCtx(c, [2], '0'.repeat(32)));
    const before = (await c.q(COUNTS_SQL))[0], r = await attempt(() => db.writeTransaction(batch, { profile: 'import' })), info = r.ok ? null : errInfo(r.error);
    c.check('the server answers P0001 (snapshot_changed)', !r.ok && info.code === 'P0001' && /snapshot_changed/.test(String(r.error.message)), r.ok ? 'it succeeded' : JSON.stringify(info));
    if (!r.ok) { const m = W.mapError(r.error); c.check('mapped to 409 preview_stale', m.status === 409 && m.code === 'preview_stale', m.status + ' ' + m.code); }
    c.check('nothing was kept (services, catalog_imports, audit_log and the rest)', sameCounts(before, (await c.q(COUNTS_SQL))[0]), JSON.stringify(delta(before, (await c.q(COUNTS_SQL))[0])));
    const [sid] = await W.reserve('service', 1); const w = await attempt(() => W.run([{ text: svcInsert, params: [sid, c.runId + '-after-guard', 'g2', null] }, W.audit(ACTOR, 'g2.after_guard', 'service', sid, {})]));
    c.check('and an ordinary write works straight afterwards (no lock left behind)', w.ok, w.ok ? '' : JSON.stringify(errInfo(w.error))); if (w.ok) c.note('created', { service_id: sid });
  } });

// Synthetic rows. The import tells apart "similar" names and asks for a decision on them; the two rows must therefore have nothing in common but the g2- prefix that marks them as ours.
const words = (seed, n) => { let h = crypto.createHash('sha256').update(seed).digest(), k = 0; return Array.from({ length: n }, () => Array.from({ length: 8 }, () => String.fromCharCode(1488 + (h[k++ % 32] ^ h[(k * 7) % 32]) % 27)).join('')); };
const rowOf = (c, F, i) => { const [s1, s2, p1, p2, b1] = words(c.runId + '/' + i, 5), num = parseInt(crypto.createHash('md5').update(c.runId + '/' + i).digest('hex').slice(0, 7), 16);
  return Object.assign({}, F.ROWS.fixed, { service: c.runId + ' ' + s1 + ' ' + s2, description: 'g2 ' + s2, provider: c.runId + ' ' + p1 + ' ' + p2, business: b1 + ' ' + s1, phone: '05' + String(10000000 + (num % 89999999)), email: p1.length + 'x' + num.toString(36) + '@example.test', externalId: 'G2-' + num.toString(36), notes: 'g2' }); };
stage('atomic-import', { kind: 'write', raw: [COUNTS_SQL], needs: ['atomic-guard'], title: 'a SMALL import (2 rows) end to end, then the same import again', plan: ['read the snapshot, build the preview of a 2-row synthetic file, approve every offered change, plan and save with the import timeouts and the table lock', 'counts: the new services, providers, engagements, price layers, one import-log row, one audit row', 'the same batch again: refused (preview_stale), nothing doubled', 'a new preview says every row is already there'],
  async run(c) {
    const { W, store, Imp, db } = c.product, F = require(path.join(ROOT, 'tests', 'fixtures', 'catalog-demo.js'));
    const csv = F.csv([F.row(rowOf(c, F, 1)), F.row(rowOf(c, F, 2))]), snap = await store.readSnapshot(), preview = Imp.buildPreview({ csv, existing: snap.snapshot, maxRows: 300 });
    if (!c.check('the 2-row file is usable and both rows are new', preview.ok && preview.rows.filter((r) => r.status === 'new').length === 2, JSON.stringify(preview.fileProblems || preview.rows.map((r) => r.status)))) return;
    const rows = {}; for (const r of preview.rows) if (!['skipped', 'problem', 'unchanged'].includes(r.status) && !(r.decisions || []).length) rows[r.rowNumber] = { apply: true, accept: r.changes.filter((x) => !x.manual && !x.blocked).map((x) => x.id), acceptManual: [], confirmed: r.needsConfirmation };
    if (!c.check('both rows can be approved without a manual decision', Object.keys(rows).length === 2, JSON.stringify(preview.rows.map((r) => [r.status, (r.decisions || []).length])))) return;
    const plan = Imp.planApply(preview, { rows }, snap.snapshot, { actor: ACTOR, previewId: preview.previewId }); if (!c.check('the plan is accepted', plan.ok, plan.reason)) return;
    Imp.assertSafe(plan.operations); const ids = await W.reserveIds(plan.operations), log = Imp.importLog(preview, plan, ACTOR), applied = Array.from(new Set(plan.operations.map((o) => o.source_row))).sort((a, b) => a - b);
    const batch = W.importBatch(plan.operations, ids, { expect: snap.fingerprint, actor: ACTOR, fileSha256: preview.fileSha256, summary: plan.summary, rowsApplied: applied, log });
    const n = (op) => plan.operations.filter((o) => o.op === op).length, before = (await c.q(COUNTS_SQL))[0];
    await W.run(batch, 'import'); const r = c.guard.records[c.guard.records.length - 1];   // the import itself: taken before any other request is made
    const after = (await c.q(COUNTS_SQL))[0], d = delta(before, after);
    c.check('the import added exactly what the plan said', d.services === n('create_service') && d.professionals === n('create_provider') && d.provider_services === n('create_engagement') && d.provider_service_prices === n('create_layer') && d.catalog_imports === 1 && d.audit_log === 1 && d.pricing === 0 && d.settings === 0, JSON.stringify(d));
    c.check('one request with the import timeouts and the table lock first', r.kind === 'batch' && r.statements === batch.length + 2 && r.first[0] === "SET LOCAL lock_timeout = '2000ms'" && r.first[1] === "SET LOCAL statement_timeout = '5000ms'", JSON.stringify(r)); c.note('import_request', { statements: r.statements, bytes: r.bytes, ms: r.ms });
    const again = await attempt(() => W.run(batch, 'import'));
    c.check('the same import again is refused: 409 preview_stale', !again.ok && again.error.status === 409 && again.error.code === 'preview_stale', again.ok ? 'it was accepted' : again.error.status + ' ' + again.error.code);
    c.check('and added nothing', sameCounts(after, (await c.q(COUNTS_SQL))[0]), JSON.stringify(delta(after, (await c.q(COUNTS_SQL))[0])));
    const snap2 = await store.readSnapshot(), pv2 = Imp.buildPreview({ csv, existing: snap2.snapshot, maxRows: 300 });
    c.check('a new preview of the file says there is nothing left to do', pv2.ok && pv2.rows.filter((x) => x.status !== 'skipped').every((x) => x.status === 'unchanged'), JSON.stringify(pv2.rows.map((x) => x.status)));
    c.note('created', { services: plan.operations.filter((o) => o.op === 'create_service').map((o) => o.name), providers: plan.operations.filter((o) => o.op === 'create_provider').map((o) => o.name) }); c.note('batch_statements', batch.length);
  } });

// locked: designed in the plan, NOT runnable. Unlocking one is a change to this file that has to be reviewed and approved on its own.
const LOCKED = {
  timeouts: 'lock_timeout, statement_timeout and the transaction_timeout feasibility test on the real service (needs two connections and the owner\'s separate approval)',
  concurrency: 'two real connections: import+import, import+single write, reads during a lock, a deliberate deadlock, compare-and-set on one row',
  disconnect: 'client disconnects in the middle of a batch and the unknown-result behaviour',
  'size-ladder': 'imports of 10, 50, 150 and finally 300 rows. NOT reachable before every small stage has passed AND the owner has approved this stage separately',
  race: 'publishing a price against renaming its service (needs migration 003 on the child branch, which has its own approval)',
};
for (const [id, why] of Object.entries(LOCKED)) stage(id, { kind: 'locked', status: 'locked', title: why, plan: [why] });

// ---- state file (no secrets: stage names, pass/fail, counts, the endpoint id and a short hash of the marker) ----------------------------------------------------------------
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
function readState(file) { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(s.runs) ? s : { runs: [] }; } catch (e) { return { runs: [] }; } }
function passed(state, id, endpoint, marker) { const runs = state.runs.filter((r) => r.stage === id && r.endpoint === endpoint && r.marker === sha8(marker)); return runs.length > 0 && runs[runs.length - 1].pass === true; }

// ---- arguments ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { forbid: [], approved: [], list: false, allowWrites: false, allowPooler: false };
  for (const x of argv) {
    if (/:\/\/|postgres/i.test(x)) refuse('a connection string must never be given on the command line (it ends up in the shell history). Use KASPCHEM_G2_DATABASE_URL.');
    let m;
    if (x === '--list') a.list = true; else if (x === '--allow-writes') a.allowWrites = true; else if (x === '--allow-pooler') a.allowPooler = true;
    else if ((m = /^--(run|plan|expect-endpoint|expect-env|marker|approved-stages|forbid-endpoint|state|expect-fingerprint)=(.*)$/.exec(x))) {
      const k = m[1], v = m[2];
      if (k === 'run') a.run = v; else if (k === 'plan') a.plan = v; else if (k === 'expect-endpoint') a.endpoint = v; else if (k === 'expect-env') a.env = v; else if (k === 'marker') a.marker = v;
      else if (k === 'approved-stages') a.approved = v.split(',').map((s) => s.trim()).filter(Boolean); else if (k === 'forbid-endpoint') a.forbid.push(v); else if (k === 'state') a.state = v; else a.expectFingerprint = v;
    } else refuse('unknown option: ' + x.slice(0, 40));
  }
  return a;
}

// ---- main -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// deps (tests): { fetch, write, now }. Returns { code, lines }: 0 = the stage passed, 1 = it ran and a check failed, 2 = refused before anything was sent.
async function main(argv, env, deps) {
  const d = deps || {}, lines = [];
  let redact = makeRedactor([]);
  const out = (s) => { const t = redact(s); lines.push(t); (d.write || console.log)(t); };
  let unpatch = () => {};
  try {
    const args = parseArgs(argv);
    if (args.list) { for (const s of Object.values(STAGES)) out(s.id.padEnd(16) + (s.status === 'locked' ? 'LOCKED   ' : s.kind.padEnd(9)) + s.title); return { code: 0, lines }; }
    if (args.plan) { const s = STAGES[args.plan]; if (!s) refuse('unknown stage'); out('STAGE ' + s.id + (s.status === 'locked' ? ' (LOCKED: cannot be run)' : ' [' + s.kind + ']') + ': ' + s.title); s.plan.forEach((p) => out('  - ' + p)); if (s.needs.length) out('  needs first (passed on the same endpoint and marker): ' + s.needs.join(', ')); return { code: 0, lines }; }
    if (!args.run) refuse('nothing to do: use --list, --plan=<stage> or --run=<stage>.');
    const st = STAGES[args.run]; if (!st) refuse('unknown stage');
    if (st.status === 'locked') refuse('stage "' + st.id + '" is LOCKED: ' + st.title);
    if (!args.approved.includes(st.id)) refuse('stage "' + st.id + '" is not in --approved-stages: nothing runs without being listed there.');
    if (st.kind === 'write' && !args.allowWrites) refuse('stage "' + st.id + '" writes (synthetic data): it also needs --allow-writes.');
    if (!args.endpoint || !/^ep-[a-z0-9-]{3,60}$/.test(args.endpoint)) refuse('give --expect-endpoint=ep-... (the endpoint of the CHILD branch).');
    if (!args.env || !/^[a-z][a-z0-9_-]{0,30}$/.test(args.env) || args.env === 'production') refuse('give --expect-env=<value of meta.environment>; "production" is never accepted.');
    if (!args.marker || !/^[a-z0-9]{12,40}$/.test(args.marker)) refuse('give --marker=<the token of the child-branch marker> (12-40 lower-case letters and digits).');
    for (const f of args.forbid) if (!/^ep-[a-z0-9-]{3,60}$/.test(f)) refuse('--forbid-endpoint must be an endpoint id (ep-...).');
    const raw = env.KASPCHEM_G2_DATABASE_URL; if (!raw) refuse('set KASPCHEM_G2_DATABASE_URL (the connection string of kaspchem_app on the CHILD branch; it is never shown).');
    const conn = parseConnection(raw); redact = makeRedactor([raw, conn.password, conn.host]);
    if (env === process.env) delete process.env.KASPCHEM_G2_DATABASE_URL;   // not left in the environment for anything this process might start
    if (conn.pooler && !args.allowPooler) refuse('the host is a pooler address; add --allow-pooler only when a pooled address is what you mean to test.');
    const ambient = AMBIENT_URL_VARS.map((k) => (env[k] ? endpointOf(env[k]) : null)).filter(Boolean), forbidden = new Set(FORBIDDEN_ENDPOINTS.concat(args.forbid, ambient));
    if (conn.endpoint !== args.endpoint) refuse('the endpoint of the connection string is not the one in --expect-endpoint.');
    if (forbidden.has(conn.endpoint)) refuse('that endpoint is forbidden (the temporary branch itself, a branch you listed, or a database set in this shell\'s environment). G2 talks to the CHILD branch only.');
    if (AMBIENT_URL_VARS.some((k) => env[k] && env[k] === raw)) refuse('KASPCHEM_G2_DATABASE_URL is identical to another database URL set in this shell.');
    const stateFile = args.state || DEFAULT_STATE, state = readState(stateFile);
    for (const need of st.needs) if (!passed(state, need, conn.endpoint, args.marker)) refuse('stage "' + st.id + '" needs stage "' + need + '" to have passed first on this endpoint and marker (state file).');

    // everything below may touch the network, through the guard only
    const product = { db, W, store, Imp };
    const neon = require('@neondatabase/serverless'), cfg = neon.neonConfig, savedFetch = cfg.fetchFunction, savedEnv = process.env.KASPCHEM_DATABASE_URL;
    const guard = makeGuard({ conn, baseFetch: d.fetch || globalThis.fetch, db: product.db }); guard.state.raw.add(IDENTITY_SQL);
    cfg.fetchFunction = guard.fetch; process.env.KASPCHEM_DATABASE_URL = raw; product.db.setDriver(null); product.db.setTransactionDriver(null);
    unpatch = () => { cfg.fetchFunction = savedFetch; if (savedEnv === undefined) delete process.env.KASPCHEM_DATABASE_URL; else process.env.KASPCHEM_DATABASE_URL = savedEnv; product.db.setDriver(null); product.db.setTransactionDriver(null); };
    const sql = neon.neon(raw);
    const registered = new Set(st.raw), notRegistered = (t) => { if (!registered.has(t)) throw new Error('blocked_by_g2_guard: a statement this stage did not register'); };
    const q = async (text, params) => { notRegistered(text); return sql.query(text, params || []); };
    const tx = async (texts, o) => { texts.forEach(notRegistered); return sql.transaction(texts.map((t) => sql.query(t, [])), { readOnly: o.readOnly, isolationLevel: o.isolationLevel }); };

    // proof 3: the identity read, the only statement allowed so far
    const idRows = await sql.query(IDENTITY_SQL, []), idr = idRows[0];
    if (idr.cu !== ROLE || idr.su !== ROLE) refuse('the server says the role is not ' + ROLE + '.');
    if (idr.db !== conn.db) refuse('the server says the database is not the one named in the connection string.');
    if (idr.env !== args.env || idr.env === 'production') refuse('settings.meta.environment is "' + String(idr.env).slice(0, 20) + '", expected "' + args.env + '" (never production).');
    if (idr.neon_endpoint && String(idr.neon_endpoint).replace(/-pooler$/, '') !== conn.endpoint) refuse('the server reports another Neon endpoint than the connection string names.');
    if (idr.marker !== 'kaspchem-g2-child:' + args.marker) refuse('the CHILD-branch marker is missing or different: this is not the branch G2 was prepared on. Nothing was run.');
    guard.state.phase = 'stage'; st.raw.forEach((t) => guard.state.raw.add(t));
    out('IDENTITY OK  endpoint ' + conn.endpoint + (conn.pooler ? ' (pooler)' : ' (direct)') + '  role ' + idr.cu + '  env ' + idr.env + '  marker matches' + (idr.neon_endpoint ? '  neon endpoint matches' : '  (the server does not report a neon endpoint id)'));

    const runId = 'g2-' + (d.now ? d.now() : Date.now()).toString(36) + '-' + crypto.randomBytes(2).toString('hex'), ck = newChecks();
    const ctx = Object.assign(ck, { q, tx, product, guard, conn, args, identity: idr, runId });
    ctx.notes = ck.notes; let crashed = null;
    try { await st.run(ctx); } catch (e) { crashed = e; ck.check('the stage ran to its end', false, 'stopped by ' + (e && e.message && /^blocked_by_g2_guard/.test(e.message) ? e.message : JSON.stringify(errInfo(e)))); }
    const pass = ck.checks.length > 0 && ck.checks.every((x) => x.ok);
    out('STAGE ' + st.id + ' [' + st.kind + '] run ' + runId);
    for (const x of ck.checks) out((x.ok ? '  ok    ' : '  FAIL  ') + x.name + (x.ok ? '' : ' -> ' + String(x.detail).slice(0, 300)));
    for (const [k, v] of Object.entries(ck.notes)) out('  note  ' + k + ': ' + JSON.stringify(v));
    out('  requests: ' + guard.records.length + ' (blocked by the guard: ' + guard.state.blocked + '), statements ' + guard.records.reduce((n, r) => n + r.statements, 0) + ', bytes ' + guard.records.reduce((n, r) => n + r.bytes, 0));
    out('RESULT ' + st.id + ': ' + (pass ? 'PASS' : 'FAIL'));
    try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); state.runs.push({ stage: st.id, pass, endpoint: conn.endpoint, marker: sha8(args.marker), utc: new Date(d.now ? d.now() : Date.now()).toISOString(), run: runId, notes: JSON.parse(redact(JSON.stringify(ck.notes))) }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) { out('(the state file could not be written; later stages will not unlock)'); }
    return { code: pass ? 0 : 1, lines, crashed: !!crashed };
  } catch (e) {
    if (e instanceof Refused) { out('REFUSED: ' + e.message + ' Nothing was sent to the database.'); return { code: 2, lines }; }
    const info = errInfo(e); out('STOPPED: ' + (e && /^blocked_by_g2_guard/.test(String(e.message)) ? e.message : 'unexpected error ' + (info.code || info.name || '') + ' - ' + String((e && e.message) || '').slice(0, 160))); return { code: 2, lines };
  } finally { unpatch(); }
}

module.exports = { main, parseArgs, parseConnection, makeRedactor, makeGuard, STAGES, LOCKED, FORBIDDEN_ENDPOINTS, FORBIDDEN_BRANCHES, IDENTITY_SQL, COUNTS_SQL, PRIV_SQL, TABLES, wantedPriv, readState, passed, sha8, DEFAULT_STATE };
if (require.main === module) {
  main(process.argv.slice(2), process.env).then((r) => process.exit(r.code), () => { console.error('STOPPED: unexpected failure.'); process.exit(2); });
}
