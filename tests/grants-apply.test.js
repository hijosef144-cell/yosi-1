'use strict';
// The guarded grant step (scripts/kaspchem-grants.js), tested on an in-memory Postgres (PGlite) built like the Neon temporary branch: the real grants of kaspchem_app on the 13 base
// tables, migration 001 adopted and 002 applied through the real runner. Synthetic data only. NOTHING here touches Neon.
//
// The step is SQL that is sent through a trusted connection (the Neon SQL tool, which resolves the credentials itself). These tests send the very same text to PGlite:
//   - the DO blocks refuse, from inside, to run on any database that is not the one they were written for, and then change nothing;
//   - the judge (evaluate) accepts exactly the reviewed before/after states and rejects every deviation;
//   - the rollback file takes back exactly what the grant gave.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const M = require('../scripts/kaspchem-migrate.js');
const G = require(process.env.KC_GRANTS_MODULE || path.join(__dirname, '..', 'scripts', 'kaspchem-grants.js'));

const OPEN = new Set();   // every database is closed when the file ends, also after a failing assertion (and clones of clones are tracked too)
const track = (db) => { OPEN.add(db); const close = db.close.bind(db); db.close = async () => { OPEN.delete(db); return close(); }; const clone = db.clone.bind(db); db.clone = async () => track(await clone()); return db; };
class PGlite extends PGliteBase { constructor(...a) { super(...a); track(this); } }
test.after(async () => { for (const db of [...OPEN]) { try { await db.close(); } catch (e) { /* closed */ } } });

const ROOT = path.join(__dirname, '..');
const BASE_DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const REAL = M.loadMigrations();
const qp = (pg) => async (t, p) => (await pg.query(t, p || [])).rows;
// the target the DO blocks are written for, adapted to PGlite (another owner name, another database name, a fake endpoint, no fixed privilege fingerprint)
const T = (extra) => Object.assign({}, G.NEON_TARGET, { owner: 'postgres', database: 'postgres', endpoint: 'ep-test-fake', identity: G.sha256('postgres|test'), privFingerprint: null, privLines: null, defaultAclTotal: 0 }, extra || {});
const OWNER = 'postgres';
const TODAY_GRANTS = `
  GRANT INSERT, SELECT, UPDATE ON applicants, consents, outcomes, pricing, professionals, revenues, services, settings, treatment_requests TO kaspchem_app;
  GRANT INSERT, SELECT ON audit_log, request_notes TO kaspchem_app;
  GRANT DELETE, INSERT, SELECT, UPDATE ON questionnaire_versions TO kaspchem_app;
  GRANT DELETE, INSERT, SELECT ON rate_limits TO kaspchem_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kaspchem_app;`;

