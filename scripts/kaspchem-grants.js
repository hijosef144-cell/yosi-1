'use strict';
// The M1 grant step as code: builds the exact SQL and judges the results. It connects to NOTHING and sends NOTHING.
//
//   node scripts/kaspchem-grants.js --print pre|probe|dryrun|apply|post|rollback
//        (probe = the guards only, no GRANT in the text at all: the check to run first on a real database)
//        prints ONE SQL statement, to be sent as the database owner through a connection the owner trusts (the Neon SQL tool, which resolves the credentials itself and never
//        shows them), pinned to the temporary branch. pre/post only READ. dryrun checks every guard and then stops before any GRANT (it grants nothing). apply and rollback are
//        single DO blocks: they run as ONE transaction, they refuse to run anywhere but on the database they were written for (user, database, endpoint, migration history,
//        table count, environment label, no default privileges, the application role exists and has none of the target privileges yet), and they contain exactly the statements
//        of db/grants/m1-app-grants.sql (or its rollback), nothing else.
//   node scripts/kaspchem-grants.js --evaluate pre|post|post-rollback <results.json> [--before <pre-results.json>]
//        judges the result of the pre/post statement (exit 0 = go on, exit 1 = STOP and report). The result is what the SQL tool returned, saved as a file.
//
// Nothing is applied by this file. Whoever applies it needs the owner's explicit approval, for the temporary branch only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const GRANTS_DIR = path.join(ROOT, 'db', 'grants');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- what the files must contain, exactly -------------------------------------------------------------------------------------------------------------------
const APPLY = [
  'GRANT SELECT, INSERT, UPDATE ON provider_profiles, provider_services, provider_service_prices, service_settings TO kaspchem_app',
  'GRANT SELECT, INSERT ON catalog_imports TO kaspchem_app',
  'GRANT USAGE ON SEQUENCE catalog_imports_id_seq TO kaspchem_app',
];
const ROLLBACK = [
  'REVOKE USAGE ON SEQUENCE catalog_imports_id_seq FROM kaspchem_app',
  'REVOKE SELECT, INSERT ON catalog_imports FROM kaspchem_app',
  'REVOKE SELECT, INSERT, UPDATE ON provider_profiles, provider_services, provider_service_prices, service_settings FROM kaspchem_app',
];
const statementsOf = (text) => String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
// Reads a grants file and refuses anything but the exact statements (a changed file can never reach the database through this script).
function loadStatements(kind, dir) {
  const file = path.join(dir || GRANTS_DIR, kind === 'apply' ? 'm1-app-grants.sql' : 'm1-app-grants.rollback.sql');
  const got = statementsOf(fs.readFileSync(file, 'utf8')), want = kind === 'apply' ? APPLY : ROLLBACK;
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('refused: ' + path.basename(file) + ' does not contain exactly the reviewed statements');
  return want.slice();
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------------------
const CHANGED = ['catalog_imports', 'catalog_imports_id_seq', 'provider_profiles', 'provider_service_prices', 'provider_services', 'service_settings'];   // the only relations whose ACL may change
const CLOSED = ['provider_service_compensation', 'schema_migrations'];                                                                                       // must stay closed to the application role
const NEW_RELATIONS = CHANGED.concat(CLOSED).sort();
const NEW_APP = {   // what kaspchem_app has on the new relations AFTER the grants
  provider_profiles: 'INSERT,SELECT,UPDATE', provider_services: 'INSERT,SELECT,UPDATE', provider_service_prices: 'INSERT,SELECT,UPDATE', service_settings: 'INSERT,SELECT,UPDATE',
  catalog_imports: 'INSERT,SELECT', catalog_imports_id_seq: 'USAGE', provider_service_compensation: '', schema_migrations: '',
};
const NONE_APP = Object.fromEntries(NEW_RELATIONS.map((r) => [r, '']));   // what it has BEFORE the grants (and after a rollback)
const BASE_TODAY = {   // the real grants of kaspchem_app on the 13 base tables (read from the Neon temporary branch on 2026-11-06); they must not change
  applicants: 'INSERT,SELECT,UPDATE', audit_log: 'INSERT,SELECT', consents: 'INSERT,SELECT,UPDATE', outcomes: 'INSERT,SELECT,UPDATE', pricing: 'INSERT,SELECT,UPDATE',
  professionals: 'INSERT,SELECT,UPDATE', questionnaire_versions: 'DELETE,INSERT,SELECT,UPDATE', rate_limits: 'DELETE,INSERT,SELECT', request_notes: 'INSERT,SELECT',
  revenues: 'INSERT,SELECT,UPDATE', services: 'INSERT,SELECT,UPDATE', settings: 'INSERT,SELECT,UPDATE', treatment_requests: 'INSERT,SELECT,UPDATE',
};
const BASE_SEQUENCES = ['applicants', 'audit_log', 'consents', 'outcomes', 'pricing', 'professionals', 'questionnaire_versions', 'request_notes', 'revenues', 'services', 'treatment_requests'].map((t) => t + '_id_seq');
const MIGRATIONS = [['001-base', '55d6624afcab982addf23f798375ea4aed43c518be90942017114dfe07222860'], ['002-provider-catalog', '5138ec64630d79788ff135c3db14972e1290643d5a3eccbbf62c05eea41dbbf6']];
const MIGRATION_003 = ['003-price-race-guard', '84c0d179ba75c8c5d3fe9672c9ecc4113882633c9afc0e32570fe02f36ce24f2'];   // only a production target that has 003 applied BEFORE the grants lists it

// The database this step is written for: the Neon temporary branch br-temp-baseline-aaaaaa after migrations 001 (adopted) and 002.
const NEON_TARGET = {
  owner: 'neondb_owner', database: 'neondb', env: 'test', endpoint: 'ep-temp-branch-aaaaaa', pg: '18.6', tables: 20,
  defaultAclTotal: 2,   // Neon's own: objects created by cloud_admin in public give privileges to neon_superuser (read on 2026-11-07)
  identity: sha256('neondb|test'),
  structureMd5: 'ee041cea851f2dc3287abe67ae6f8a56', structureLines: 429,
  privFingerprint: 'd856a513b97dcba04e2c584f9910ab1d', privLines: 215,   // role/membership/ACL/schema/database lines, the six changing relations left out (they carry no ACL today)
};
// The PRODUCTION database (read-only, step 0, 2026-11-12: 13 tables, no schema_migrations table yet, structure d1e08acf... = 001-base exactly, privilege fingerprint d856a513... with 215 lines, kaspchem_app with a password and
// exactly the grants of BASE_TODAY, only kaspchem_app sessions). The state the grants meet is the state AFTER the migrations: 20 tables (13 + the bookkeeping table + six catalog tables), the history 001 (adopted), 002 and the identity
// record of this database, optionally 003 when it was applied first. Nothing here can name the database: the endpoint id is given at run time (--expect-endpoint=ep-...) so that the public repository never carries it. The identity checks
// are stricter than the temporary branch's: besides what every target checks, the DO block compares the STRUCTURE and the PRIVILEGE fingerprint from inside and refuses when a catalog switch is already open.
function productionTarget(endpoint, opts) {
  if (typeof endpoint !== 'string' || !/^ep-[a-z0-9]+(-[a-z0-9]+){1,4}$/.test(endpoint) || endpoint.length > 60) throw new Error('the production target needs --expect-endpoint=ep-... (the endpoint id of the production branch, read from Neon, never from this file)');
  const with003 = !!(opts && opts.after003);
  return {
    owner: 'neondb_owner', database: 'neondb', env: 'production', endpoint, pg: '18.6', tables: 20, defaultAclTotal: 2, identity: sha256('neondb|production'),
    migrations: with003 ? MIGRATIONS.concat([MIGRATION_003]) : MIGRATIONS,
    structureMd5: with003 ? '6e4d3d7e5b8b63a8cd0e38d07edc60e3' : 'ee041cea851f2dc3287abe67ae6f8a56', structureLines: with003 ? 430 : 429,
    privFingerprint: 'd856a513b97dcba04e2c584f9910ab1d', privLines: 215,
    guardStructure: true, switchesClosed: true,
  };
}
const historyOf = (t) => (t.migrations || MIGRATIONS).map(([id, sum]) => id + ':' + sum).concat(['@identity:' + t.identity]).join(',');
const lit = (v) => { const s = String(v); if (!/^[A-Za-z0-9_:.,|@\-]+$/.test(s)) throw new Error('unsafe literal: ' + s); return "'" + s + "'"; };
const arr = (list) => 'ARRAY[' + list.map(lit).join(', ') + ']';

// ---- the SQL -------------------------------------------------------------------------------------------------------------------------------------------------
function signatureSql() {   // scripts/schema-signature.sql without its comment lines and final semicolon: one cell, `signature`
  return fs.readFileSync(path.join(__dirname, 'schema-signature.sql'), 'utf8').split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n').replace(/;\s*$/, '');
}
const privLinesSql = (changed) => `
  SELECT 'role ' || rolname || ' super=' || rolsuper || ' login=' || rolcanlogin || ' createrole=' || rolcreaterole || ' createdb=' || rolcreatedb || ' repl=' || rolreplication || ' bypassrls=' || rolbypassrls AS line FROM pg_roles WHERE rolname !~ '^pg_'
  UNION ALL SELECT 'member ' || r.rolname || ' of ' || g.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid WHERE r.rolname !~ '^pg_'
  UNION ALL SELECT 'acl ' || c.relkind::text || ' ' || c.relname || ' ' || coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type || ' grantable=' || a.is_grantable FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') AND c.relname <> ALL (${arr(changed)})
  UNION ALL SELECT 'schema ' || n.nspname || ' ' || coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee WHERE n.nspname = 'public'
  UNION ALL SELECT 'db ' || d.datname || ' ' || coalesce(g.rolname, 'PUBLIC') || ' ' || a.privilege_type FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a LEFT JOIN pg_roles g ON g.oid = a.grantee WHERE d.datname = current_database()`;

// READ-ONLY. One row, one cell `state`: everything the evaluator needs.
function stateSql() {
  return `SELECT jsonb_build_object(
  'database', current_database(),
  'user', current_user,
  'pg', split_part(version(), ' ', 2),
  'endpoint', current_setting('neon.endpoint_id', true),
  'env', (SELECT value #>> '{}' FROM settings WHERE key = 'meta.environment'),
  'tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'),
  'history', (SELECT coalesce(string_agg(id || ':' || checksum, ',' ORDER BY id COLLATE "C"), '') FROM schema_migrations),
  'structure', (SELECT jsonb_build_object('md5', md5(signature), 'lines', array_length(string_to_array(signature, E'\\n'), 1)) FROM (${signatureSql()}) sig),
  'default_acl_total', (SELECT count(*) FROM pg_default_acl),
  'default_acl_risky', (SELECT count(*) FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user) OR a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'kaspchem_app')),
  'app_role', (SELECT jsonb_build_object('login', rolcanlogin, 'super', rolsuper, 'createrole', rolcreaterole, 'createdb', rolcreatedb, 'bypassrls', rolbypassrls, 'replication', rolreplication,
      'member_of', (SELECT coalesce(jsonb_agg(g.rolname ORDER BY g.rolname), '[]'::jsonb) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid)) FROM pg_roles r WHERE r.rolname = 'kaspchem_app'),
  'privileges', (SELECT jsonb_build_object('md5', md5(string_agg(line, E'\\n' ORDER BY line)), 'lines', count(*)) FROM (${privLinesSql(CHANGED)}) l),
  'relations', (SELECT coalesce(jsonb_object_agg(c.relname, jsonb_build_object('kind', c.relkind::text, 'owner', pg_get_userbyid(c.relowner), 'acl_null', c.relacl IS NULL, 'rls', c.relrowsecurity,
      'public_or_grantable', (SELECT count(*) FROM aclexplode(c.relacl) a WHERE a.grantee = 0 OR a.is_grantable),
      'app', CASE WHEN to_regrole('kaspchem_app') IS NULL THEN NULL
                  WHEN c.relkind = 'S' THEN (SELECT coalesce(string_agg(p, ',' ORDER BY p), '') FROM unnest(ARRAY['SELECT', 'UPDATE', 'USAGE']) p WHERE has_sequence_privilege('kaspchem_app', c.oid, p))
                  ELSE (SELECT coalesce(string_agg(p, ',' ORDER BY p), '') FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p WHERE has_table_privilege('kaspchem_app', c.oid, p)) END)), '{}'::jsonb)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S'))
)::text AS state`;
}

// The guards every DO block starts with. They need no data from outside: whatever database they run on is checked from inside.
function guardsSql(t, kind) {
  const g = [];
  g.push(`IF current_user <> ${lit(t.owner)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, connected as % (expected ${t.owner})', current_user; END IF;`);
  g.push(`IF current_database() <> ${lit(t.database)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, database is % (expected ${t.database})', current_database(); END IF;`);
  if (t.endpoint) g.push(`IF current_setting('neon.endpoint_id', true) IS DISTINCT FROM ${lit(t.endpoint)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, endpoint is % (expected ${t.endpoint})', coalesce(current_setting('neon.endpoint_id', true), '(none)'); END IF;`);
  g.push(`IF (SELECT value #>> '{}' FROM settings WHERE key = 'meta.environment') IS DISTINCT FROM ${lit(t.env)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, environment label is not ${t.env}'; END IF;`);
  g.push(`IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r') <> ${Number(t.tables)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, the database does not have exactly ${t.tables} tables'; END IF;`);
  g.push(`IF (SELECT coalesce(string_agg(id || ':' || checksum, ',' ORDER BY id COLLATE "C"), '') FROM schema_migrations) <> ${lit(historyOf(t))} THEN RAISE EXCEPTION 'kaspchem-grants: refused, the migration history is not ${(t.migrations || MIGRATIONS).map((m) => m[0]).join(', ')} and the identity record'; END IF;`);
  g.push(`IF to_regrole('kaspchem_app') IS NULL THEN RAISE EXCEPTION 'kaspchem-grants: refused, the role kaspchem_app does not exist'; END IF;`);
  if (t.guardStructure && kind !== 'rollback') {   // the strict identity of a production target, checked from inside the same transaction that grants
    if (t.structureMd5) g.push(`IF (SELECT md5(signature) FROM (${signatureSql()}) sig) IS DISTINCT FROM ${lit(t.structureMd5)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, the structure of the database is not the reviewed one'; END IF;`);
    if (t.privFingerprint) g.push(`IF (SELECT md5(string_agg(line, E'\\n' ORDER BY line)) FROM (${privLinesSql(CHANGED)}) l) IS DISTINCT FROM ${lit(t.privFingerprint)} THEN RAISE EXCEPTION 'kaspchem-grants: refused, the privileges of the database are not the reviewed ones'; END IF;`);
  }
  if (t.switchesClosed && kind !== 'rollback') g.push(`IF EXISTS (SELECT 1 FROM settings WHERE key IN ('private.catalog_enabled', 'private.catalog_activation_enabled') AND value = 'true'::jsonb) THEN RAISE EXCEPTION 'kaspchem-grants: refused, a catalog switch is already open'; END IF;`);
  // Neon itself keeps default privileges for objects created by its own admin role (cloud_admin -> neon_superuser): those are harmless here. What must not exist: a default that applies to objects
  // created by the owner role, or one that reaches PUBLIC or kaspchem_app (it would hand out privileges on future tables by itself).
  g.push(`IF EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = ${lit(t.owner)}) OR a.grantee = 0 OR a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'kaspchem_app')) THEN RAISE EXCEPTION 'kaspchem-grants: refused, default privileges exist that apply to objects created by ${t.owner} or that reach PUBLIC or kaspchem_app'; END IF;`);
  g.push(`IF (SELECT count(*) FROM unnest(${arr(NEW_RELATIONS)}) r WHERE to_regclass('public.' || r) IS NULL) <> 0 THEN RAISE EXCEPTION 'kaspchem-grants: refused, one of the new relations does not exist'; END IF;`);
  if (kind !== 'rollback') {   // a grant starts from a clean state; a rollback must work from any state
    g.push(`IF EXISTS (SELECT 1 FROM unnest(${arr(NEW_RELATIONS.filter((r) => r !== 'catalog_imports_id_seq'))}) r WHERE has_table_privilege('kaspchem_app'::name, ('public.' || r)::text, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR has_sequence_privilege('kaspchem_app'::name, 'public.catalog_imports_id_seq'::text, 'USAGE,SELECT,UPDATE') THEN RAISE EXCEPTION 'kaspchem-grants: refused, kaspchem_app already has a privilege on a target relation'; END IF;`);
  }
  return g;
}
function doBlock(t, kind, statements, stopBeforeChanging) {
  const body = guardsSql(t, kind).map((s) => '  ' + s);
  if (stopBeforeChanging) body.push("  IF true THEN RAISE EXCEPTION 'kaspchem-grants: DRY RUN, every guard passed, nothing was granted'; END IF;");
  statements.forEach((s) => body.push('  ' + s + ';'));
  return 'DO $kc$\nBEGIN\n' + body.join('\n') + '\nEND\n$kc$';
}
function sql(what, opts) {
  const o = opts || {}, t = o.target || NEON_TARGET;
  if (what === 'pre' || what === 'post') return stateSql();
  if (what === 'apply') return doBlock(t, 'apply', loadStatements('apply', o.dir), false);
  if (what === 'dryrun') return doBlock(t, 'apply', loadStatements('apply', o.dir), true);
  if (what === 'probe') return doBlock(t, 'apply', [], true);   // the guards and the early stop only: it contains NO GRANT at all (safe even if a tool were to split the text at semicolons)
  if (what === 'rollback') return doBlock(t, 'rollback', loadStatements('rollback', o.dir), false);
  throw new Error('unknown statement: ' + what);
}

// ---- the judge -----------------------------------------------------------------------------------------------------------------------------------------------
const parseState = (raw) => { let v = raw; if (typeof v === 'string') v = JSON.parse(v); if (Array.isArray(v)) v = v[0]; if (v && v.state !== undefined) v = v.state; if (typeof v === 'string') v = JSON.parse(v); return v; };
// phase: 'pre' (nothing granted yet), 'post' (the proposal applied), 'post-rollback' (back to nothing). before: the parsed result of the pre statement, for post phases.
function evaluate(phase, rawState, rawBefore, opts) {
  const t = (opts && opts.target) || NEON_TARGET, problems = [], s = parseState(rawState), before = rawBefore ? parseState(rawBefore) : null;
  const bad = (m) => problems.push(m), eq = (what, got, want) => { if (got !== want) bad(what + ': ' + JSON.stringify(got) + ' (expected ' + JSON.stringify(want) + ')'); };
  if (!['pre', 'post', 'post-rollback'].includes(phase)) return { ok: false, problems: ['unknown phase ' + phase] };
  if (!s || typeof s !== 'object') return { ok: false, problems: ['the result is not a state object'] };
  eq('user', s.user, t.owner); eq('database', s.database, t.database); eq('environment', s.env, t.env); if (t.endpoint) eq('endpoint', s.endpoint, t.endpoint);
  if (t.pg) eq('postgres version', s.pg, t.pg);
  eq('tables', Number(s.tables), t.tables); eq('migration history', s.history, historyOf(t));
  eq('default privileges that apply to the owner\'s objects or reach PUBLIC or kaspchem_app', Number(s.default_acl_risky), 0);
  if (t.defaultAclTotal !== null && t.defaultAclTotal !== undefined) eq('default privileges in total (Neon\'s own)', Number(s.default_acl_total), t.defaultAclTotal);
  if (before) eq('default privileges in total compared with before', Number(s.default_acl_total), Number(before.default_acl_total));
  if (t.structureMd5) { eq('structure md5', s.structure && s.structure.md5, t.structureMd5); eq('structure lines', s.structure && Number(s.structure.lines), t.structureLines); }
  if (t.privFingerprint) { eq('privilege fingerprint (without the six changing relations)', s.privileges && s.privileges.md5, t.privFingerprint); eq('privilege lines', s.privileges && Number(s.privileges.lines), t.privLines); }
  const r = s.role || s.app_role;
  if (!r) bad('the role kaspchem_app does not exist');
  else {
    eq('kaspchem_app login', r.login, true);
    ['super', 'createrole', 'createdb', 'bypassrls', 'replication'].forEach((k) => eq('kaspchem_app ' + k, r[k], false));
    eq('kaspchem_app member of', JSON.stringify(r.member_of), '[]');
  }
  const rel = s.relations || {};
  Object.keys(BASE_TODAY).forEach((x) => eq('base table ' + x + ' (kaspchem_app)', rel[x] && rel[x].app, BASE_TODAY[x]));
  BASE_SEQUENCES.forEach((x) => eq('base sequence ' + x + ' (kaspchem_app)', rel[x] && rel[x].app, 'USAGE'));
  const want = phase === 'post' ? NEW_APP : NONE_APP;
  NEW_RELATIONS.forEach((x) => {
    const e = rel[x]; if (!e) { bad('relation ' + x + ' is missing'); return; }
    eq(x + ' (kaspchem_app)', e.app, want[x]); eq(x + ' owner', e.owner, t.owner); eq(x + ' row-level security', e.rls, false); eq(x + ' PUBLIC or grantable entries', Number(e.public_or_grantable), 0);
    if (phase === 'pre') eq(x + ' ACL is empty before the grants', e.acl_null, true);
  });
  if (before) {
    eq('structure md5 compared with before', s.structure && s.structure.md5, before.structure && before.structure.md5);
    eq('privilege fingerprint compared with before', s.privileges && s.privileges.md5, before.privileges && before.privileges.md5);
    eq('migration history compared with before', s.history, before.history); eq('table count compared with before', Number(s.tables), Number(before.tables));
    Object.keys(before.relations || {}).forEach((x) => { if (!rel[x]) bad('the relation ' + x + ' existed before and is gone now'); });
    Object.keys(rel).filter((x) => !NEW_RELATIONS.includes(x)).forEach((x) => {
      const b = before.relations && before.relations[x];
      if (!b || b.app !== rel[x].app) bad('the privileges of kaspchem_app on ' + x + ' changed');
      if (!b || b.acl_null !== rel[x].acl_null || Number(b.public_or_grantable) !== Number(rel[x].public_or_grantable)) bad('the permission list of ' + x + ' changed');
    });
  }
  return { ok: problems.length === 0, problems };
}

module.exports = { APPLY, ROLLBACK, NEW_APP, NEW_RELATIONS, CHANGED, CLOSED, BASE_TODAY, NEON_TARGET, productionTarget, MIGRATION_003, MIGRATIONS, historyOf, loadStatements, statementsOf, sql, stateSql, guardsSql, evaluate, parseState, sha256 };

// ---- command line ---------------------------------------------------------------------------------------------------------------------------------------------
// --target production --expect-endpoint=ep-... [--after-003]: the production target (the endpoint is never read from this file). Without --target the temporary branch's target is used, and on any other database its guards refuse.
function targetFromArgs(a) {
  const i = a.indexOf('--target');
  if (i < 0) { if (a.some((x) => /^--(expect-endpoint|after-003)/.test(x))) throw new Error('--expect-endpoint and --after-003 belong to --target production'); return undefined; }
  if (a[i + 1] !== 'production') throw new Error('the only target that can be named is production (without --target the temporary branch is the target)');
  const e = a.find((x) => /^--expect-endpoint=/.test(x));
  return productionTarget(e ? e.slice('--expect-endpoint='.length) : undefined, { after003: a.includes('--after-003') });
}
if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    const target = targetFromArgs(a), topts = target ? { target } : undefined;
    if (a[0] === '--print') { process.stdout.write(sql(a[1], topts) + '\n'); return; }
    if (a[0] === '--evaluate') {
      const bi = a.indexOf('--before');
      const res = evaluate(a[1], fs.readFileSync(a[2], 'utf8'), bi > 0 ? fs.readFileSync(a[bi + 1], 'utf8') : null, topts);
      res.problems.forEach((p) => console.log('PROBLEM ' + p));
      console.log(res.ok ? 'VERDICT (' + a[1] + '): GO, every check passed' : 'VERDICT (' + a[1] + '): STOP, ' + res.problems.length + ' problem(s) above');
      process.exit(res.ok ? 0 : 1);
    }
    console.error('usage: --print pre|probe|dryrun|apply|post|rollback   |   --evaluate pre|post|post-rollback <results.json> [--before <pre-results.json>]   (both: [--target production --expect-endpoint=ep-... [--after-003]])'); process.exit(2);
  } catch (e) { console.error(e.message); process.exit(1); }
}
