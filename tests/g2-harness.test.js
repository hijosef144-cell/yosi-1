'use strict';
// F5: the G2 test tool (scripts/kaspchem-g2.js) tested WITHOUT any network. The tool is driven against an emulation of Neon's HTTP endpoint over in-memory Postgres (PGlite), with the real tables and
// the real grants of kaspchem_app. What is proved: the wrong branch / role / environment is refused before anything runs; a secret never reaches the output or the state file; only the approved
// statements ever leave (a tampered stage is stopped); small stages come first and unlock the next; the stages themselves work end to end. What is NOT proved (G2 does that): anything about the
// real service: real timeouts and locks, a second connection, the exact answers of Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { world, closeAll } = require('./fixtures/catalog-world.js');
const { emulator } = require('./fixtures/neon-http-emulator.js');
const G = require('../scripts/kaspchem-g2.js');
const db = require('../netlify/functions/_kaspchem/db.js');
test.after(closeAll);

const ENV_AT_START = process.env.KASPCHEM_DATABASE_URL;   // the tool sets this for the product code and must put it back after every run
const PW = 'G2-TEST-PASSWORD-7c1f', EP = 'ep-child-test-123456', HOST = EP + '.c-2.us-east-1.aws.neon.tech', API = 'api.c-2.us-east-1.aws.neon.tech';
const URL_ = 'postgresql://kaspchem_app:' + PW + '@' + HOST + '/postgres?sslmode=require', MARKER = 'abc123def456ghi789';
const WRITES = new Set(['atomic-control', 'atomic-rollback', 'atomic-guard', 'atomic-import']);
const SECRETS = [PW, URL_, HOST, 'sslmode=require'];
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-state-')), 'state.json');
const noNet = () => { const calls = []; return { calls, fetch: async () => { calls.push(1); throw new Error('the network must not be touched'); } }; };
async function g2world(opts) {
  const w = await world({ seed: false });
  await w.owner('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY)');   // the runner's own table: the real grants give the role nothing on it
  await w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '\"test\"'::jsonb, 'test')");
  await w.owner("COMMENT ON DATABASE postgres IS 'kaspchem-g2-child:" + MARKER + "'");
  return { w, em: emulator(w.pg, opts) };
}
const argvOf = (stage, state, extra, o) => ['--run=' + stage, '--approved-stages=' + ((o && o.approved) || stage), '--expect-endpoint=' + EP, '--expect-env=test', '--marker=' + MARKER, '--state=' + state].concat(WRITES.has(stage) ? ['--allow-writes'] : [], extra || []);
const go = async (argv, env, fetch) => { const r = await G.main(argv, env === undefined ? { KASPCHEM_G2_DATABASE_URL: URL_ } : env, { fetch, write: () => {}, now: () => 1762600000000 }); assert.equal(process.env.KASPCHEM_DATABASE_URL, ENV_AT_START, 'the environment is exactly as it was after EVERY run, refused or not'); assert.equal(require('@neondatabase/serverless').neonConfig.fetchFunction, undefined, 'and the driver\'s fetch too'); return r; };
const text = (r) => r.lines.join('\n');
const noSecrets = (s, label) => { for (const x of SECRETS) assert.ok(!String(s).includes(x), (label || '') + ' leaked: ' + x.slice(0, 14)); assert.ok(!/postgres(ql)?:\/\/\S/i.test(s), (label || '') + ' leaked a connection string'); };

