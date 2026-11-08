'use strict';
// The A2 launcher (scripts/kaspchem-g2-clipboard.js): the connection string comes from the clipboard only, is checked before use, is cleared at once, and lives in memory only. Tested with a FAKE clipboard and
// the Neon HTTP emulation over in-memory Postgres (no network, no real clipboard, invented strings only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { world, closeAll } = require('./fixtures/catalog-world.js');
const { emulator } = require('./fixtures/neon-http-emulator.js');
const L = require('../scripts/kaspchem-g2-clipboard.js');
const G = require('../scripts/kaspchem-g2.js');
test.after(closeAll);

const PW = 'CLIP-TEST-PASSWORD-31ab', EP = 'ep-child-test-123456', HOST = EP + '.c-2.us-east-1.aws.neon.tech', MARKER = 'abc123def456ghi789';
const mk = (host, user) => 'postgresql://' + (user || 'kaspchem_app') + ':' + PW + '@' + host + '/postgres?sslmode=require';
const GOOD = mk(HOST), SECRETS = [PW, GOOD, HOST];
const state = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-clip-')), 'state.json');
const ENV_AT_START = { g2: process.env.KASPCHEM_G2_DATABASE_URL, db: process.env.KASPCHEM_DATABASE_URL };
async function g2world(o) {
  const w = await world({ seed: false });
  await w.owner('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY)');
  await w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '\"test\"'::jsonb, 'test')");
  await w.owner("COMMENT ON DATABASE postgres IS 'kaspchem-g2-child:" + MARKER + "'");
  return { w, em: emulator(w.pg, o) };
}
// a clipboard that holds the first item of `seq`, and gets the next one each time the launcher waits (sleep), like a person copying things over time; clearing empties it
function fakeClipboard(seq, o) {
  const opt = o || {}; let i = 1, content = seq.length ? seq[0] : ''; const log = { reads: 0, clears: 0 };
  return { log, get content() { return content; }, advance: async () => { if (i < seq.length) content = seq[i++]; }, read: async () => { log.reads++; return content; },
    clear: async () => { log.clears++; if (!opt.stuck) content = ''; }, historyEnabled: async () => !!opt.history };
}
const argv = (extra) => ['--expect-endpoint=' + EP, '--expect-env=test', '--marker=' + MARKER].concat(extra || []);
const ticking = () => { let t = 0; return () => (t += 1000); };
const deps = (clip, fetch, extra) => Object.assign({ clipboard: clip, fetch, write: () => {}, sleep: () => clip.advance(), clock: ticking(), now: () => 1762600000000, env: {} }, extra || {});
const noNet = () => { const calls = []; return { calls, fetch: async () => { calls.push(1); throw new Error('the network must not be touched'); } }; };
const text = (r) => r.lines.join('\n');
const noSecrets = (s, label) => { for (const x of SECRETS) assert.ok(!String(s).includes(x), (label || '') + ' leaked ' + x.slice(0, 12)); assert.ok(!/postgres(ql)?:\/\/\S/i.test(s), (label || '') + ' leaked a connection string'); };

test('extractUrl and the argument rules', () => {
  assert.equal(L.extractUrl("psql 'postgresql://u:p@h.neon.tech/db?sslmode=require'"), 'postgresql://u:p@h.neon.tech/db?sslmode=require');
  assert.equal(L.extractUrl('DATABASE_URL="postgres://u:p@h/d"'), 'postgres://u:p@h/d'); assert.equal(L.extractUrl('hello'), null); assert.equal(L.extractUrl(''), null); assert.equal(L.extractUrl(null), null);
  assert.throws(() => L.parseArgs(argv([GOOD])), /command line/); assert.throws(() => L.parseArgs(argv(['--stages=atomic-control'])), /explicit approval/); assert.throws(() => L.parseArgs(argv(['--stages=identity,atomic-import'])), /only these stages/);
  assert.throws(() => L.parseArgs(argv(['--allow-writes'])), /must name the one stage/); assert.throws(() => L.parseArgs(['--expect-env=test', '--marker=' + MARKER]), /expect-endpoint/); assert.throws(() => L.parseArgs(argv(['--wait-seconds=1'])), /between/);
  assert.throws(() => L.parseArgs(['--expect-endpoint=' + EP, '--expect-env=production', '--marker=' + MARKER]), /production/);
  assert.deepEqual(L.parseArgs(argv()).stages, ['identity', 'headers', 'lock-probe']); assert.deepEqual(L.ALLOWED_STAGES, ['identity', 'headers', 'lock-probe']);
});