let MIGRATED = null;   // built once, cloned per test
async function build() {
  const pg = new PGlite();
  await pg.exec(BASE_DDL);
  await pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '\"test\"', 'setup')");
  await pg.exec('CREATE ROLE kaspchem_app LOGIN; CREATE ROLE stranger NOLOGIN');
  await pg.exec(TODAY_GRANTS);
  const r = await M.apply(qp(pg), { migrations: REAL.migrations, expectEnv: 'test' });
  assert.equal(r.refused, false, (r.problems || []).join('; '));
  return pg;
}
async function fresh(endpoint) {
  if (!MIGRATED) MIGRATED = await build();
  const pg = await MIGRATED.clone();
  if (endpoint !== null) await pg.exec(`SELECT set_config('neon.endpoint_id', '${endpoint || 'ep-test-fake'}', false)`);   // a custom setting stands in for the Neon endpoint id
  return pg;
}
const stateOf = async (pg, t) => JSON.parse((await pg.query(G.sql('pre', { target: t || T() }))).rows[0].state);
const aclSnapshot = async (pg) => JSON.stringify((await pg.query("SELECT c.relname, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S') ORDER BY 1")).rows);
const REFUSED = /kaspchem-grants: refused/;
const asApp = async (pg, sql) => { await pg.exec('SET SESSION AUTHORIZATION kaspchem_app'); try { return await pg.query(sql); } finally { await pg.exec('SET SESSION AUTHORIZATION ' + OWNER); } };

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test('the SQL is built only from the reviewed files: a changed file is refused; the statements are exactly the 3 GRANTs / 3 REVOKEs; nothing dynamic, nothing forbidden', () => {
  assert.deepEqual(G.loadStatements('apply'), G.APPLY); assert.deepEqual(G.loadStatements('rollback'), G.ROLLBACK);
  const fileApply = fs.readFileSync(path.join(ROOT, 'db', 'grants', 'm1-app-grants.sql'), 'utf8'), fileRollback = fs.readFileSync(path.join(ROOT, 'db', 'grants', 'm1-app-grants.rollback.sql'), 'utf8');
  for (const [name, edit] of [['an extra DELETE', (s) => s.replace('SELECT, INSERT, UPDATE ON', 'SELECT, INSERT, UPDATE, DELETE ON')], ['compensation added', (s) => s.replace('provider_services,', 'provider_services, provider_service_compensation,')], ['an extra statement', (s) => s + '\nGRANT ALL ON schema_migrations TO kaspchem_app;\n'], ['a statement removed', (s) => s.replace('GRANT USAGE ON SEQUENCE catalog_imports_id_seq TO kaspchem_app;', '')]]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ga-')); fs.writeFileSync(path.join(dir, 'm1-app-grants.sql'), edit(fileApply)); fs.writeFileSync(path.join(dir, 'm1-app-grants.rollback.sql'), fileRollback);
    assert.throws(() => G.sql('apply', { dir }), /does not contain exactly the reviewed statements/, name); assert.throws(() => G.sql('dryrun', { dir }), /reviewed statements/, name);
  }
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ga-')); fs.writeFileSync(path.join(dir2, 'm1-app-grants.sql'), fileApply); fs.writeFileSync(path.join(dir2, 'm1-app-grants.rollback.sql'), fileRollback.replace('REVOKE SELECT, INSERT ON catalog_imports', 'REVOKE SELECT ON catalog_imports'));
  assert.throws(() => G.sql('rollback', { dir: dir2 }), /reviewed statements/, 'a changed rollback file');
  const apply = G.sql('apply'), dry = G.sql('dryrun'), roll = G.sql('rollback'), pre = G.sql('pre'), post = G.sql('post');
  for (const s of [apply, dry, roll, pre, post]) assert.ok(!/[^\x00-\x7f]/.test(s), 'ASCII only');
  assert.equal((apply.match(/^\s*GRANT /gm) || []).length, 3); assert.equal((roll.match(/^\s*REVOKE /gm) || []).length, 3); assert.ok(!/\bREVOKE\b/.test(apply) && !/\bGRANT\b/.test(roll));
  for (const s of [apply, dry, roll]) { assert.ok(!/\bEXECUTE\b/i.test(s), 'no dynamic SQL'); assert.ok(!/\b(DELETE|TRUNCATE|ALTER|DROP|CREATE|COPY|CALL)\b/.test(s.replace(/'[^']*'/g, "''")), 'a forbidden verb outside a string'); assert.match(s, /^DO \$kc\$\nBEGIN\n/); assert.match(s, /\nEND\n\$kc\$$/); }
  assert.ok(dry.indexOf('DRY RUN') > 0 && dry.indexOf('DRY RUN') < dry.indexOf('GRANT SELECT, INSERT, UPDATE'), 'the dry run stops before the first GRANT');
  assert.ok(!/DRY RUN/.test(apply) && !/DRY RUN/.test(roll));
  const probe = G.sql('probe'); assert.ok(!/\b(GRANT|REVOKE)\b/.test(probe), 'the probe must contain no GRANT and no REVOKE'); assert.match(probe, /DRY RUN, every guard passed, nothing was granted/); assert.ok(!/[^\x00-\x7f]/.test(probe));
  assert.equal(probe.split('\n').length, dry.split('\n').length - 3, 'the probe is the dry run without its three GRANT lines');
  for (const s of [pre, post]) { assert.equal(pre, post); assert.doesNotThrow(() => M.readOnly(async () => [])(s), 'the state statement must be a plain read'); assert.ok(!/\b(INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/.test(s.replace(/'[^']*'/g, "''"))); }
  // the pinned facts agree with the runner and the files
  assert.deepEqual(G.MIGRATIONS.map((m) => m[0]), REAL.migrations.map((m) => m.id)); assert.deepEqual(G.MIGRATIONS.map((m) => m[1]), REAL.migrations.map((m) => m.sha));
  assert.equal(G.NEON_TARGET.identity, G.sha256('neondb|test'));
});

test('HAPPY PATH: pre-check, dry run (grants nothing), apply, post-check, with the judge saying GO each time; the result equals applying the file\'s statements directly', async () => {
  const pg = await fresh(); const t = T();
  const pre = await stateOf(pg, t); const before = await aclSnapshot(pg);
  const v0 = G.evaluate('pre', pre, null, { target: t }); assert.deepEqual(v0.problems, []); assert.equal(v0.ok, true);
  assert.equal(pre.endpoint, 'ep-test-fake'); assert.equal(pre.structure.md5, 'ee041cea851f2dc3287abe67ae6f8a56'); assert.equal(Number(pre.structure.lines), 429); assert.equal(Number(pre.tables), 20);
  // the dry run passes every guard and stops before any GRANT
  await assert.rejects(() => pg.query(G.sql('dryrun', { target: t })), /DRY RUN, every guard passed, nothing was granted/);
  await assert.rejects(() => pg.query(G.sql('probe', { target: t })), /DRY RUN, every guard passed, nothing was granted/);
  assert.equal(await aclSnapshot(pg), before, 'the dry run changed an ACL');
  // apply
  await pg.query(G.sql('apply', { target: t }));
  const post = await stateOf(pg, t); const v1 = G.evaluate('post', post, pre, { target: t }); assert.deepEqual(v1.problems, []); assert.equal(v1.ok, true);
  for (const [r, want] of Object.entries(G.NEW_APP)) assert.equal(post.relations[r].app, want, r);
  assert.equal(post.relations.provider_service_compensation.app, ''); assert.equal(post.relations.schema_migrations.app, '');
  // identical to running the file's statements directly
  const direct = await fresh(); for (const s of G.APPLY) await direct.exec(s);
  assert.equal(await aclSnapshot(pg), await aclSnapshot(direct), 'the guarded block and the plain statements gave different ACLs'); await direct.close();
  // a short smoke of what the restricted role can and cannot do now (the full matrix is in tests/grants.test.js)
  await asApp(pg, "INSERT INTO professionals (name) VALUES ('Synthetic Provider')"); await asApp(pg, "INSERT INTO services (name) VALUES ('Synthetic Service')");
  await asApp(pg, 'INSERT INTO provider_services (professional_id, service_id) VALUES (1, 1)');
  assert.equal((await asApp(pg, "INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES ('csv', 'x', 0, 0, 0, 0, 'o') RETURNING id")).rows.length, 1);
  for (const sql of ['SELECT * FROM provider_service_compensation', 'SELECT * FROM schema_migrations', 'DELETE FROM provider_services', 'TRUNCATE provider_services', 'UPDATE catalog_imports SET rows_total = 1', 'ALTER TABLE provider_services ADD COLUMN x int'])
    await assert.rejects(() => asApp(pg, sql), /permission denied|must be owner/, sql);
  await pg.close();
});

test('EVERY GUARD REFUSES FROM INSIDE and nothing is granted: wrong user, database, endpoint, environment, table count, migration history, identity record, missing role, default privileges, a privilege already there', async () => {
  const cases = [
    ['connected as another user', null, (pg) => pg, T({ owner: 'neondb_owner' }), /connected as postgres \(expected neondb_owner\)/],
    ['another database', null, (pg) => pg, T({ database: 'neondb' }), /database is postgres \(expected neondb\)/],
    ['another endpoint', 'ep-somewhere-else', (pg) => pg, T(), /endpoint is ep-somewhere-else/],
    ['no endpoint setting at all', null, (pg) => pg, T(), /endpoint is \(none\)/],
    ['the environment label is production', undefined, (pg) => pg.exec("UPDATE settings SET value = '\"production\"' WHERE key = 'meta.environment'"), T(), /environment label is not test/],
    ['a table too many', undefined, (pg) => pg.exec('CREATE TABLE stray (id int)'), T(), /exactly 20 tables/],
    ['a table too few (002 not applied: a 13-table database)', undefined, (pg) => pg.exec('DROP TABLE catalog_imports'), T(), /exactly 20 tables/],
    ['002 recorded with another fingerprint', undefined, (pg) => pg.exec("UPDATE schema_migrations SET checksum = 'ab' WHERE id = '002-provider-catalog'"), T(), /migration history/],
    ['the identity record changed', undefined, (pg) => pg.exec("UPDATE schema_migrations SET checksum = 'ab' WHERE id = '@identity'"), T(), /migration history/],
    ['a migration record missing', undefined, (pg) => pg.exec("DELETE FROM schema_migrations WHERE id = '002-provider-catalog'"), T(), /migration history/],
    ['a default privilege for kaspchem_app', undefined, (pg) => pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kaspchem_app'), T(), /default privileges exist that apply to objects created by postgres or that reach PUBLIC or kaspchem_app/],
    ['a default privilege that reaches PUBLIC', undefined, (pg) => pg.exec('ALTER DEFAULT PRIVILEGES FOR ROLE stranger IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC'), T(), /default privileges exist that apply/],
    ['a default privilege for the owner\'s own objects', undefined, (pg) => pg.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO stranger'), T(), /default privileges exist that apply/],
    ['kaspchem_app already has a privilege on a target table', undefined, (pg) => pg.exec('GRANT SELECT ON provider_services TO kaspchem_app'), T(), /already has a privilege/],
    ['kaspchem_app already has USAGE on the sequence', undefined, (pg) => pg.exec('GRANT USAGE ON SEQUENCE catalog_imports_id_seq TO kaspchem_app'), T(), /already has a privilege/],
    ['kaspchem_app already reads the confidential table', undefined, (pg) => pg.exec('GRANT SELECT ON provider_service_compensation TO kaspchem_app'), T(), /already has a privilege/],
    ['kaspchem_app already reads the bookkeeping table', undefined, (pg) => pg.exec('GRANT SELECT ON schema_migrations TO kaspchem_app'), T(), /already has a privilege/],
    ['the role kaspchem_app does not exist', undefined, async (pg) => { await pg.exec('DROP OWNED BY kaspchem_app'); await pg.exec('DROP ROLE kaspchem_app'); }, T(), /kaspchem_app does not exist/],
  ];
  for (const [name, endpoint, prepare, target, re] of cases) {
    const pg = await fresh(endpoint === null ? (name === 'no endpoint setting at all' ? null : undefined) : endpoint === undefined ? undefined : endpoint);
    if (name === 'another endpoint') await pg.exec("SELECT set_config('neon.endpoint_id', 'ep-somewhere-else', false)");
    await prepare(pg); const before = await aclSnapshot(pg);
    for (const kind of ['apply', 'dryrun', 'probe']) await assert.rejects(() => pg.query(G.sql(kind, { target })), (e) => { assert.match(e.message, REFUSED, name + ' (' + kind + ')'); assert.match(e.message, re, name + ' (' + kind + ')'); return true; });
    assert.equal(await aclSnapshot(pg), before, name + ': an ACL changed although the guard refused');
    await pg.close();
  }
  // Neon's own kind of default privilege (objects created by ANOTHER admin role give privileges to a third role) is harmless and must not stop the step
  const benign = await fresh();
  await benign.exec('CREATE ROLE neon_like NOLOGIN; ALTER DEFAULT PRIVILEGES FOR ROLE stranger IN SCHEMA public GRANT SELECT ON TABLES TO neon_like');
  await assert.rejects(() => benign.query(G.sql('probe', { target: T({ defaultAclTotal: 1 }) })), /DRY RUN, every guard passed/, 'a harmless default privilege must not stop the step');
  const benignState = await stateOf(benign, T({ defaultAclTotal: 1 })); assert.equal(Number(benignState.default_acl_total), 1); assert.equal(Number(benignState.default_acl_risky), 0);
  assert.deepEqual(G.evaluate('pre', benignState, null, { target: T({ defaultAclTotal: 1 }) }).problems, []); assert.equal(G.evaluate('pre', benignState, null, { target: T({ defaultAclTotal: 2 }) }).ok, false, 'the total of Neon\'s own defaults is pinned');
  await benign.close();
  // applying twice: the second run is refused and changes nothing
  const pg = await fresh(); await pg.query(G.sql('apply', { target: T() })); const once = await aclSnapshot(pg);
  await assert.rejects(() => pg.query(G.sql('apply', { target: T() })), /already has a privilege/); assert.equal(await aclSnapshot(pg), once); await pg.close();
});

test('THE JUDGE accepts the reviewed states and rejects every deviation (user, endpoint, tables, history, structure, default privileges, role attributes, base grants, closed tables, PUBLIC, grant option, row-level security, owner, missing relation, fingerprint)', () => {
  const t = G.NEON_TARGET;
  const synthetic = (phase) => {
    const rel = {};
    for (const [k, v] of Object.entries(G.BASE_TODAY)) rel[k] = { kind: 'r', owner: t.owner, acl_null: false, rls: false, public_or_grantable: 0, app: v };
    ['applicants', 'audit_log', 'consents', 'outcomes', 'pricing', 'professionals', 'questionnaire_versions', 'request_notes', 'revenues', 'services', 'treatment_requests'].forEach((x) => { rel[x + '_id_seq'] = { kind: 'S', owner: t.owner, acl_null: false, rls: false, public_or_grantable: 0, app: 'USAGE' }; });
    for (const r of G.NEW_RELATIONS) rel[r] = { kind: r.endsWith('_seq') ? 'S' : 'r', owner: t.owner, acl_null: phase === 'pre', rls: false, public_or_grantable: 0, app: phase === 'post' ? G.NEW_APP[r] : '' };
    return { database: t.database, user: t.owner, pg: t.pg, endpoint: t.endpoint, env: t.env, tables: t.tables, history: G.historyOf(t), structure: { md5: t.structureMd5, lines: t.structureLines }, default_acl_total: t.defaultAclTotal, default_acl_risky: 0,
      app_role: { login: true, super: false, createrole: false, createdb: false, bypassrls: false, replication: false, member_of: [] }, privileges: { md5: t.privFingerprint, lines: t.privLines }, relations: rel };
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const pre = synthetic('pre'), post = synthetic('post'), rolled = synthetic('post-rollback');
  assert.deepEqual(G.evaluate('pre', pre).problems, []); assert.deepEqual(G.evaluate('post', post, pre).problems, []); assert.deepEqual(G.evaluate('post-rollback', rolled, pre).problems, []);
  assert.deepEqual(G.evaluate('pre', [{ state: JSON.stringify(pre) }]).problems, [], 'the SQL tool\'s row shape is understood');
  const rejects = (phase, mutate, base, name) => { const s = clone(base); mutate(s); const v = G.evaluate(phase, s, phase === 'pre' ? null : pre); assert.equal(v.ok, false, name + ' must be rejected'); assert.ok(v.problems.length > 0, name); };
  const common = [
    ['another user', (s) => { s.user = 'kaspchem_app'; }], ['another database', (s) => { s.database = 'postgres'; }], ['another environment', (s) => { s.env = 'production'; }], ['another endpoint', (s) => { s.endpoint = 'ep-production-dddddd'; }],
    ['the test branch endpoint', (s) => { s.endpoint = 'ep-test-preview-cccccc'; }], ['13 tables', (s) => { s.tables = 13; }], ['21 tables', (s) => { s.tables = 21; }], ['history without 002', (s) => { s.history = s.history.split(',')[0]; }],
    ['another identity record', (s) => { s.history = s.history.replace(/@identity:.*/, '@identity:ab'); }], ['another structure', (s) => { s.structure.md5 = 'ab'; }], ['fewer structure lines', (s) => { s.structure.lines = 243; }],
    ['another privilege fingerprint', (s) => { s.privileges.md5 = 'ab'; }], ['a risky default privilege', (s) => { s.default_acl_risky = 1; }], ['another number of Neon\'s own default privileges', (s) => { s.default_acl_total = 3; }], ['no kaspchem_app', (s) => { s.app_role = null; }], ['a superuser app role', (s) => { s.app_role.super = true; }],
    ['an app role that can create roles', (s) => { s.app_role.createrole = true; }], ['an app role that bypasses RLS', (s) => { s.app_role.bypassrls = true; }], ['an app role that is a member of another role', (s) => { s.app_role.member_of = ['neon_superuser']; }],
    ['an app role that cannot log in', (s) => { s.app_role.login = false; }], ['DELETE on a base table', (s) => { s.relations.applicants.app = 'DELETE,INSERT,SELECT,UPDATE'; }], ['a base table without UPDATE', (s) => { s.relations.pricing.app = 'INSERT,SELECT'; }],
    ['a base sequence without USAGE', (s) => { s.relations.applicants_id_seq.app = ''; }], ['a missing new relation', (s) => { delete s.relations.catalog_imports; }], ['a new table with another owner', (s) => { s.relations.provider_services.owner = 'kaspchem_app'; }],
    ['row-level security on a new table', (s) => { s.relations.provider_services.rls = true; }], ['a PUBLIC or grantable entry on a new table', (s) => { s.relations.service_settings.public_or_grantable = 1; }],
  ];
  common.forEach(([name, m]) => { rejects('pre', m, pre, 'pre: ' + name); rejects('post', m, post, 'post: ' + name); rejects('post-rollback', m, rolled, 'rollback: ' + name); });
  rejects('pre', (s) => { s.relations.provider_services.app = 'SELECT'; }, pre, 'pre: a privilege already granted'); rejects('pre', (s) => { s.relations.provider_service_compensation.app = 'SELECT'; }, pre, 'pre: compensation already readable');
  rejects('pre', (s) => { s.relations.provider_services.acl_null = false; }, pre, 'pre: an ACL already present');
  const postCases = [['DELETE on engagements', (s) => { s.relations.provider_services.app += ',DELETE'; }], ['TRUNCATE on profiles', (s) => { s.relations.provider_profiles.app += ',TRUNCATE'; }], ['UPDATE on the import log', (s) => { s.relations.catalog_imports.app = 'INSERT,SELECT,UPDATE'; }],
    ['compensation readable', (s) => { s.relations.provider_service_compensation.app = 'SELECT'; }], ['the bookkeeping table readable', (s) => { s.relations.schema_migrations.app = 'SELECT'; }], ['SELECT on the sequence', (s) => { s.relations.catalog_imports_id_seq.app = 'SELECT,USAGE'; }],
    ['no USAGE on the sequence', (s) => { s.relations.catalog_imports_id_seq.app = ''; }], ['a missing grant on prices', (s) => { s.relations.provider_service_prices.app = 'INSERT,SELECT'; }], ['nothing granted at all', (s) => { for (const r of G.NEW_RELATIONS) s.relations[r].app = ''; }]];
  postCases.forEach(([name, m]) => rejects('post', m, post, 'post: ' + name));
  assert.equal(G.evaluate('post', clone(pre), pre).ok, false, 'the BEFORE state is not an AFTER state'); assert.equal(G.evaluate('pre', clone(post)).ok, false, 'the AFTER state is not a BEFORE state');
  const drift = clone(post); drift.structure.md5 = 'ab'; assert.equal(G.evaluate('post', drift, pre, { target: Object.assign({}, t, { structureMd5: null }) }).ok, false, 'structure compared with before');
  const moved = clone(post); moved.relations.settings.app = 'DELETE,INSERT,SELECT,UPDATE'; assert.equal(G.evaluate('post', moved, pre, { target: Object.assign({}, t, { privFingerprint: null }) }).ok, false, 'a base table changed compared with before');
  // a relation that is not in the plan at all: whatever kaspchem_app has on it must be the same before and after (a stray table must not gain or lose a privilege)
  const withStray = (st, app, grantable) => { const s = clone(st); s.relations.stray_table = { kind: 'r', owner: t.owner, acl_null: false, rls: false, public_or_grantable: grantable || 0, app }; return s; };
  assert.equal(G.evaluate('post', withStray(post, ''), withStray(pre, '')).ok, true, 'an unchanged stray relation is fine');
  assert.equal(G.evaluate('post', withStray(post, 'SELECT'), withStray(pre, '')).ok, false, 'a privilege appeared on a relation outside the plan');
  assert.equal(G.evaluate('post', withStray(post, '', 1), withStray(pre, '', 0)).ok, false, 'a PUBLIC or grantable entry appeared on a relation outside the plan');
  assert.equal(G.evaluate('post', post, withStray(pre, '')).ok, false, 'a relation outside the plan vanished');
  assert.equal(G.evaluate('nonsense', pre).ok, false); assert.equal(G.evaluate('pre', null).ok, false); assert.equal(G.evaluate('pre', {}).ok, false);
});

test('ROLLBACK: the REVOKE block takes back exactly what the grant gave (judged GO), has its own guards, can run twice, and the grant can be applied again afterwards', async () => {
  const pg = await fresh(); const t = T(); const pre = await stateOf(pg, t);
  await pg.query(G.sql('apply', { target: t })); const post = await stateOf(pg, t); assert.equal(G.evaluate('post', post, pre, { target: t }).ok, true);
  // guards of the rollback: wrong endpoint / user change nothing
  await pg.exec("SELECT set_config('neon.endpoint_id', 'ep-somewhere-else', false)"); const granted = await aclSnapshot(pg);
  await assert.rejects(() => pg.query(G.sql('rollback', { target: t })), /refused, endpoint is ep-somewhere-else/); assert.equal(await aclSnapshot(pg), granted);
  await assert.rejects(() => pg.query(G.sql('rollback', { target: T({ owner: 'neondb_owner' }) })), REFUSED); assert.equal(await aclSnapshot(pg), granted);
  await pg.exec("SELECT set_config('neon.endpoint_id', 'ep-test-fake', false)");
  await pg.query(G.sql('rollback', { target: t })); await pg.query(G.sql('rollback', { target: t }));   // twice
  const back = await stateOf(pg, t); const v = G.evaluate('post-rollback', back, pre, { target: t }); assert.deepEqual(v.problems, []); assert.equal(v.ok, true);
  for (const r of G.NEW_RELATIONS) assert.equal(back.relations[r].app, '', r + ' must be back to nothing');
  for (const sql of ['SELECT * FROM provider_services', 'SELECT * FROM catalog_imports']) await assert.rejects(() => asApp(pg, sql), /permission denied/);
  assert.equal((await asApp(pg, 'SELECT count(*)::int AS n FROM settings')).rows[0].n, 1, 'the existing grants survived the rollback');
  // the grant can be applied again (the guard looks at the effective privileges, not at the ACL text)
  await pg.query(G.sql('apply', { target: t })); assert.equal(G.evaluate('post', await stateOf(pg, t), pre, { target: t }).ok, true);
  await pg.close();
});

test('THE COMMAND LINE prints the same SQL and judges result files (also in the SQL tool\'s row shape); it refuses unknown input; it sends nothing anywhere', () => {
  const script = path.join(ROOT, 'scripts', 'kaspchem-grants.js'); const run = (args) => spawnSync(process.execPath, [script].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, { KASPCHEM_DATABASE_URL: '' }) });
  for (const w of ['pre', 'probe', 'dryrun', 'apply', 'post', 'rollback']) { const r = run(['--print', w]); assert.equal(r.status, 0, w); assert.equal(r.stdout, G.sql(w) + '\n', w); }
  assert.equal(run(['--print', 'nonsense']).status, 1); assert.equal(run([]).status, 2); assert.equal(run(['--evaluate', 'pre']).status, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-ga-cli-')); const t = G.NEON_TARGET;
  const bare = { database: t.database, user: t.owner, pg: t.pg, endpoint: t.endpoint, env: t.env, tables: 13, history: '', structure: { md5: 'ab', lines: 1 }, default_acl_total: 2, default_acl_risky: 0, app_role: null, privileges: { md5: 'ab', lines: 1 }, relations: {} };
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify([{ state: JSON.stringify(bare) }]));
  const bad = run(['--evaluate', 'pre', path.join(dir, 'bad.json')]); assert.equal(bad.status, 1); assert.match(bad.stdout, /VERDICT \(pre\): STOP/); assert.match(bad.stdout, /^PROBLEM tables: 13/m);
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json'); assert.equal(run(['--evaluate', 'pre', path.join(dir, 'junk.json')]).status, 1);
  const src = fs.readFileSync(script, 'utf8'); assert.ok(!/require\(['"](https?|net|tls|child_process|@neondatabase)/.test(src), 'the script has no way to reach a database or the network');
});