// ---- the tool without a database -------------------------------------------------------------------------------------------------------------------------------------------------------
test('--list and --plan touch nothing; the heavy stages are LOCKED and cannot be run with any flags', async () => {
  const nn = noNet(); let r = await go(['--list'], {}, nn.fetch); assert.equal(r.code, 0); const t = text(r);
  for (const id of ['identity', 'headers', 'lock-probe', 'atomic-control', 'atomic-rollback', 'atomic-guard', 'atomic-import']) assert.match(t, new RegExp('^' + id + '\\s', 'm'));
  for (const id of ['timeouts', 'concurrency', 'disconnect', 'size-ladder', 'race']) assert.match(t, new RegExp('^' + id + '\\s+LOCKED', 'm'), id + ' is locked');
  r = await go(['--plan=atomic-import'], {}, nn.fetch); assert.equal(r.code, 0); assert.match(text(r), /needs first.*atomic-guard/); assert.match(text(r), /2-row/);
  r = await go(['--plan=size-ladder'], {}, nn.fetch); assert.match(text(r), /LOCKED/); assert.match(text(r), /300 rows/);
  r = await go(['--plan=nonexistent'], {}, nn.fetch); assert.equal(r.code, 2);
  for (const id of ['timeouts', 'concurrency', 'disconnect', 'size-ladder', 'race']) {
    r = await go(argvOf(id, tmpState(), ['--allow-writes', '--allow-pooler']), undefined, nn.fetch); assert.equal(r.code, 2, id); assert.match(text(r), /LOCKED/, id);
  }
  assert.equal(nn.calls.length, 0, 'no request');
});

const OTHER = (host, user) => 'postgresql://' + (user || 'kaspchem_app') + ':' + PW + '@' + host + '/postgres?sslmode=require';
test('REFUSED before the network is touched: no approval, no endpoint, wrong role, wrong host, the temporary branch, an ambient database, a connection string on the command line, a missing earlier stage', async () => {
  const cases = [
    [[], undefined, /nothing to do/], [['--run=nope'], undefined, /unknown stage/],
    [['--run=identity', '--expect-endpoint=' + EP, '--expect-env=test', '--marker=' + MARKER], undefined, /not in --approved-stages/],
    [argvOf('atomic-control', tmpState()).filter((x) => x !== '--allow-writes'), undefined, /--allow-writes/],
    [argvOf('identity', tmpState()).filter((x) => !x.startsWith('--expect-endpoint')), undefined, /--expect-endpoint/], [argvOf('identity', tmpState()).filter((x) => !x.startsWith('--expect-env')), undefined, /--expect-env/],
    [argvOf('identity', tmpState()).map((x) => (x.startsWith('--expect-env') ? '--expect-env=production' : x)), undefined, /production/], [argvOf('identity', tmpState()).map((x) => (x.startsWith('--marker') ? '--marker=short' : x)), undefined, /--marker/],
    [argvOf('identity', tmpState()), {}, /KASPCHEM_G2_DATABASE_URL/],
    [argvOf('identity', tmpState(), [URL_]), undefined, /command line/], [argvOf('identity', tmpState(), ['--note=postgres']), undefined, /command line/], [argvOf('identity', tmpState(), ['--whatever']), undefined, /unknown option/],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: 'not a url ' + PW }, /not a valid connection string/],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: 'mysql://kaspchem_app:' + PW + '@' + HOST + '/postgres' }, /postgres:\/\//],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: OTHER(HOST, 'neondb_owner') }, /application role/], [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: OTHER('db.example.com') }, /Neon endpoint/],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: OTHER('ep-other-999999.c-2.us-east-1.aws.neon.tech') }, /not the one in --expect-endpoint/],
    [['--run=identity', '--approved-stages=identity', '--expect-endpoint=ep-temp-branch-aaaaaa', '--expect-env=test', '--marker=' + MARKER, '--state=' + tmpState()], { KASPCHEM_G2_DATABASE_URL: OTHER('ep-temp-branch-aaaaaa.c-2.us-east-1.aws.neon.tech') }, /forbidden/],
    [argvOf('identity', tmpState(), ['--forbid-endpoint=' + EP]), undefined, /forbidden/],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: URL_, KASPCHEM_DATABASE_URL: OTHER(HOST) }, /forbidden/], [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: URL_, DATABASE_URL: OTHER(EP + '-pooler.c-2.us-east-1.aws.neon.tech') }, /forbidden/],
    [argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: OTHER(EP + '-pooler.c-2.us-east-1.aws.neon.tech') }, /pooler/],
    [argvOf('headers', tmpState()), undefined, /needs stage "identity"/], [argvOf('atomic-import', tmpState()), undefined, /needs stage "atomic-guard"/],
  ];
  for (const [argv, env, re] of cases) {
    const nn = noNet(), r = await go(argv, env, nn.fetch); assert.equal(r.code, 2, JSON.stringify(argv).slice(0, 90)); assert.match(text(r), re, JSON.stringify(argv).slice(0, 90)); assert.match(text(r), /Nothing was sent/);
    assert.equal(nn.calls.length, 0, 'the network was touched: ' + JSON.stringify(argv).slice(0, 90)); noSecrets(text(r), JSON.stringify(argv).slice(0, 60)); assert.ok(!text(r).includes('G2-TEST-PASSWORD'), 'no password');
  }
  // a state file from ANOTHER endpoint or marker does not unlock anything
  const file = tmpState(); fs.writeFileSync(file, JSON.stringify({ runs: [{ stage: 'identity', pass: true, endpoint: 'ep-other-999999', marker: G.sha8(MARKER) }, { stage: 'identity', pass: true, endpoint: EP, marker: G.sha8('another-marker-123') }, { stage: 'identity', pass: false, endpoint: EP, marker: G.sha8(MARKER) }] }));
  const nn = noNet(), r = await go(argvOf('headers', file), undefined, nn.fetch); assert.equal(r.code, 2); assert.match(text(r), /needs stage "identity"/); assert.equal(nn.calls.length, 0);
  const c = G.parseConnection(URL_); assert.deepEqual([c.endpoint, c.pooler, c.db, c.apiHost], [EP, false, 'postgres', API]);
});