test('the whole run: other clipboard text is left alone, wrong strings are cleared and refused, the right one is consumed and cleared, the three stages pass in order, no secret appears anywhere', async () => {
  const { w, em } = await g2world(), file = state();
  const clip = fakeClipboard(['just some text I copied', '', 'psql \'' + mk(HOST, 'neondb_owner') + '\'', 'DATABASE_URL=' + mk('ep-other-999999.c-2.us-east-1.aws.neon.tech'), mk(EP + '-pooler.c-2.us-east-1.aws.neon.tech'), "psql '" + GOOD + "'"], { history: true });
  const r = await L.run(argv(['--state=' + file]), deps(clip, em.fetch));
  assert.equal(r.code, 0, text(r)); assert.deepEqual(r.results, [['identity', 0], ['headers', 0], ['lock-probe', 0]]);
  const all = text(r) + '\n' + fs.readFileSync(file, 'utf8'); noSecrets(all, 'output and state file');
  assert.match(all, /READY/); assert.match(all, /Win\+V/); assert.equal((all.match(/REJECTED and cleared/g) || []).length, 3, 'three wrong strings were refused'); assert.match(all, /application role/); assert.match(all, /its endpoint is not ep-child-test-123456/); assert.match(all, /pooled/);
  assert.match(all, /GOT IT/); assert.match(all, /RESULT identity: PASS/); assert.match(all, /RESULT headers: PASS/); assert.match(all, /RESULT lock-probe: PASS/); assert.match(all, /A2 RESULT: PASS/);
  assert.equal(clip.log.clears, 4, 'each connection string (3 wrong, 1 right) was cleared at once; ordinary text never'); assert.equal(clip.content, '', 'the clipboard ends empty');
  assert.deepEqual([process.env.KASPCHEM_G2_DATABASE_URL, process.env.KASPCHEM_DATABASE_URL], [ENV_AT_START.g2, ENV_AT_START.db], 'the process environment never held the string');
  for (const id of ['identity', 'headers', 'lock-probe']) assert.ok(G.passed(G.readState(file), id, EP, MARKER), id + ' recorded');
  assert.ok(!G.passed(G.readState(file), 'atomic-control', EP, MARKER)); assert.equal(await w.count('audit_log'), 0, 'nothing was written'); assert.equal(await w.count('services'), 0);
  assert.ok(em.requests.length > 8, 'real requests were made'); await w.pg.close();
});

