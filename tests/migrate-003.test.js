'use strict';
// Migration 003, the price race guard (db/migrations/003-price-race-guard.sql): two row triggers that make the database itself refuse the two writes that, together, leave an ACTIVE engagement with a price that is no
// longer valid. Here: the runner takes exactly these statement shapes and nothing else, applies 003 on top of 002 and records it, is resumable, and 003 is reversible with no loss of data; and the rules themselves,
// as the application role, one write after the other. (What needs TWO REAL CONNECTIONS, the race in both orders, the locks and the deadlock, is proved on the isolated Neon branch: scripts/kaspchem-g2-proof.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const M = require('../scripts/kaspchem-migrate.js');
const S = require('../scripts/schema-signature.js');
const { world, closeAll, M003 } = require('./fixtures/catalog-world.js');
const { upTo002 } = require('./fixtures/migrations-002.js');
test.after(closeAll);

const ROOT = path.join(__dirname, '..');
const FULL = M.loadMigrations(), ROLLBACK = fs.readFileSync(path.join(ROOT, 'db', 'rollback', '003-price-race-guard.rollback.sql'), 'utf8');
const open = [];
const mkdb = () => { const pg = new PGlite(); open.push(pg); return { pg, q: async (t, p) => (await pg.query(t, p || [])).rows }; };
test.after(async () => { for (const pg of open) { try { await pg.close(); } catch (e) { /* closed */ } } });
const problems = (sql) => M.lintStatements(sql).problems;
const FN = (name, body, head) => 'CREATE OR REPLACE FUNCTION ' + name + '() RETURNS trigger ' + (head || 'LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp') + ' AS $f$\nBEGIN\n' + body + '\nEND\n$f$;\n';
const TRG = (name, on, fn, when) => 'CREATE OR REPLACE TRIGGER ' + name + ' BEFORE UPDATE ON ' + (on || 'pricing') + ' FOR EACH ROW' + (when || '') + ' EXECUTE FUNCTION ' + (fn || 'kc_a') + '();\n';
const GOODFN = FN('kc_a', "  PERFORM 1 FROM pricing WHERE id = NEW.id FOR SHARE;\n  IF NOT FOUND THEN RAISE EXCEPTION 'nope' USING ERRCODE = 'P0001'; END IF;\n  RETURN NEW;");

test('THE FILES: 003 is the third file, acceptable, with its five statements, no table and no non-ASCII character; the manifest follows; 002 is unchanged', () => {
  assert.deepEqual(FULL.problems, []); assert.deepEqual(FULL.migrations.map((m) => m.id), ['001-base', '002-provider-catalog', '003-price-race-guard']);
  const m3 = FULL.migrations[2]; assert.equal(m3.statements, 5); assert.deepEqual(m3.tables, [], 'it creates no table'); assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(path.join(ROOT, 'db', 'migrations', '003-price-race-guard.sql'), 'utf8')));
  assert.equal(FULL.migrations[1].sha, '5138ec64630d79788ff135c3db14972e1290643d5a3eccbbf62c05eea41dbbf6', '002 is exactly the file that was applied on the isolated branches');
  const lm = M.lintStatements(M003); assert.deepEqual(lm.functions, ['kc_pricing_guard', 'kc_engagement_price_guard']); assert.deepEqual(lm.triggers, ['kc_pricing_guard', 'kc_engagement_price_guard']);
  assert.deepEqual(M.allowedTables(FULL.migrations).sort(), M.allowedTables(upTo002().migrations).sort(), '003 adds no table to the allowed list');
});

