// Applies the Kaspchem database migrations to the DEDICATED Kaspchem Neon database. Additive and repeatable: a migration only ever contains
// CREATE ... IF NOT EXISTS, so it never changes or deletes an existing row, column or table. It does NOT repair an older table (an existing table is skipped as it is).
//
// Migrations are an ordered list: `001-base` is db/kaspchem-schema.sql (frozen: its fingerprint is pinned below), followed by db/migrations/NNN-name.sql (002, 003, ...)
// listed with their SHA-256 fingerprints in db/migrations/MANIFEST.sha256. What has been applied is recorded in the table `schema_migrations`.
//
// Usage:
//   KASPCHEM_DATABASE_URL=postgres://... node scripts/kaspchem-migrate.js --check [--expect-env=<name>] [--allow-empty-database]
//        READ-ONLY dry run of exactly what an apply would decide. It writes nothing in ANY state, the first run on a new database included: every statement it sends
//        passes a guard that refuses anything that is not a plain read (and the check tests prove it against a recording connection).
//   KASPCHEM_DATABASE_URL=postgres://... node scripts/kaspchem-migrate.js --expect-env=<name> [--allow-empty-database]
//        apply the pending migrations. --expect-env must equal the database's own `settings` row meta.environment ("production", "test"), so that the wrong database cannot be
//        reached by a wrong connection string. --allow-empty-database is the only way to initialise a database that has no tables.
//   node scripts/kaspchem-migrate.js --verify-files [--migrations-dir=<dir>]     check the migration files, their numbering and the manifest (no database)
//   node scripts/kaspchem-migrate.js --print-manifest [--migrations-dir=<dir>]   print the manifest lines for the files (no database; the output is what MANIFEST.sha256 must hold)
//
// Before ANY write the runner refuses (exit code 1, nothing written) unless all of these hold:
//   identity   the database has only Kaspchem tables, its meta.environment equals --expect-env, and the identity recorded on the first run still matches;
//   history    the recorded migrations are exactly the first N files, in order, and each recorded fingerprint equals the file's fingerprint now;
//   files      numbering is 002, 003, ... without gaps or duplicates, the manifest lists exactly those files with matching fingerprints, and every statement is additive;
//   structure  the real structure equals what the applied migrations create (the comparison of scripts/schema-signature.js), so out-of-band changes are noticed.
// A failure in the middle of a migration records nothing for that migration; running it again is safe because every statement is idempotent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./schema-signature.js');

const ROOT = path.join(__dirname, '..');
const SCHEMA_FILE = path.join(ROOT, 'db', 'kaspchem-schema.sql');
const MIGRATIONS_DIR = path.join(ROOT, 'db', 'migrations');
const MANIFEST_NAME = 'MANIFEST.sha256';
const BASE_ID = '001-base';
// The fingerprint of db/kaspchem-schema.sql (line endings normalised to LF). The base schema is frozen: it is what production was created from. New tables go into
// db/migrations/NNN-*.sql. Changing the base file on purpose means changing this pin in the same reviewed commit.
const BASE_SHA256 = '55d6624afcab982addf23f798375ea4aed43c518be90942017114dfe07222860';
const BOOKKEEPING = 'schema_migrations';
const IDENTITY_ID = '@identity';
const BOOKKEEPING_DDL = 'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())';

// Every table that db/kaspchem-schema.sql creates. tests/migrate.test.js fails when this list and the schema file differ: `outcomes` was once missing here, so a
// second run would have refused the table the first run had just created, calling it "foreign". Tables of later migrations are added automatically (allowedTables).
const OURS = ['applicants', 'questionnaire_versions', 'services', 'professionals', 'pricing', 'treatment_requests', 'consents', 'request_notes', 'revenues', 'settings', 'audit_log', 'rate_limits', 'outcomes'];

const sha = (text) => crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');
const short = (h) => String(h).slice(0, 12);

// Neon HTTP runs one statement per call; split on semicolons that end a statement, then drop comment lines.
function splitDdl(ddl) { return ddl.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean); }

