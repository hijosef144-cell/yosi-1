// The structure of the database (column types, NOT NULL, defaults, primary/foreign/unique/check constraints, indexes) as a list of lines, and a comparison of a real
// database against what db/kaspchem-schema.sql would create. It reads catalogs only (scripts/schema-signature.sql): no row of any table, no personal data.
//
//   node scripts/schema-signature.js --expected             print the expected signature (the schema applied to an in-memory Postgres)
//   node scripts/schema-signature.js --compare <file>       compare the signature copied from the real database (the single cell returned by scripts/schema-signature.sql)
//
// The comparison tells, per table, what the migration will create by itself (a table that does not exist yet, an index that is missing) and what it can NOT fix
// (a column, a type or a constraint that differs in a table that already exists). Exit code 0 only when nothing needs a manual look.
const fs = require('fs');
const path = require('path');

const SQL = fs.readFileSync(path.join(__dirname, 'schema-signature.sql'), 'utf8');
const SCHEMA = path.join(__dirname, '..', 'db', 'kaspchem-schema.sql');

async function signatureOf(query) { const rows = await query(SQL); return String(rows[0].signature || ''); }
const lines = (text) => new Set(String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
const tableOf = (line) => (/^(col|con|idx) ([a-z_]+)[ .]/.exec(line) || [])[2];

async function expectedSignature() {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(SCHEMA, 'utf8'));
  const text = await signatureOf(async (t) => (await pg.query(t)).rows);
  await pg.close();
  return text;
}

// actual: the real database; expected: what the schema creates.
function compare(actualText, expectedText) {
  const actual = lines(actualText), expected = lines(expectedText);
  const actualTables = new Set([...actual].map(tableOf).filter(Boolean));
  const out = { createdByMigration: [], needsManualLook: [], unexpectedInDatabase: [], same: 0 };
  for (const l of expected) {
    if (actual.has(l)) { out.same++; continue; }
    const t = tableOf(l);
    if (!actualTables.has(t)) out.createdByMigration.push(l);                  // the whole table is missing: the migration creates it
    else if (l.startsWith('idx ')) out.createdByMigration.push(l);             // an index is missing: CREATE INDEX IF NOT EXISTS adds it
    else out.needsManualLook.push(l);                                          // a column or constraint of an existing table is missing or different: the migration cannot fix it
  }
  for (const l of actual) if (!expected.has(l)) out.unexpectedInDatabase.push(l);
  return out;
}

module.exports = { signatureOf, expectedSignature, compare, lines };

if (require.main === module) {
  (async () => {
    const a = process.argv.slice(2);
    if (a.includes('--expected')) { console.log(await expectedSignature()); return; }
    const i = a.indexOf('--compare');
    if (i < 0 || !a[i + 1]) { console.error('usage: node scripts/schema-signature.js --expected | --compare <file>'); process.exit(2); }
    const r = compare(fs.readFileSync(a[i + 1], 'utf8'), await expectedSignature());
    const tables = (arr) => [...new Set(arr.map(tableOf))].join(', ') || '-';
    console.log('identical lines:', r.same);
    console.log('to be created by the migration (' + r.createdByMigration.length + '), tables: ' + tables(r.createdByMigration));
    r.createdByMigration.forEach((l) => console.log('   + ' + l));
    console.log('NEEDS A MANUAL LOOK, differs in an existing table (' + r.needsManualLook.length + ')');
    r.needsManualLook.forEach((l) => console.log('   ! expected: ' + l));
    console.log('IN THE DATABASE BUT NOT IN THE SCHEMA (' + r.unexpectedInDatabase.length + ')');
    r.unexpectedInDatabase.forEach((l) => console.log('   ? found:    ' + l));
    const ok = !r.needsManualLook.length && !r.unexpectedInDatabase.length;
    console.log(ok ? 'RESULT: every existing table matches the schema; the migration only adds what is listed above.' : 'RESULT: differences found; do not run the migration before they are understood.');
    process.exit(ok ? 0 : 1);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
