'use strict';
// The M1 permission plan for the application role, tested on an in-memory Postgres (PGlite) with synthetic data. NOTHING here touches Neon.
//
// db/grants/m1-app-grants.sql is a PROPOSAL: it is applied to no real database. These tests build a database exactly as the Neon test branch is today (13 base tables with the
// grants kaspchem_app really has, read on 2026-11-06; then migrations 001 [adopted] and 002 through the real runner), apply the proposal, and check:
//   - the exact privilege matrix, for the application role and for roles that must have nothing (a future provider-portal role, a dedicated compensation role, a stranger);
//   - every forbidden access, run as the restricted role: the confidential compensation table, the migration bookkeeping table, DELETE, TRUNCATE, structure changes,
//     permission management and role escalation;
//   - that everything M1 needs still works as the restricted role (including upserts and the import log);
//   - what table privileges can and cannot do for compensation (credential versus person), with the alternatives tried for real;
//   - that the rollback file is the exact inverse, and that the proposal touches nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite: PGliteBase } = require('@electric-sql/pglite');
const M = require('../scripts/kaspchem-migrate.js');

// every database made here is closed when the file ends, even if a failing assertion skipped its own close() (an open one would keep a failing run from ending)
const OPEN = new Set();
// (a clone is made by the library itself, so its own clone() must be wrapped too: track() wraps both close() and clone() of every instance, clones of clones included)
const track = (db) => { OPEN.add(db); const close = db.close.bind(db); db.close = async () => { OPEN.delete(db); return close(); }; const clone = db.clone.bind(db); db.clone = async () => track(await clone()); return db; };
class PGlite extends PGliteBase { constructor(...a) { super(...a); track(this); } }
test.after(async () => { for (const db of [...OPEN]) { try { await db.close(); } catch (e) { /* closed */ } } });

const ROOT = path.join(__dirname, '..');
// (KC_GRANTS_DIR lets a mutation check run the same tests on a temporary, deliberately broken copy; by default the files in the repository are tested)
const GRANTS_DIR = process.env.KC_GRANTS_DIR || path.join(ROOT, 'db', 'grants');
const GRANTS_FILE = path.join(GRANTS_DIR, 'm1-app-grants.sql');
const ROLLBACK_FILE = path.join(GRANTS_DIR, 'm1-app-grants.rollback.sql');
const BASE_DDL = fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8');
const REAL = M.loadMigrations();
const qp = (pg) => async (t, p) => (await pg.query(t, p || [])).rows;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The matrix (the single source of truth for this file; docs/research/raw/PROVIDER-M1-PERMISSIONS.md shows the same table)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const BASE_TODAY = {   // what kaspchem_app really has on the 13 base tables today (read from the Neon temp branch on 2026-11-06): data only, no TRUNCATE/REFERENCES/TRIGGER anywhere
  applicants: 'INSERT,SELECT,UPDATE', audit_log: 'INSERT,SELECT', consents: 'INSERT,SELECT,UPDATE', outcomes: 'INSERT,SELECT,UPDATE', pricing: 'INSERT,SELECT,UPDATE',
  professionals: 'INSERT,SELECT,UPDATE', questionnaire_versions: 'DELETE,INSERT,SELECT,UPDATE', rate_limits: 'DELETE,INSERT,SELECT', request_notes: 'INSERT,SELECT',
  revenues: 'INSERT,SELECT,UPDATE', services: 'INSERT,SELECT,UPDATE', settings: 'INSERT,SELECT,UPDATE', treatment_requests: 'INSERT,SELECT,UPDATE',
};
const NEW_APP = {   // what the proposal gives kaspchem_app on the 6 new tables and the bookkeeping table
  provider_profiles: 'INSERT,SELECT,UPDATE', provider_services: 'INSERT,SELECT,UPDATE', provider_service_prices: 'INSERT,SELECT,UPDATE', service_settings: 'INSERT,SELECT,UPDATE',
  catalog_imports: 'INSERT,SELECT',
  provider_service_compensation: '',   // confidential: no access at all for the application role
  schema_migrations: '',               // belongs to the migration runner: no access at all for the application role
};
const NEW_TABLES = Object.keys(NEW_APP);
const BASE_TABLES = Object.keys(BASE_TODAY);
const ALL_TABLES = BASE_TABLES.concat(NEW_TABLES);
const COMP = 'provider_service_compensation';