test('NOTHING happens without a usable string: timeout leaves the clipboard and the network alone; a clipboard that cannot be cleared stops the run before connecting; a refused stage stops the next ones', async () => {
  { const nn = noNet(), clip = fakeClipboard(['nothing useful', 'still nothing']), r = await L.run(argv(['--wait-seconds=30']), deps(clip, nn.fetch)); assert.equal(r.code, 2); assert.match(text(r), /TIMEOUT/); assert.equal(nn.calls.length, 0); assert.equal(clip.log.clears, 0, 'the clipboard was not touched'); }
  { const nn = noNet(), clip = fakeClipboard([GOOD], { stuck: true }), r = await L.run(argv(), deps(clip, nn.fetch)); assert.equal(r.code, 2); assert.match(text(r), /could not be cleared/); assert.equal(nn.calls.length, 0, 'it never connected'); noSecrets(text(r), 'stuck clipboard'); }
  { const nn = noNet(), clip = fakeClipboard([GOOD]), r = await L.run(argv(['--stages=atomic-import']), deps(clip, nn.fetch)); assert.equal(r.code, 2); assert.equal(clip.log.reads, 0, 'refused before even looking at the clipboard'); assert.equal(nn.calls.length, 0); }
  { const { w, em } = await g2world(); await w.owner("COMMENT ON DATABASE postgres IS 'kaspchem-g2-child:ffffffffffffffff'"); const file = state(), clip = fakeClipboard([GOOD]);
    const r = await L.run(argv(['--state=' + file]), deps(clip, em.fetch)); assert.equal(r.code, 2, text(r)); assert.match(text(r), /marker/); assert.match(text(r), /STOPPED at stage identity/); assert.deepEqual(r.results, [['identity', 2]]);
    assert.equal(em.requests.length, 1, 'only the identity read was sent; headers and lock-probe never ran'); noSecrets(text(r), 'wrong marker'); assert.equal(clip.content, ''); await w.pg.close(); }
});

test('the temporary branch and a database named in the shell\'s environment are still refused by the tool\'s own checks', async () => {
  { const nn = noNet(), temp = mk('ep-temp-branch-aaaaaa.c-2.us-east-1.aws.neon.tech'), clip = fakeClipboard([temp]);
    const r = await L.run(['--expect-endpoint=ep-temp-branch-aaaaaa', '--expect-env=test', '--marker=' + MARKER], deps(clip, nn.fetch)); assert.equal(r.code, 2); assert.match(text(r), /forbidden/); assert.equal(nn.calls.length, 0); noSecrets(text(r)); assert.equal(clip.content, ''); }
  { const nn = noNet(), clip = fakeClipboard([GOOD]), r = await L.run(argv(), deps(clip, nn.fetch, { env: { KASPCHEM_DATABASE_URL: mk(HOST) } })); assert.equal(r.code, 2); assert.match(text(r), /forbidden/); assert.equal(nn.calls.length, 0); noSecrets(text(r)); }
});

// ---- stage C1 (atomic-control) from the launcher: the ONE write stage, alone, approved by name ------------------------------------------------------------------------------------------------
const WRITE = ['--stages=atomic-control', '--allow-writes=atomic-control'];
test('the argument rules of the write stage: only atomic-control, alone, approved by its own name; nothing else that writes and no locked stage can be named, with or without any flag', () => {
  const ok = L.parseArgs(argv(WRITE)); assert.deepEqual(ok.stages, ['atomic-control']); assert.equal(ok.allowWrite, 'atomic-control'); assert.deepEqual(L.WRITE_STAGES, ['atomic-control']);
  const refused = [
    [['--stages=atomic-control'], /explicit approval/], [['--stages=atomic-control', '--allow-writes'], /must name the one stage/], [['--stages=atomic-control', '--allow-writes='], /explicit approval/], [['--stages=atomic-control', '--allow-writes=identity'], /explicit approval/],
    [['--stages=atomic-control', '--allow-writes=atomic-rollback'], /explicit approval/], [['--stages=atomic-control', '--allow-writes=ATOMIC-CONTROL'], /explicit approval/], [['--stages=atomic-control', '--allow-writes=atomic-control,atomic-import'], /explicit approval/],
    [['--stages=identity,atomic-control', '--allow-writes=atomic-control'], /runs alone/], [['--stages=atomic-control,identity', '--allow-writes=atomic-control'], /runs alone/], [['--stages=atomic-control,atomic-control', '--allow-writes=atomic-control'], /runs alone/],
    [['--allow-writes=atomic-control'], /none was named/], [['--stages=identity', '--allow-writes=atomic-control'], /none was named/], [['--stages=identity,headers,lock-probe', '--allow-writes=atomic-control'], /none was named/],
  ];
  for (const stage of ['atomic-rollback', 'atomic-guard', 'atomic-import', 'timeouts', 'concurrency', 'disconnect', 'size-ladder', 'race', 'nonsense', '']) {
    refused.push([['--stages=' + stage, '--allow-writes=' + stage], /only these stages|stages/]); refused.push([['--stages=' + stage], /only these stages|stages/]); if (stage) refused.push([['--stages=atomic-control,' + stage, '--allow-writes=atomic-control'], /only these stages/]);   // (an empty element is simply dropped, and what is left is the one approved stage)
  }
  assert.deepEqual(L.parseArgs(argv(['--stages=atomic-control,', '--allow-writes=atomic-control'])).stages, ['atomic-control']);
  for (const [extra, re] of refused) assert.throws(() => L.parseArgs(argv(extra)), re, JSON.stringify(extra));
});

