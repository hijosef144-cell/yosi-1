'use strict';
// Thin DB layer. Production: Neon over HTTP (no connection pooling concerns in Functions).
// Tests inject a PGlite-backed driver via setDriver().
let driver = null;

function setDriver(fn) { driver = fn; }

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

const configured = () => !!(driver || process.env.KASPCHEM_DATABASE_URL);

module.exports = { query, setDriver, configured };