// ---- the branch is proved by the database itself, after one read and before anything else ------------------------------------------------------------------------------------
test('the identity read is the ONLY thing sent when the database is not the prepared child branch: wrong or missing marker, wrong environment, wrong role, wrong database, a different Neon endpoint', async () => {
  const bad = [
    ['wrong marker', async (w) => {}, (a) => a.map((x) => (x.startsWith('--marker') ? '--marker=zzzzzzzzzzzzzz' : x)), /marker/],
    ['no marker', async (w) => w.owner('COMMENT ON DATABASE postgres IS NULL'), null, /marker/],
    ['marker of another kind', async (w) => w.owner("COMMENT ON DATABASE postgres IS 'something else'"), null, /marker/],
    ['environment production', async (w) => w.owner("UPDATE settings SET value = '\"production\"'::jsonb WHERE key = 'meta.environment'"), (a) => a.map((x) => (x.startsWith('--expect-env') ? '--expect-env=test' : x)), /production/],
    ['environment differs', async (w) => w.owner("UPDATE settings SET value = '\"staging\"'::jsonb WHERE key = 'meta.environment'"), null, /staging/],
    ['no environment row', async (w) => w.owner("DELETE FROM settings WHERE key = 'meta.environment'"), null, /environment/],
    ['another role', async (w) => w.pg.exec('SET SESSION AUTHORIZATION postgres'), null, /role is not/],
    ['another Neon endpoint', async (w) => w.pg.exec("SET neon.endpoint_id = 'ep-another-777777'"), null, /another Neon endpoint/],
  ];
  for (const [label, prep, edit, re] of bad) {
    const { w, em } = await g2world(); await prep(w); const argv = argvOf('identity', tmpState()), r = await go(edit ? edit(argv) : argv, undefined, em.fetch);
    assert.equal(r.code, 2, label); assert.match(text(r), re, label); assert.match(text(r), /Nothing was sent|REFUSED/, label); noSecrets(text(r), label);
    assert.equal(em.requests.length, 1, label + ': exactly ONE request, the identity read'); assert.equal(em.requests[0].statements[0], G.IDENTITY_SQL, label); assert.equal(await w.count('audit_log'), 0, label); await w.pg.close();
  }
  { const { w, em } = await g2world(); const argv = argvOf('identity', tmpState()), r = await go(argv, { KASPCHEM_G2_DATABASE_URL: URL_.replace('/postgres?', '/otherdb?') }, em.fetch);
    assert.equal(r.code, 2); assert.match(text(r), /database is not the one/); assert.equal(em.requests.length, 1); await w.pg.close(); }
  { const { w, em } = await g2world(); await w.pg.exec("SET neon.endpoint_id = '" + EP + "'"); const r = await go(argvOf('identity', tmpState()), undefined, em.fetch); assert.equal(r.code, 0, text(r)); assert.match(text(r), /neon endpoint matches/); await w.pg.close(); }
});

