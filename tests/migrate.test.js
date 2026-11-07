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
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
// Every in-memory database made by this file (also the clones) is closed when the file ends, even when a failing assertion skipped its own close():
// an open database keeps the test process alive, and a FAILING test would then hang instead of ending with its failure.
const OPEN_DBS = new Set();
const track = (db) => { OPEN_DBS.add(db); const close = db.close.bind(db); db.close = async () => { OPEN_DBS.delete(db); return close(); }; const clone = db.clone.bind(db); db.clone = async () => track(await clone()); return db; };   // wraps clone() too, so a clone of a clone is tracked as well
class PGlite extends PGliteBase {
  constructor(...args) { super(...args); track(this); }
  // (clone() is wrapped by track() itself, for every instance)
}
test.after(async () => { for (const db of [...OPEN_DBS]) { try { await db.close(); } catch (e) { /* already closed */ } } });
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
const BASE = [REAL.migrations[0]];   // the base schema alone: the runner's mechanics are tested on this, whatever real migrations exist
const O = (x) => Object.assign({ migrations: BASE, expectEnv: 'production' }, x);
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
    await assert.rejects(() => M.apply(flaky, { migrations: BASE, expectEnv: 'test', allowEmpty: true }), /001-base stopped at statement/);
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
  assert.match(ok, /Existing Kaspchem tables \(13\):/); assert.match(ok, /Base tables not present \(0\): \(none\)/); assert.match(ok, /Base schema 001-base: .*RECORDED; none of its 18 statements would be sent/); assert.match(ok, /Foreign tables \(0\): \(none\)/);
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
  const old = await M.plan(M.readOnly(q), { migrations: BASE, expectEnv: 'test' });
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
  await M.apply(q, Object.assign({ migrations: BASE }, base));
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
  const opts = { migrations: BASE, expectEnv: 'test', allowEmpty: true };
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
  const evil = [BASE[0], { id: '002-evil', sql: 'ALTER TABLE settings ADD COLUMN x int;\n', sha: M.sha('x'), tables: [], statements: 1 }];
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
  r = run(['--verify-files']); assert.equal(r.status, 0); assert.match(r.stdout, /001-base/); assert.match(r.stdout, /002-provider-catalog/); assert.match(r.stdout, /acceptable/);
  r = run(['--print-manifest', '--migrations-dir=' + makeDir({ '002-demo.sql': DEMO_002 })]); assert.equal(r.status, 0); assert.match(r.stdout, /^[0-9a-f]{64} {2}002-demo$/m);
  r = run(['--verify-files', '--migrations-dir=' + makeDir({ '003-x.sql': DEMO_002 })]); assert.equal(r.status, 1); assert.match(r.stdout, /numbering/);
  r = run(['--check', '--migrations-dir=' + makeDir({ '003-x.sql': DEMO_002 })]); assert.equal(r.status, 1); assert.match(r.stderr, /not acceptable/); assert.doesNotMatch(r.stderr, NET);
});

// =====================================================================================================================================================
// Migration 002 (M1: service catalog, providers, engagements): the REAL files, applied to in-memory databases with synthetic data only. No network, no Neon.
// =====================================================================================================================================================
const M2 = REAL.migrations[1];
const NEW_TABLES = ['catalog_imports', 'provider_profiles', 'provider_service_compensation', 'provider_service_prices', 'provider_services', 'service_settings'];
const NEW_RELATIONS = NEW_TABLES.concat(['schema_migrations', 'catalog_imports_id_seq']);   // everything 002 and the runner add; the rest must be exactly as before
const MANIFEST_FILE = path.join(ROOT, 'db', 'migrations', 'MANIFEST.sha256');
const FILE_002 = path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql');
const R = (x) => Object.assign({ migrations: REAL.migrations, expectEnv: 'production' }, x);
const tableOfLine = (l) => (/^(col|con|idx) ([a-z_]+)[ .]/.exec(l) || [])[2];
const migrated = async () => { const pg = await production(); const r = await M.apply(qp(pg), R()); assert.equal(r.refused, false, (r.problems || []).join('; ')); return pg; };
// built once and cloned per test: a clone is much cheaper than running the migrations again
let FULL = null, AFTER_BASE = null;
const fullClone = async () => { if (!FULL) FULL = await migrated(); return FULL.clone(); };
const afterBaseClone = async () => { if (!AFTER_BASE) { AFTER_BASE = await production(); await M.apply(qp(AFTER_BASE), R({ migrations: [REAL.migrations[0]] })); } return AFTER_BASE.clone(); };
const quoted = NEW_RELATIONS.map((x) => "'" + x + "'").join(',');
// owner, permissions and row-security flag of every table and sequence that existed before 002
const aclsOf = async (pg) => JSON.stringify((await pg.query(`SELECT c.relname, c.relkind, c.relowner::regrole::text AS owner, c.relacl::text AS acl, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND c.relname NOT IN (${quoted}) ORDER BY 1`)).rows);
const countOf = async (pg, sql) => (await pg.query(sql)).rows[0].n;
async function seedCatalog(pg) {   // synthetic rows in every new table (ids start at 1 on a database as production has it: none of these tables has rows there)
  await pg.exec(`
    INSERT INTO professionals (name, contact) VALUES ('Synthetic Provider A', 'a@example.test'), ('Synthetic Provider B', NULL);
    INSERT INTO services (topic, name) VALUES ('synthetic', 'Synthetic Service One'), ('synthetic', 'Synthetic Service Two');
    INSERT INTO pricing (service_id, professional_id, label, price, approved, approved_by, approved_at, public) VALUES (1, 1, 'synthetic fixed price', 100, TRUE, 'owner@example.test', now(), FALSE);
    INSERT INTO provider_profiles (professional_id, business_name, contact_email) VALUES (1, 'Synthetic Office', 'office@example.test');
    INSERT INTO provider_services (professional_id, service_id, external_ref) VALUES (1, 1, 'A-1'), (1, 2, 'A-2'), (2, 1, 'B-1');
    INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, recorded_by) VALUES (1, 1, 'market', 'fixed', 500, 'owner@example.test');
    INSERT INTO provider_service_prices (professional_id, service_id, kind, model, percent_low, percent_high, status, recorded_by) VALUES (1, 1, 'provider_offer', 'percent_of_result', 5, 10, 'awaiting_response', 'owner@example.test');
    INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, recorded_by) VALUES (1, 1, 'percent', 8, 'owner@example.test');
    INSERT INTO service_settings (service_id, code) VALUES (1, 'synthetic-one');
    INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES ('csv', repeat('0', 64), 3, 3, 0, 0, 'owner@example.test');`);
}

