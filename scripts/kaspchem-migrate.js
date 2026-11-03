// Applies db/kaspchem-schema.sql to the DEDICATED Kaspchem Neon database. Idempotent.
// Usage: KASPCHEM_DATABASE_URL=postgres://... node scripts/kaspchem-migrate.js
// Safety: refuses to run unless the DB has no tables outside the Kaspchem set, so it can never be pointed at another project's database by mistake.
const fs = require('fs');
const path = require('path');
const { neon } = require('@neondatabase/serverless');

const OURS = ['applicants', 'questionnaire_versions', 'services', 'professionals', 'pricing', 'treatment_requests', 'consents', 'request_notes', 'revenues', 'settings', 'audit_log', 'rate_limits'];

(async () => {
  const url = process.env.KASPCHEM_DATABASE_URL;
  if (!url) { console.error('Set KASPCHEM_DATABASE_URL'); process.exit(1); }
  const sql = neon(url);
  const tables = (await sql.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name);
  const foreign = tables.filter((t) => !OURS.includes(t));
  if (foreign.length) { console.error('Refusing: database contains non-Kaspchem tables:', foreign.join(', ')); process.exit(1); }
  const ddl = fs.readFileSync(path.join(__dirname, '..', 'db', 'kaspchem-schema.sql'), 'utf8');
  // Neon HTTP runs one statement per call; split on semicolons that end a statement.
  const stmts = ddl.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  for (const s of stmts) await sql.query(s);
  console.log('Applied', stmts.length, 'statements.');
})().catch((e) => { console.error(e.message); process.exit(1); });
