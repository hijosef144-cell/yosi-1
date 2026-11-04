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