// ---- the whole sequence, small stages first ----------------------------------------------------------------------------------------------------------------------------------------------
test('the stages run in order against the emulated service, each unlocks the next, nothing is written outside the approved synthetic data, and nothing else is sent', async () => {
  const { w, em } = await g2world(); await w.owner("INSERT INTO professionals (id, name) VALUES (90001, 'Private Person'); INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email) VALUES (90001, 'Private Office', '0587654321', 'real.person@gmail.test')");
  const file = tmpState(), env0 = { url: process.env.KASPCHEM_DATABASE_URL }, seq = ['identity', 'headers', 'lock-probe', 'atomic-control', 'atomic-rollback', 'atomic-guard', 'atomic-import'], all = [];
  const refusedEarly = await go(argvOf('atomic-control', file), undefined, em.fetch); assert.equal(refusedEarly.code, 2); assert.match(text(refusedEarly), /needs stage "lock-probe"/);
  for (const id of seq) {
    const r = await go(argvOf(id, file), undefined, em.fetch); all.push(text(r)); assert.equal(r.code, 0, id + '\n' + text(r)); assert.match(text(r), new RegExp('RESULT ' + id + ': PASS')); assert.match(text(r), /blocked by the guard: 0/); assert.ok(!/  FAIL /.test(text(r)), id);
    assert.ok(G.passed(G.readState(file), id, EP, MARKER), id + ' is recorded as passed'); noSecrets(text(r), id);
  }
  const output = all.join('\n'), state = fs.readFileSync(file, 'utf8'); noSecrets(output, 'output'); noSecrets(state, 'state file');
  for (const x of ['0587654321', 'real.person@gmail.test', 'Private Person', 'Private Office']) { assert.ok(!output.includes(x) && !state.includes(x), 'no row of the database is shown or stored: ' + x); }
  assert.match(output, /privileges equal the approved matrix/); assert.match(output, /host_class: "direct"/);
  // what the five write stages left: only g2-named synthetic rows
  const names = (await w.owner("SELECT name FROM services ORDER BY id")).map((x) => x.name); assert.equal(names.length, 4); assert.ok(names.every((n) => /^g2-/.test(n)), names.join());
  assert.deepEqual((await w.owner('SELECT (SELECT count(*) FROM professionals)::int AS p, (SELECT count(*) FROM provider_services)::int AS e, (SELECT count(*) FROM catalog_imports)::int AS i, (SELECT count(*) FROM audit_log)::int AS a, (SELECT count(*) FROM pricing)::int AS pr'))[0], { p: 3, e: 2, i: 1, a: 3, pr: 0 });   // 1 private + 2 imported
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM professionals WHERE name LIKE 'g2-%'"))[0].n, 2);
  // everything that left: no destructive or structural statement, and no write to the tables G2 never touches
  const sent = em.requests.flatMap((q) => q.statements); assert.ok(sent.length > 100);
  assert.deepEqual(sent.filter((s) => s !== G.PRIV_SQL && /\b(delete|truncate|drop|alter|grant|revoke|create|copy|vacuum)\b/i.test(s)).map((s) => s.slice(0, 160)), [], 'no destructive statement was sent (the privilege probe only NAMES the privileges DELETE and TRUNCATE to ask whether they are absent)');
  assert.ok(!sent.some((s) => /\b(insert\s+into|update)\s+(pricing|settings|provider_service_compensation|schema_migrations|questionnaire_versions|applicants|consents|outcomes|revenues|treatment_requests)\b/i.test(s)), 'no write to a table G2 does not use');
  assert.ok(em.requests.every((q) => !q.batch || q.readOnly || /^SET LOCAL lock_timeout = '(1500|2000)ms'$/.test(q.statements[0]) || q.statements.every((s) => !/^(insert|update|with)/i.test(s))), 'every request that writes starts with the timeouts');
  assert.equal(process.env.KASPCHEM_DATABASE_URL, env0.url, 'the environment is restored'); assert.equal(require('@neondatabase/serverless').neonConfig.fetchFunction, undefined, 'the driver\'s fetch is restored');
  // a stage can be run again, and the 300-row stage does not exist to run
  assert.equal((await go(argvOf('atomic-control', file), undefined, em.fetch)).code, 0); assert.equal((await go(argvOf('size-ladder', file), undefined, em.fetch)).code, 2); await w.pg.close();
});

