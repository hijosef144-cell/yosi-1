'use strict';
// The migration script, tested on an in-memory Postgres (PGlite): never against a real database.
// It must (1) accept every table the schema creates, `outcomes` included (it once refused its own table on the second run), (2) be additive and repeatable:
// the first and every later run leaves existing structure and rows exactly as they were, (3) refuse a database that has foreign tables, and (4) the structure
// comparison must tell apart what the migration creates from what it cannot repair.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PGlite } = require('@electric-sql/pglite');
const M = require('../scripts/kaspchem-migrate.js');
const S = require('../scripts/schema-signature.js');

const ROOT = path.join(__dirname, '..');
const DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const MARK = '-- Impact outcomes (stage 3)';
assert.ok(DDL.includes(MARK), 'the schema file no longer has the marker this test uses to build the older (production) shape');
const OLD_DDL = DDL.slice(0, DDL.indexOf(MARK)); // the schema as production has it today: 12 tables, no `outcomes`

const rows = (pg) => async (t) => (await pg.query(t)).rows;
const tablesOf = async (pg) => (await rows(pg)("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).map((r) => r.table_name);
const sigOf = (pg) => S.signatureOf(rows(pg));
async function fingerprint(pg, tables) {
  const out = {};
  for (const t of tables) { const r = (await pg.query(`SELECT count(*)::int AS c, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0]; out[t] = r.c + ':' + r.h; }
  return out;
}
async function seedOld(pg) {
  await pg.exec(`
    INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '"production"', 'setup'), ('public.counter_enabled', 'false', 'owner');
    INSERT INTO applicants (name, phone) VALUES ('Test One', '0501111111');
    INSERT INTO audit_log (actor, action) VALUES ('owner@example.test', 'login'), ('owner@example.test', 'settings.update');
    INSERT INTO questionnaire_versions (topic, version, status, content) VALUES ('lost-funds', 1, 'draft', '{"a":1}');
    INSERT INTO rate_limits (bucket, ip_hash) VALUES ('lead', 'abc');`);
}
const OLD_TABLES = ['applicants', 'questionnaire_versions', 'services', 'professionals', 'pricing', 'treatment_requests', 'consents', 'request_notes', 'revenues', 'settings', 'audit_log', 'rate_limits'];

test('the allowed-table list is exactly the set of tables the schema creates, outcomes included', () => {
  const created = [...DDL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]).sort();
  assert.equal(created.length, 13);
  assert.deepEqual([...M.OURS].sort(), created);
  assert.ok(M.OURS.includes('outcomes'));
});

test('a fresh database: the first run creates 13 tables; the second and third run succeed and change nothing (structure and rows)', async () => {
  const pg = new PGlite(); const q = rows(pg);
  const n1 = await M.migrate(q, DDL);
  assert.ok(n1 >= 18);
  assert.deepEqual(await tablesOf(pg), [...M.OURS].sort());
  await seedOld(pg);
  await pg.exec(`INSERT INTO outcomes (source, kind, amount, amount_basis, family_count, entered_by) VALUES ('baseline', 'one_time_refund', 1000, 'documented', 2, 'owner@example.test')`);
  const sig1 = await sigOf(pg), fp1 = await fingerprint(pg, M.OURS);
  await M.migrate(q, DDL);                       // second run: must not refuse its own tables
  await M.migrate(q, DDL);                       // and a third
  assert.equal(await sigOf(pg), sig1, 'structure changed on a later run');
  assert.deepEqual(await fingerprint(pg, M.OURS), fp1, 'rows changed on a later run');
  await pg.close();
});

test('a database as production has it today (12 tables, rows in place, no outcomes): the migration adds outcomes only; nothing existing changes; a second run changes nothing', async () => {
  const pg = new PGlite(); const q = rows(pg);
  await pg.exec(OLD_DDL); await seedOld(pg);
  assert.deepEqual(await tablesOf(pg), [...OLD_TABLES].sort());
  const sigOld = await sigOf(pg), fpOld = await fingerprint(pg, OLD_TABLES);
  const before = await M.check(q);
  assert.deepEqual(before.missing, ['outcomes']); assert.deepEqual(before.foreign, []);
  assert.equal(await sigOf(pg), sigOld, '--check changed something');

  await M.migrate(q, DDL);                       // first run
  const sigNew = await sigOf(pg);
  const was = S.lines(sigOld), now = S.lines(sigNew);
  assert.deepEqual([...was].filter((l) => !now.has(l)), [], 'a line of the existing structure disappeared or changed');
  const added = [...now].filter((l) => !was.has(l));
  assert.ok(added.length > 0 && added.every((l) => /^(col|con|idx) outcomes[ .]/.test(l)), 'something other than outcomes was added: ' + added.filter((l) => !/ outcomes[ .]/.test(l)).join(' | '));
  assert.deepEqual(await fingerprint(pg, OLD_TABLES), fpOld, 'existing rows changed');
  assert.deepEqual(await tablesOf(pg), [...M.OURS].sort());

  await M.migrate(q, DDL);                       // second run on the migrated database
  assert.equal(await sigOf(pg), sigNew, 'structure changed on the second run');
  assert.deepEqual(await fingerprint(pg, OLD_TABLES), fpOld, 'existing rows changed on the second run');
  await pg.close();
});

test('a database with a foreign table is refused, and nothing is created', async () => {
  const pg = new PGlite(); const q = rows(pg);
  await pg.exec('CREATE TABLE someone_elses_users (id int)');
  await assert.rejects(() => M.migrate(q, DDL), /non-Kaspchem tables: someone_elses_users/);
  assert.deepEqual(await tablesOf(pg), ['someone_elses_users']);
  const c = await M.check(q); assert.deepEqual(c.foreign, ['someone_elses_users']);
  await pg.close();
});

test('the structure comparison: the production shape needs only outcomes created; a changed type, a missing column and an extra column are reported', async () => {
  const expected = await S.expectedSignature();
  const pg = new PGlite(); await pg.exec(OLD_DDL);
  const same = S.compare(await sigOf(pg), expected);
  assert.deepEqual(same.needsManualLook, []); assert.deepEqual(same.unexpectedInDatabase, []);
  assert.ok(same.createdByMigration.length > 0 && same.createdByMigration.every((l) => / outcomes[ .]/.test(l)));

  await pg.exec('ALTER TABLE settings ALTER COLUMN updated_by TYPE varchar(50)');
  await pg.exec('ALTER TABLE applicants DROP COLUMN email');
  await pg.exec('ALTER TABLE services ADD COLUMN stray integer');
  const bad = S.compare(await sigOf(pg), expected);
  assert.ok(bad.needsManualLook.some((l) => l.startsWith('col settings.updated_by text')), 'type change not reported');
  assert.ok(bad.needsManualLook.some((l) => l.startsWith('col applicants.email')), 'missing column not reported');
  assert.ok(bad.unexpectedInDatabase.some((l) => l.startsWith('col services.stray')), 'extra column not reported');
  await pg.close();
});

test('the command line: it needs the connection variable and says so', () => {
  for (const args of [[], ['--check']]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kaspchem-migrate.js')].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { KASPCHEM_DATABASE_URL: '' }) });
    assert.equal(r.status, 1); assert.match(r.stderr, /Set KASPCHEM_DATABASE_URL/);
  }
});

// =====================================================================================================================================================
// The versioned runner (identity, history, file integrity, structure, additive-only, read-only check). PGlite and synthetic data only: no network, no Neon.
// =====================================================================================================================================================
const os = require('os');
const REAL = M.loadMigrations();
const O = (x) => Object.assign({ migrations: REAL.migrations, expectEnv: 'production' }, x);
const qp = (pg) => async (t, p) => (await pg.query(t, p || [])).rows;
const isRead = (t) => /^(select|show|with)\b/i.test(String(t).replace(/--[^\n]*/g, '').trim());
function recording(q) { const log = []; const f = async (t, p) => { log.push(String(t)); return q(t, p); }; f.log = log; return f; }
// everything a write could change: the list of tables, the structure and every row of every table
async function catalog(pg) {
  const t = await tablesOf(pg), fp = {};
  for (const x of t) { const r = (await pg.query(`SELECT count(*)::int AS c, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${x} x`)).rows[0]; fp[x] = r.c + ':' + r.h; }
  return JSON.stringify({ t, sig: t.length ? await sigOf(pg) : '', fp });
}
const DEMO_002 = '-- synthetic demo migration (test only)\nCREATE TABLE IF NOT EXISTS zz_demo (\n  id BIGSERIAL PRIMARY KEY,\n  name TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS zz_demo_name_idx ON zz_demo (name);\n';
const DEMO_003 = 'CREATE TABLE IF NOT EXISTS zz_demo_two (id BIGSERIAL PRIMARY KEY, demo_id BIGINT REFERENCES zz_demo(id));\n';
function makeDir(files, manifest) { // a throw-away migrations folder, with a correct manifest unless told otherwise
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-mig-'));
  Object.entries(files).forEach(([n, s]) => fs.writeFileSync(path.join(dir, n), s));
  const lm = M.loadMigrations({ dir });
  if (manifest !== false) fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), manifest || M.manifestText(lm.migrations));
  return dir;
}
const production = async () => { const pg = new PGlite(); await pg.exec(DDL); await seedOld(pg); return pg; };   // 13 tables, rows in place, no bookkeeping (as production is today)

test('the real files: the base schema matches its pinned fingerprint, every statement is additive, and the list of tables is the same list as the schema creates', () => {
  assert.deepEqual(REAL.problems, []);
  assert.deepEqual(REAL.migrations.map((m) => m.id), ['001-base']);
  assert.equal(REAL.migrations[0].sha, M.BASE_SHA256);
  assert.deepEqual([...REAL.migrations[0].tables].sort(), [...M.OURS].sort());
  assert.ok(M.allowedTables(REAL.migrations).includes('schema_migrations'));
});

test('the additive-only rule: CREATE ... IF NOT EXISTS is accepted, every other kind of statement is refused', () => {
  const ok = M.lintStatements('CREATE TABLE IF NOT EXISTS a (id int);\nCREATE UNIQUE INDEX IF NOT EXISTS a_i ON a (id);\n');
  assert.deepEqual(ok.problems, []); assert.deepEqual(ok.tables, ['a']);
  const bad = ['ALTER TABLE a ADD COLUMN b int', 'DROP TABLE a', 'DELETE FROM a', 'UPDATE a SET b = 1', 'TRUNCATE a', 'GRANT SELECT ON a TO x', 'INSERT INTO a VALUES (1)', 'CREATE TABLE a (id int)', 'CREATE INDEX a_i ON a (id)',
    'CREATE TABLE IF NOT EXISTS a AS SELECT 1', 'CREATE TABLE IF NOT EXISTS a (id int); DROP TABLE b', 'DO $$ BEGIN END $$', 'CREATE OR REPLACE VIEW v AS SELECT 1', 'CREATE EXTENSION IF NOT EXISTS x'];
  for (const s of bad) assert.ok(M.lintStatements(s + ';\n').problems.length > 0, 'should be refused: ' + s);
  assert.deepEqual(M.lintStatements('CREATE TABLE IF NOT EXISTS a (\n  id int, -- a comment; with a semicolon\n  n int\n);\n').problems, [], 'a semicolon inside a comment is not a second statement');
});

test('the files: numbering, manifest and fingerprints are all enforced, and the base schema is pinned', () => {
  const good = makeDir({ '002-demo.sql': DEMO_002, '003-demo-two.sql': DEMO_003 });
  const lm = M.loadMigrations({ dir: good });
  assert.deepEqual(lm.problems, []); assert.deepEqual(lm.migrations.map((m) => m.id), ['001-base', '002-demo', '003-demo-two']);
  const has = (r, re) => r.problems.some((p) => re.test(p));
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '003-x.sql': DEMO_002 }) }), /numbering/), 'a gap');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-a.sql': DEMO_002, '002-b.sql': DEMO_003 }) }), /numbering/), 'a repeated number');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-Demo.sql': DEMO_002 }) }), /unexpected file/), 'a badly named file');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002 }, false) }), /MANIFEST.sha256 is missing/), 'no manifest');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002, '003-demo-two.sql': DEMO_003 }, M.manifestText(lm.migrations).replace(/^[0-9a-f]{8}/, '00000000')) }), /does not match the file/), 'a wrong fingerprint');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002 }, M.manifestText(lm.migrations)) }), /lists 003-demo-two which has no file/), 'an entry with no file');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002, '003-demo-two.sql': DEMO_003 }, M.manifestText(lm.migrations).split('\n')[0] + '\n') }), /003-demo-two is not listed/), 'a file with no entry');
  const edited = makeDir({ '002-demo.sql': DEMO_002 }); fs.writeFileSync(path.join(edited, '002-demo.sql'), DEMO_002 + '-- edited after the manifest\n');
  assert.ok(has(M.loadMigrations({ dir: edited }), /does not match the file/), 'a file edited after the manifest was made');
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-bad.sql': 'ALTER TABLE settings ADD COLUMN x int;\n' }) }), /not additive/), 'a statement that is not additive');
  const tmpBase = path.join(os.tmpdir(), 'kc-base-' + Date.now() + '.sql'); fs.writeFileSync(tmpBase, DDL + '\n-- changed\n');
  assert.ok(has(M.loadMigrations({ baseFile: tmpBase }), /pinned fingerprint/), 'the base schema changed');
  const lf = DDL.replace(/\r\n/g, '\n');   // this checkout may already hold CRLF (Windows); start from the LF form so that the CRLF form below is exactly one \r per line
  assert.equal(M.sha(lf), M.sha(lf.replace(/\n/g, '\r\n')), 'the fingerprint must not depend on the line endings of the checkout');
  assert.equal(M.sha(DDL), M.BASE_SHA256, 'the checkout, whichever its line endings, must produce the pinned fingerprint');
});

test('the read-only guard lets plain reads through and refuses every kind of write', async () => {
  const pg = new PGlite(); await pg.exec(DDL); const rq = M.readOnly(qp(pg));
  for (const t of ['SELECT 1', 'select count(*) from settings', 'SHOW server_version', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x', "SELECT 'insert into x' AS s"]) await rq(t);
  const writes = ["INSERT INTO settings (key, value) VALUES ('a', '1')", "UPDATE settings SET value = '1'", 'DELETE FROM settings', 'DROP TABLE settings', 'CREATE TABLE t (a int)', 'ALTER TABLE settings ADD COLUMN z int', 'TRUNCATE settings',
    'GRANT SELECT ON settings TO PUBLIC', 'WITH x AS (DELETE FROM settings RETURNING 1) SELECT * FROM x', 'SELECT * INTO newt FROM settings', 'SELECT * FROM settings FOR UPDATE', 'BEGIN', 'COMMIT', 'SET search_path = public', 'COPY settings TO STDOUT', '/* */ DROP TABLE settings', 'VACUUM settings'];
  for (const t of writes) await assert.rejects(() => rq(t), /read-only mode/, t);
  assert.deepEqual(await tablesOf(pg), [...M.OURS].sort());
  await pg.close();
});

test('--check never writes, in any state: empty, legacy, half-initialised, versioned, drifted, foreign (a recording connection sees reads only)', async () => {
  const halfInit = async () => {
    const pg = new PGlite(); const q = qp(pg);
    const flaky = async (t, p) => { if (/CREATE TABLE IF NOT EXISTS consents/.test(t)) throw new Error('simulated outage'); return q(t, p); };
    await assert.rejects(() => M.apply(flaky, { migrations: REAL.migrations, expectEnv: 'test', allowEmpty: true }), /001-base stopped at statement/);
    return pg;
  };
  const versioned = async () => { const pg = await production(); await M.apply(qp(pg), O()); return pg; };
  const states = {
    empty: async () => new PGlite(),
    legacy: production,
    halfInitialised: halfInit,
    versioned,
    drifted: async () => { const pg = await versioned(); await pg.exec('ALTER TABLE services ADD COLUMN stray integer'); return pg; },
    foreign: async () => { const pg = new PGlite(); await pg.exec('CREATE TABLE someone_elses_users (id int)'); return pg; },
  };
  for (const [name, build] of Object.entries(states)) {
    const pg = await build(); const log = recording(qp(pg)); const before = await catalog(pg);
    await M.plan(M.readOnly(log), O({ allowEmpty: true, expectEnv: name === 'empty' || name === 'halfInitialised' ? 'test' : 'production' }));
    assert.equal(await catalog(pg), before, name + ': the check changed something');
    assert.ok(log.log.length > 0 && log.log.every(isRead), name + ': a statement that is not a plain read was sent: ' + log.log.filter((t) => !isRead(t)).join(' | '));
    await pg.close();
  }
});

test('--check on an empty database: no table, not even the bookkeeping table; it says what an apply would need, and accepts once it is told', async () => {
  const pg = new PGlite(); const rq = M.readOnly(qp(pg));
  const refused = await M.plan(rq, O({ expectEnv: 'test' }));
  assert.equal(refused.state, 'empty'); assert.ok(refused.problems.some((x) => /--allow-empty-database/.test(x)));
  assert.ok((await M.plan(rq, O({ allowEmpty: true, expectEnv: null }))).problems.some((x) => /--expect-env/.test(x)));
  const ok = await M.plan(rq, O({ allowEmpty: true, expectEnv: 'test' }));
  assert.deepEqual(ok.problems, []); assert.deepEqual(ok.pending, ['001-base']);
  assert.deepEqual(await tablesOf(pg), []);
  await pg.close();
});

test('the text of --check: it says what exists, what is pending, every reason for a refusal, and always that nothing was written', async () => {
  const pg = await production(); const rq = M.readOnly(qp(pg));
  const ok = M.checkReport(await M.plan(rq, O())).join('\n');
  assert.match(ok, /Existing Kaspchem tables \(13\):/); assert.match(ok, /Would be created \(0\): \(none\)/); assert.match(ok, /Foreign tables \(0\): \(none\)/);
  assert.match(ok, /Database state: legacy \| environment: production \| structure: matches/); assert.match(ok, /Migrations recorded \(0\): \(none\) \| pending \(1\): 001-base/);
  assert.match(ok, /RESULT: nothing was written \(read-only check\); an apply would be accepted\./);
  const no = M.checkReport(await M.plan(rq, O({ expectEnv: 'test' }))).join('\n');
  assert.match(no, /PROBLEM identity: WRONG DATABASE\?/); assert.match(no, /RESULT: nothing was written \(read-only check\); an apply would be REFUSED for the 1 reason\(s\) above\./);
  await pg.close();
  const empty = new PGlite(); const e = M.checkReport(await M.plan(M.readOnly(qp(empty)), O({ expectEnv: 'test' }))).join('\n');
  assert.match(e, /Database state: empty \| environment: \(none recorded\)/); assert.match(e, /REFUSED/); assert.match(e, /nothing was written/);
  await empty.close();
});

test('a database as production has it: the check accepts it as "legacy", lists the base as pending, verifies the structure, and writes nothing; apply records the base and the identity and changes no existing structure or row', async () => {
  const pg = await production(); const q = qp(pg);
  const sig0 = await sigOf(pg), fp0 = await fingerprint(pg, M.OURS), before = await catalog(pg);
  const p = await M.plan(M.readOnly(q), O());
  assert.equal(p.state, 'legacy'); assert.deepEqual(p.problems, []); assert.equal(p.structure, 'matches'); assert.deepEqual(p.pending, ['001-base']); assert.equal(p.env, 'production');
  assert.equal(await catalog(pg), before);
  const r = await M.apply(q, O());
  assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base']);
  const hist = (await pg.query('SELECT id, checksum FROM schema_migrations ORDER BY id COLLATE "C"')).rows;
  assert.deepEqual(hist.map((h) => h.id), ['001-base', '@identity']); assert.equal(hist[0].checksum, M.BASE_SHA256);
  assert.deepEqual(await fingerprint(pg, M.OURS), fp0, 'existing rows changed');
  const was = S.lines(sig0), added = [...S.lines(await sigOf(pg))].filter((l) => !was.has(l));
  assert.ok(added.length > 0 && added.every((l) => / schema_migrations[ .]/.test(l)), 'something besides the bookkeeping table was added: ' + added.join(' | '));
  const again = await M.apply(q, O());
  assert.equal(again.refused, false); assert.deepEqual(again.applied, []); assert.deepEqual(again.pending, []);
  await pg.close();
});

test('structure: a database that differs from the base is refused and NOTHING is written, not even the bookkeeping table', async () => {
  for (const change of ['ALTER TABLE services ADD COLUMN stray integer', 'ALTER TABLE applicants DROP COLUMN email', 'ALTER TABLE settings ALTER COLUMN updated_by TYPE varchar(50)']) {
    const pg = await production(); await pg.exec(change); const before = await catalog(pg);
    const r = await M.apply(qp(pg), O());
    assert.equal(r.refused, true, change); assert.ok(r.problems.some((x) => /^structure:/.test(x)), change);
    assert.equal(await catalog(pg), before, change + ': something was written');
    await pg.close();
  }
});

test('identity: wrong environment, no --expect-env, no meta.environment, no settings table, another project\'s tables, a changed identity: all refused, nothing written', async () => {
  let pg = await production(); const before = await catalog(pg);
  let r = await M.apply(qp(pg), O({ expectEnv: 'test' })); assert.ok(r.refused && r.problems.some((x) => /WRONG DATABASE/.test(x)));
  r = await M.apply(qp(pg), O({ expectEnv: null })); assert.ok(r.refused && r.problems.some((x) => /--expect-env/.test(x)));
  assert.equal(await catalog(pg), before);
  await pg.exec("DELETE FROM settings WHERE key = 'meta.environment'"); r = await M.apply(qp(pg), O()); assert.ok(r.refused && r.problems.some((x) => /no meta.environment/.test(x)));
  await pg.close();

  pg = new PGlite(); await pg.exec('CREATE TABLE applicants (id int)'); r = await M.apply(qp(pg), O()); assert.ok(r.refused && r.problems.some((x) => /no settings table/.test(x)));
  await pg.close();

  pg = new PGlite(); await pg.exec('CREATE TABLE someone_elses_users (id int)'); r = await M.apply(qp(pg), O()); assert.ok(r.refused && r.problems.some((x) => /not Kaspchem tables: someone_elses_users/.test(x)));
  assert.deepEqual(await tablesOf(pg), ['someone_elses_users']);
  await pg.close();

  pg = await production(); await M.apply(qp(pg), O());                                  // identity recorded on the first run
  await pg.exec('UPDATE settings SET value = \'"test"\' WHERE key = \'meta.environment\'');   // then the label changes (a restore into another environment, a mix-up)
  r = await M.apply(qp(pg), O({ expectEnv: 'test' })); assert.ok(r.refused && r.problems.some((x) => /recorded identity does not match/.test(x)));
  r = await M.apply(qp(pg), O()); assert.ok(r.refused);
  await pg.close();
});

test('a new, empty database: initialised only on purpose; base and later migrations are applied and recorded; meta.environment and the identity are written once; a second run does nothing', async () => {
  const lm = M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002, '003-demo-two.sql': DEMO_003 }) }); assert.deepEqual(lm.problems, []);
  const pg = new PGlite(); const q = qp(pg); const O2 = (x) => Object.assign({ migrations: lm.migrations, expectEnv: 'test' }, x);
  let r = await M.apply(q, O2()); assert.ok(r.refused && r.problems.some((x) => /--allow-empty-database/.test(x))); assert.deepEqual(await tablesOf(pg), []);
  r = await M.apply(q, O2({ allowEmpty: true })); assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base', '002-demo', '003-demo-two']);
  const tbls = await tablesOf(pg); [...M.OURS, 'schema_migrations', 'zz_demo', 'zz_demo_two'].forEach((t) => assert.ok(tbls.includes(t), 'missing ' + t));
  assert.equal((await pg.query("SELECT value FROM settings WHERE key = 'meta.environment'")).rows[0].value, 'test');
  assert.deepEqual((await pg.query('SELECT id FROM schema_migrations ORDER BY id COLLATE "C"')).rows.map((h) => h.id), ['001-base', '002-demo', '003-demo-two', '@identity']);
  const sig = await sigOf(pg), before = await catalog(pg);
  r = await M.apply(q, O2()); assert.deepEqual(r.applied, []); assert.equal(await sigOf(pg), sig); assert.equal(await catalog(pg), before);
  // the tables of the later migrations are not "foreign" for a runner that knows the files, and are foreign for one that does not
  const old = await M.plan(M.readOnly(q), { migrations: REAL.migrations, expectEnv: 'test' });
  assert.ok(old.problems.some((x) => /zz_demo/.test(x)));
  await pg.close();
});

test('history: a changed, missing or unknown migration is refused before anything is written', async () => {
  const lm = M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002 }) });
  const pg = new PGlite(); const q = qp(pg); const O2 = (x, m) => Object.assign({ migrations: (m || lm).migrations, expectEnv: 'test', allowEmpty: true }, x);
  await M.apply(q, O2()); const before = await catalog(pg);
  const edited = M.loadMigrations({ dir: makeDir({ '002-demo.sql': DEMO_002 + '\nCREATE TABLE IF NOT EXISTS zz_other (id int);\n' }) });   // edited after it was applied (its manifest is regenerated: only the database remembers)
  let r = await M.apply(q, O2({}, edited)); assert.ok(r.refused && r.problems.some((x) => /was CHANGED after it was applied/.test(x))); assert.equal(await catalog(pg), before);
  r = await M.apply(q, O2({}, M.loadMigrations({ dir: makeDir({}) }))); assert.ok(r.refused && r.problems.some((x) => /history:/.test(x)));           // the file disappeared: the database is ahead of the files
  await pg.query("INSERT INTO schema_migrations (id, checksum) VALUES ('002b-unknown', 'x')");
  r = await M.apply(q, O2()); assert.ok(r.refused && r.problems.some((x) => /history:/.test(x)));                                                        // an id that no file has
  await pg.query("DELETE FROM schema_migrations WHERE id = '002b-unknown'");
  await pg.query("DELETE FROM schema_migrations WHERE id = '002-demo'");                                                                                   // every statement had run but the record was lost: that is the one gap that is safe to finish
  const resumed = await M.apply(q, O2()); assert.equal(resumed.refused, false); assert.deepEqual(resumed.applied, ['002-demo']);
  await pg.close();
});

test('structure drift: whatever is changed outside the migrations (a column, an index, a table) is noticed on the next run', async () => {
  for (const change of ['ALTER TABLE services ADD COLUMN stray integer', 'DROP INDEX tr_status_idx', 'DROP TABLE request_notes', 'ALTER TABLE settings ALTER COLUMN updated_by TYPE varchar(50)']) {
    const pg = await production(); await M.apply(qp(pg), O()); await pg.exec(change);
    const p = await M.plan(M.readOnly(qp(pg)), O());
    assert.equal(p.structure, 'differs', change); assert.ok(p.problems.some((x) => /^structure:/.test(x)), change);
    await pg.close();
  }
});

test('a failure in the middle of a migration records nothing for it; its half-made objects are not drift; the next run completes it. A migration that cannot work at all is stopped before anything is written', async () => {
  const GOOD = 'CREATE TABLE IF NOT EXISTS zz_a (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS zz_b (id BIGSERIAL PRIMARY KEY, a_id BIGINT REFERENCES zz_a(id));\n';
  const BROKEN = 'CREATE TABLE IF NOT EXISTS zz_a (id BIGSERIAL PRIMARY KEY);\nCREATE TABLE IF NOT EXISTS zz_b (id BIGSERIAL PRIMARY KEY, a_id BIGINT REFERENCES zz_missing(id));\n';
  const pg = new PGlite(); const q = qp(pg); const base = { expectEnv: 'test', allowEmpty: true };
  await M.apply(q, Object.assign({ migrations: REAL.migrations }, base));
  const good = M.loadMigrations({ dir: makeDir({ '002-pair.sql': GOOD }) }), broken = M.loadMigrations({ dir: makeDir({ '002-pair.sql': BROKEN }) });
  const before = await catalog(pg);
  const stopped = await M.apply(q, Object.assign({ migrations: broken.migrations }, base));       // fails in the rehearsal on an in-memory copy, before the real database is touched
  assert.ok(stopped.refused && stopped.problems.some((x) => /^structure:/.test(x))); assert.equal(await catalog(pg), before);
  let down = true; const flaky = async (t, p) => { if (down && /CREATE TABLE IF NOT EXISTS zz_b/.test(t)) throw new Error('simulated connection loss'); return q(t, p); };
  await assert.rejects(() => M.apply(flaky, Object.assign({ migrations: good.migrations }, base)), /002-pair stopped at statement 2 of 2/);
  assert.deepEqual((await pg.query("SELECT id FROM schema_migrations WHERE id <> '@identity' ORDER BY id COLLATE \"C\"")).rows.map((r) => r.id), ['001-base']);   // nothing recorded for 002
  assert.ok((await tablesOf(pg)).includes('zz_a') && !(await tablesOf(pg)).includes('zz_b'));
  down = false;
  const c = await M.plan(M.readOnly(q), Object.assign({ migrations: good.migrations }, base));
  assert.deepEqual(c.problems, [], 'the half-made objects of the pending migration were reported as drift'); assert.deepEqual(c.pending, ['002-pair']);
  const r = await M.apply(q, Object.assign({ migrations: good.migrations }, base)); assert.deepEqual(r.applied, ['002-pair']);
  await pg.close();
});

test('a first initialisation that stopped half-way can be resumed, only for the same environment, and ends with meta.environment and the identity in place', async () => {
  const pg = new PGlite(); const q = qp(pg); let down = true;
  const flaky = async (t, p) => { if (down && /CREATE TABLE IF NOT EXISTS consents/.test(t)) throw new Error('simulated outage'); return q(t, p); };
  const opts = { migrations: REAL.migrations, expectEnv: 'test', allowEmpty: true };
  await assert.rejects(() => M.apply(flaky, opts), /001-base stopped at statement/);
  const s = await M.plan(M.readOnly(q), opts); assert.equal(s.state, 'initializing'); assert.deepEqual(s.problems, []);
  const w = await M.plan(M.readOnly(q), Object.assign({}, opts, { expectEnv: 'production' })); assert.ok(w.problems.some((x) => /different environment/.test(x)), 'a different environment must not resume it');
  down = false;
  const r = await M.apply(q, opts); assert.deepEqual(r.applied, ['001-base']);
  assert.equal((await pg.query("SELECT value FROM settings WHERE key = 'meta.environment'")).rows[0].value, 'test');
  assert.deepEqual((await M.apply(q, opts)).applied, []);
  await pg.close();
});

test('another run recorded the same migration first: accepted when the fingerprint is the same, stopped when it is not', async () => {
  for (const [other, ok] of [[M.BASE_SHA256, true], ['deadbeef'.repeat(8), false]]) {
    const pg = await production(); const q = qp(pg);
    const racing = async (t, p) => { if (/^INSERT INTO schema_migrations/.test(t) && p && p[0] === '001-base') await pg.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p[0], other]); return q(t, p); };
    if (ok) assert.deepEqual((await M.apply(racing, O())).applied, ['001-base']);
    else await assert.rejects(() => M.apply(racing, O()), /different fingerprint/);
    await pg.close();
  }
});

test('the additive-only rule also holds inside apply for migrations handed in directly: refused, nothing written', async () => {
  const pg = await production(); const before = await catalog(pg);
  const evil = [REAL.migrations[0], { id: '002-evil', sql: 'ALTER TABLE settings ADD COLUMN x int;\n', sha: M.sha('x'), tables: [], statements: 1 }];
  const r = await M.apply(qp(pg), { migrations: evil, expectEnv: 'production' });
  assert.ok(r.refused && r.problems.some((x) => /files: 002-evil .*not additive/.test(x)));
  assert.equal(await catalog(pg), before);
  await pg.close();
});

test('the command line refuses, before any database is touched: unknown options, applying without --expect-env, a bad name, a folder override when applying; the file commands work offline', () => {
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kaspchem-migrate.js')].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { KASPCHEM_DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' }) });
  let r = run(['--nonsense']); assert.equal(r.status, 1); assert.match(r.stderr, /Unknown option/);
  const NET = /ECONNREFUSED|ENOTFOUND|getaddrinfo|fetch failed|ETIMEDOUT/i;   // what a real attempt to reach the (unreachable) database would print
  r = run([]); assert.equal(r.status, 1); assert.match(r.stderr, /--expect-env/); assert.doesNotMatch(r.stderr, NET);    // refused before the database is contacted
  r = run(['--expect-env=BAD NAME']); assert.equal(r.status, 1); assert.match(r.stderr, /short lower-case name/);
  r = run(['--expect-env=test', '--migrations-dir=' + os.tmpdir()]); assert.equal(r.status, 1); assert.match(r.stderr, /only for --check/);
  r = run(['--verify-files']); assert.equal(r.status, 0); assert.match(r.stdout, /001-base/); assert.match(r.stdout, /acceptable/);
  r = run(['--print-manifest', '--migrations-dir=' + makeDir({ '002-demo.sql': DEMO_002 })]); assert.equal(r.status, 0); assert.match(r.stdout, /^[0-9a-f]{64} {2}002-demo$/m);
  r = run(['--verify-files', '--migrations-dir=' + makeDir({ '003-x.sql': DEMO_002 })]); assert.equal(r.status, 1); assert.match(r.stdout, /numbering/);
  r = run(['--check', '--migrations-dir=' + makeDir({ '003-x.sql': DEMO_002 })]); assert.equal(r.status, 1); assert.match(r.stderr, /not acceptable/); assert.doesNotMatch(r.stderr, NET);
});
