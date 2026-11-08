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
// Catalog stage 4a: ONLY read-only transactions are enabled. Write transactions need the owner's separate approval (stage 4b), so they are refused here, and so is any statement that is not
// a SELECT (the database itself also refuses writes in a READ ONLY transaction: two separate fences).
const ISOLATION_LEVELS = ['ReadCommitted', 'RepeatableRead', 'Serializable'];   // 'ReadUncommitted' is not offered: Postgres treats it as ReadCommitted
async function transaction(statements, opts) {
  const o = opts || {};
  if (o.readOnly !== true) throw new Error('write_transactions_not_enabled');
  if (o.isolationLevel !== undefined && !ISOLATION_LEVELS.includes(o.isolationLevel)) throw new Error('bad_isolation_level');
  if (!Array.isArray(statements) || !statements.length || statements.length > 50) throw new Error('bad_statements');
  const list = statements.map((s) => {
    if (!s || typeof s.text !== 'string' || !/^\s*(select|with)\b/i.test(s.text)) throw new Error('read_only_statements_only');
    return { text: s.text, params: s.params || [] };
  });
  if (!txDriver) {
    const url = process.env.KASPCHEM_DATABASE_URL;
    if (!url) throw new Error('db_not_configured');
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    txDriver = (stmts, options) => sql.transaction(stmts.map((s) => sql.query(s.text, s.params)), { readOnly: options.readOnly, isolationLevel: options.isolationLevel });
  }
  return txDriver(list, { readOnly: true, isolationLevel: o.isolationLevel });
}

const configured = () => !!(driver || process.env.KASPCHEM_DATABASE_URL);

module.exports = { query, transaction, setDriver, setTransactionDriver, configured, ISOLATION_LEVELS };