test('a FAILED stage is recorded as failed and the next stage stays locked until it passes', async () => {
  const { w, em } = await g2world({ onRequest: async (body) => { if (em.fail && Array.isArray(body.queries) && /INSERT INTO services/.test(body.queries.map((q) => q.query).join('|'))) throw new Error('simulated outage'); } });
  const file = tmpState(); for (const id of ['identity', 'headers', 'lock-probe']) assert.equal((await go(argvOf(id, file), undefined, em.fetch)).code, 0, id);
  em.fail = true; const failed = await go(argvOf('atomic-control', file), undefined, em.fetch); assert.equal(failed.code, 1, text(failed)); assert.match(text(failed), /RESULT atomic-control: FAIL/); assert.equal(G.passed(G.readState(file), 'atomic-control', EP, MARKER), false);
  assert.equal(await w.count('services'), 0, 'nothing was written'); em.fail = false;
  const blocked = await go(argvOf('atomic-rollback', file), undefined, em.fetch); assert.equal(blocked.code, 2); assert.match(text(blocked), /needs stage "atomic-control"/);
  assert.equal((await go(argvOf('atomic-control', file), undefined, em.fetch)).code, 0); assert.equal((await go(argvOf('atomic-rollback', file), undefined, em.fetch)).code, 0); await w.pg.close();
});

// ---- secrets -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
test('SECRETS: the redactor, and failures that echo the connection string (a driver does) never reach the output or the state file', async () => {
  const red = G.makeRedactor([URL_, PW, HOST]);
  for (const bad of [PW, encodeURIComponent(PW), URL_, 'x ' + URL_ + ' y', 'postgres://u:p@h/d', 'postgresql://neondb_owner:npg_AbCdEf123456@ep-x.neon.tech/db', 'npg_ZzYy998877aa', 'Bearer eyJhbGciOi.abc-def_ghi', 'mail me at someone@gmail.com or Someone.Else+x@company.co.il', HOST]) {
    const out = red(bad); assert.ok(!/G2-TEST-PASSWORD|npg_|eyJhbGci|someone@|Someone\.Else|company\.co|postgres(ql)?:\/\/[^<]|c-2\.us-east/i.test(out), 'not redacted: ' + bad + ' -> ' + out);
  }
  assert.equal(red('owner is g2@example.test'), 'owner is g2@example.test', 'the synthetic address stays readable'); assert.equal(red('nothing secret here'), 'nothing secret here');
  // 1. the service answers every database error with the connection string appended
  { const { w, em } = await g2world({ leak: URL_ + ' ' + PW }); const file = tmpState(); const outs = [];
    for (const id of ['identity', 'headers', 'lock-probe', 'atomic-control', 'atomic-rollback']) { const r = await go(argvOf(id, file), undefined, em.fetch); outs.push(text(r)); assert.equal(r.code, 0, id + text(r)); }
    noSecrets(outs.join('\n') + fs.readFileSync(file, 'utf8'), 'leaking service'); await w.pg.close(); }
  // 2. the network layer fails with the connection string in the message, at the identity read and in the middle of a stage
  for (const when of ['identity', 'stage']) {
    const { w, em } = await g2world({ onRequest: async () => { if (when === 'identity' || em.arm) throw new Error('connect ECONNRESET ' + URL_ + ' password=' + PW + ' host ' + HOST); } });
    const file = tmpState(); let r;
    if (when === 'stage') { for (const id of ['identity', 'headers']) await go(argvOf(id, file), undefined, em.fetch); em.arm = true; r = await go(argvOf('lock-probe', file), undefined, em.fetch); } else r = await go(argvOf('identity', file), undefined, em.fetch);
    assert.ok(r.code === 1 || r.code === 2, when); noSecrets(text(r) + (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''), 'failing network at ' + when); assert.match(text(r), /STOPPED|FAIL/); await w.pg.close();
  }
  // 3. a malformed connection string whose text is the secret
  { const nn = noNet(), r = await go(argvOf('identity', tmpState()), { KASPCHEM_G2_DATABASE_URL: PW + ' not a url' }, nn.fetch); assert.equal(r.code, 2); noSecrets(text(r), 'malformed'); assert.ok(!text(r).includes(PW)); }
});

