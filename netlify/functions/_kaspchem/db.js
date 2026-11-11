'use strict';
// Thin DB layer. Production: Neon over HTTP (no connection pooling concerns in Functions).
// Tests inject a PGlite-backed driver via setDriver().
let driver = null;
let txDriver = null;

function setDriver(fn) { driver = fn; }
function setTransactionDriver(fn) { txDriver = fn; }

async function query(text, params) {
  if (!driver) {
    const url = process.env.KASPCHEM_DATABASE_URL;
    if (!url) throw new Error('db_not_configured');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    driver = (t, p) => sql.query(t, p);
  }
  return driver(text, params || []);
}

// A list of parameterised statements run as ONE transaction: the Neon HTTP driver sends them in a single request and the server runs them between BEGIN and COMMIT. Nothing can use the
// result of an earlier statement (it is not an interactive transaction). Returns one array of rows per statement.
const ISOLATION_LEVELS = ['ReadCommitted', 'RepeatableRead', 'Serializable'];   // 'ReadUncommitted' is not offered: Postgres treats it as ReadCommitted
function send(list, options) {
  if (!txDriver) {
    const url = process.env.KASPCHEM_DATABASE_URL;
    if (!url) throw new Error('db_not_configured');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    txDriver = (stmts, o) => sql.transaction(stmts.map((s) => sql.query(s.text, s.params)), { readOnly: o.readOnly, isolationLevel: o.isolationLevel });
  }
  return txDriver(list, options);
}

// READ ONLY transactions (catalog stage 4a): SELECT statements only, a bounded list, a known isolation level. The database itself also refuses any write in a READ ONLY transaction.
async function transaction(statements, opts) {
  const o = opts || {};
  if (o.readOnly !== true) throw new Error('write_transactions_not_enabled');   // writes go through writeTransaction, which has its own, stricter checks
  if (o.isolationLevel !== undefined && !ISOLATION_LEVELS.includes(o.isolationLevel)) throw new Error('bad_isolation_level');
  if (!Array.isArray(statements) || !statements.length || statements.length > 50) throw new Error('bad_statements');
  const list = statements.map((s) => {
    if (!s || typeof s.text !== 'string' || !/^\s*(select|with)\b/i.test(s.text)) throw new Error('read_only_statements_only');
    return { text: s.text, params: s.params || [] };
  });
  return send(list, { readOnly: true, isolationLevel: o.isolationLevel });
}