test('C1 through the launcher: after the read stages, ONE write, five requests in a fixed order, only services and audit_log change, the write flag reaches the tool for this stage only, no secret anywhere', async () => {
  const { w, em } = await g2world(), file = state(), calls = [], realMain = G.main;
  G.main = async (a, e, dd) => { calls.push(a.slice()); return realMain(a, e, dd); };
  try {
    let r = await L.run(argv(['--state=' + file]), deps(fakeClipboard([GOOD]), em.fetch)); assert.equal(r.code, 0, text(r));
    assert.equal(calls.length, 3); assert.ok(calls.every((c) => !c.includes('--allow-writes')), 'a read stage never gets the write flag'); calls.length = 0;
    const before = await w.fingerprint(), seq0 = await w.owner('SELECT last_value, is_called FROM services_id_seq'), n0 = em.requests.length, clip = fakeClipboard([GOOD]);
    r = await L.run(argv(['--state=' + file].concat(WRITE)), deps(clip, em.fetch)); assert.equal(r.code, 0, text(r)); assert.match(text(r), /THIS RUN WRITES/); assert.match(text(r), /WRITE STAGE RESULT: PASS \(atomic-control\)/);
    assert.deepEqual(calls.map((c) => c.filter((x) => x === '--allow-writes').length), [1], 'the tool got the write flag exactly once, for exactly one stage'); assert.ok(calls[0].includes('--run=atomic-control') && calls[0].includes('--approved-stages=atomic-control'));
    noSecrets(text(r) + fs.readFileSync(file, 'utf8'), 'write run'); assert.equal(clip.content, '', 'the clipboard is cleared');
    const reqs = em.requests.slice(n0); assert.equal(reqs.length, 5, JSON.stringify(reqs.map((q) => q.statements.length)));
    assert.deepEqual(reqs.map((q) => [q.batch, q.batch ? q.readOnly : null]), [[false, null], [false, null], [false, null], [true, false], [false, null]]);
    assert.equal(reqs[0].statements[0], G.IDENTITY_SQL); assert.equal(reqs[1].statements[0], G.COUNTS_SQL); assert.equal(reqs[2].statements[0], "SELECT nextval('services_id_seq') AS id FROM generate_series(1, $1::int)"); assert.equal(reqs[4].statements[0], G.COUNTS_SQL);
    assert.equal(reqs[3].isolation, 'ReadCommitted'); assert.equal(reqs[3].statements.length, 4);
    assert.deepEqual(reqs[3].statements.slice(0, 2), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"]);
    assert.match(reqs[3].statements[2], /^INSERT INTO services \(id, name, topic, description, active\) VALUES \(\$1::bigint, \$2, \$3, \$4, false\)$/); assert.match(reqs[3].statements[3], /^INSERT INTO audit_log \(actor, action, entity, entity_id, detail\) VALUES/);
    const after = await w.fingerprint(); const changed = Object.keys(before).filter((t) => before[t].h !== after[t].h || before[t].c !== after[t].c).sort(); assert.deepEqual(changed, ['audit_log', 'services'], 'only these two tables changed');
    const svc = await w.owner('SELECT id::text AS id, name, topic, description, active FROM services'), aud = await w.owner('SELECT actor, action, entity, entity_id, detail FROM audit_log');
    assert.equal(svc.length, 1); assert.match(svc[0].name, /^g2-[a-z0-9]+-[0-9a-f]{4}-control$/); assert.equal(svc[0].topic, 'g2'); assert.equal(svc[0].description, null); assert.equal(svc[0].active, false, 'the synthetic service is INACTIVE');
    assert.equal(aud.length, 1); assert.deepEqual([aud[0].actor, aud[0].action, aud[0].entity, aud[0].entity_id], ['g2@example.test', 'g2.control', 'service', svc[0].id]); assert.deepEqual(Object.keys(aud[0].detail), ['run']);
    assert.equal(await w.count('pricing'), 0, 'no price at all, so no public price'); assert.equal(await w.count('provider_service_prices'), 0);
    const seq1 = await w.owner('SELECT last_value, is_called FROM services_id_seq'); assert.notDeepEqual(seq1, seq0, 'the id reservation advanced the sequence'); assert.equal(String(seq1[0].last_value), svc[0].id);
    await w.pg.close();
  } finally { G.main = realMain; }
});

test('the write stage is refused, with no write and nothing sent, when the gate is not met or the identity is wrong; an attempt to name any other stage that writes never reaches the tool', async () => {
  { const nn = noNet(), clip = fakeClipboard([GOOD]), r = await L.run(argv(['--state=' + state()].concat(WRITE)), deps(clip, nn.fetch));
    assert.equal(r.code, 2); assert.match(text(r), /needs stage "lock-probe"/); assert.equal(clip.log.reads, 0, 'refused before the clipboard was even looked at'); assert.equal(nn.calls.length, 0); }
  { const { w, em } = await g2world(), file = state(); assert.equal((await L.run(argv(['--state=' + file]), deps(fakeClipboard([GOOD]), em.fetch))).code, 0);
    await w.owner("COMMENT ON DATABASE postgres IS 'kaspchem-g2-child:ffffffffffffffff'"); const n0 = em.requests.length, before = await w.fingerprint();
    const r = await L.run(argv(['--state=' + file].concat(WRITE)), deps(fakeClipboard([GOOD]), em.fetch)); assert.equal(r.code, 2, text(r)); assert.match(text(r), /marker/); assert.equal(em.requests.length - n0, 1, 'only the identity read was sent');
    assert.deepEqual(await w.fingerprint(), before, 'nothing was written'); noSecrets(text(r), 'wrong marker, write'); await w.pg.close(); }
  { const { w, em } = await g2world(), file = state(); assert.equal((await L.run(argv(['--state=' + file]), deps(fakeClipboard([GOOD]), em.fetch))).code, 0);
    const n0 = em.requests.length; for (const stage of ['atomic-rollback', 'atomic-guard', 'atomic-import', 'size-ladder']) { const r = await L.run(argv(['--state=' + file, '--stages=' + stage, '--allow-writes=' + stage]), deps(fakeClipboard([GOOD]), em.fetch)); assert.equal(r.code, 2, stage); assert.match(text(r), /only these stages/); }
    assert.equal(em.requests.length, n0, 'nothing at all was sent'); assert.equal(await w.count('services'), 0); await w.pg.close(); }
  { const state2 = state(); fs.writeFileSync(state2, JSON.stringify({ runs: ['identity', 'headers', 'lock-probe'].map((s) => ({ stage: s, pass: true, endpoint: 'ep-temp-branch-aaaaaa', marker: G.sha8(MARKER) })) }));
    const nn = noNet(), r = await L.run(['--expect-endpoint=ep-temp-branch-aaaaaa', '--expect-env=test', '--marker=' + MARKER, '--state=' + state2].concat(WRITE), deps(fakeClipboard([mk('ep-temp-branch-aaaaaa.c-2.us-east-1.aws.neon.tech')]), nn.fetch));
    assert.equal(r.code, 2); assert.match(text(r), /forbidden/); assert.equal(nn.calls.length, 0, 'the temporary branch can never be written to'); noSecrets(text(r)); }
});