test('migration 002 as a file: acceptable, exactly the six M1 tables, never the bookkeeping table, no base table; the allowed-table list and the committed manifest follow the files', () => {
  assert.deepEqual(REAL.problems, []); assert.deepEqual(REAL.migrations.map((m) => m.id), ['001-base', '002-provider-catalog']);
  const sql = fs.readFileSync(FILE_002, 'utf8');   // whatever the line endings of this checkout
  const code = sql.replace(/--[^\n]*/g, '');
  assert.deepEqual([...sql.matchAll(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/gm)].map((m) => m[1]).sort(), NEW_TABLES, 'the file must create exactly these six tables');
  assert.deepEqual([...M2.tables].sort(), NEW_TABLES, 'the runner reads the same six tables');
  assert.ok(!/schema_migrations/.test(code), 'the bookkeeping table belongs to the runner, not to this file');
  NEW_TABLES.forEach((t) => assert.ok(!M.OURS.includes(t) && t !== M.BOOKKEEPING, t + ' must not be a base table or the bookkeeping table'));
  assert.ok(!/[^\x00-\x7f]/.test(sql), 'ASCII only (no hidden or look-alike characters)');
  assert.deepEqual(M.lintStatements(M2.sql).problems, []);
  assert.equal(M.OURS.length, 13); assert.deepEqual([...M.OURS].sort(), [...DDL.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]).sort(), 'OURS is still exactly the 13 base tables');
  assert.deepEqual(M.allowedTables(REAL.migrations).sort(), [...M.OURS, M.BOOKKEEPING, ...NEW_TABLES].sort());
  assert.equal(fs.readFileSync(MANIFEST_FILE, 'utf8').replace(/\r\n/g, '\n'), M.manifestText(REAL.migrations), 'MANIFEST.sha256 is not what the runner prints for these files');
  assert.equal(M.sha(sql), M2.sha);
});

test('the ownership rule: a migration file can never create the bookkeeping table, a base table, or a table an earlier migration already creates', () => {
  const has = (r, re) => r.problems.some((p) => re.test(p));
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-x.sql': 'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY);\n' }) }), /002-x creates schema_migrations, which belongs to the runner/));
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-x.sql': 'CREATE TABLE IF NOT EXISTS settings (id int);\n' }) }), /002-x creates settings, which 001-base already creates/));
  assert.ok(has(M.loadMigrations({ dir: makeDir({ '002-x.sql': DEMO_002, '003-y.sql': DEMO_002 }) }), /003-y creates zz_demo, which 002-x already creates/));
  assert.deepEqual(M.loadMigrations({ dir: makeDir({ '002-x.sql': DEMO_002, '003-y.sql': DEMO_003 }) }).problems, []);
});

test('migration 002 on a database as production has it: the 13 base tables keep their exact structure, rows and permissions; six tables and the bookkeeping table appear, nothing else; a second run does nothing', async () => {
  const pg = await production(); const q = qp(pg);
  const sig0 = await sigOf(pg), fp0 = await fingerprint(pg, M.OURS), acl0 = await aclsOf(pg), tables0 = await tablesOf(pg);
  const p = await M.plan(M.readOnly(q), R());
  assert.equal(p.state, 'legacy'); assert.deepEqual(p.problems, []); assert.equal(p.structure, 'matches'); assert.deepEqual(p.pending, ['001-base', '002-provider-catalog']);
  const r = await M.apply(q, R());
  assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base', '002-provider-catalog']);
  const was = S.lines(sig0), now = S.lines(await sigOf(pg));
  assert.deepEqual([...was].filter((l) => !now.has(l)), [], 'a line of the existing structure disappeared or changed');
  const added = [...now].filter((l) => !was.has(l));
  assert.deepEqual([...new Set(added.map(tableOfLine))].sort(), [...NEW_TABLES, 'schema_migrations'].sort(), 'structure was added to a table other than the six and the bookkeeping table');
  assert.deepEqual(await fingerprint(pg, M.OURS), fp0, 'a row of a base table changed');
  assert.equal(await aclsOf(pg), acl0, 'owner, permissions or row-security of a base table or sequence changed');
  assert.deepEqual((await tablesOf(pg)).filter((t) => !tables0.includes(t)).sort(), [...NEW_TABLES, 'schema_migrations'].sort());
  assert.equal((await tablesOf(pg)).length, 20);
  for (const t of NEW_TABLES) assert.equal(await countOf(pg, `SELECT count(*)::int AS n FROM ${t}`), 0, t + ' must start empty (a migration loads no data)');
  assert.equal(await countOf(pg, "SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal"), 0, 'no trigger');
  assert.equal(await countOf(pg, "SELECT count(*)::int AS n FROM pg_views WHERE schemaname = 'public'"), 0, 'no view');
  assert.equal(await countOf(pg, "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'"), 0, 'no function');
  const hist = (await pg.query('SELECT id, checksum FROM schema_migrations ORDER BY id COLLATE "C"')).rows;
  assert.deepEqual(hist.map((h) => h.id), ['001-base', '002-provider-catalog', '@identity']); assert.equal(hist[1].checksum, M2.sha);
  const done = await catalog(pg);
  const again = await M.apply(q, R());
  assert.equal(again.refused, false); assert.deepEqual(again.applied, []); assert.deepEqual(again.pending, []); assert.equal(await catalog(pg), done);
  await pg.close();
});

test('migration 002 on a new, empty database ends with the same structure as on a migrated production-shaped one (20 tables); the environment and identity are written once', async () => {
  const a = await fullClone(); const b = new PGlite(); const q = qp(b);
  const r = await M.apply(q, R({ expectEnv: 'test', allowEmpty: true }));
  assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base', '002-provider-catalog']);
  assert.deepEqual(await tablesOf(b), [...M.OURS, 'schema_migrations', ...NEW_TABLES].sort());
  assert.equal(await sigOf(b), await sigOf(a), 'a new database and a migrated one must have the same structure');
  assert.equal((await b.query("SELECT value FROM settings WHERE key = 'meta.environment'")).rows[0].value, 'test');
  assert.deepEqual((await b.query('SELECT id FROM schema_migrations ORDER BY id COLLATE "C"')).rows.map((h) => h.id), ['001-base', '002-provider-catalog', '@identity']);
  const done = await catalog(b); assert.deepEqual((await M.apply(q, R({ expectEnv: 'test' }))).applied, []); assert.equal(await catalog(b), done);
  await a.close(); await b.close();
});

test('re-running the files changes nothing, structure or rows: 002 again, the base again, with data in every new table', async () => {
  const pg = await fullClone(); await seedCatalog(pg);
  for (const t of NEW_TABLES) assert.ok(await countOf(pg, `SELECT count(*)::int AS n FROM ${t}`) > 0, t + ' should hold a synthetic row');
  const before = await catalog(pg);
  await pg.exec(M2.sql); await pg.exec(M2.sql); await pg.exec(DDL);
  assert.equal(await catalog(pg), before, 'running a file again changed structure or rows');
  await pg.close();
});