// ---- only the approved statements leave ---------------------------------------------------------------------------------------------------------------------------------------------
function craft(statements, o) {
  const x = o || {}, headers = Object.assign({ 'Neon-Connection-String': x.cs || URL_, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' }, x.batch === false ? {} : { 'Neon-Batch-Isolation-Level': x.iso || 'ReadCommitted', 'Neon-Batch-Read-Only': String(!!x.readOnly) }, x.headers || {});
  const body = x.batch === false ? { query: statements[0], params: [] } : { queries: statements.map((q) => ({ query: q, params: [] })) };
  return [x.url || 'https://' + API + '/sql', { method: x.method || 'POST', headers, body: JSON.stringify(body) }];
}
test('the HTTP guard: only the verified endpoint, the known headers and the statements the stage registered; the identity read alone before the branch is proved', async () => {
  const sent = []; const guard = G.makeGuard({ conn: G.parseConnection(URL_), baseFetch: async (u, i) => { sent.push(i); return new Response('{}', { status: 200 }); }, db });
  const blocked = async (args, why) => { const n = sent.length; await assert.rejects(() => guard.fetch(...args), /blocked_by_g2_guard/, why); assert.equal(sent.length, n, 'not sent: ' + why); };
  const sentOk = async (args, why) => { const n = sent.length; await guard.fetch(...args); assert.equal(sent.length, n + 1, why); };
  // before the identity is proved: the identity read and nothing else
  guard.state.raw.add(G.IDENTITY_SQL); await sentOk(craft([G.IDENTITY_SQL], { batch: false }), 'identity'); await blocked(craft(['SELECT 1'], { batch: false }), 'any other read'); await blocked(craft(["INSERT INTO services (name) VALUES ('x')"]), 'a write');
  guard.state.phase = 'stage'; G.TABLES.length; guard.state.raw.add(G.COUNTS_SQL);
  await sentOk(craft([G.COUNTS_SQL], { batch: false }), 'a registered read'); await sentOk(craft(["SELECT 1 AS x FROM services"], { batch: false }), 'a plain single read'); await sentOk(craft(["SELECT nextval('services_id_seq') AS id FROM generate_series(1, $1::int)"], { batch: false }), 'the id reservation');
  await sentOk(craft(["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'", 'INSERT INTO services (id, name) VALUES ($1::bigint, $2)']), 'timeouts + a fence-valid insert'); await sentOk(craft(['SELECT name FROM services'], { readOnly: true, iso: 'RepeatableRead' }), 'a read-only batch');
  const rejected = ['DELETE FROM services', 'TRUNCATE services', 'DROP TABLE services', 'ALTER TABLE services ADD COLUMN x int', 'GRANT ALL ON services TO PUBLIC', 'SET ROLE postgres', "SET LOCAL statement_timeout = '0ms'", "UPDATE pricing SET price = 1", "INSERT INTO settings (key, value) VALUES ('a', '1')", "INSERT INTO provider_service_compensation (professional_id) VALUES (1)",
    'SELECT 1; DELETE FROM services', 'SELECT pg_sleep(30)', "SELECT set_config('statement_timeout', '0', true)", 'LOCK TABLE pricing IN ACCESS EXCLUSIVE MODE', 'LOCK TABLE services IN ACCESS EXCLUSIVE MODE'];
  for (const s of rejected) { await blocked(craft([s]), 'batch: ' + s); await blocked(craft([s], { readOnly: true }), 'read-only batch: ' + s); await blocked(craft([s], { batch: false }), 'single: ' + s); }
  await blocked(craft(["INSERT INTO services (name) VALUES ('x')"], { batch: false }), 'a single request is never a write');
  // the request itself
  await blocked(craft([G.COUNTS_SQL], { url: 'https://api.c-3.eu-central-1.aws.neon.tech/sql' }), 'another host'); await blocked(craft([G.COUNTS_SQL], { url: 'https://' + API + '/other' }), 'another path'); await blocked(craft([G.COUNTS_SQL], { url: 'http://' + API + '/sql' }), 'plain http');
  await blocked(craft([G.COUNTS_SQL], { method: 'GET' }), 'GET'); await blocked(craft([G.COUNTS_SQL], { headers: { Authorization: 'Bearer abc' } }), 'a token header'); await blocked(craft([G.COUNTS_SQL], { headers: { 'X-Other': '1' } }), 'an unknown header');
  await blocked(craft([G.COUNTS_SQL], { cs: URL_.replace(EP, 'ep-another-999999') }), 'the header names another endpoint'); await blocked(craft([G.COUNTS_SQL], { cs: URL_.replace('kaspchem_app', 'neondb_owner') }), 'the header names another role'); await blocked(craft([G.COUNTS_SQL], { cs: URL_.replace('/postgres', '/other') }), 'the header names another database');
  await blocked(['https://' + API + '/sql', { method: 'POST', headers: { 'Neon-Connection-String': URL_ }, body: 'not json' }], 'not json');
  assert.ok(guard.state.blocked > 40);
  // a runaway loop is cut
  for (let i = guard.state.requests; i < 80; i++) await guard.fetch(...craft([G.COUNTS_SQL], { batch: false })); await blocked(craft([G.COUNTS_SQL], { batch: false }), 'too many requests');
});

test('a tampered stage cannot send anything it did not register: raw statements, single writes and writes through the product code are all stopped, and nothing reaches the database', async () => {
  const { w, em } = await g2world(); const file = tmpState(); for (const id of ['identity', 'headers', 'lock-probe']) assert.equal((await go(argvOf(id, file), undefined, em.fetch)).code, 0, id);
  const original = G.STAGES['atomic-control'].run, n0 = () => em.requests.length;
  const attempts = [
    ['a raw delete', async (c) => c.q('DELETE FROM services')], ['a raw batch', async (c) => c.tx(['DELETE FROM services'], { readOnly: false, isolationLevel: 'ReadCommitted' })], ['a registered text with a new tail', async (c) => c.q(G.COUNTS_SQL + '; DELETE FROM services')],
    ['a delete through the product query', async (c) => c.product.db.query('DELETE FROM services')], ['a single insert through the product query', async (c) => c.product.db.query("INSERT INTO services (name) VALUES ('g2-x')")], ['a grant through the product query', async (c) => c.product.db.query('GRANT ALL ON services TO PUBLIC')],
    ['a delete through the write fence', async (c) => c.product.db.writeTransaction([{ text: 'DELETE FROM services' }])], ['a price update through the write fence', async (c) => c.product.db.writeTransaction([{ text: 'UPDATE pricing SET price = 1' }])],
    ['a timeout switched off', async (c) => c.product.db.writeTransaction([{ text: "SET LOCAL statement_timeout = '0ms'" }])],
  ];
  try {
    for (const [label, fn] of attempts) {
      G.STAGES['atomic-control'].run = async (c) => { const r = await fn(c).then(() => 'went through', (e) => 'stopped: ' + e.message); c.check(label + ' did not go through', r.startsWith('stopped'), r); };
      const before = n0(), r = await go(argvOf('atomic-control', file), undefined, em.fetch);
      assert.equal(r.code, 0, label + '\n' + text(r)); assert.equal(em.requests.slice(before).filter((q) => q.statements.some((s) => /delete|grant|pricing|insert into services \(name\)|statement_timeout = '0ms'/i.test(s))).length, 0, label + ': it reached the service');
    }
  } finally { G.STAGES['atomic-control'].run = original; }
  assert.equal(await w.count('services'), 0, 'nothing was written'); await w.pg.close();
});
