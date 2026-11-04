// Applies db/kaspchem-schema.sql to the DEDICATED Kaspchem Neon database. Idempotent and additive: the schema file only has CREATE ... IF NOT EXISTS, so it never
// changes or deletes an existing row, column or table. It also does NOT repair an older table (a table that already exists is skipped as it is): compare the
// real structure with scripts/schema-signature.js before the first run on a database that already has tables.
//
// Usage:
//   KASPCHEM_DATABASE_URL=postgres://... node scripts/kaspchem-migrate.js           apply the schema
//   KASPCHEM_DATABASE_URL=postgres://... node scripts/kaspchem-migrate.js --check   read-only: list what exists, what would be created, anything foreign; changes nothing
// Safety: refuses to run unless the DB has no tables outside the Kaspchem set, so it can never be pointed at another project's database by mistake.
const fs = require('fs');
const path = require('path');

// Every table that db/kaspchem-schema.sql creates. tests/migrate.test.js fails when this list and the schema file differ: `outcomes` was once missing here, so a
// second run would have refused the table the first run had just created, calling it "foreign".
const OURS = ['applicants', 'questionnaire_versions', 'services', 'professionals', 'pricing', 'treatment_requests', 'consents', 'request_notes', 'revenues', 'settings', 'audit_log', 'rate_limits', 'outcomes'];

// Neon HTTP runs one statement per call; split on semicolons that end a statement, then drop comment lines.
function splitDdl(ddl) { return ddl.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean); }

// `query(text)` must resolve to an array of row objects (the Neon driver does; the tests adapt PGlite).
async function existingTables(query) {
  return (await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name);
}
function foreignOf(tables) { return tables.filter((t) => !OURS.includes(t)); }

async function check(query) {
  const tables = await existingTables(query);
  return { existing: tables.filter((t) => OURS.includes(t)).sort(), missing: OURS.filter((t) => !tables.includes(t)), foreign: foreignOf(tables) };
}

async function migrate(query, ddl) {
  const foreign = foreignOf(await existingTables(query));
  if (foreign.length) { const e = new Error('Refusing: database contains non-Kaspchem tables: ' + foreign.join(', ')); e.foreign = foreign; throw e; }
  const stmts = splitDdl(ddl);
  for (const s of stmts) await query(s);
  return stmts.length;
}

module.exports = { OURS, splitDdl, check, migrate };

if (require.main === module) {
  (async () => {
    const url = process.env.KASPCHEM_DATABASE_URL;
    if (!url) { console.error('Set KASPCHEM_DATABASE_URL'); process.exit(1); }
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    const query = (t) => sql.query(t);
    if (process.argv.includes('--check')) {
      const r = await check(query);
      console.log('Existing Kaspchem tables (' + r.existing.length + '):', r.existing.join(', ') || '(none)');
      console.log('Would be created (' + r.missing.length + '):', r.missing.join(', ') || '(none)');
      console.log('Foreign tables (' + r.foreign.length + '):', r.foreign.join(', ') || '(none)');
      console.log(r.foreign.length ? 'RESULT: a migration would be REFUSED.' : 'RESULT: nothing changed (read-only check); a migration would be accepted.');
      process.exit(r.foreign.length ? 1 : 0);
    }
    const n = await migrate(query, fs.readFileSync(path.join(__dirname, '..', 'db', 'kaspchem-schema.sql'), 'utf8'));
    console.log('Applied', n, 'statements.');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