const TODAY_GRANTS = `
  GRANT INSERT, SELECT, UPDATE ON applicants, consents, outcomes, pricing, professionals, revenues, services, settings, treatment_requests TO kaspchem_app;
  GRANT INSERT, SELECT ON audit_log, request_notes TO kaspchem_app;
  GRANT DELETE, INSERT, SELECT, UPDATE ON questionnaire_versions TO kaspchem_app;
  GRANT DELETE, INSERT, SELECT ON rate_limits TO kaspchem_app;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO kaspchem_app;`;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const statementsOf = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
const effective = async (pg, role, table) => { const out = []; for (const p of PRIVS) if ((await pg.query('SELECT has_table_privilege($1::name, $2::text, $3::text) AS ok', [role, table, p])).rows[0].ok) out.push(p); return out.sort().join(','); };
// SET SESSION AUTHORIZATION (not SET ROLE): the session user becomes the role, as after a real login, so the role cannot switch to the owner or any other role it is not a member of
// (PGlite's RESET SESSION AUTHORIZATION does not go back to the superuser, so the way back is an explicit SET SESSION AUTHORIZATION postgres)
const OWNER = 'postgres';
const asRole = async (pg, role, sql) => { await pg.exec('SET SESSION AUTHORIZATION ' + role); try { return await pg.query(sql); } finally { await pg.exec('SET SESSION AUTHORIZATION ' + OWNER); } };
const DENIED = /permission denied|must be owner|must be superuser|violates row-level security/;
const denied = async (pg, role, sql, re) => { await assert.rejects(() => asRole(pg, role, sql), re || DENIED, role + ': ' + sql); };
const aclOf = async (pg, names) => JSON.stringify((await pg.query(`SELECT c.relname, c.relkind::text AS kind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S') AND c.relname = ANY ($1) ORDER BY 1`, [names])).rows);
const allRelations = async (pg) => (await pg.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','S') ORDER BY 1")).rows.map((r) => r.relname);
const rowCount = async (pg, t) => (await pg.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
const matrixOf = async (pg, role) => { const out = {}; for (const t of ALL_TABLES) out[t] = await effective(pg, role, t); return out; };

// A database exactly as the Neon test branch is today: base schema, the environment label, the real grants of kaspchem_app, then 001 (adopted) and 002 through the real runner.
let MIGRATED = null;
async function migratedClone() {
  if (!MIGRATED) {
    const pg = new PGlite();
    await pg.exec(BASE_DDL);
    await pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '\"test\"', 'setup')");
    await pg.exec('CREATE ROLE kaspchem_app NOLOGIN; CREATE ROLE kaspchem_portal NOLOGIN; CREATE ROLE kaspchem_comp NOLOGIN; CREATE ROLE stranger NOLOGIN');
    await pg.exec(TODAY_GRANTS);
    const r = await M.apply(qp(pg), { migrations: REAL.migrations, expectEnv: 'test' });
    assert.equal(r.refused, false, (r.problems || []).join('; ')); assert.deepEqual(r.adopted, ['001-base']);
    MIGRATED = pg;
  }
  return MIGRATED.clone();
}
let GRANTED = null;   // the same database after the proposal was applied
async function grantedClone() {
  if (!GRANTED) { GRANTED = await migratedClone(); for (const s of statementsOf(GRANTS_FILE)) await GRANTED.exec(s); }
  return GRANTED.clone();
}
// synthetic data, written as the owner (the restricted role is tested separately)
async function seed(pg) {
  await pg.exec(`
    INSERT INTO professionals (name, contact) VALUES ('Synthetic Provider A', 'a@example.test'), ('Synthetic Provider B', NULL);
    INSERT INTO services (topic, name) VALUES ('synthetic', 'Synthetic Service One'), ('synthetic', 'Synthetic Service Two');
    INSERT INTO pricing (service_id, professional_id, label, price, approved, approved_by, approved_at, public) VALUES (1, 1, 'synthetic fixed price', 100, TRUE, 'owner@example.test', now(), FALSE);
    INSERT INTO provider_profiles (professional_id, business_name) VALUES (1, 'Synthetic Office');
    INSERT INTO provider_services (professional_id, service_id, external_ref, terms_note) VALUES (1, 1, 'A-1', 'internal terms'), (2, 1, 'B-1', NULL);
    INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, recorded_by) VALUES (1, 1, 'market', 'fixed', 500, 'owner@example.test');
    INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, payer_note, recorded_by) VALUES (1, 1, 'percent', 10, 'synthetic confidential note', 'owner@example.test');
    INSERT INTO service_settings (service_id, code) VALUES (1, 'synthetic-one');`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test('the proposal as a file: three GRANT statements, only the allowed relations, only kaspchem_app, never DELETE/TRUNCATE/REFERENCES/TRIGGER/ALL/PUBLIC/grant option/ON ALL; the rollback is its exact inverse', () => {
  const g = statementsOf(GRANTS_FILE), r = statementsOf(ROLLBACK_FILE);
  const raw = fs.readFileSync(GRANTS_FILE, 'utf8'), code = g.join(';\n');
  assert.ok(!/[^\x00-\x7f]/.test(raw + fs.readFileSync(ROLLBACK_FILE, 'utf8')), 'ASCII only');
  assert.equal(g.length, 3, g.join(' | '));
  const ALLOWED = ['provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'catalog_imports', 'catalog_imports_id_seq'];
  const parsed = g.map((s) => { const m = /^GRANT (SELECT, INSERT, UPDATE|SELECT, INSERT|USAGE) ON (SEQUENCE )?([a-z_]+(?:, [a-z_]+)*) TO kaspchem_app$/.exec(s); assert.ok(m, 'not an accepted shape: ' + s); return { privs: m[1], seq: !!m[2], rels: m[3].split(', ') }; });
  parsed.forEach((p) => p.rels.forEach((rel) => assert.ok(ALLOWED.includes(rel), 'a relation outside the allowed set: ' + rel)));
  assert.ok(!/DELETE|TRUNCATE|REFERENCES|TRIGGER|\bALL\b|PUBLIC|GRANT OPTION|ON ALL|MAINTAIN|CREATE|CONNECT|TEMP/i.test(code), 'a forbidden word is in the proposal');
  assert.ok(!/provider_service_compensation|schema_migrations/.test(code), 'the confidential and the bookkeeping table must not appear in a GRANT');
  assert.equal(new Set(parsed.flatMap((p) => p.rels)).size, ALLOWED.length, 'every allowed relation is granted exactly once');
  // the rollback: the same relations and privileges, as REVOKE ... FROM kaspchem_app, and nothing else
  assert.equal(r.length, 3);
  const inverse = g.map((s) => s.replace(/^GRANT /, 'REVOKE ').replace(/ TO kaspchem_app$/, ' FROM kaspchem_app')).sort();
  assert.deepEqual(r.slice().sort(), inverse, 'the rollback must be the exact inverse');
  assert.ok(r.every((s) => /^REVOKE /.test(s) && / FROM kaspchem_app$/.test(s)));
});

test('the starting point is the real one: today kaspchem_app has the recorded data-only grants on the 13 base tables and nothing on the 7 new tables; the other roles have nothing', async () => {
  const pg = await migratedClone();
  for (const [t, p] of Object.entries(BASE_TODAY)) assert.equal(await effective(pg, 'kaspchem_app', t), p, 'today: ' + t);
  for (const t of NEW_TABLES) assert.equal(await effective(pg, 'kaspchem_app', t), '', 'before the proposal kaspchem_app must have nothing on ' + t);
  for (const role of ['kaspchem_portal', 'kaspchem_comp', 'stranger']) for (const t of ALL_TABLES) assert.equal(await effective(pg, role, t), '', role + ' on ' + t);
  assert.equal((await pg.query("SELECT relacl IS NULL AS n FROM pg_class WHERE relname = 'provider_service_compensation'")).rows[0].n, true);
  await pg.close();
});

test('THE MATRIX: after the proposal kaspchem_app has exactly this on the 20 tables; the portal, compensation and stranger roles have nothing; no table outside the plan changed', async () => {
  const before = await migratedClone(); const aclBase0 = await aclOf(before, BASE_TABLES); const rels0 = await allRelations(before);
  const aclBefore = JSON.parse(await aclOf(before, rels0)); await before.close();
  const pg = await grantedClone();
  const app = await matrixOf(pg, 'kaspchem_app');
  for (const t of BASE_TABLES) assert.equal(app[t], BASE_TODAY[t], 'a base table changed: ' + t);
  for (const t of NEW_TABLES) assert.equal(app[t], NEW_APP[t], 'new table: ' + t);
  assert.equal(await aclOf(pg, BASE_TABLES), aclBase0, 'the ACL text of a base table changed');
  for (const role of ['kaspchem_portal', 'kaspchem_comp', 'stranger']) { const m = await matrixOf(pg, role); ALL_TABLES.forEach((t) => assert.equal(m[t], '', role + ' must have nothing on ' + t)); }
  // sequences: the only change is USAGE on catalog_imports_id_seq
  const seqUsage = async (role, s) => (await pg.query('SELECT has_sequence_privilege($1::name, $2::text, $3::text) AS ok', [role, s, 'USAGE'])).rows[0].ok;
  assert.equal(await seqUsage('kaspchem_app', 'catalog_imports_id_seq'), true); assert.equal(await seqUsage('kaspchem_app', 'applicants_id_seq'), true, 'today\'s sequence grants are unchanged');
  for (const p of ['SELECT', 'UPDATE']) assert.equal((await pg.query('SELECT has_sequence_privilege($1::name, $2::text, $3::text) AS ok', ['kaspchem_app', 'catalog_imports_id_seq', p])).rows[0].ok, false, 'sequence ' + p);
  for (const role of ['kaspchem_portal', 'kaspchem_comp', 'stranger']) assert.equal(await seqUsage(role, 'catalog_imports_id_seq'), false);
  // no grant option and no PUBLIC entry anywhere on the new relations
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.relname = ANY ($1) AND (a.is_grantable OR a.grantee = 0)", [NEW_TABLES.concat(['catalog_imports_id_seq'])])).rows[0].n, 0);
  // exactly these relations changed their ACL
  const rels = await allRelations(pg); const after = JSON.parse(await aclOf(pg, rels)); const changed = after.filter((a) => (aclBefore.find((b) => b.relname === a.relname) || {}).acl !== a.acl).map((a) => a.relname).sort();
  assert.deepEqual(changed, ['catalog_imports', 'catalog_imports_id_seq', 'provider_profiles', 'provider_service_prices', 'provider_services', 'service_settings'], 'the proposal changed the ACL of a relation that is not in the plan');
  await pg.close();
});

test('FORBIDDEN ACCESS as kaspchem_app: the confidential table and the bookkeeping table are unreachable; no DELETE or TRUNCATE anywhere in the new set; no structure change; no permission management; no escalation', async () => {
  const pg = await grantedClone(); await seed(pg);
  // compensation and schema_migrations: every kind of access
  for (const t of [COMP, 'schema_migrations']) {
    await denied(pg, 'kaspchem_app', `SELECT * FROM ${t}`); await denied(pg, 'kaspchem_app', `SELECT count(*) FROM ${t}`); await denied(pg, 'kaspchem_app', `UPDATE ${t} SET recorded_by = 'x'`.replace('recorded_by', t === COMP ? 'recorded_by' : 'checksum'));
    await denied(pg, 'kaspchem_app', `DELETE FROM ${t}`); await denied(pg, 'kaspchem_app', `TRUNCATE ${t}`);
  }
  await denied(pg, 'kaspchem_app', "INSERT INTO provider_service_compensation (professional_id, service_id, recorded_by) VALUES (2, 1, 'x')");
  await denied(pg, 'kaspchem_app', "INSERT INTO schema_migrations (id, checksum) VALUES ('009-fake', 'x')");
  await denied(pg, 'kaspchem_app', 'SELECT percent_recorded FROM provider_service_compensation'); await denied(pg, 'kaspchem_app', 'COPY (SELECT * FROM provider_service_compensation) TO STDOUT');
  // no DELETE and no TRUNCATE on any new table, no UPDATE where the table is append-only
  for (const t of NEW_TABLES) { await denied(pg, 'kaspchem_app', `DELETE FROM ${t}`); await denied(pg, 'kaspchem_app', `TRUNCATE ${t}`); }
  await denied(pg, 'kaspchem_app', 'UPDATE catalog_imports SET rows_total = 1');
  // the cascading deletes of the base tables can never be started by the application
  for (const t of ['professionals', 'services', 'pricing']) { await denied(pg, 'kaspchem_app', `DELETE FROM ${t}`); await denied(pg, 'kaspchem_app', `TRUNCATE ${t}`); }
  assert.equal(await rowCount(pg, 'provider_services'), 2); assert.equal(await rowCount(pg, COMP), 1); assert.equal(await rowCount(pg, 'professionals'), 2);
  // the sequence: USAGE only
  await denied(pg, 'kaspchem_app', 'SELECT last_value FROM catalog_imports_id_seq'); await denied(pg, 'kaspchem_app', "SELECT setval('catalog_imports_id_seq', 1000)");
  // structure changes
  for (const sql of ['ALTER TABLE provider_services ADD COLUMN stray int', 'ALTER TABLE provider_services DROP COLUMN terms_note', 'DROP TABLE provider_profiles', 'DROP TABLE provider_service_prices CASCADE', 'CREATE INDEX stray_idx ON provider_services (priority)',
    'CREATE TABLE app_made (id int)', 'CREATE TRIGGER stray_trg BEFORE INSERT ON provider_services FOR EACH ROW EXECUTE FUNCTION tsvector_update_trigger()', 'ALTER TABLE provider_services DISABLE TRIGGER ALL', 'ALTER TABLE provider_services ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE provider_services OWNER TO kaspchem_app', 'ALTER TABLE catalog_imports DROP CONSTRAINT catalog_imports_source_check', 'COMMENT ON TABLE provider_services IS \'x\''])
    await denied(pg, 'kaspchem_app', sql);
  // permission management and escalation: refused, or without any effect (a GRANT by a role without grant option is only a warning in Postgres: the EFFECT is what is checked)
  for (const sql of ['ALTER ROLE kaspchem_app SUPERUSER', 'ALTER ROLE kaspchem_app BYPASSRLS', 'CREATE ROLE evil LOGIN', "ALTER ROLE stranger PASSWORD 'x'", 'SET ROLE postgres', 'DROP ROLE stranger']) await denied(pg, 'kaspchem_app', sql);
  await asRole(pg, 'kaspchem_app', 'GRANT SELECT ON provider_services TO stranger').catch(() => {}); await asRole(pg, 'kaspchem_app', 'GRANT SELECT ON provider_service_compensation TO stranger').catch(() => {});
  await asRole(pg, 'kaspchem_app', 'REVOKE SELECT ON provider_services FROM kaspchem_app').catch(() => {});
  assert.equal(await effective(pg, 'stranger', 'provider_services'), '', 'kaspchem_app managed to grant'); assert.equal(await effective(pg, 'stranger', COMP), '');
  assert.equal(await effective(pg, 'kaspchem_app', 'provider_services'), 'INSERT,SELECT,UPDATE', 'kaspchem_app managed to revoke its own privilege');
  assert.equal((await pg.query("SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication FROM pg_roles WHERE rolname = 'kaspchem_app'")).rows[0].rolsuper, false);
  await pg.close();
});

test('INDIRECT LEAK PATHS for the confidential table: statistics, catalog views, column names, errors and joins show nothing to kaspchem_app; the data lives in no other table', async () => {
  const pg = await grantedClone(); await seed(pg); await pg.exec('ANALYZE provider_service_compensation');
  assert.ok((await pg.query("SELECT count(*)::int AS n FROM pg_stats WHERE tablename = 'provider_service_compensation'")).rows[0].n > 0, 'test setup: the owner sees statistics');
  const n = async (sql) => (await asRole(pg, 'kaspchem_app', sql)).rows[0].n;
  assert.equal(await n("SELECT count(*)::int AS n FROM pg_stats WHERE tablename = 'provider_service_compensation'"), 0, 'pg_stats shows values of the confidential table');
  assert.equal(await n("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'provider_service_compensation'"), 0);
  assert.equal(await n("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'schema_migrations'"), 0);
  assert.equal(await n("SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_name = 'provider_service_compensation' AND grantee = 'kaspchem_app'"), 0);
  // the confidential columns exist in exactly one table, and no view or function could expose them
  assert.deepEqual((await pg.query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('percent_recorded', 'fixed_recorded', 'payer_note')")).rows.map((r) => r.table_name), [COMP]);
  assert.equal((await pg.query("SELECT ((SELECT count(*) FROM pg_views WHERE schemaname = 'public') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'))::int AS n")).rows[0].n, 0);
  // a join or a subquery cannot read it, and permitted tables do not carry it
  await denied(pg, 'kaspchem_app', 'SELECT s.activation FROM provider_services s JOIN provider_service_compensation c USING (professional_id, service_id)');
  await denied(pg, 'kaspchem_app', 'SELECT activation, (SELECT percent_recorded FROM provider_service_compensation c WHERE c.professional_id = s.professional_id LIMIT 1) FROM provider_services s');
  const cols = (await asRole(pg, 'kaspchem_app', 'SELECT * FROM provider_services LIMIT 1')).fields.map((f) => f.name);
  assert.ok(!cols.some((c) => /percent|fixed_recorded|payer|compensation/.test(c)), 'a general query on engagements returns a compensation column: ' + cols.join(','));
  // an insert that violates a constraint of a permitted table reveals only that table's own key
  const err = await asRole(pg, 'kaspchem_app', "INSERT INTO provider_services (professional_id, service_id) VALUES (1, 1)").catch((e) => e.message);
  assert.match(String(err), /duplicate key value/); assert.ok(!/synthetic confidential|percent/.test(String(err)));
  await pg.close();
});

test('WHAT M1 NEEDS still works as kaspchem_app: catalog, providers, engagements, price layers, settings, the import log with its id, upserts and archiving; the safety rules still hold for the restricted role', async () => {
  const pg = await grantedClone(); const run = (sql) => asRole(pg, 'kaspchem_app', sql);
  await run("INSERT INTO professionals (name) VALUES ('Synthetic Provider A'), ('Synthetic Provider B')"); await run("INSERT INTO services (topic, name) VALUES ('synthetic', 'Synthetic Service One'), ('synthetic', 'Synthetic Service Two')");
  await run("INSERT INTO pricing (service_id, professional_id, label, price) VALUES (1, 1, 'synthetic', 100)"); await run("UPDATE pricing SET approved = TRUE, approved_by = 'owner@example.test', approved_at = now() WHERE id = 1");
  await run("INSERT INTO provider_profiles (professional_id, business_name, contact_email) VALUES (1, 'Synthetic Office', 'office@example.test')");
  await run("INSERT INTO provider_services (professional_id, service_id, external_ref) VALUES (1, 1, 'A-1'), (1, 2, 'A-2')");
  await run("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, recorded_by) VALUES (1, 1, 'market', 'fixed', 500, 'owner@example.test')");
  await run("INSERT INTO service_settings (service_id, code) VALUES (1, 'synthetic-one')");
  const imp = (await run("INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES ('csv', repeat('0', 64), 2, 2, 0, 0, 'owner@example.test') RETURNING id")).rows[0].id;
  assert.equal(String(imp), '1');
  assert.equal((await run('SELECT count(*)::int AS n FROM catalog_imports')).rows[0].n, 1);
  // updates and upserts (SELECT + INSERT + UPDATE together), archiving instead of deleting
  await run("UPDATE provider_services SET activation = 'paused', paused_reason = 'synthetic' WHERE professional_id = 1 AND service_id = 1");
  await run("UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 1");
  await run("INSERT INTO provider_services (professional_id, service_id, priority) VALUES (1, 1, 7) ON CONFLICT (professional_id, service_id) DO UPDATE SET priority = EXCLUDED.priority");
  await run("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, recorded_by) VALUES (1, 1, 'market', 'fixed', 650, 'owner@example.test') ON CONFLICT (professional_id, service_id, kind) DO UPDATE SET amount = EXCLUDED.amount");
  await run("INSERT INTO service_settings (service_id, code) VALUES (1, 'synthetic-one') ON CONFLICT (service_id) DO UPDATE SET updated_at = now()");
  await run("INSERT INTO provider_profiles (professional_id) VALUES (1) ON CONFLICT (professional_id) DO UPDATE SET paused_until = now()");
  await run("INSERT INTO audit_log (actor, action) VALUES ('owner@example.test', 'catalog.import.apply')");
  assert.equal((await run('SELECT priority FROM provider_services WHERE professional_id = 1 AND service_id = 1')).rows[0].priority, 7);
  assert.equal(String((await run("SELECT amount FROM provider_service_prices WHERE kind = 'market'")).rows[0].amount), '650.00');
  const joined = await run('SELECT p.name, s.name AS service, e.activation, pr.amount, ss.code FROM provider_services e JOIN professionals p ON p.id = e.professional_id JOIN services s ON s.id = e.service_id LEFT JOIN provider_service_prices pr USING (professional_id, service_id) LEFT JOIN service_settings ss ON ss.service_id = e.service_id LEFT JOIN provider_profiles pf ON pf.professional_id = e.professional_id ORDER BY 1, 2');
  assert.ok(joined.rows.length >= 2);
  // the database safety rules bind the restricted role too
  await assert.rejects(() => run("UPDATE provider_services SET activation = 'active' WHERE professional_id = 1 AND service_id = 2"), /violates check constraint/);
  await assert.rejects(() => run("INSERT INTO service_settings (service_id, code, offered) VALUES (2, 'svc-two', TRUE)"), /violates check constraint/);
  await assert.rejects(() => run("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, recorded_by) VALUES (1, 2, 'market', 'fixed', 'x')"), /violates check constraint/);
  await pg.close();
});

test('COMPENSATION, what table privileges can and cannot do (the alternatives tried for real): one credential cannot tell two people apart; a dedicated role keeps every other code path out; a per-request flag is protection against forgetting, not against the function itself', async () => {
  // (a) the existing mechanism: grant it to kaspchem_app. Every request of the admin function uses that same role, so the database cannot tell the owner from anyone else.
  const a = await grantedClone(); await seed(a); await a.exec(`GRANT SELECT, INSERT, UPDATE ON ${COMP} TO kaspchem_app`);
  const sessionOwner = await asRole(a, 'kaspchem_app', `SELECT percent_recorded FROM ${COMP}`), sessionOps = await asRole(a, 'kaspchem_app', `SELECT payer_note FROM ${COMP}`);
  assert.equal(sessionOwner.rows.length, 1); assert.equal(sessionOps.rows.length, 1, 'with one shared credential both "people" read it: only the server\'s own role check can tell them apart');
  assert.equal(await effective(a, 'kaspchem_portal', COMP), '', 'granting it to kaspchem_app gives the portal role nothing'); await a.close();

  // (b) a dedicated role/credential: only the owner-only module would hold it. Every other code path (and the future portal) stays out at the database level.
  const b = await grantedClone(); await seed(b); await b.exec(`GRANT SELECT, INSERT, UPDATE ON ${COMP} TO kaspchem_comp`);
  assert.equal(await effective(b, 'kaspchem_comp', COMP), 'INSERT,SELECT,UPDATE'); assert.equal((await asRole(b, 'kaspchem_comp', `SELECT percent_recorded FROM ${COMP}`)).rows.length, 1);
  const insertFk = await asRole(b, 'kaspchem_comp', `INSERT INTO ${COMP} (professional_id, service_id, model, recorded_by) VALUES (2, 1, 'tbd', 'owner@example.test')`).then(() => 'works without any privilege on the engagement table (the foreign key check runs as the table owner)').catch((e) => 'refused: ' + e.message);
  assert.match(insertFk, /^works without any privilege/, insertFk);
  for (const t of BASE_TABLES.concat(['provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'catalog_imports', 'schema_migrations'])) await denied(b, 'kaspchem_comp', `SELECT * FROM ${t}`);
  await denied(b, 'kaspchem_comp', `DELETE FROM ${COMP}`); await denied(b, 'kaspchem_comp', `TRUNCATE ${COMP}`);
  await denied(b, 'kaspchem_app', `SELECT * FROM ${COMP}`); await denied(b, 'kaspchem_portal', `SELECT * FROM ${COMP}`); await b.close();

  // (c) row-level security keyed to a per-request flag, with the same credential: rows appear only when the request declares itself owner-only. This stops code that FORGETS to declare it
  // (a general query, a new endpoint) but not the function itself, which could declare it too. It also needs a schema change (ALTER TABLE ... ENABLE ROW LEVEL SECURITY), i.e. a new migration.
  const c = await grantedClone(); await seed(c);
  await c.exec(`ALTER TABLE ${COMP} ENABLE ROW LEVEL SECURITY; CREATE POLICY comp_owner_only ON ${COMP} FOR ALL TO kaspchem_app USING (current_setting('app.owner_request', true) = 'on') WITH CHECK (current_setting('app.owner_request', true) = 'on'); GRANT SELECT, INSERT, UPDATE ON ${COMP} TO kaspchem_app`);
  assert.equal((await asRole(c, 'kaspchem_app', `SELECT * FROM ${COMP}`)).rows.length, 0, 'without the flag the row is invisible');
  await denied(c, 'kaspchem_app', `INSERT INTO ${COMP} (professional_id, service_id, recorded_by) VALUES (2, 1, 'x')`, /row-level security/);
  await c.exec('SET SESSION AUTHORIZATION kaspchem_app'); await c.exec("SELECT set_config('app.owner_request', 'on', false)");
  assert.equal((await c.query(`SELECT * FROM ${COMP}`)).rows.length, 1, 'with the flag it is visible'); await c.exec("SELECT set_config('app.owner_request', '', false)"); await c.exec('SET SESSION AUTHORIZATION ' + OWNER);
  assert.equal((await asRole(c, 'kaspchem_app', `SELECT * FROM ${COMP}`)).rows.length, 0); await c.close();
});

test('THE FUTURE PROVIDER PORTAL: a separate role starts with nothing and the database can hide internal columns; the application role\'s grants do not reach it', async () => {
  const pg = await grantedClone(); await seed(pg);
  for (const t of ALL_TABLES) await denied(pg, 'kaspchem_portal', `SELECT * FROM ${t}`);
  await pg.exec('GRANT SELECT (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, priority) ON provider_services TO kaspchem_portal');
  assert.equal((await asRole(pg, 'kaspchem_portal', 'SELECT professional_id, activation, priority FROM provider_services')).rows.length, 2);
  await denied(pg, 'kaspchem_portal', 'SELECT * FROM provider_services'); await denied(pg, 'kaspchem_portal', 'SELECT terms_note FROM provider_services'); await denied(pg, 'kaspchem_portal', 'SELECT paused_reason FROM provider_services');
  await denied(pg, 'kaspchem_portal', 'UPDATE provider_services SET priority = 1'); await denied(pg, 'kaspchem_portal', 'DELETE FROM provider_services');
  for (const t of [COMP, 'provider_service_prices', 'provider_profiles', 'service_settings', 'catalog_imports', 'schema_migrations', 'audit_log', 'pricing', 'applicants']) await denied(pg, 'kaspchem_portal', `SELECT * FROM ${t}`);
  await pg.close();
});

test('APPLYING and ROLLING BACK: the proposal is idempotent; the rollback restores the effective privileges exactly and touches nothing else; both leave the base tables alone', async () => {
  const pg = await migratedClone(); const base0 = await aclOf(pg, BASE_TABLES); const before = { app: await matrixOf(pg, 'kaspchem_app'), other: await matrixOf(pg, 'stranger') };
  for (let i = 0; i < 2; i++) for (const s of statementsOf(GRANTS_FILE)) await pg.exec(s);
  const once = await aclOf(pg, NEW_TABLES.concat(['catalog_imports_id_seq']));
  for (const s of statementsOf(GRANTS_FILE)) await pg.exec(s);
  assert.equal(await aclOf(pg, NEW_TABLES.concat(['catalog_imports_id_seq'])), once, 'applying again changed the ACL');
  assert.notDeepEqual(await matrixOf(pg, 'kaspchem_app'), before.app);
  for (let i = 0; i < 2; i++) for (const s of statementsOf(ROLLBACK_FILE)) await pg.exec(s);
  assert.deepEqual(await matrixOf(pg, 'kaspchem_app'), before.app, 'the rollback did not restore the effective privileges'); assert.deepEqual(await matrixOf(pg, 'stranger'), before.other);
  assert.equal(await aclOf(pg, BASE_TABLES), base0, 'a base table changed');
  const seqUsage = (await pg.query("SELECT has_sequence_privilege('kaspchem_app', 'catalog_imports_id_seq', 'USAGE') AS ok")).rows[0].ok; assert.equal(seqUsage, false);
  await denied(pg, 'kaspchem_app', 'SELECT * FROM catalog_imports');
  await pg.close();
});