test('a failure in the middle of migration 002 (first, middle, last statement, or while recording it): nothing is recorded for it, base tables are untouched, the half-made objects are not drift, and the next run ends exactly like a clean run', async () => {
  const clean = await fullClone(); const cleanSig = await sigOf(clean); await clean.close();
  assert.equal(M2.statements, 8);   // 6 tables and 2 indexes, in this order: profiles, services, 2 indexes, compensation, prices, settings, imports
  const cases = [
    ['the first statement', (t) => /CREATE TABLE IF NOT EXISTS provider_profiles/.test(t), /002-provider-catalog stopped at statement 1 of 8/],
    ['a middle statement', (t) => /CREATE TABLE IF NOT EXISTS provider_service_prices/.test(t), /002-provider-catalog stopped at statement 6 of 8/],
    ['the last statement', (t) => /CREATE TABLE IF NOT EXISTS catalog_imports/.test(t), /002-provider-catalog stopped at statement 8 of 8/],
    ['recording it, after every statement ran', (t, p) => /^INSERT INTO schema_migrations/.test(t) && p && p[0] === '002-provider-catalog', /simulated connection loss|002-provider-catalog/],
  ];
  for (const [name, when, expected] of cases) {
    const pg = await afterBaseClone(); const q = qp(pg);
    const fpBase = await fingerprint(pg, M.OURS), aclBase = await aclsOf(pg); let down = true;
    const flaky = async (t, p) => { if (down && when(t, p)) throw new Error('simulated connection loss'); return q(t, p); };
    await assert.rejects(() => M.apply(flaky, R()), expected, name);
    assert.deepEqual((await pg.query("SELECT id FROM schema_migrations WHERE id <> '@identity' ORDER BY id COLLATE \"C\"")).rows.map((r) => r.id), ['001-base'], name + ': something was recorded for 002');
    assert.deepEqual(await fingerprint(pg, M.OURS), fpBase, name + ': a base table changed'); assert.equal(await aclsOf(pg), aclBase, name);
    down = false;
    const c = await M.plan(M.readOnly(q), R());
    assert.deepEqual(c.problems, [], name + ': the half-made objects were reported as drift'); assert.deepEqual(c.pending, ['002-provider-catalog']);
    const r = await M.apply(q, R()); assert.equal(r.refused, false); assert.deepEqual(r.applied, ['002-provider-catalog']);
    assert.equal(await sigOf(pg), cleanSig, name + ': a resumed run must end with exactly the structure of a clean run');
    const done = await catalog(pg); assert.deepEqual((await M.apply(q, R())).applied, []); assert.equal(await catalog(pg), done);
    await pg.close();
  }
});