// WRITE transactions (catalog stage 4b). The last fence, below every builder and every route: whatever a bug above might produce, only these shapes can reach the database.
//   * the only tables a catalog write may INSERT into or UPDATE are the catalog tables, `services`, `professionals`, the import log and the audit log: never `pricing`, `settings`, the
//     commission table or the migration history;
//   * no DELETE, TRUNCATE or any structure, permission or session statement;
//   * the only statements besides SELECT / INSERT / UPDATE / WITH are three constant ones: the table lock of an import, the parameter that carries the expected fingerprint, and the guard blocks
//     (DO ... RAISE). The two timeouts below are not accepted from a caller at all: this layer puts them first in EVERY write batch itself.
//
// TIMEOUTS of a write batch (F1). They are SET LOCAL, inside the batch, because a setting made on the connection is not reliable over Neon HTTP. What each one really bounds:
//   * lock_timeout      one wait for one lock. A LOCK TABLE on five tables takes five locks one after the other, so on its own it can wait up to five times this value;
//   * statement_timeout one statement from start to end, lock waits of that statement included, so it is what bounds the five-table LOCK TABLE, and the longest any single statement may take.
//   NEITHER bounds the batch as a whole: a batch of N statements may take up to N times statement_timeout (the only whole-batch ceilings are the statement count below, the size of the file
//   the routes accept, and the host's own time limit). transaction_timeout is NOT used and nothing may be assumed from it until a feasibility test on the real service has shown what it does (F3).
//   A timeout is an ordinary error inside the transaction: the whole batch is rolled back, never part of it. A caller cannot choose, lengthen or switch off these values.
const WRITE_TIMEOUTS = Object.freeze({ single: Object.freeze({ lockMs: 1500, statementMs: 4000 }), import: Object.freeze({ lockMs: 2000, statementMs: 5000 }) });
const TIMEOUT_STATEMENT = /^SET LOCAL (?:lock|statement)_timeout = '[1-9][0-9]{2,4}ms'$/;
function timeoutStatements(profile) {
  if (typeof profile !== 'string' || !Object.prototype.hasOwnProperty.call(WRITE_TIMEOUTS, profile)) throw new Error('bad_timeout_profile');
  const t = WRITE_TIMEOUTS[profile], list = ["SET LOCAL lock_timeout = '" + t.lockMs + "ms'", "SET LOCAL statement_timeout = '" + t.statementMs + "ms'"];
  list.forEach((x) => { if (!TIMEOUT_STATEMENT.test(x)) throw new Error('bad_timeout_profile'); });
  return list.map((text) => ({ text, params: [] }));
}
const WRITE_TARGETS = new Set(['services', 'professionals', 'provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'catalog_imports', 'audit_log']);
const FORBIDDEN = /\b(delete|truncate|drop|alter|create|grant|revoke|copy|vacuum|reindex|cluster|comment|reset|listen|notify|prepare|execute|call|merge)\b/i;
const TABLE_LOCK = /^LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN SHARE ROW EXCLUSIVE MODE$/;
const GUARD_BLOCK = /^DO \$guard\$ BEGIN IF [\s\S]* THEN RAISE EXCEPTION '(snapshot_changed|no_rows)' USING ERRCODE = 'P0001'; END IF; END \$guard\$$/;
const TARGET = /(?<!\bdo\s)\b(?:insert\s+into|update)\s+(?:only\s+)?(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const MAX_WRITE_STATEMENTS = 3000, MAX_STATEMENT_CHARS = 12000;
// The only shapes a write statement may have besides the constant ones above: an INSERT or an UPDATE of an allowed table; the same wrapped in the "did it change a row" counter; and the
// parameter that carries the expected fingerprint into the transaction. A bare SELECT is not a write statement and is not accepted here.
const SET_EXPECT = /^SELECT set_config\('kaspchem\.expect', \$1, true\)$/;
const COUNTED = /^WITH u AS \(((?:INSERT INTO|UPDATE) [\s\S]*) RETURNING 1\) SELECT set_config\('kaspchem\.rows', \(SELECT count\(\*\) FROM u\)::text, true\)$/;
const DANGEROUS_FUNCTIONS = /\b(nextval|setval|currval|lastval|current_setting|set_config|pg_[a-z_0-9]+|lo_[a-z_0-9]+|dblink[a-z_0-9]*|txid_[a-z_0-9]+|version|inet_[a-z_]+)\s*\(|\b(current_user|session_user|current_role|user|current_database|current_schema|current_catalog)\b/i;
function checkWriteStatement(s) {
  if (!s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > MAX_STATEMENT_CHARS) throw new Error('bad_statement');
  const params = s.params === undefined ? [] : s.params;
  if (!Array.isArray(params) || params.some((p) => !(p === null || ['string', 'number', 'boolean'].includes(typeof p) || (Array.isArray(p) && p.every((x) => typeof x === 'string'))))) throw new Error('bad_params');
  const text = s.text.trim();
  if (TABLE_LOCK.test(text) || SET_EXPECT.test(text)) return;
  if (/^DO\b/i.test(text)) { if (!GUARD_BLOCK.test(text) || FORBIDDEN.test(text.replace(/RAISE EXCEPTION/g, ''))) throw new Error('write_statement_not_allowed'); return; }
  const counted = COUNTED.exec(text), body = counted ? counted[1] : text;
  if (!/^(insert\s+into|update)\s/i.test(body)) throw new Error('write_statement_not_allowed');
  if (FORBIDDEN.test(body) || /;\s*\S/.test(body) || /--|\/\*|\\/.test(body)) throw new Error('write_statement_not_allowed');   // one statement per entry; no comments (they can hide a word from this check)
  if (DANGEROUS_FUNCTIONS.test(body) || /\bfor\s+(update|share|no\s+key)/i.test(body)) throw new Error('write_statement_not_allowed');
  if (/\binto\b/i.test(body.replace(/\binsert\s+into\b/gi, ''))) throw new Error('write_statement_not_allowed');   // SELECT ... INTO would create a table
  if (/[^\x20-\x7e\t\n\r]/.test(text)) throw new Error('write_statement_not_allowed');   // statement text is plain ASCII (all values are parameters): no look-alike letters in a table name
  const targets = [...body.matchAll(TARGET)], keywords = (body.match(/(?<!\bdo\s)\b(?:insert\s+into|update)\b/gi) || []).length;
  if (targets.length !== keywords) throw new Error('write_target_not_allowed');   // every INSERT / UPDATE must name a table this check could read: otherwise refuse
  for (const m of targets) if (!WRITE_TARGETS.has(m[1].toLowerCase())) throw new Error('write_target_not_allowed');
}
// opts: { isolationLevel, profile }. `profile` picks one of the fixed timeout pairs above ('single' by default, 'import' for the import); nothing else about the timeouts can be passed in.
// The two timeout statements go first and are NOT part of the result: the rows returned line up with the statements the caller gave. There is no retry here and none anywhere above: a
// batch is sent once, and what a failure means (nothing saved / not known) is decided by the caller from the error (catalog-writes.js, mapError).
async function writeTransaction(statements, opts) {
  const o = opts || {};
  const level = o.isolationLevel === undefined ? 'ReadCommitted' : o.isolationLevel;
  if (!ISOLATION_LEVELS.includes(level)) throw new Error('bad_isolation_level');
  const timeouts = timeoutStatements(o.profile === undefined ? 'single' : o.profile);
  if (!Array.isArray(statements) || !statements.length || statements.length > MAX_WRITE_STATEMENTS) throw new Error('bad_statements');
  statements.forEach(checkWriteStatement);
  const out = await send(timeouts.concat(statements.map((s) => ({ text: s.text, params: s.params || [] }))), { readOnly: false, isolationLevel: level });
  return out.slice(timeouts.length);
}

const configured = () => !!(driver || process.env.KASPCHEM_DATABASE_URL);

module.exports = { query, transaction, writeTransaction, setDriver, setTransactionDriver, configured, ISOLATION_LEVELS, WRITE_TARGETS, WRITE_TIMEOUTS, timeoutStatements, checkWriteStatement, MAX_WRITE_STATEMENTS };