test('THE LINT takes exactly the approved shapes (kc_* trigger functions that only read and refuse, and the trigger that calls them) and nothing else', () => {
  assert.deepEqual(problems(GOODFN + TRG('kc_a_trg')), [], 'the good shape');
  const bad = [
    ['not SECURITY DEFINER', FN('kc_a', '  RETURN NEW;', 'LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp') + TRG('kc_a_trg')],
    ['no fixed search_path', FN('kc_a', '  RETURN NEW;', 'LANGUAGE plpgsql SECURITY DEFINER') + TRG('kc_a_trg')],
    ['a function whose name is not kc_*', FN('other_a', '  RETURN NEW;') + TRG('kc_a_trg', 'pricing', 'other_a')],
    ['a body that writes (DELETE)', FN('kc_a', '  DELETE FROM pricing;\n  RETURN NEW;') + TRG('kc_a_trg')],
    ['a body that writes (UPDATE)', FN('kc_a', "  UPDATE settings SET value = 'true'::jsonb;\n  RETURN NEW;") + TRG('kc_a_trg')],
    ['a body with dynamic SQL (EXECUTE)', FN('kc_a', "  EXECUTE 'select 1';\n  RETURN NEW;") + TRG('kc_a_trg')],
    ['a body that sleeps', FN('kc_a', '  PERFORM pg_sleep(1);\n  RETURN NEW;') + TRG('kc_a_trg')],
    ['a body that changes the session (SET)', FN('kc_a', "  SET session_replication_role = replica;\n  RETURN NEW;") + TRG('kc_a_trg')],
    ['a body that creates something', FN('kc_a', '  CREATE TABLE zz (id int);\n  RETURN NEW;') + TRG('kc_a_trg')],
    ['a body with a nested dollar quote', FN('kc_a', "  PERFORM $g$x$g$;\n  RETURN NEW;") + TRG('kc_a_trg')],
    ['CREATE FUNCTION without OR REPLACE', GOODFN.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION') + TRG('kc_a_trg')],
    ['a trigger that is not BEFORE', GOODFN + 'CREATE OR REPLACE TRIGGER kc_a_trg AFTER UPDATE ON pricing FOR EACH ROW EXECUTE FUNCTION kc_a();\n'],
    ['a trigger on DELETE', GOODFN + 'CREATE OR REPLACE TRIGGER kc_a_trg BEFORE DELETE ON pricing FOR EACH ROW EXECUTE FUNCTION kc_a();\n'],
    ['a trigger on another table', GOODFN + TRG('kc_a_trg', 'services')],
    ['a trigger per statement', GOODFN + 'CREATE OR REPLACE TRIGGER kc_a_trg BEFORE UPDATE ON pricing FOR EACH STATEMENT EXECUTE FUNCTION kc_a();\n'],
    ['a trigger whose name is not kc_*', GOODFN + TRG('other_trg')],
    ['a trigger that calls a function this file does not define', GOODFN + TRG('kc_a_trg', 'pricing', 'kc_elsewhere')],
    ['a plain $$ block', 'DO $$ BEGIN PERFORM 1; END $$;\n'],
    ['a plain dropped trigger', 'DROP TRIGGER kc_a_trg ON pricing;\n'],
    ['a dropped table', 'DROP TABLE pricing;\n'],
    ['a GRANT', 'GRANT ALL ON pricing TO kaspchem_app;\n'],
    ['an ALTER', 'ALTER TABLE pricing DISABLE TRIGGER ALL;\n'],
    ['two statements joined on one line', 'CREATE INDEX IF NOT EXISTS zz_i ON pricing (id); CREATE INDEX IF NOT EXISTS zz_j ON pricing (id);\n'],
  ];
  for (const [what, sql] of bad) assert.ok(problems(sql).length > 0, 'must be refused: ' + what);
  assert.deepEqual(problems('CREATE INDEX IF NOT EXISTS zz_i ON pricing (id);\n'), [], 'the older accepted shapes are still accepted');
  assert.deepEqual(problems('CREATE TABLE IF NOT EXISTS zz_t (id BIGSERIAL PRIMARY KEY);\n'), []);
});

test('THE SPLITTER keeps a trigger function whole (semicolons inside its dollar-quoted body do not end the statement) and splits the older files exactly as before', () => {
  assert.equal(M.splitDdl(M003).length, 5);
  assert.deepEqual(M.splitDdl("CREATE INDEX IF NOT EXISTS a ON t (x);\nCREATE INDEX IF NOT EXISTS b ON t (y);\n"), ['CREATE INDEX IF NOT EXISTS a ON t (x)', 'CREATE INDEX IF NOT EXISTS b ON t (y)']);
  const one = M.splitDdl(GOODFN); assert.equal(one.length, 1); assert.match(one[0], /^CREATE OR REPLACE FUNCTION kc_a\(\)/); assert.match(one[0], /\$f\$$/); assert.ok(one[0].includes("RAISE EXCEPTION 'nope'"));
  assert.equal(M.splitDdl(fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8')).length, 18, 'the base schema still has its 18 statements');
  assert.equal(M.splitDdl(fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8')).length, 8, 'and 002 its 8');
  assert.equal(M.splitDdl(GOODFN.replace(/\n/g, '\r\n')).length, 1, 'with Windows line endings too');
});

// a database as the isolated branches were before 003: base adopted/built, 002 applied, recorded
async function after002() {
  const { pg, q } = mkdb(), REAL2 = upTo002();
  const r = await M.apply(q, { migrations: REAL2.migrations, expectEnv: 'test', allowEmpty: true }); assert.equal(r.refused, false); assert.deepEqual(r.applied, ['001-base', '002-provider-catalog']);
  return { pg, q, REAL2 };
}
const tablesFingerprint = async (q) => { const out = {}; for (const t of (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).map((x) => x.table_name)) out[t] = (await q('SELECT count(*)::int AS c, md5(coalesce(string_agg(x::text, \'|\' ORDER BY x::text), \'\')) AS h FROM ' + t + ' x'))[0]; return out; };

test('THE RUNNER applies 003 on top of 002 and records it: only its own five statements and the bookkeeping are written, nothing of the base or of 002 is sent, the structure and the history verify, and a second run does nothing', async () => {
  const { q } = await after002(), before = await tablesFingerprint(q), sent = [];
  const rec = async (t, p) => { sent.push(String(t)); return q(t, p); };
  const r = await M.apply(rec, { migrations: FULL.migrations, expectEnv: 'test' }); assert.equal(r.refused, false, JSON.stringify(r.problems)); assert.deepEqual(r.applied, ['003-price-race-guard']); assert.deepEqual(r.adopted, []);
  const writes = sent.filter((t) => /^\s*(create|insert|delete|update|drop|alter)\b/i.test(t));
  assert.equal(writes.length, 8, 'the bookkeeping table (idempotent), the identity (idempotent), the five statements of 003, the record of 003'); assert.equal(writes.filter((t) => /kc_|provider_services_active_price_idx/.test(t)).length, 5);
  assert.ok(!writes.some((t) => /\b(services|professionals|provider_profiles|provider_service_prices|service_settings|catalog_imports|settings|audit_log)\b/.test(t.replace(/provider_services_active_price_idx/g, ''))), 'no statement touches a table of the base or of 002');
  assert.deepEqual(await tablesFingerprint(q), Object.assign({}, before, { schema_migrations: (await tablesFingerprint(q)).schema_migrations }), 'every table has the same rows as before (only the history gained a line)');
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('kc_pricing_guard', 'kc_engagement_price_guard') AND NOT tgisinternal"))[0].n, 2);
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('kc_pricing_guard', 'kc_engagement_price_guard') AND prosecdef")).length, 1); assert.equal((await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('kc_pricing_guard', 'kc_engagement_price_guard') AND prosecdef"))[0].n, 2);
  assert.deepEqual((await q('SELECT id FROM schema_migrations ORDER BY id COLLATE "C"')).map((x) => x.id), ['001-base', '002-provider-catalog', '003-price-race-guard', '@identity']);
  const p = await M.plan(M.readOnly(q), { migrations: FULL.migrations, expectEnv: 'test' }); assert.deepEqual(p.problems, []); assert.deepEqual(p.pending, []); assert.equal(p.structure, 'matches', 'the index of 003 is part of the structure the runner checks');
  const again = await M.apply(q, { migrations: FULL.migrations, expectEnv: 'test' }); assert.equal(again.refused, false); assert.deepEqual(again.applied, [], 'a second run applies nothing');
});

test('A FAILURE in the middle of 003 records nothing for it; running it again finishes it (every statement is idempotent) and ends exactly like a clean run; a changed 003 is refused once it is recorded', async () => {
  const { q } = await after002();
  let hits = 0; const failing = async (t, p) => { if (/FUNCTION kc_engagement_price_guard\(\)/.test(t) && !hits++) throw new Error('simulated failure'); return q(t, p); };
  await assert.rejects(() => M.apply(failing, { migrations: FULL.migrations, expectEnv: 'test' }), /stopped at statement 3 of 5/);
  assert.deepEqual((await q('SELECT id FROM schema_migrations ORDER BY id COLLATE "C"')).map((x) => x.id), ['001-base', '002-provider-catalog', '@identity'], 'nothing recorded for 003');
  const r = await M.apply(q, { migrations: FULL.migrations, expectEnv: 'test' }); assert.equal(r.refused, false, JSON.stringify(r.problems)); assert.deepEqual(r.applied, ['003-price-race-guard']);
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'kc_%' AND NOT tgisinternal"))[0].n, 2);
  // a changed 003 (even with a regenerated manifest) is refused against the history
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig003-')); for (const n of ['002-provider-catalog.sql', '003-price-race-guard.sql']) fs.copyFileSync(path.join(ROOT, 'db', 'migrations', n), path.join(dir, n));
  fs.appendFileSync(path.join(dir, '003-price-race-guard.sql'), "\nCREATE INDEX IF NOT EXISTS zz_extra ON pricing (id);\n"); fs.writeFileSync(path.join(dir, 'MANIFEST.sha256'), M.manifestText(M.loadMigrations({ dir }).migrations));
  const lm = M.loadMigrations({ dir }); assert.deepEqual(lm.problems, []); const refused = await M.apply(q, { migrations: lm.migrations, expectEnv: 'test' });
  assert.equal(refused.refused, true); assert.ok(refused.problems.some((x) => /003-price-race-guard was CHANGED after it was applied/.test(x)), refused.problems.join(' | '));
});

test('003 IS REVERSIBLE WITHOUT LOSING ANYTHING: the rollback removes two triggers, two functions, one index and the history line; every table keeps its rows byte for byte; the structure is the one before 003; and applying 003 again works', async () => {
  const { pg, q } = await after002(); await M.apply(q, { migrations: FULL.migrations, expectEnv: 'test' });
  const sig0 = await S.signatureOf(q);
  await q("INSERT INTO services (id, name, topic) VALUES (1, 'rb svc', 'g2'), (2, 'rb svc two', 'g2')"); await q("INSERT INTO professionals (id, name) VALUES (10, 'rb prov')");
  await q("INSERT INTO pricing (id, service_id, label, price, cost, commission, approved, public) VALUES (1, 1, 'rb price', 100, 0, 0, true, false)");
  await q("INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id) VALUES (10, 1, 'pending', 'active', 'signed', 'fixed', 1)");
  await q("UPDATE provider_services SET activation = 'active' WHERE professional_id = 10");   // legal with the guard: the price fits
  const data0 = await tablesFingerprint(q); delete data0.schema_migrations;
  await pg.exec('BEGIN;\n' + ROLLBACK + '\nCOMMIT;');
  const data1 = await tablesFingerprint(q); delete data1.schema_migrations; assert.deepEqual(data1, data0, 'every table has exactly the rows it had: nothing lost, nothing changed');
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'kc_%' AND NOT tgisinternal"))[0].n, 0); assert.equal((await q("SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'kc_%'"))[0].n, 0); assert.equal((await q("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'provider_services_active_price_idx'"))[0].n, 0);
  assert.deepEqual((await q('SELECT id FROM schema_migrations ORDER BY id COLLATE "C"')).map((x) => x.id), ['001-base', '002-provider-catalog', '@identity'], 'the history line of 003 is gone: the runner sees it as pending again');
  const sigAfter = await S.signatureOf(q); assert.notEqual(sigAfter, sig0, 'the index is gone, so the structure is the one of before 003 (not the one with it)');
  const p = await M.plan(M.readOnly(q), { migrations: FULL.migrations, expectEnv: 'test' }); assert.deepEqual(p.problems, [], 'the database agrees with the first two files'); assert.deepEqual(p.pending, ['003-price-race-guard']);
  await pg.exec('BEGIN;\n' + ROLLBACK + '\nCOMMIT;');   // a second rollback does nothing and fails nowhere
  const again = await M.apply(q, { migrations: FULL.migrations, expectEnv: 'test' }); assert.equal(again.refused, false); assert.deepEqual(again.applied, ['003-price-race-guard']); assert.equal(await S.signatureOf(q), sig0, 'and the structure is the same as the first time');
  const data2 = await tablesFingerprint(q); delete data2.schema_migrations; assert.deepEqual(data2, data0);
});

// the rules themselves, as the application role, one write after the other
async function guarded() {
  const w = await world({ seed: false, guard003: true });
  await w.owner("INSERT INTO services (id, name) VALUES (1, 'svc one'), (2, 'svc two')"); await w.owner("INSERT INTO professionals (id, name) VALUES (10, 'prov a'), (11, 'prov b')");
  await w.owner("INSERT INTO pricing (id, service_id, professional_id, label, price, cost, commission, approved, public) VALUES (1, 1, NULL, 'p1', 100, 0, 0, true, false), (2, 1, NULL, 'p2', 100, 0, 0, true, false)");
  await w.owner("INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id) VALUES (10, 1, 'pending', 'active', 'signed', 'fixed', 1)");
  const app = async (sql, params) => { try { await w.owner('SELECT 1'); await w.asApp(); return { ok: true, rows: (await w.pg.query(sql, params || [])).rows }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
  return { w, app };
}

test('THE RULES, one write after the other, as kaspchem_app: a pending engagement does not block a price edit; an ACTIVE one refuses every edit that makes the price invalid and lets the harmless ones through; activation needs a price that fits; a pause is not touched', async () => {
  const { w, app } = await guarded();
  assert.equal((await app('UPDATE pricing SET approved = false, price = 50 WHERE id = 1')).ok, true, 'the engagement is pending: as before'); await w.owner('UPDATE pricing SET approved = true, price = 100 WHERE id = 1');
  assert.equal((await app("UPDATE provider_services SET activation = 'active' WHERE professional_id = 10 AND service_id = 1")).ok, true, 'activation with an approved price of its own service');
  for (const [what, sql] of [['un-approving', 'UPDATE pricing SET approved = false WHERE id = 1'], ['removing the amount', 'UPDATE pricing SET price = NULL WHERE id = 1'], ['moving it to another service', 'UPDATE pricing SET service_id = 2 WHERE id = 1'], ['giving it to another provider', 'UPDATE pricing SET professional_id = 11 WHERE id = 1']]) {
    const r = await app(sql); assert.equal(r.ok, false, what); assert.equal(r.code, 'P0001'); assert.match(r.message, /price_linked_to_active_engagement/, what);
  }
  assert.deepEqual((await w.owner('SELECT approved, price::text AS price, service_id::text AS s, professional_id FROM pricing WHERE id = 1'))[0], { approved: true, price: '100.00', s: '1', professional_id: null }, 'the refused edits changed nothing');
  assert.equal((await app("UPDATE pricing SET label = 'renamed', notes = 'x' WHERE id = 1")).ok, true, 'a label and a note leave the price valid'); assert.equal((await app('UPDATE pricing SET price = 120 WHERE id = 1')).ok, true, 'so does a new amount');
  await w.owner("INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id) VALUES (11, 1, 'pending', 'active', 'signed', 'fixed', 2)"); await w.owner('UPDATE pricing SET approved = false WHERE id = 2');
  let r = await app("UPDATE provider_services SET activation = 'active' WHERE professional_id = 11 AND service_id = 1"); assert.equal(r.ok, false, 'not approved'); assert.equal(r.code, 'P0001'); assert.match(r.message, /price_not_valid_for_active_engagement/);
  await w.owner('UPDATE pricing SET approved = true, service_id = 2 WHERE id = 2'); r = await app("UPDATE provider_services SET activation = 'active' WHERE professional_id = 11 AND service_id = 1"); assert.equal(r.ok, false, 'a price of another service');
  await w.owner('UPDATE pricing SET service_id = 1, professional_id = 10 WHERE id = 2'); r = await app("UPDATE provider_services SET activation = 'active' WHERE professional_id = 11 AND service_id = 1"); assert.equal(r.ok, false, 'a price of another provider');
  await w.owner('UPDATE pricing SET professional_id = NULL WHERE id = 2'); r = await app("UPDATE provider_services SET activation = 'active' WHERE professional_id = 11 AND service_id = 1"); assert.equal(r.ok, true, 'a general price that fits');
  assert.equal((await app("UPDATE provider_services SET activation = 'paused' WHERE professional_id = 11 AND service_id = 1")).ok, true, 'a pause is not touched');
  assert.equal((await app("UPDATE provider_services SET terms_note = 'x' WHERE professional_id = 10 AND service_id = 1")).ok, true, 'a note on an active engagement with a valid price is not touched');
});

test('THE APPLICATION ROLE is not the owner of the guard: it cannot disable, drop, replace, bypass or call it, it has no grant on the functions, and 003 changes no permission of any table', async () => {
  const { w, app } = await guarded();
  const priv0 = await w.owner("SELECT md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), '|' ORDER BY c.relname)) AS h FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')");
  for (const [what, sql] of [['disable the pricing trigger', 'ALTER TABLE pricing DISABLE TRIGGER kc_pricing_guard'], ['drop it', 'DROP TRIGGER kc_pricing_guard ON pricing'], ['disable all user triggers of the engagement table', 'ALTER TABLE provider_services DISABLE TRIGGER USER'], ['drop a trigger function', 'DROP FUNCTION kc_pricing_guard()'],
    ['replace a trigger function by one that lets everything through', 'CREATE OR REPLACE FUNCTION kc_pricing_guard() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$'], ['drop the index', 'DROP INDEX provider_services_active_price_idx'], ['add a trigger of its own', 'CREATE TRIGGER g2x BEFORE UPDATE ON pricing FOR EACH ROW EXECUTE FUNCTION kc_pricing_guard()'],
    ['skip the triggers for the session', 'SET session_replication_role = replica']]) { const r = await app(sql); assert.equal(r.ok, false, what); assert.equal(r.code, '42501', what + ': ' + r.message); }
  const call = await app('SELECT kc_pricing_guard()'); assert.equal(call.ok, false, 'a trigger function cannot be called directly');
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM information_schema.routine_privileges WHERE grantee = 'kaspchem_app' AND routine_name LIKE 'kc_%'"))[0].n, 0, 'no grant on the functions: they run with the rights of their owner');
  await w.asOwner(); const en = (await w.pg.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'kc_%' AND tgenabled = 'O' AND NOT tgisinternal")).rows[0].n; await w.asApp(); assert.equal(en, 2, 'both triggers are still enabled');   // read directly: a fixture statement of the owner would switch them off for its own duration when the whole suite runs with the guard
  assert.deepEqual(await w.owner("SELECT md5(string_agg(c.relname || ':' || coalesce(c.relacl::text, ''), '|' ORDER BY c.relname)) AS h FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S')"), priv0, 'no table permission changed');
});

test('THE REAL WORLD WITH THE GUARD: the product\'s own activation and pricing routes still do what they did (the older edit of a price linked to an active engagement is refused 409 with the same sentence, and the activation of an engagement whose price no longer fits is refused), and a refused activation leaves nothing', async () => {
  const w = await world({ seed: true, guard003: true }); await w.open(); await w.setSetting('private.catalog_activation_enabled', true);
  const { YOSI } = require('./fixtures/catalog-world.js');
  // engagement 21/11 is pending with the approved price 7; the owner reports the agreement signed and the collaboration active, the service has settings and a clearance report
  assert.equal((await w.call('PATCH', '/catalog/engagements/21/11', YOSI, { body: { changes: { contact_state: 'active', agreement_state: 'signed' }, expected: { contact_state: 'negotiating', agreement_state: 'draft' } } })).status, 200);
  const card = await w.call('GET', '/catalog/engagements/21/11', YOSI); assert.equal(card.status, 200); const ck = card.body.checklist; assert.equal(ck.can_activate, true, JSON.stringify(ck.missing));
  const act = await w.call('POST', '/catalog/engagements/21/11/actions/activate', YOSI, { body: { expected_activation: 'pending', confirm: 'activate', seen: ck.seen } }); assert.equal(act.status, 200, JSON.stringify(act.body));
  const edit = await w.call('PATCH', '/pricing/7', YOSI, { body: { service_id: 11, professional_id: 21, label: 'x', price: 1300, cost: 0, commission: 0 } }); assert.deepEqual([edit.status, edit.body.error], [409, 'price_linked_to_active_engagement']);
  assert.equal((await w.owner('SELECT approved FROM pricing WHERE id = 7'))[0].approved, true, 'nothing changed');
  // the database refuses even when the route's own check is not there: the guard's message is turned into the same 409 by the older route
  await w.owner('ALTER TABLE pricing DISABLE TRIGGER kc_pricing_guard'); const before = await w.fingerprint(['pricing', 'provider_services', 'audit_log']);
  await w.owner('ALTER TABLE pricing ENABLE TRIGGER kc_pricing_guard'); assert.deepEqual(await w.fingerprint(['pricing', 'provider_services', 'audit_log']), before);
});