test('structure drift after 002: every change made outside the migrations is noticed, apply refuses and writes NOTHING', async () => {
  const dropCheck = async (pg, table, like) => { const r = await pg.query(`SELECT conname FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%${like.replace(/'/g, "''")}%'`); assert.equal(r.rows.length, 1, 'the constraint to drop must exist exactly once'); await pg.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${r.rows[0].conname}`); };
  const STRUCT = /^structure:/, FOREIGN = /not Kaspchem tables: provider_extra/;
  const cases = [
    ['a stray column in a catalog table', (pg) => pg.exec('ALTER TABLE provider_services ADD COLUMN stray integer'), STRUCT],
    ['the "active needs signed + active + fixed price" rule removed', (pg) => dropCheck(pg, 'provider_services', "activation <> 'active'"), STRUCT],
    ['the "offered needs recorded clearance" rule removed', (pg) => dropCheck(pg, 'service_settings', 'legal_cleared_by'), STRUCT],
    ['a column type changed', (pg) => pg.exec('ALTER TABLE provider_service_prices ALTER COLUMN terms_text TYPE varchar(50)'), STRUCT],
    ['NOT NULL dropped', (pg) => pg.exec('ALTER TABLE catalog_imports ALTER COLUMN imported_by DROP NOT NULL'), STRUCT],
    ['a unique index dropped', (pg) => pg.exec('DROP INDEX provider_services_external_ref_uq'), STRUCT],
    ['a foreign key dropped', (pg) => pg.exec('ALTER TABLE provider_service_prices DROP CONSTRAINT provider_service_prices_professional_id_service_id_fkey'), STRUCT],
    ['a table dropped', (pg) => pg.exec('DROP TABLE provider_service_compensation'), STRUCT],
    ['a base table changed while 002 is recorded', (pg) => pg.exec('ALTER TABLE pricing ADD COLUMN stray integer'), STRUCT],
    ['an extra table next to the catalog', (pg) => pg.exec('CREATE TABLE provider_extra (id int)'), FOREIGN],
  ];
  for (const [name, change, expected] of cases) {
    const pg = await fullClone(); await change(pg); const before = await catalog(pg);
    const r = await M.apply(qp(pg), R());
    assert.equal(r.refused, true, name); assert.ok(r.problems.some((x) => expected.test(x)), name + ': ' + r.problems.join(' | '));
    assert.equal(await catalog(pg), before, name + ': something was written');
    await pg.close();
  }
});

test('modified files: an edited, renamed, shortened or extended 002 is refused offline; a careful edit with a regenerated manifest is refused by the additive-only and ownership rules or by the history; nothing is written', async () => {
  const orig = fs.readFileSync(FILE_002, 'utf8').replace(/\r\n/g, '\n'), origManifest = fs.readFileSync(MANIFEST_FILE, 'utf8').replace(/\r\n/g, '\n');
  const edit = (from, to) => { assert.ok(orig.includes(from), 'test setup: the text to edit is no longer in 002: ' + from); return orig.replace(from, to); };
  const NET = /ECONNREFUSED|ENOTFOUND|getaddrinfo|fetch failed|ETIMEDOUT/i;
  const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'kaspchem-migrate.js')].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { KASPCHEM_DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' }) });
  // 1. edited after the manifest was made (the manifest still has the old fingerprint)
  const stale = [
    ['a comment appended', orig + '-- edited\n'],
    ['a CHECK removed', edit("CHECK (delivery_method IN ('portal','manual'))", '')],
    ['a column added', edit('  retired_reason    TEXT,\n', '  retired_reason    TEXT,\n  stray             TEXT,\n')],
    ['a table removed', orig.slice(0, orig.indexOf('-- Catalog loads from a spreadsheet'))],
    ['a table added', orig + 'CREATE TABLE IF NOT EXISTS provider_extra (id int);\n'],
  ];
  for (const [name, sql] of stale) {
    const dir = makeDir({ '002-provider-catalog.sql': sql }, origManifest);
    assert.ok(M.loadMigrations({ dir }).problems.some((p) => /does not match the file/.test(p)), name + ': the manifest did not catch it');
    const r = cli(['--check', '--migrations-dir=' + dir]); assert.equal(r.status, 1, name); assert.match(r.stderr, /not acceptable/, name); assert.doesNotMatch(r.stderr, NET, name + ': the database was contacted');
  }
  const renamed = makeDir({ '003-provider-catalog.sql': orig }, origManifest.replace('002-provider-catalog', '003-provider-catalog'));
  assert.ok(M.loadMigrations({ dir: renamed }).problems.some((p) => /numbering/.test(p)), 'a renamed file (a gap in the numbering)');
  assert.ok(M.loadMigrations({ dir: makeDir({ '002-provider-catalog.sql': orig }, '\n') }).problems.some((p) => /is not listed/.test(p)), 'an empty manifest');
  // 2. a careful edit: the manifest is regenerated to agree with the edited file, so only the rules and the database's own memory can stop it
  for (const bad of ['ALTER TABLE services DROP COLUMN name;\n', 'DROP TABLE pricing;\n', 'GRANT ALL ON provider_services TO PUBLIC;\n', 'DELETE FROM settings;\n', "INSERT INTO settings (key, value) VALUES ('x', '1');\n", 'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY);\n', 'CREATE TABLE IF NOT EXISTS pricing (id int);\n']) {
    const lm = M.loadMigrations({ dir: makeDir({ '002-provider-catalog.sql': orig + bad }) });
    assert.ok(lm.problems.length > 0, 'should be refused: ' + bad);
    const pg = await production(); const before = await catalog(pg);
    const r = await M.apply(qp(pg), { migrations: lm.migrations, expectEnv: 'production' });
    assert.equal(r.refused, true, bad); assert.equal(await catalog(pg), before, bad + ': something was written'); await pg.close();
  }
  // 3. a harmless-looking but different 002 (manifest regenerated) against a database that already ran the real one: the history refuses it
  const full = await fullClone(); const before = await catalog(full);
  const lm = M.loadMigrations({ dir: makeDir({ '002-provider-catalog.sql': orig + 'CREATE TABLE IF NOT EXISTS provider_extra (id int);\n' }) });
  assert.deepEqual(lm.problems, [], 'test setup: this edit is additive and its manifest agrees');
  const r = await M.apply(qp(full), { migrations: lm.migrations, expectEnv: 'production' });
  assert.ok(r.refused && r.problems.some((x) => /was CHANGED after it was applied/.test(x)), r.problems.join(' | ')); assert.equal(await catalog(full), before);
  await full.close();
  // 4. the base schema is pinned too
  const tmpBase = path.join(os.tmpdir(), 'kc-base2-' + Date.now() + '.sql'); fs.writeFileSync(tmpBase, DDL + '\n-- changed\n');
  assert.ok(M.loadMigrations({ baseFile: tmpBase }).problems.some((p) => /pinned fingerprint/.test(p)));
});

test('the database enforces the M1 rules itself: states, the ACTIVE safety rule, price models, commission record, clearance, lengths, keys and cascades (synthetic data)', async () => {
  const pg = await fullClone(); await seedCatalog(pg);
  const KIND = { check: /violates check constraint/, fk: /violates foreign key constraint/, unique: /duplicate key value violates unique constraint/, notnull: /violates not-null constraint/ };
  const ok = async (sql) => { await pg.query(sql); };
  const bad = async (kind, sql) => { await assert.rejects(() => pg.query(sql), (e) => { assert.match(e.message, KIND[kind], sql); return true; }); };
  // --- provider_services: defaults, and the rule that ACTIVE needs a signed agreement, an active collaboration, a fixed price model and a price row
  const d = (await pg.query('SELECT activation, contact_state, agreement_state, pricing_model, priority, pricing_id, retired_at FROM provider_services WHERE professional_id = 1 AND service_id = 1')).rows[0];
  assert.deepEqual(d, { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', priority: 100, pricing_id: null, retired_at: null });
  await ok("INSERT INTO professionals (name) VALUES ('Synthetic Provider C')"); await ok("INSERT INTO services (name) VALUES ('Synthetic Service Three')");
  await ok("INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id) VALUES (3, 3, 'active', 'active', 'signed', 'fixed', 1)");   // everything in place: accepted
  const ACTIVE = (over) => { const v = Object.assign({ activation: "'active'", contact_state: "'active'", agreement_state: "'signed'", pricing_model: "'fixed'", pricing_id: '1' }, over); return `INSERT INTO provider_services (professional_id, service_id, ${Object.keys(v).join(', ')}) VALUES (2, 2, ${Object.values(v).join(', ')})`; };
  for (const a of ['draft', 'not_discussed', 'ended']) await bad('check', ACTIVE({ agreement_state: `'${a}'` }));
  for (const c of ['negotiating', 'contacted', 'stopped', 'none']) await bad('check', ACTIVE({ contact_state: `'${c}'` }));
  for (const m of ['percent_of_result', 'percent_with_minimum', 'variable', 'quote', 'tbd']) await bad('check', ACTIVE({ pricing_model: `'${m}'` }));
  await bad('check', ACTIVE({ pricing_id: 'NULL' }));
  await bad('check', "UPDATE provider_services SET activation = 'active' WHERE professional_id = 1 AND service_id = 2");                       // the same rule on the update path
  await bad('check', "UPDATE provider_services SET agreement_state = 'ended' WHERE professional_id = 3 AND service_id = 3");                // and an active offering cannot silently lose a prerequisite
  await bad('check', 'UPDATE provider_services SET pricing_id = NULL WHERE professional_id = 3 AND service_id = 3');
  await bad('check', 'DELETE FROM pricing WHERE id = 1');                                                                                     // the price of an active offering cannot be deleted from under it (ON DELETE SET NULL would break the rule)
  await bad('check', "UPDATE provider_services SET activation = 'retired' WHERE professional_id = 1 AND service_id = 2");                    // retired needs retired_at
  await ok("UPDATE provider_services SET activation = 'retired', retired_at = now() WHERE professional_id = 1 AND service_id = 2");
  await ok("UPDATE provider_services SET activation = 'paused', paused_reason = 'synthetic' WHERE professional_id = 3 AND service_id = 3");
  for (const [col, v] of [['activation', 'live'], ['contact_state', 'called'], ['agreement_state', 'verbal'], ['pricing_model', 'free']]) await bad('check', `INSERT INTO provider_services (professional_id, service_id, ${col}) VALUES (3, 1, '${v}')`);
  await bad('unique', 'INSERT INTO provider_services (professional_id, service_id) VALUES (1, 1)');                                           // one engagement per provider and service
  await bad('unique', "INSERT INTO provider_services (professional_id, service_id, external_ref) VALUES (3, 1, 'A-1')");                      // an external id is used once
  await ok('INSERT INTO provider_services (professional_id, service_id) VALUES (3, 2)'); await ok('INSERT INTO provider_services (professional_id, service_id) VALUES (3, 1)');   // missing external ids (NULL) may repeat
  await bad('fk', 'INSERT INTO provider_services (professional_id, service_id) VALUES (99, 1)'); await bad('fk', 'INSERT INTO provider_services (professional_id, service_id) VALUES (1, 99)');
  await bad('fk', 'INSERT INTO provider_services (professional_id, service_id, pricing_id) VALUES (2, 2, 99)');
  await bad('notnull', 'INSERT INTO provider_services (professional_id, service_id, activation) VALUES (2, 2, NULL)');
  // --- provider_service_compensation: a RECORD of what the sheet says; the model and the recorded numbers must agree
  const COMP = (v) => `INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, fixed_recorded, status, recorded_by) VALUES (2, 1, ${v})`;
  await bad('check', COMP("'percent', NULL, NULL, 'recorded', 'o'")); await bad('check', COMP("'none', 5, NULL, 'recorded', 'o'")); await bad('check', COMP("'fixed', NULL, NULL, 'recorded', 'o'")); await bad('check', COMP("'tbd', NULL, 100, 'recorded', 'o'"));
  await bad('check', COMP("'percent', 101, NULL, 'recorded', 'o'")); await bad('check', COMP("'percent', -1, NULL, 'recorded', 'o'")); await bad('check', COMP("'fixed', NULL, -5, 'recorded', 'o'"));
  await bad('check', COMP("'tbd', NULL, NULL, 'paid', 'o'")); await bad('check', COMP("'bonus', NULL, NULL, 'recorded', 'o'")); await bad('notnull', COMP("'tbd', NULL, NULL, 'recorded', NULL"));
  await bad('fk', "INSERT INTO provider_service_compensation (professional_id, service_id, recorded_by) VALUES (2, 2, 'o')");                    // no engagement, no record
  await bad('unique', "INSERT INTO provider_service_compensation (professional_id, service_id, recorded_by) VALUES (1, 1, 'o')");
  for (const v of ["'none', NULL, NULL, 'recorded', 'o'", "'percent', 12.5, NULL, 'negotiating', 'o'", "'fixed', NULL, 300, 'agreed', 'o'", "'tbd', NULL, NULL, 'recorded', 'o'"]) { await ok(COMP(v)); await ok('DELETE FROM provider_service_compensation WHERE professional_id = 2 AND service_id = 1'); }
  // --- provider_service_prices: the layers, each with the fields its model needs and none that it must not have
  const PR = (kind, model, f) => { const v = Object.assign({ amount: 'NULL', percent_low: 'NULL', percent_high: 'NULL', minimum_amount: 'NULL', status: "'recorded'" }, f || {}); return `INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, status, recorded_by) VALUES (2, 1, '${kind}', '${model}', ${v.amount}, ${v.percent_low}, ${v.percent_high}, ${v.minimum_amount}, ${v.status}, 'o')`; };
  const clear = () => ok('DELETE FROM provider_service_prices WHERE professional_id = 2 AND service_id = 1');
  for (const sql of [PR('market', 'fixed', { amount: '800' }), PR('provider_offer', 'percent_of_result', { percent_low: '10', status: "'awaiting_response'" }), PR('provider_offer', 'percent_of_result', { percent_low: '5', percent_high: '10', status: "'received'" }),
    PR('provider_offer', 'percent_with_minimum', { percent_low: '10', minimum_amount: '2000', status: "'declined'" }), PR('unclassified', 'fixed', { amount: '0' }), PR('market', 'variable'), PR('market', 'quote'), PR('unclassified', 'tbd')]) { await ok(sql); await clear(); }
  await bad('check', PR('market', 'fixed')); await bad('check', PR('market', 'fixed', { amount: '5', percent_low: '5' })); await bad('check', PR('market', 'fixed', { amount: '5', minimum_amount: '5' })); await bad('check', PR('market', 'fixed', { amount: '-1' }));
  await bad('check', PR('market', 'percent_of_result')); await bad('check', PR('market', 'percent_of_result', { percent_low: '5', amount: '5' })); await bad('check', PR('market', 'percent_with_minimum', { percent_low: '5' }));
  await bad('check', PR('market', 'percent_of_result', { percent_low: '10', percent_high: '5' })); await bad('check', PR('market', 'percent_of_result', { percent_low: '0' })); await bad('check', PR('market', 'percent_of_result', { percent_low: '101' }));
  await bad('check', PR('market', 'variable', { amount: '5' })); await bad('check', PR('market', 'quote', { percent_low: '5' })); await bad('check', PR('market', 'tbd', { minimum_amount: '5' }));
  await bad('check', PR('market', 'fixed', { amount: '5', status: "'awaiting_response'" }));                                                  // only an offer to Kaspchem can wait for an answer
  await bad('check', PR('unclassified', 'fixed', { amount: '5', status: "'received'" }));
  await bad('check', PR('approved', 'fixed', { amount: '5' })); await bad('check', PR('market', 'barter')); await bad('check', PR('provider_offer', 'fixed', { amount: '5', status: "'maybe'" }));
  const TXT = (col, n) => `INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, ${col}, recorded_by) VALUES (2, 1, 'market', 'fixed', 5, '${'x'.repeat(n)}', 'o')`;
  await ok(TXT('terms_text', 600)); await clear(); await ok(TXT('source_note', 600)); await clear();
  await bad('check', TXT('terms_text', 601)); await bad('check', TXT('source_note', 601));                                                  // wording is kept verbatim but bounded
  await bad('unique', PR('market', 'fixed', { amount: '5' }).replace('VALUES (2, 1,', 'VALUES (1, 1,'));                                      // one row per layer of an engagement
  await bad('fk', PR('market', 'fixed', { amount: '5' }).replace('VALUES (2, 1,', 'VALUES (2, 2,'));
  // --- service_settings: never offered to the public without recorded clearance; a readable, unique code
  const SS = (v) => `INSERT INTO service_settings (service_id, code, legal_cleared, legal_cleared_by, offered) VALUES (2, ${v})`;
  await ok(SS("'svc-two', TRUE, 'owner@example.test', TRUE")); await ok('DELETE FROM service_settings WHERE service_id = 2');
  await bad('check', SS("'svc-two', FALSE, NULL, TRUE")); await bad('check', SS("'svc-two', TRUE, NULL, TRUE")); await bad('check', SS("'Svc-Two', FALSE, NULL, FALSE")); await bad('check', SS("'x', FALSE, NULL, FALSE")); await bad('check', SS("'" + 'a'.repeat(41) + "', FALSE, NULL, FALSE"));
  await bad('unique', SS("'synthetic-one', FALSE, NULL, FALSE")); await bad('fk', "INSERT INTO service_settings (service_id, code) VALUES (99, 'ghost')");
  assert.deepEqual((await pg.query('SELECT offered, legal_cleared FROM service_settings WHERE service_id = 1')).rows[0], { offered: false, legal_cleared: false }, 'a service is not offered and not cleared by default');
  // --- provider_profiles: one row per provider, bounded text, a plausible email
  await ok('INSERT INTO provider_profiles (professional_id) VALUES (2)');
  assert.deepEqual((await pg.query('SELECT delivery_method, availability FROM provider_profiles WHERE professional_id = 2')).rows[0], { delivery_method: 'portal', availability: {} });
  await bad('unique', 'INSERT INTO provider_profiles (professional_id) VALUES (1)'); await bad('fk', 'INSERT INTO provider_profiles (professional_id) VALUES (99)');
  for (const set of ["delivery_method = 'fax'", 'capacity_open = -1', "business_name = '" + 'b'.repeat(201) + "'", "contact_phone = '" + '0'.repeat(41) + "'", "internal_notes = '" + 'n'.repeat(1001) + "'", "contact_email = 'not-an-email'", "contact_email = 'a@b'", "contact_email = 'a b@c.de'", "contact_email = '<a@c.de>'"]) await bad('check', `UPDATE provider_profiles SET ${set} WHERE professional_id = 2`);
  await ok("UPDATE provider_profiles SET delivery_method = 'manual', capacity_open = 0, contact_email = 'x@y.co', paused_until = now() WHERE professional_id = 2");
  // --- catalog_imports: counts only
  const CI = (v) => `INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES (${v})`;
  await ok(CI("'xlsx', 'abc', 0, 0, 0, 0, 'o'")); await bad('check', CI("'pdf', 'abc', 1, 1, 0, 0, 'o'")); await bad('check', CI("'csv', 'abc', -1, 0, 0, 0, 'o'")); await bad('check', CI("'csv', 'abc', 1, -1, 0, 0, 'o'")); await bad('notnull', CI("'csv', NULL, 1, 1, 0, 0, 'o'")); await bad('notnull', CI("'csv', 'abc', 1, 1, 0, 0, NULL"));
  // --- cascades: removing a provider removes its profile and engagements with their price layers and commission record (the app role gets no DELETE, see the permissions test)
  await ok('DELETE FROM professionals WHERE id = 1');
  for (const t of ['provider_profiles', 'provider_services', 'provider_service_prices', 'provider_service_compensation']) assert.equal(await countOf(pg, `SELECT count(*)::int AS n FROM ${t} WHERE professional_id = 1`), 0, t);
  assert.equal(await countOf(pg, 'SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 2'), 1, 'another provider is not affected');
  await pg.close();
});

test('database permissions (as far as a local database can show): 002 grants nothing and changes no existing permission; without a grant step the app role is locked out of the new tables', async () => {
  const pg = await production();
  // the permissions of today, modelled: the application role may read and write the existing tables and use their sequences (production's real grants are not known here)
  await pg.exec('CREATE ROLE kaspchem_app NOLOGIN; CREATE ROLE stranger NOLOGIN; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO kaspchem_app; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kaspchem_app; GRANT SELECT ON settings TO stranger');
  const acl0 = await aclsOf(pg);
  assert.match(acl0, /kaspchem_app=arw\/postgres/, 'test setup: the modelled grants are in place');
  const r = await M.apply(qp(pg), R()); assert.equal(r.refused, false, (r.problems || []).join('; '));
  assert.equal(await aclsOf(pg), acl0, '002 changed an owner, a permission or a row-security flag of an existing table or sequence');
  const newAcl = (await pg.query(`SELECT relname, relacl::text AS acl FROM pg_class WHERE relname IN (${quoted})`)).rows;
  assert.equal(newAcl.length, 8); newAcl.forEach((x) => assert.equal(x.acl, null, x.relname + ' must carry no grant at all after the migration'));
  const can = async (role, table, priv) => (await pg.query('SELECT has_table_privilege($1::name, $2::text, $3::text) AS ok', [role, table, priv])).rows[0].ok;
  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
  for (const t of [...NEW_TABLES, 'schema_migrations']) for (const who of ['kaspchem_app', 'stranger']) for (const p of PRIVS) assert.equal(await can(who, t, p), false, `${who} must have no ${p} on ${t} before a grant step`);
  const asRole = async (role, sql) => { await pg.exec('SET ROLE ' + role); try { return await pg.query(sql); } finally { await pg.exec('RESET ROLE'); } };
  await assert.rejects(() => asRole('kaspchem_app', 'SELECT count(*) FROM provider_services'), /permission denied for table provider_services/);
  await assert.rejects(() => asRole('kaspchem_app', "INSERT INTO service_settings (service_id, code) VALUES (1, 'nope')"), /permission denied/);
  assert.equal((await asRole('kaspchem_app', 'SELECT count(*)::int AS n FROM settings')).rows[0].n, 2, 'existing access is unchanged');
  // The grants for the NEW tables are a separate, separately approved step: db/grants/m1-app-grants.sql, tested in tests/grants.test.js (matrix, forbidden access, rollback).
  await pg.close();
});

test('--check never writes, with the real files, in every state around 002: empty, legacy, 002 pending, half-made 002, complete, drifted, foreign (a recording connection sees reads only)', async () => {
  const halfMade = async () => { const pg = await afterBaseClone(); const q = qp(pg); const flaky = async (t, p) => { if (/CREATE TABLE IF NOT EXISTS provider_service_prices/.test(t)) throw new Error('simulated outage'); return q(t, p); }; await assert.rejects(() => M.apply(flaky, R()), /stopped at statement/); return pg; };
  const states = [
    ['empty', async () => new PGlite(), { allowEmpty: true, expectEnv: 'test' }, (p) => assert.deepEqual(p.pending, ['001-base', '002-provider-catalog'])],
    ['legacy', production, {}, (p) => { assert.equal(p.state, 'legacy'); assert.deepEqual(p.problems, []); assert.deepEqual(p.pending, ['001-base', '002-provider-catalog']); }],
    ['002 pending', afterBaseClone, {}, (p) => { assert.equal(p.state, 'versioned'); assert.deepEqual(p.problems, []); assert.equal(p.structure, 'matches'); assert.deepEqual(p.pending, ['002-provider-catalog']); }],
    ['half-made 002', halfMade, {}, (p) => { assert.deepEqual(p.problems, []); assert.deepEqual(p.pending, ['002-provider-catalog']); }],
    ['complete', fullClone, {}, (p) => { assert.equal(p.state, 'versioned'); assert.deepEqual(p.problems, []); assert.equal(p.structure, 'matches'); assert.deepEqual(p.pending, []); }],
    ['drifted', async () => { const pg = await fullClone(); await pg.exec('ALTER TABLE provider_services ADD COLUMN stray integer'); return pg; }, {}, (p) => assert.ok(p.problems.some((x) => /^structure:/.test(x)))],
    ['foreign', async () => { const pg = await fullClone(); await pg.exec('CREATE TABLE someone_elses_users (id int)'); return pg; }, {}, (p) => assert.ok(p.problems.some((x) => /someone_elses_users/.test(x)))],
  ];
  for (const [name, build, over, verdict] of states) {
    const pg = await build(); const log = recording(qp(pg)); const before = await catalog(pg), acl = await aclsOf(pg);
    const p = await M.plan(M.readOnly(log), R(over));
    verdict(p);
    assert.equal(await catalog(pg), before, name + ': the check changed something'); assert.equal(await aclsOf(pg), acl, name);
    assert.ok(log.log.length > 0 && log.log.every(isRead), name + ': a statement that is not a plain read was sent: ' + log.log.filter((t) => !isRead(t)).join(' | '));
    assert.ok(M.checkReport(p).join('\n').includes('nothing was written'), name);
    await pg.close();
  }
});

test('the older entry points (check, migrate) know the M1 tables: they are not "foreign" once the files are applied; a really foreign table is still refused', async () => {
  const pg = await fullClone(); const q = rows(pg);
  const c = await M.check(q); assert.deepEqual(c.foreign, []); assert.deepEqual(c.missing, []);
  const before = await catalog(pg); await M.migrate(q, DDL); assert.equal(await catalog(pg), before, 'the older migrate changed a migrated database');
  await pg.exec('CREATE TABLE someone_elses_users (id int)');
  assert.deepEqual((await M.check(q)).foreign, ['someone_elses_users']);
  await assert.rejects(() => M.migrate(q, DDL), /non-Kaspchem tables: someone_elses_users/);
  await pg.close();
});

test('nothing public or existing uses the new tables yet: no page, function, script or admin code outside db/migrations, db/grants, the grant tool scripts/kaspchem-grants.js and the tests mentions them', () => {
  const NAMES = new RegExp('\\b(' + NEW_TABLES.join('|') + ')\\b');
  const skip = new Set(['node_modules', '.git', 'docs', 'tests', '.netlify', 'test-results', 'playwright-report']);   // db/grants (the proposed grants) and db/migrations are the only non-test places that name the new tables
  const hits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name), rel = path.relative(ROOT, full).replace(/\\/g, '/');
      if (e.isDirectory()) { if (!skip.has(e.name) && rel !== 'db/migrations' && rel !== 'db/grants') walk(full); continue; }
      if (!/\.(js|mjs|cjs|html|json|toml|sql|md|txt|xml|css)$/i.test(e.name) || fs.statSync(full).size > 2000000) continue;
      if (rel === 'scripts/kaspchem-grants.js') continue;   // the one operations tool that has to name them (it builds the grant step; it is not application, public or admin code)
      if (NAMES.test(fs.readFileSync(full, 'utf8'))) hits.push(rel);
    }
  })(ROOT);
  assert.deepEqual(hits, [], 'these files mention a new table: ' + hits.join(', '));
});

// =====================================================================================================================================================
// Adopting an existing database. When a database from before the bookkeeping table equals 001-base EXACTLY (and passes identity, environment, history and the full
// structure comparison), 001-base is only RECORDED: none of its statements is sent again. An empty database is built from it as before, an interrupted first
// initialisation is finished as before, and everything else (partly there, differing, wrong identity, unverified) is refused, never completed and never skipped over.
// PGlite and synthetic data only. Nothing here touches Neon.
// =====================================================================================================================================================
const norm = (t) => String(t).replace(/\s+/g, ' ').trim();
const BASE_STMTS = M.splitDdl(REAL.migrations[0].sql).map(norm);
const sentBase = (log) => log.filter((t) => BASE_STMTS.includes(norm(t))).length;
const writesOf = (log) => log.filter((t) => !isRead(t));
let LEGACY = null;   // a database exactly as production has it (13 tables, rows, meta.environment "production", no bookkeeping), built once and cloned
const legacyClone = async () => { if (!LEGACY) LEGACY = await production(); return LEGACY.clone(); };
const asTest = async (pg) => { await pg.exec("UPDATE settings SET value = '\"test\"' WHERE key = 'meta.environment'"); return pg; };   // the shape of the temporary Neon branch: environment "test"

test('the base schema has 18 statements, and the helper that recognises them is exact', () => {
  assert.equal(BASE_STMTS.length, 18); assert.equal(new Set(BASE_STMTS).size, 18);
  assert.equal(sentBase(['SELECT 1', BASE_STMTS[0], BASE_STMTS[5] + ' ', 'CREATE TABLE IF NOT EXISTS zz (id int)']), 2);
});

test('ADOPT: an existing database that equals 001-base exactly is only RECORDED (none of its 18 statements is sent); 002 is applied after it; the 13 base tables, rows and permissions are untouched', async () => {
  const pg = await legacyClone(); const q = recording(qp(pg));
  const sig0 = await sigOf(pg), fp0 = await fingerprint(pg, M.OURS), acl0 = await aclsOf(pg), seq0 = JSON.stringify((await pg.query('SELECT sequencename, last_value FROM pg_sequences ORDER BY 1')).rows);
  const p = await M.plan(M.readOnly(qp(pg)), R());
  assert.equal(p.state, 'legacy'); assert.deepEqual(p.problems, []); assert.equal(p.structure, 'matches'); assert.equal(p.baseMode, 'adopt'); assert.equal(p.baseStatements, 18); assert.deepEqual(p.history, []);
  assert.match(M.checkReport(p).join('\n'), /Base schema 001-base: the database matches it exactly \(identity, environment, no history, full structure\), so it would only be RECORDED; none of its 18 statements would be sent/);
  const r = await M.apply(q, R());
  assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base', '002-provider-catalog']); assert.deepEqual(r.adopted, ['001-base']);
  assert.equal(sentBase(q.log), 0, 'a statement of the base schema was sent to an existing database');
  const w = writesOf(q.log).map(norm);   // exactly: bookkeeping table, identity, record of 001, the 8 statements of 002 (in order), record of 002
  assert.equal(w.length, 12);
  assert.match(w[0], /^CREATE TABLE IF NOT EXISTS schema_migrations/); assert.match(w[1], /^INSERT INTO schema_migrations/); assert.match(w[2], /^INSERT INTO schema_migrations/);
  assert.deepEqual(w.slice(3, 11), M.splitDdl(M2.sql).map(norm)); assert.match(w[11], /^INSERT INTO schema_migrations/);
  const was = S.lines(sig0), now = S.lines(await sigOf(pg));
  assert.deepEqual([...was].filter((l) => !now.has(l)), [], 'a line of the existing structure disappeared or changed');
  assert.deepEqual([...new Set([...now].filter((l) => !was.has(l)).map(tableOfLine))].sort(), [...NEW_TABLES, 'schema_migrations'].sort());
  assert.deepEqual(await fingerprint(pg, M.OURS), fp0, 'a row of a base table changed'); assert.equal(await aclsOf(pg), acl0);
  assert.equal(JSON.stringify((await pg.query('SELECT sequencename, last_value FROM pg_sequences ORDER BY 1')).rows.filter((s) => !/catalog_imports/.test(s.sequencename))), JSON.stringify(JSON.parse(seq0).filter((s) => !/catalog_imports/.test(s.sequencename))), 'a sequence of a base table moved');
  const hist = (await pg.query('SELECT id, checksum FROM schema_migrations ORDER BY id COLLATE "C"')).rows;
  assert.deepEqual(hist.map((h) => h.id), ['001-base', '002-provider-catalog', '@identity']); assert.equal(hist[0].checksum, M.BASE_SHA256); assert.equal(hist[1].checksum, M2.sha);
  const done = await catalog(pg);
  const again = recording(qp(pg)); const r2 = await M.apply(again, R());
  assert.equal(r2.refused, false); assert.deepEqual(r2.applied, []); assert.deepEqual(r2.adopted, []); assert.equal(r2.baseMode, 'recorded'); assert.equal(sentBase(again.log), 0);
  assert.deepEqual(writesOf(again.log).map(norm).filter((t) => !/^CREATE TABLE IF NOT EXISTS schema_migrations|^INSERT INTO schema_migrations .*ON CONFLICT \(id\) DO NOTHING$/.test(t)), [], 'a second run sent something besides the two idempotent bookkeeping statements');
  assert.equal(await catalog(pg), done);
  await pg.close();
});

test('ADOPT, as the temporary Neon branch will meet it (environment "test"): the runner decides adopt, sends 12 writes of which none belongs to the base schema, and ends with the same structure as a clean build', async () => {
  const pg = await asTest(await legacyClone()); const q = recording(qp(pg)); const fp0 = await fingerprint(pg, M.OURS);
  const p = await M.plan(M.readOnly(qp(pg)), R({ expectEnv: 'test' })); assert.deepEqual(p.problems, []); assert.equal(p.baseMode, 'adopt'); assert.equal(p.env, 'test');
  const r = await M.apply(q, R({ expectEnv: 'test' })); assert.equal(r.refused, false); assert.deepEqual(r.adopted, ['001-base']);
  assert.equal(sentBase(q.log), 0); assert.equal(writesOf(q.log).length, 12);
  assert.deepEqual(await fingerprint(pg, M.OURS), fp0);
  const clean = await fullClone(); assert.equal(await sigOf(pg), await sigOf(clean), 'adopting must end with the structure of a clean build'); await clean.close();
  await pg.close();
});

test('BUILD: a new, empty database is built from 001-base as before (all 18 statements sent, nothing adopted); an interrupted first initialisation is finished the same way', async () => {
  const O3 = R({ expectEnv: 'test', allowEmpty: true });
  const pg = new PGlite(); const q = recording(qp(pg));
  const p = await M.plan(M.readOnly(qp(pg)), O3); assert.equal(p.state, 'empty'); assert.deepEqual(p.problems, []); assert.equal(p.baseMode, 'create');
  assert.match(M.checkReport(p).join('\n'), /Base schema 001-base: this is an empty database; its 18 statements would be sent to create it/);
  const r = await M.apply(q, O3); assert.equal(r.refused, false); assert.deepEqual(r.adopted, []); assert.equal(sentBase(q.log), 18);
  assert.equal((await tablesOf(pg)).length, 20); await pg.close();

  const pg2 = new PGlite(); const q2 = qp(pg2); let down = true;
  const flaky = async (t, p) => { if (down && /CREATE TABLE IF NOT EXISTS consents/.test(t)) throw new Error('simulated outage'); return q2(t, p); };
  await assert.rejects(() => M.apply(flaky, O3), /001-base stopped at statement/);
  const s = await M.plan(M.readOnly(q2), O3); assert.equal(s.state, 'initializing'); assert.deepEqual(s.problems, []); assert.equal(s.baseMode, 'resume');
  assert.match(M.checkReport(s).join('\n'), /Base schema 001-base: an interrupted first initialisation; its 18 statements \(all IF NOT EXISTS\) would be sent again to finish it/);
  down = false; const log2 = recording(q2); const r2 = await M.apply(log2, O3);
  assert.equal(r2.refused, false); assert.deepEqual(r2.adopted, []); assert.equal(sentBase(log2.log), 18, 'a half-built database must be finished with the full base, not adopted');
  assert.equal((await tablesOf(pg2)).length, 20); await pg2.close();
});

test('PARTIAL: an existing database that is only partly there is REFUSED (never completed, never skipped over): nothing is written, no statement of 001-base is sent, --check says so and writes nothing', async () => {
  const cases = [
    ['a base table is missing', 'DROP TABLE request_notes', /request_notes/],
    ['the newest base table (outcomes) is missing', 'DROP TABLE outcomes', /outcomes/],
    ['an index is missing', 'DROP INDEX tr_status_idx', /tr_status_idx/],
    ['several tables are missing', 'DROP TABLE request_notes; DROP TABLE outcomes; DROP TABLE revenues', /request_notes|outcomes|revenues/],
  ];
  for (const [name, change, mention] of cases) {
    const pg = await legacyClone(); await pg.exec(change); const before = await catalog(pg);
    const log = recording(qp(pg)); const p = await M.plan(M.readOnly(log), R());
    assert.equal(p.state, 'legacy', name); assert.equal(p.structure, 'partial', name); assert.equal(p.baseMode, null, name); assert.deepEqual(p.pending.slice(0, 1), ['001-base'], name + ': it must stay pending, not be skipped');
    assert.ok(p.problems.some((x) => /^structure: the base schema is only partly present/.test(x) && mention.test(x)), name + ': ' + p.problems.join(' | '));
    assert.ok(log.log.every(isRead), name + ': the check sent a write'); assert.equal(await catalog(pg), before, name + ': the check changed something');
    const text = M.checkReport(p).join('\n'); assert.match(text, /structure: partial/); assert.match(text, /Base schema 001-base: not decided, because this check is refused/); assert.match(text, /REFUSED/); assert.match(text, /nothing was written/);
    const q = recording(qp(pg)); const r = await M.apply(q, R());
    assert.equal(r.refused, true, name); assert.deepEqual(r.applied, [], name); assert.equal(writesOf(q.log).length, 0, name + ': a write was sent'); assert.equal(sentBase(q.log), 0, name); assert.equal(await catalog(pg), before, name + ': something was written');
    await pg.close();
  }
});

test('DIFFERENT: an existing database whose structure differs in any way is refused with nothing written and no statement of 001-base sent: column, type, default, extra index, extra table, partly there and different at once', async () => {
  const cases = [
    ['a stray column', 'ALTER TABLE services ADD COLUMN stray integer', /^structure:/],
    ['a missing column', 'ALTER TABLE applicants DROP COLUMN email', /^structure:/],
    ['a changed type', 'ALTER TABLE settings ALTER COLUMN updated_by TYPE varchar(50)', /^structure:/],
    ['a changed default', 'ALTER TABLE services ALTER COLUMN active SET DEFAULT FALSE', /^structure:/],
    ['an extra index', 'CREATE INDEX stray_idx ON applicants (name)', /^structure:/],
    ['an extra table', 'CREATE TABLE someone_elses_users (id int)', /not Kaspchem tables: someone_elses_users/],
    ['a missing table AND a stray column', 'DROP TABLE request_notes; ALTER TABLE services ADD COLUMN stray integer', /^structure:/],
  ];
  for (const [name, change, expected] of cases) {
    const pg = await legacyClone(); await pg.exec(change); const before = await catalog(pg);
    const log = recording(qp(pg)); const p = await M.plan(M.readOnly(log), R());
    assert.equal(p.baseMode, null, name); assert.ok(p.problems.some((x) => expected.test(x)), name + ': ' + p.problems.join(' | ')); assert.ok(log.log.every(isRead), name); assert.equal(await catalog(pg), before, name);
    const q = recording(qp(pg)); const r = await M.apply(q, R());
    assert.equal(r.refused, true, name); assert.equal(writesOf(q.log).length, 0, name + ': a write was sent'); assert.equal(sentBase(q.log), 0, name); assert.equal(await catalog(pg), before, name + ': something was written');
    await pg.close();
  }
});

test('ADOPT needs the identity, the environment, the history and a verified structure: without any one of them nothing is adopted and nothing is written', async () => {
  const prep = {
    'the wrong environment is expected': [async (pg) => pg, R({ expectEnv: 'test' }), /WRONG DATABASE/],
    'no environment is expected': [async (pg) => pg, R({ expectEnv: null }), /--expect-env/],
    'the database says nothing about its environment': [async (pg) => { await pg.exec("DELETE FROM settings WHERE key = 'meta.environment'"); return pg; }, R(), /no meta.environment/],
    'the structure was not verified': [async (pg) => pg, R({ verifyStructure: false }), /not verified/],
    'a recorded migration was changed (history)': [async (pg) => { await pg.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO schema_migrations (id, checksum) VALUES ('001-base', '" + 'ab'.repeat(32) + "')"); return pg; }, R(), /history:|identity:/],
    'a recorded migration is unknown (history)': [async (pg) => { await pg.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO schema_migrations (id, checksum) VALUES ('009-unknown', 'x')"); return pg; }, R(), /history:/],
  };
  for (const [name, [setup, opts, expected]] of Object.entries(prep)) {
    const pg = await setup(await legacyClone()); const before = await catalog(pg);
    const log = recording(qp(pg)); const p = await M.plan(M.readOnly(log), opts);
    assert.notEqual(p.baseMode, 'adopt', name); assert.ok(p.problems.some((x) => expected.test(x)), name + ': ' + p.problems.join(' | ')); assert.ok(log.log.every(isRead), name); assert.equal(await catalog(pg), before, name);
    const q = recording(qp(pg)); const r = await M.apply(q, opts);
    assert.equal(r.refused, true, name); assert.equal(writesOf(q.log).length, 0, name + ': a write was sent'); assert.equal(sentBase(q.log), 0, name); assert.equal(await catalog(pg), before, name + ': something was written');
    await pg.close();
  }
});

test('the --check text says, for every state, what would happen to 001-base, and an adopt/refused check writes nothing', async () => {
  const legacy = await legacyClone(); const full = await fullClone(); const empty = new PGlite(); const bad = await legacyClone(); await bad.exec('ALTER TABLE services ADD COLUMN stray integer');
  const line = async (pg, opts) => { const log = recording(qp(pg)); const before = await catalog(pg); const t = M.checkReport(await M.plan(M.readOnly(log), opts)).join('\n'); assert.equal(await catalog(pg), before); assert.ok(log.log.every(isRead)); return t; };
  assert.match(await line(legacy, R()), /Base schema 001-base: .*RECORDED; none of its 18 statements would be sent/);
  assert.match(await line(full, R()), /Base schema 001-base: already recorded; none of its statements would be sent/);
  assert.match(await line(empty, R({ expectEnv: 'test', allowEmpty: true })), /Base schema 001-base: this is an empty database; its 18 statements would be sent to create it/);
  assert.match(await line(bad, R()), /Base schema 001-base: not decided, because this check is refused/);
  for (const pg of [legacy, full, empty, bad]) await pg.close();
});