// ---- the additive-only rule ---------------------------------------------------------------------------------------------------------------------------------
const TABLE_STMT = /^CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)\s*\(/i;
const INDEX_STMT = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*[\s(]/i;
function lintStatements(ddl) {
  const problems = [], tables = [], statements = splitDdl(ddl);
  statements.forEach((raw, i) => {
    const s = raw.replace(/--[^\n]*/g, '').replace(/;\s*$/, '').trim(); const where = 'statement ' + (i + 1) + ' (' + s.slice(0, 48).replace(/\s+/g, ' ') + '...)';
    if (/\$\$/.test(s)) problems.push(where + ': dollar-quoted blocks are not allowed');
    else if (s.includes(';')) problems.push(where + ': more than one statement joined on a line');
    else if (TABLE_STMT.test(s)) tables.push(TABLE_STMT.exec(s)[1].toLowerCase());
    else if (!INDEX_STMT.test(s)) problems.push(where + ': not additive. Only CREATE TABLE IF NOT EXISTS and CREATE [UNIQUE] INDEX IF NOT EXISTS are allowed');
  });
  return { statements, tables, problems };
}

// ---- the migration files ------------------------------------------------------------------------------------------------------------------------------------
// Returns { migrations: [{ id, sql, sha, tables, statements }], problems: [] }. Never throws for a bad file: the problems are listed so that nothing is applied.
function loadMigrations(opts) {
  const o = opts || {}, dir = o.dir || MIGRATIONS_DIR, baseFile = o.baseFile || SCHEMA_FILE, problems = [], migrations = [];
  let baseSql = '';
  try { baseSql = fs.readFileSync(baseFile, 'utf8'); } catch (e) { problems.push('cannot read the base schema file: ' + baseFile); }
  const baseSha = sha(baseSql);
  if (baseSql && baseSha !== (o.basePin || BASE_SHA256)) problems.push('the base schema file does not match its pinned fingerprint (file ' + short(baseSha) + ', pinned ' + short(o.basePin || BASE_SHA256) + '): it is frozen, and a change needs a new migration');
  const baseLint = lintStatements(baseSql); baseLint.problems.forEach((p) => problems.push(BASE_ID + ' ' + p));
  migrations.push({ id: BASE_ID, sql: baseSql, sha: baseSha, tables: baseLint.tables, statements: baseLint.statements.length });

  let names = [];
  if (fs.existsSync(dir)) names = fs.readdirSync(dir);
  const files = names.filter((n) => n !== MANIFEST_NAME).sort();
  files.forEach((n) => { if (!/^\d{3}-[a-z0-9-]+\.sql$/.test(n)) problems.push('unexpected file in the migrations folder: ' + n); });
  const good = files.filter((n) => /^\d{3}-[a-z0-9-]+\.sql$/.test(n));
  good.forEach((n, i) => { const want = String(i + 2).padStart(3, '0'); if (n.slice(0, 3) !== want) problems.push('numbering: expected ' + want + '-*.sql at position ' + (i + 1) + ' but found ' + n + ' (numbers start at 002, are consecutive and are never reused)'); });
  good.forEach((n) => {
    const id = n.replace(/\.sql$/, ''); const sql = fs.readFileSync(path.join(dir, n), 'utf8'); const l = lintStatements(sql);
    l.problems.forEach((p) => problems.push(id + ' ' + p));
    migrations.push({ id, sql, sha: sha(sql), tables: l.tables, statements: l.statements.length });
  });
  // the manifest lists exactly the numbered files, with the fingerprints they have now
  if (good.length) {
    const mf = path.join(dir, MANIFEST_NAME);
    if (!fs.existsSync(mf)) problems.push('db/migrations/' + MANIFEST_NAME + ' is missing: every migration file must be listed with its fingerprint');
    else {
      const listed = {};
      fs.readFileSync(mf, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).forEach((l) => {
        const m = /^([0-9a-f]{64})\s+(\d{3}-[a-z0-9-]+)$/.exec(l); if (!m) problems.push('manifest: unreadable line: ' + l.slice(0, 60)); else if (listed[m[2]]) problems.push('manifest: ' + m[2] + ' is listed twice'); else listed[m[2]] = m[1];
      });
      migrations.slice(1).forEach((m) => { if (!listed[m.id]) problems.push('manifest: ' + m.id + ' is not listed'); else if (listed[m.id] !== m.sha) problems.push('manifest: the fingerprint of ' + m.id + ' does not match the file (manifest ' + short(listed[m.id]) + ', file ' + short(m.sha) + ')'); });
      Object.keys(listed).forEach((id) => { if (!migrations.some((m) => m.id === id)) problems.push('manifest: lists ' + id + ' which has no file'); });
    }
  }
  ownershipProblems(migrations).forEach((p) => problems.push(p));
  return { migrations, problems };
}
// A migration may create only tables nobody else owns: not the bookkeeping table (the runner creates and owns it), and not a table that the base schema or an earlier migration already creates.
function ownershipProblems(migrations) {
  const out = [], seen = {};
  migrations.forEach((m, i) => (m.tables || []).forEach((t) => {
    if (i > 0 && t === BOOKKEEPING) out.push(m.id + ' creates ' + t + ', which belongs to the runner and is never created by a migration file');
    else if (seen[t]) out.push(m.id + ' creates ' + t + ', which ' + seen[t] + ' already creates');
    else seen[t] = m.id;
  }));
  return out;
}
const manifestText = (migrations) => migrations.slice(1).map((m) => m.sha + '  ' + m.id).join('\n') + (migrations.length > 1 ? '\n' : '');
const allowedTables = (migrations) => Array.from(new Set(OURS.concat([BOOKKEEPING], ...migrations.map((m) => m.tables))));

// ---- read-only guard ----------------------------------------------------------------------------------------------------------------------------------------
// Wraps a query function so that only plain reads get through. Used for every statement of --check and for every read of an apply.
function readOnly(q) {
  return async (text, params) => {
    const t = String(text).replace(/--[^\n]*/g, '').trim(), bare = t.replace(/'(?:[^']|'')*'/g, "''");
    const plainRead = /^(select|show)\b/i.test(t) || /^with\b/i.test(t);
    const writes = /\b(insert|update|delete|create|drop|alter|truncate|grant|revoke|copy|call|merge|vacuum|analyze|lock|listen|notify|reset|begin|commit|rollback)\b|\bset\s+(?:local\s+|session\s+)?[a-z_]+\s*(?:=|to)\b|\binto\b|\bfor\s+(?:no\s+key\s+)?(?:update|share)\b/i.test(bare);
    if (!plainRead || writes) throw new Error('read-only mode: refused to send a statement that is not a plain read: ' + t.slice(0, 70).replace(/\s+/g, ' '));
    return q(text, params);
  };
}

// ---- the structure that the applied migrations should have created ----------------------------------------------------------------------------------------
const sigCache = new Map();
async function expectedSignatureFor(migrations, count, withBookkeeping) {
  const key = migrations.slice(0, count).map((m) => m.sha).join('|') + '#' + (withBookkeeping ? 1 : 0);
  if (sigCache.has(key)) return sigCache.get(key);
  let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch (e) { throw new Error('cannot verify the structure: the package @electric-sql/pglite is not installed (run npm ci)'); }
  const pg = new PGlite();
  try {
    for (const m of migrations.slice(0, count)) await pg.exec(m.sql);
    if (withBookkeeping) await pg.exec(BOOKKEEPING_DDL);
    const text = await S.signatureOf(async (t) => (await pg.query(t)).rows);
    sigCache.set(key, text); return text;
  } finally { await pg.close(); }
}

async function existingTables(query) {
  return (await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).map((r) => r.table_name);
}
// A table is "foreign" unless the base schema, the bookkeeping or one of the migration files creates it (so the catalog tables of migration 002 are never foreign).
function foreignOf(tables) { const allowed = allowedTables(loadMigrations().migrations); return tables.filter((t) => !allowed.includes(t)); }

// Legacy read-only check of the table names alone (kept for the older tests and for quick use).
async function check(query) {
  const tables = await existingTables(query);
  return { existing: tables.filter((t) => OURS.includes(t)).sort(), missing: OURS.filter((t) => !tables.includes(t)), foreign: foreignOf(tables) };
}

// Legacy single-file apply (the base schema only). The versioned runner below is what the command line uses.
async function migrate(query, ddl) {
  const foreign = foreignOf(await existingTables(query));
  if (foreign.length) { const e = new Error('Refusing: database contains non-Kaspchem tables: ' + foreign.join(', ')); e.foreign = foreign; throw e; }
  const stmts = splitDdl(ddl);
  for (const s of stmts) await query(s);
  return stmts.length;
}

// ---- the plan: every decision, from reads only --------------------------------------------------------------------------------------------------------------
// `rq` is a READ-ONLY query function (text, params) => rows. opts: { migrations, expectEnv, allowEmpty, verifyStructure }.
async function plan(rq, opts) {
  const o = opts || {}, migrations = o.migrations, problems = [];
  const tables = await existingTables(rq);
  const allowed = allowedTables(migrations);
  const foreign = tables.filter((t) => !allowed.includes(t));
  if (foreign.length) problems.push('identity: the database contains tables that are not Kaspchem tables: ' + foreign.join(', '));
  migrations.forEach((m) => lintStatements(m.sql).problems.forEach((x) => problems.push('files: ' + m.id + ' ' + x)));   // the additive-only rule holds for whatever is handed in, not only for files read from disk
  ownershipProblems(migrations).forEach((x) => problems.push('files: ' + x));
  const dbName = (await rq('SELECT current_database() AS d'))[0].d;
  const hasBook = tables.includes(BOOKKEEPING);
  const recorded = hasBook ? await rq('SELECT id, checksum FROM schema_migrations ORDER BY id COLLATE "C"') : [];   // "C": byte order, so the order never depends on the database's locale
  const idRow = recorded.find((r) => r.id === IDENTITY_ID);
  const history = recorded.filter((r) => r.id !== IDENTITY_ID);
  let env = null;
  if (tables.includes('settings')) { const r = await rq("SELECT value FROM settings WHERE key = 'meta.environment'"); if (r.length) env = typeof r[0].value === 'string' ? r[0].value : String(JSON.stringify(r[0].value)); }
  const state = tables.length === 0 ? 'empty' : (!hasBook ? 'legacy' : (history.length === 0 ? 'initializing' : 'versioned'));

  // identity
  if (state === 'empty') {
    if (!o.allowEmpty) problems.push('identity: the database has no tables; pass --allow-empty-database to initialise a new database on purpose');
    if (!o.expectEnv) problems.push('identity: initialising needs --expect-env=<name>; it is recorded as meta.environment');
  } else {
    if (!o.expectEnv) problems.push('identity: state which database you mean with --expect-env=<value of meta.environment>' + (env ? ' (this one says "' + env + '")' : ''));
    if (state === 'initializing') {
      // a first run that stopped half-way: the identity recorded at its start must still match what is expected now
      if (!idRow) problems.push('identity: the bookkeeping table exists with no history and no identity record; it is not safe to guess which database this is');
      else if (o.expectEnv && idRow.checksum !== sha(dbName + '|' + o.expectEnv)) problems.push('identity: this database was being initialised for a different environment than "' + o.expectEnv + '"');
      if (env !== null && o.expectEnv && env !== o.expectEnv) problems.push('identity: meta.environment is "' + env + '" but --expect-env is "' + o.expectEnv + '"');
    } else {
      if (!tables.includes('settings')) problems.push('identity: Kaspchem tables exist but there is no settings table, so the database cannot be identified');
      else if (env === null) problems.push('identity: settings has no meta.environment row, so the database cannot be identified');
      else if (o.expectEnv && env !== o.expectEnv) problems.push('identity: WRONG DATABASE? meta.environment is "' + env + '" but --expect-env is "' + o.expectEnv + '"');
      if (state === 'versioned') {
        if (!idRow) problems.push('identity: the history exists but the identity record is missing');
        else if (env !== null && idRow.checksum !== sha(dbName + '|' + env)) problems.push('identity: the database name or environment changed since the first run (the recorded identity does not match)');
      }
    }
  }

  // history: what is recorded must be exactly the first N files, in order, with the fingerprints the files have now
  const ids = migrations.map((m) => m.id);
  history.forEach((r, i) => {
    if (r.id !== ids[i]) problems.push('history: position ' + (i + 1) + ' is "' + r.id + '" in the database but "' + (ids[i] || '(no such file)') + '" in the files');
    else if (r.checksum !== migrations[i].sha) problems.push('history: ' + r.id + ' was CHANGED after it was applied (recorded ' + short(r.checksum) + ', file now ' + short(migrations[i].sha) + ')');
  });
  const pending = (state === 'versioned' ? migrations.slice(history.length) : migrations).map((m) => m.id);

  // structure: what exists must equal what the applied migrations create (a legacy or half-started database is compared with the base)
  let structure = 'skipped';
  if (o.verifyStructure !== false && state !== 'empty' && !foreign.length) {
    try {
      const count = state === 'versioned' ? history.length : 1;
      const expected = await expectedSignatureFor(migrations, count, hasBook);
      const cmp = S.compare(await S.signatureOf(rq), expected);
      // a pending migration that stopped half-way leaves some of its own objects behind: that is expected, and it is not drift
      const next = state === 'versioned' && history.length < migrations.length ? S.lines(await expectedSignatureFor(migrations, history.length + 1, hasBook)) : null;
      const unexpected = cmp.unexpectedInDatabase.filter((l) => !(next && next.has(l)));
      // in a versioned database whatever the applied migrations created must still be there (a legacy or half-started one is allowed to lack things: the run creates them)
      const vanished = state === 'versioned' ? cmp.createdByMigration : [];
      if (cmp.needsManualLook.length || unexpected.length || vanished.length) {
        structure = 'differs';
        cmp.needsManualLook.slice(0, 3).forEach((l) => problems.push('structure: expected but different or missing in an existing table: ' + l.slice(0, 90)));
        vanished.slice(0, 3).forEach((l) => problems.push('structure: recorded as applied but missing now: ' + l.slice(0, 90)));
        unexpected.slice(0, 3).forEach((l) => problems.push('structure: found in the database but not in the migrations: ' + l.slice(0, 90)));
        const more = cmp.needsManualLook.length + vanished.length + unexpected.length - 9; if (more > 0) problems.push('structure: and ' + more + ' more differences');
      } else structure = 'matches';
    } catch (e) { problems.push('structure: ' + e.message); structure = 'unverified'; }
  }
  const existing = tables.filter((t) => OURS.includes(t)).sort();
  return { state, dbName, env, history: history.map((r) => r.id), pending, structure, problems, tables: { existing, missing: OURS.filter((t) => !tables.includes(t)), foreign } };
}

// ---- apply --------------------------------------------------------------------------------------------------------------------------------------------------
// q: the real query function (text, params) => rows. Returns { refused, ...plan } when the plan has problems (nothing was written), else { applied: [ids] }.
async function apply(q, opts) {
  const rq = readOnly(q);
  const p = await plan(rq, opts);
  if (p.problems.length) return Object.assign({ refused: true, applied: [] }, p);
  const env = p.state === 'empty' ? opts.expectEnv : (p.env !== null ? p.env : opts.expectEnv);
  const applied = [];
  await q(BOOKKEEPING_DDL);
  // the identity is recorded first, so that a run that stops half-way can be resumed and still be checked against the same database
  await q('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [IDENTITY_ID, sha(p.dbName + '|' + env)]);
  for (const m of opts.migrations) {
    if (!p.pending.includes(m.id)) continue;
    const stmts = splitDdl(m.sql);
    for (let i = 0; i < stmts.length; i++) {
      try { await q(stmts[i]); }
      catch (e) { const err = new Error(m.id + ' stopped at statement ' + (i + 1) + ' of ' + stmts.length + ': ' + e.message + '. Nothing is recorded for ' + m.id + '; running the command again is safe.'); err.applied = applied; throw err; }
    }
    if (m.id === BASE_ID && p.env === null) await q("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', to_jsonb($1::text), 'kaspchem-migrate') ON CONFLICT (key) DO NOTHING", [opts.expectEnv]);
    const ins = await q('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [m.id, m.sha]);
    if (!ins.length) { // another run recorded it first: fine only if it is the very same file
      const ex = await q('SELECT checksum FROM schema_migrations WHERE id = $1', [m.id]);
      if (!ex.length || ex[0].checksum !== m.sha) throw new Error(m.id + ' was recorded by another run with a different fingerprint; stopping');
    }
    applied.push(m.id);
  }
  const after = await plan(rq, opts);   // the database must now agree with the files, with nothing pending
  if (after.problems.length || after.pending.length) { const e = new Error('verification after applying failed: ' + after.problems.concat(after.pending.map((x) => 'still pending: ' + x)).join(' | ')); e.applied = applied; throw e; }
  return Object.assign({ refused: false, applied }, after);
}

// The text of a --check, as a list of lines, from a plan. Kept apart from the command line so that it can be tested.
function checkReport(p) {
  const out = [];
  out.push('Existing Kaspchem tables (' + p.tables.existing.length + '): ' + (p.tables.existing.join(', ') || '(none)'));
  out.push('Would be created (' + p.tables.missing.length + '): ' + (p.tables.missing.join(', ') || '(none)'));
  out.push('Foreign tables (' + p.tables.foreign.length + '): ' + (p.tables.foreign.join(', ') || '(none)'));
  out.push('Database state: ' + p.state + ' | environment: ' + (p.env === null ? '(none recorded)' : p.env) + ' | structure: ' + p.structure);
  out.push('Migrations recorded (' + p.history.length + '): ' + (p.history.join(', ') || '(none)') + ' | pending (' + p.pending.length + '): ' + (p.pending.join(', ') || '(none)'));
  p.problems.forEach((x) => out.push('PROBLEM ' + x));
  out.push(p.problems.length ? 'RESULT: nothing was written (read-only check); an apply would be REFUSED for the ' + p.problems.length + ' reason(s) above.' : 'RESULT: nothing was written (read-only check); an apply would be accepted.');
  return out;
}

module.exports = { OURS, BASE_ID, BASE_SHA256, BOOKKEEPING, IDENTITY_ID, sha, splitDdl, lintStatements, loadMigrations, manifestText, allowedTables, readOnly, plan, apply, checkReport, check, migrate };

// ---- command line -------------------------------------------------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { check: false, expectEnv: null, allowEmpty: false, printManifest: false, verifyFiles: false, dir: null, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--check') a.check = true;
    else if (x === '--allow-empty-database') a.allowEmpty = true;
    else if (x === '--print-manifest') a.printManifest = true;
    else if (x === '--verify-files') a.verifyFiles = true;
    else if (x.startsWith('--expect-env=')) a.expectEnv = x.slice('--expect-env='.length);
    else if (x === '--expect-env') a.expectEnv = argv[++i] || '';
    else if (x.startsWith('--migrations-dir=')) a.dir = x.slice('--migrations-dir='.length);
    else a.unknown.push(x);
  }
  return a;
}
function die(msg) { console.error(msg); process.exit(1); }

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length) die('Unknown option(s): ' + args.unknown.join(' ') + '\nSee the header of scripts/kaspchem-migrate.js for the options.');
    if (args.expectEnv !== null && !/^[a-z][a-z0-9_-]{0,30}$/.test(args.expectEnv)) die('--expect-env must be a short lower-case name such as production or test.');
    if (args.printManifest || args.verifyFiles) { // no database involved
      const { migrations, problems } = loadMigrations({ dir: args.dir || undefined });
      if (args.printManifest) { process.stdout.write(manifestText(migrations)); if (problems.length) console.error('Note: ' + problems.length + ' problem(s) in the files; run --verify-files'); return; }
      console.log('Migration files (' + migrations.length + '): ' + migrations.map((m) => m.id + ' ' + short(m.sha)).join(', '));
      problems.forEach((p) => console.log('PROBLEM ' + p));
      console.log(problems.length ? 'RESULT: the files are NOT acceptable; nothing would be applied.' : 'RESULT: the files, their numbering, the manifest and every statement are acceptable.');
      process.exit(problems.length ? 1 : 0);
    }
    const url = process.env.KASPCHEM_DATABASE_URL;
    if (!url) die('Set KASPCHEM_DATABASE_URL');
    // everything that can be refused without a database is refused BEFORE the network is touched
    if (!args.check && !args.expectEnv) die('Applying needs --expect-env=<value of meta.environment> (for example production or test), so that the wrong database cannot be reached by a wrong connection string. To only look, use --check.');
    if (!args.check && args.dir) die('--migrations-dir is only for --check, --verify-files and --print-manifest. Applying always uses db/migrations.');
    const { migrations, problems: fileProblems } = loadMigrations({ dir: args.dir || undefined });
    if (fileProblems.length) { fileProblems.forEach((p) => console.error('PROBLEM ' + p)); die('RESULT: the migration files are not acceptable; nothing was sent to the database.'); }
    const { neon } = require('@neondatabase/serverless');
    const sql = neon(url);
    const q = (t, p) => sql.query(t, p || []);
    const opts = { migrations, expectEnv: args.expectEnv, allowEmpty: args.allowEmpty };
    if (args.check) {
      const p = await plan(readOnly(q), opts);
      checkReport(p).forEach((l) => console.log(l));
      process.exit(p.problems.length ? 1 : 0);
    }
    const r = await apply(q, opts);
    if (r.refused) { r.problems.forEach((x) => console.error('PROBLEM ' + x)); die('RESULT: REFUSED; nothing was written.'); }
    console.log('Applied (' + r.applied.length + '): ' + (r.applied.join(', ') || '(nothing pending)') + '. Verified: identity, history, files and structure.');
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
