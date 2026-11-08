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
const WRITE2 = ['--stages=atomic-rollback', '--allow-writes=atomic-rollback'];
const WRITE3 = ['--stages=atomic-guard', '--allow-writes=atomic-guard'];
test('the argument rules of the write stages: atomic-control, atomic-rollback and atomic-guard only, each alone and approved by its OWN name; nothing else that writes and no locked stage can be named, with or without any flag', () => {
  const ok = L.parseArgs(argv(WRITE)); assert.deepEqual(ok.stages, ['atomic-control']); assert.equal(ok.allowWrite, 'atomic-control'); assert.deepEqual(L.WRITE_STAGES, ['atomic-control', 'atomic-rollback', 'atomic-guard']);
  const ok2 = L.parseArgs(argv(WRITE2)); assert.deepEqual(ok2.stages, ['atomic-rollback']); assert.equal(ok2.allowWrite, 'atomic-rollback');
  const ok3 = L.parseArgs(argv(WRITE3)); assert.deepEqual(ok3.stages, ['atomic-guard']); assert.equal(ok3.allowWrite, 'atomic-guard');
  const refused = [
    // atomic-guard (C3): alone, approved by its own name, and nothing else
    [['--stages=atomic-guard'], /explicit approval/], [['--stages=atomic-guard', '--allow-writes'], /must name the one stage/], [['--stages=atomic-guard', '--allow-writes='], /explicit approval/], [['--stages=atomic-guard', '--allow-writes=atomic-rollback'], /explicit approval/],
    [['--stages=atomic-guard', '--allow-writes=atomic-control'], /explicit approval/], [['--stages=atomic-guard', '--allow-writes=atomic-import'], /explicit approval/], [['--stages=atomic-guard', '--allow-writes=ATOMIC-GUARD'], /explicit approval/], [['--stages=atomic-guard', '--allow-writes=atomic-guard,atomic-import'], /explicit approval/],
    [['--stages=atomic-guard,atomic-import', '--allow-writes=atomic-guard'], /only these stages/], [['--stages=atomic-guard,atomic-rollback', '--allow-writes=atomic-guard'], /runs alone/], [['--stages=identity,atomic-guard', '--allow-writes=atomic-guard'], /runs alone/], [['--stages=atomic-guard,atomic-guard', '--allow-writes=atomic-guard'], /runs alone/],
    [['--stages=atomic-rollback', '--allow-writes=atomic-guard'], /explicit approval/], [['--stages=atomic-control', '--allow-writes=atomic-guard'], /explicit approval/], [['--stages=identity', '--allow-writes=atomic-guard'], /none was named/], [['--allow-writes=atomic-guard'], /none was named/],
    [['--stages=atomic-rollback'], /explicit approval/], [['--stages=atomic-rollback', '--allow-writes'], /must name the one stage/], [['--stages=atomic-rollback', '--allow-writes=atomic-control'], /explicit approval/], [['--stages=atomic-rollback', '--allow-writes=atomic-guard'], /explicit approval/],
    [['--stages=atomic-rollback', '--allow-writes=atomic-rollback,atomic-control'], /explicit approval/], [['--stages=atomic-control,atomic-rollback', '--allow-writes=atomic-rollback'], /runs alone/], [['--stages=atomic-rollback,atomic-rollback', '--allow-writes=atomic-rollback'], /runs alone/],
    [['--stages=identity,atomic-rollback', '--allow-writes=atomic-rollback'], /runs alone/], [['--stages=atomic-rollback,atomic-guard', '--allow-writes=atomic-rollback'], /runs alone/], [['--stages=identity', '--allow-writes=atomic-rollback'], /none was named/], [['--allow-writes=atomic-rollback'], /none was named/],
    [['--stages=atomic-control'], /explicit approval/], [['--stages=atomic-control', '--allow-writes'], /must name the one stage/], [['--stages=atomic-control', '--allow-writes='], /explicit approval/], [['--stages=atomic-control', '--allow-writes=identity'], /explicit approval/],
    [['--stages=atomic-control', '--allow-writes=atomic-rollback'], /explicit approval/], [['--stages=atomic-control', '--allow-writes=ATOMIC-CONTROL'], /explicit approval/], [['--stages=atomic-control', '--allow-writes=atomic-control,atomic-import'], /explicit approval/],
    [['--stages=identity,atomic-control', '--allow-writes=atomic-control'], /runs alone/], [['--stages=atomic-control,identity', '--allow-writes=atomic-control'], /runs alone/], [['--stages=atomic-control,atomic-control', '--allow-writes=atomic-control'], /runs alone/],
    [['--allow-writes=atomic-control'], /none was named/], [['--stages=identity', '--allow-writes=atomic-control'], /none was named/], [['--stages=identity,headers,lock-probe', '--allow-writes=atomic-control'], /none was named/],
  ];
  for (const stage of ['atomic-import', 'timeouts', 'concurrency', 'disconnect', 'size-ladder', 'race', 'nonsense', '']) {
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
    const n0 = em.requests.length; for (const stage of ['atomic-import', 'size-ladder', 'race', 'timeouts', 'concurrency', 'disconnect']) { const r = await L.run(argv(['--state=' + file, '--stages=' + stage, '--allow-writes=' + stage]), deps(fakeClipboard([GOOD]), em.fetch)); assert.equal(r.code, 2, stage); assert.match(text(r), /only these stages/); }
    { const clip = fakeClipboard([GOOD]), r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(clip, em.fetch)); assert.equal(r.code, 2); assert.match(text(r), /needs stage "atomic-rollback"/, 'atomic-guard cannot run before atomic-rollback has passed'); assert.equal(clip.log.reads, 0, 'refused before the clipboard was even looked at'); }
    assert.equal(em.requests.length, n0, 'nothing at all was sent'); assert.equal(await w.count('services'), 0); await w.pg.close(); }
  { const state2 = state(); fs.writeFileSync(state2, JSON.stringify({ runs: ['identity', 'headers', 'lock-probe'].map((s) => ({ stage: s, pass: true, endpoint: 'ep-temp-branch-aaaaaa', marker: G.sha8(MARKER) })) }));
    const nn = noNet(), r = await L.run(['--expect-endpoint=ep-temp-branch-aaaaaa', '--expect-env=test', '--marker=' + MARKER, '--state=' + state2].concat(WRITE), deps(fakeClipboard([mk('ep-temp-branch-aaaaaa.c-2.us-east-1.aws.neon.tech')]), nn.fetch));
    assert.equal(r.code, 2); assert.match(text(r), /forbidden/); assert.equal(nn.calls.length, 0, 'the temporary branch can never be written to'); noSecrets(text(r)); }
});

// ---- stage C2 (atomic-rollback) from the launcher: three batches DESIGNED TO FAIL, whole-transaction rollback, an independent check before EVERY scenario ----------------------------------------------------
const { json } = require('./fixtures/neon-http-emulator.js');
const releaseTmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-rel-')), 'g2-release.txt');
async function afterC1(opts) {   // a world in the state C1 leaves: the read stages and atomic-control have passed
  const { w, em } = await g2world(opts), file = state();
  assert.equal((await L.run(argv(['--state=' + file]), deps(fakeClipboard([GOOD]), em.fetch))).code, 0);
  assert.equal((await L.run(argv(['--state=' + file].concat(WRITE)), deps(fakeClipboard([GOOD]), em.fetch))).code, 0);
  return { w, em, file };
}
// The release protocol: every PAUSE line carries a fresh code and is released only by the text "go <code>". An answer is: 'go' = the right text for THIS pause, 'stop', 'bare-go' = "go" without the code, 'wrong-code',
// 'previous-code' = the code of the pause before, or any other text, written as it is.
const releasing = (rel, answers) => {
  let i = 0, prev = null;
  return (line) => {
    const m = /^PAUSE .* exactly this text: go ([0-9a-f]{8}) /.exec(line); if (!m) return;
    const a = answers[Math.min(i++, answers.length - 1)], code = m[1];
    const content = a === 'go' ? 'go ' + code : a === 'bare-go' ? 'go' : a === 'wrong-code' ? 'go ' + (code === 'ffffffff' ? '00000000' : 'ffffffff') : a === 'previous-code' ? 'go ' + (prev || '00000000') : a;
    prev = code; fs.writeFileSync(rel, content);
  };
};
const writeBatches = (em, from) => em.requests.slice(from).filter((q) => q.batch && !q.readOnly);
const seqNow = async (w) => (await w.owner('SELECT (SELECT last_value FROM services_id_seq)::int AS s, (SELECT last_value FROM audit_log_id_seq)::int AS a'))[0];
const isContent = (q) => !q.batch && /^SELECT jsonb_build_object\('services', jsonb_build_object\('rows'/.test(q.statements[0]), isNextval = (q) => !q.batch && /nextval\('services_id_seq'\)/.test(q.statements[0]);

test('C2 through the launcher: an independent check before EACH of the three scenarios; each fails on its LAST statement after the audit row already ran; every table identical afterwards; the sequences advance and are reported apart; the write flag once; the stage runs once only', async () => {
  const { w, em, file } = await afterC1(), rel = releaseTmp(), calls = [], realMain = G.main;
  G.main = async (a, e, dd) => { calls.push(a.slice()); return realMain(a, e, dd); };
  try {
    const before = await w.fingerprint(), seq0 = await seqNow(w), n0 = em.requests.length, clip = fakeClipboard([GOOD]);
    const r = await L.run(argv(['--state=' + file].concat(WRITE2)), deps(clip, em.fetch, { releaseFile: rel, write: releasing(rel, ['go', 'go', 'go']) }));
    assert.equal(r.code, 0, text(r)); const all = text(r) + '\n' + fs.readFileSync(file, 'utf8'); noSecrets(all, 'C2 run');
    assert.match(all, /THIS RUN SENDS three write batches that are DESIGNED TO FAIL/); assert.equal((all.match(/^PAUSE before scenario [123]:/gm) || []).length, 3, 'a pause before EACH scenario, the first included');
    for (const k of [1, 2, 3]) { assert.match(all, new RegExp('the independent check released scenario ' + k)); assert.match(all, new RegExp('just before sending scenario ' + k + ' the rows are still exactly those of the start')); assert.match(all, new RegExp('scenario ' + k + ' \\(.*\\): the server answers (23505|P0001)')); assert.match(all, new RegExp('scenario ' + k + ' \\(.*\\): ROWS unchanged')); assert.match(all, new RegExp('scenario ' + k + ' \\(.*\\): SEQUENCES \\(apart from the rows\\): services_id_seq advanced by exactly (2|1|30)')); }
    assert.match(all, /WRITE STAGE RESULT: PASS \(atomic-rollback\)/); assert.deepEqual(calls.map((c) => c.filter((x) => x === '--allow-writes').length), [1]); assert.equal(clip.content, '');
    assert.deepEqual(await w.fingerprint(), before, 'ALL tables are byte-identical to the state after C1: not one row was kept, not one was changed');
    const seq1 = await seqNow(w); assert.deepEqual([seq1.s - seq0.s, seq1.a - seq0.a], [33, 2], 'sequences: 2+1+30 service ids reserved, 1+1 audit ids used by inserts that were rolled back');
    const reqs = em.requests.slice(n0), batches = writeBatches(em, n0); assert.equal(batches.length, 3, 'exactly three write batches, once each');
    assert.deepEqual(batches.map((b) => b.statements.length), [6, 6, 33]);
    for (const b of batches) { assert.deepEqual(b.statements.slice(0, 2), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"]); assert.equal(b.isolation, 'ReadCommitted'); }
    assert.match(batches[0].statements[4], /^INSERT INTO audit_log/); assert.match(batches[0].statements[5], /^INSERT INTO services/); assert.match(batches[1].statements[3], /^INSERT INTO audit_log/); assert.match(batches[1].statements[5], /^DO \$guard\$/);
    assert.match(batches[2].statements[32], /^INSERT INTO services/); assert.equal(batches[2].statements.filter((s) => /^INSERT INTO services/.test(s)).length, 31);
    const nv = reqs.map((q, i) => (isNextval(q) ? i : -1)).filter((i) => i >= 0); assert.equal(nv.length, 3, 'one id reservation per scenario');
    for (const i of nv) assert.ok(isContent(reqs[i - 1]), 'the rows are read once more right before each scenario is sent');
    assert.ok(reqs.every((q) => !q.statements.some((s) => /\b(delete|truncate|drop|alter|grant)\b/i.test(s.replace(G.IDENTITY_SQL, '')))), 'nothing destructive');
    assert.ok(G.passed(G.readState(file), 'atomic-rollback', EP, MARKER));
    // once only: a stage that has passed is not run again from here, and nobody is asked to copy a string for it
    const again = fakeClipboard([GOOD]), n1 = em.requests.length, r2 = await L.run(argv(['--state=' + file].concat(WRITE2)), deps(again, em.fetch, { releaseFile: rel })); assert.equal(r2.code, 2); assert.match(text(r2), /already PASSED/); assert.equal(again.log.reads, 0); assert.equal(em.requests.length, n1);
    await w.pg.close();
  } finally { G.main = realMain; }
});

test('C2 release protocol: a scenario is released ONLY by "go <the code of that very pause>"; "stop", "go" without the code, a wrong code, the code of an EARLIER pause, a file from before the run, junk and silence all stop the stage, and nothing more is sent', async () => {
  const cases = [   // [name, answers, pre-existing file, quiet, write batches expected, the check that must have failed]
    ['stop', ['stop'], null, false, 0, 1], ['bare go', ['bare-go'], null, false, 0, 1], ['wrong code', ['wrong-code'], null, false, 0, 1], ['junk', ['ok, continue'], null, false, 0, 1], ['empty file', [''], null, false, 0, 1],
    ['an old "go" file from before', [], 'go', true, 0, 1], ['an old "go <code>" file from before', [], 'go 00000000', true, 0, 1], ['silence', [], null, true, 0, 1],
    ['the code of the EARLIER pause', ['go', 'previous-code'], null, false, 1, 2], ['stop at the last pause', ['go', 'go', 'stop'], null, false, 2, 3], ['wrong code at the last pause', ['go', 'go', 'wrong-code'], null, false, 2, 3],
  ];
  for (const [name, answers, preexisting, quiet, sent, failedAt] of cases) {
    const { w, em, file } = await afterC1(), rel = releaseTmp(), before = await w.fingerprint(), n0 = em.requests.length;
    if (preexisting !== null) fs.writeFileSync(rel, preexisting);   // present BEFORE the run began: must never release anything
    const extra = { releaseFile: rel, write: quiet ? () => {} : releasing(rel, answers) }; if (quiet) extra.pauseSeconds = 3;
    const r = await L.run(argv(['--state=' + file].concat(WRITE2)), deps(fakeClipboard([GOOD]), em.fetch, extra));
    assert.equal(r.code, 1, name + '\n' + text(r)); assert.match(text(r), new RegExp('the independent check released scenario ' + failedAt)); assert.match(text(r), /STOPPED at stage atomic-rollback/);
    assert.equal(writeBatches(em, n0).length, sent, name + ': ' + sent + ' scenario(s) were sent and no more'); assert.deepEqual(await w.fingerprint(), before, name + ': nothing kept');
    assert.ok(!G.passed(G.readState(file), 'atomic-rollback', EP, MARKER), 'a stopped stage is not recorded as passed'); noSecrets(text(r), name); assert.ok(!fs.existsSync(rel) || preexisting === null, name); await w.pg.close();
  }
});

test('C2 stops at anything unexpected and never retries: an UNKNOWN outcome (no answer), a batch that unexpectedly SUCCEEDS, the wrong error code, rows or content changed before or after a scenario, a sequence that moved, a starting point that is not the state after C1', async () => {
  const ctl = { on: false, batches: 0, reads: 0 }, ref = {}, NTH = { changed: 2, content: 2, 'changed-after': 3, 'content-after': 3, sequence: 3, 'audit-sequence': 3 };
  const hooks = {
    onRequest: async (body, h) => { if (!ctl.on) return; const write = Array.isArray(body.queries) && String(h['Neon-Batch-Read-Only']) !== 'true'; if (write) ctl.batches++;
      if (ctl.mode === 'unknown' && write && ctl.batches === 2) throw new Error('socket hang up');
      if (NTH[ctl.mode] && !Array.isArray(body.queries) && /^SELECT jsonb_build_object\('services', jsonb_build_object\('rows'/.test(body.query) && ++ctl.reads === NTH[ctl.mode]) {   // the Nth read of the rows: somebody changes something at that moment
        if (ctl.mode.startsWith('changed')) await ref.w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('g2.test.leak', '1'::jsonb, 'x')");
        else if (ctl.mode.startsWith('content')) await ref.w.owner("UPDATE services SET description = 'changed in place'");   // same row count, different content
        else await ref.w.owner(ctl.mode === 'sequence' ? "SELECT nextval('services_id_seq')" : "SELECT nextval('audit_log_id_seq')");   // a sequence moves more than the stage expects
      } },
    respond: async (body, h) => { if (!ctl.on || !Array.isArray(body.queries) || String(h['Neon-Batch-Read-Only']) === 'true') return null;
      if (ctl.mode === 'success' && ctl.batches === 1) return json(200, { results: body.queries.map(() => ({ command: 'INSERT', rowCount: 0, rows: [], fields: [] })) });
      if (ctl.mode === 'wrongcode' && ctl.batches === 1) return json(400, { message: 'permission denied for table services', severity: 'ERROR', code: '42501' }); return null; },
  };
  const before1 = /just before sending scenario 1 the rows are still exactly/;
  for (const [mode, re, batchesSent, pauses] of [['unknown', /UNKNOWN/, 2, 2], ['success', /IT SUCCEEDED/, 1, 1], ['wrongcode', /the server answers 23505/, 1, 1],
    ['changed', before1, 0, 1], ['content', before1, 0, 1], ['changed-after', /scenario 1 .*ROWS unchanged/, 1, 1], ['content-after', /scenario 1 .*ROWS unchanged/, 1, 1], ['sequence', /services_id_seq advanced by exactly 2/, 1, 1], ['audit-sequence', /audit_log_id_seq advanced by exactly 1/, 1, 1]]) {
    Object.assign(ctl, { on: false, batches: 0, reads: 0, mode }); const { w, em, file } = await afterC1(hooks); ref.w = w; const rel = releaseTmp(), before = await w.fingerprint(), n0 = em.requests.length; ctl.on = true;
    const r = await L.run(argv(['--state=' + file].concat(WRITE2)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: rel, write: releasing(rel, ['go', 'go', 'go']) })); ctl.on = false;
    assert.equal(r.code, 1, mode + '\n' + text(r)); assert.match(text(r), re, mode); assert.match(text(r), /STOPPED at stage atomic-rollback/); assert.equal(writeBatches(em, n0).length, batchesSent, mode + ': no retry, no further scenario'); assert.equal((text(r).match(/^PAUSE/gm) || []).length, pauses, mode);
    if (!/^(changed|content)/.test(mode)) assert.deepEqual(await w.fingerprint(), before, mode + ': the database was not touched by the stage'); assert.ok(!G.passed(G.readState(file), 'atomic-rollback', EP, MARKER)); noSecrets(text(r), mode);
    if (mode === 'unknown') assert.match(text(r), /check what was kept before anything else/); await w.pg.close();
  }
  const start = /the starting point is the state after atomic-control/;
  for (const [what, tweak, re] of [['an extra service', "INSERT INTO services (name) VALUES ('extra')", start], ['an extra audit row', "INSERT INTO audit_log (actor, action) VALUES ('x', 'extra')", start], ['a catalog row', "INSERT INTO professionals (name) VALUES ('extra')", start],
    ['the control service switched on (same counts)', 'UPDATE services SET active = true', /the atomic-control service exists and is inactive/], ['the control service changed topic (same counts)', "UPDATE services SET topic = 'other'", /the atomic-control service exists and is inactive/]]) {
    const { w, em, file } = await afterC1(); await w.owner(tweak); const n0 = em.requests.length, r = await L.run(argv(['--state=' + file].concat(WRITE2)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: releaseTmp() }));
    assert.equal(r.code, 1, what); assert.match(text(r), re, what); assert.equal(writeBatches(em, n0).length, 0, what + ': nothing was written when the starting point is not the state after C1'); assert.ok(!/^PAUSE/m.test(text(r)), what + ': it does not even pause: the starting point is refused first'); await w.pg.close();
  }
});

// ---- stage C3 (atomic-guard) from the launcher: three import batches that the import GUARD must stop before any write (a wrong and an old fingerprint), then ONE ordinary write ---------------------------------
// An independent check holds back EVERY send (four of them); nothing is kept by the three guard batches; the sequences are reported apart; the ordinary write is the only change of rows.
const Imp = require('../netlify/functions/_kaspchem/catalog/import.js');
const STORE = require('../netlify/functions/_kaspchem/catalog-store.js');
async function afterC2(opts) {   // a world in the state C2 leaves: the read stages, atomic-control and atomic-rollback have passed
  const { w, em, file } = await afterC1(opts), rel = releaseTmp();
  assert.equal((await L.run(argv(['--state=' + file].concat(WRITE2)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: rel, write: releasing(rel, ['go', 'go', 'go']) }))).code, 0);
  return { w, em, file };
}
// the four sequences the stage reports, read by the owner; a sequence that has never been called counts as 0 (the stage does the same)
const seqs4 = async (w) => (await w.owner("SELECT CASE WHEN (SELECT is_called FROM services_id_seq) THEN (SELECT last_value FROM services_id_seq) ELSE 0 END::int AS s, CASE WHEN (SELECT is_called FROM professionals_id_seq) THEN (SELECT last_value FROM professionals_id_seq) ELSE 0 END::int AS p, CASE WHEN (SELECT is_called FROM audit_log_id_seq) THEN (SELECT last_value FROM audit_log_id_seq) ELSE 0 END::int AS a, CASE WHEN (SELECT is_called FROM catalog_imports_id_seq) THEN (SELECT last_value FROM catalog_imports_id_seq) ELSE 0 END::int AS c"))[0];
const isNextvalOf = (name) => (q) => !q.batch && new RegExp("nextval\\('" + name + "'\\)").test(q.statements[0]);
const PAUSES3 = /^PAUSE (before guard scenario [123]|before the ordinary write):/gm;
const IMPORT_TIMEOUTS = ["SET LOCAL lock_timeout = '2000ms'", "SET LOCAL statement_timeout = '5000ms'"];

test('C3 through the launcher: an independent check before EACH of the four sends; the guard stops a WRONG and an OLD fingerprint before any write, even for the whole 2-row import; every table identical afterwards; only the one ordinary write changes rows; sequences apart; write flag once; the stage runs once only', async () => {
  const { w, em, file } = await afterC2(), rel = releaseTmp(), calls = [], realMain = G.main;
  G.main = async (a, e, dd) => { calls.push(a.slice()); return realMain(a, e, dd); };
  try {
    const oldFp = G.readState(file).runs.filter((r) => r.stage === 'identity' && r.pass).pop().notes.fingerprint, nowFp = (await w.owner(STORE.FINGERPRINT_SQL))[0].fingerprint;
    assert.match(oldFp, /^[0-9a-f]{32}$/); assert.notEqual(oldFp, nowFp, 'the old fingerprint really is out of date');
    const before = await w.fingerprint(), seq0 = await seqs4(w), n0 = em.requests.length, clip = fakeClipboard([GOOD]);
    const r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(clip, em.fetch, { releaseFile: rel, write: releasing(rel, ['go', 'go', 'go', 'go']) }));
    assert.equal(r.code, 0, text(r)); const all = text(r) + '\n' + fs.readFileSync(file, 'utf8'); noSecrets(all, 'C3 run');
    assert.match(all, /THIS RUN SENDS three import batches with a WRONG or an OLD fingerprint/); assert.equal((all.match(PAUSES3) || []).length, 4, 'a pause before EACH of the four sends, the first included');
    for (const k of [1, 2, 3]) { for (const re of ['the independent check released scenario ' + k, 'just before sending scenario ' + k + ' the rows are still exactly those of the start', 'scenario ' + k + ' \\(.*\\): the server answers P0001', 'scenario ' + k + ' \\(.*\\): and the message is the guard\'s own', 'scenario ' + k + ' \\(.*\\): mapped to 409 preview_stale', 'scenario ' + k + ' \\(.*\\): ROWS unchanged']) assert.match(all, new RegExp(re)); }
    assert.match(all, /CONFLICT DETECTED BEFORE SAVING/); assert.match(all, /the independent check released the ordinary write/); assert.match(all, /ROWS: the ONLY change is that write/); assert.match(all, /WRITE STAGE RESULT: PASS \(atomic-guard\)/); assert.match(all, /blocked by the guard: 0/);
    assert.deepEqual(calls.map((c) => c.filter((x) => x === '--allow-writes').length), [1], 'the write flag reached the tool once, for this stage'); assert.equal(clip.content, '', 'the clipboard is cleared');
    // rows: the ONLY change is the ordinary write (one service, one audit row); every other table is byte-identical
    const after = await w.fingerprint(), changed = Object.keys(before).filter((t) => before[t].h !== after[t].h || before[t].c !== after[t].c).sort(); assert.deepEqual(changed, ['audit_log', 'services'], 'only these two tables changed');
    assert.equal(after.services.c, before.services.c + 1); assert.equal(after.audit_log.c, before.audit_log.c + 1);
    const svc = await w.owner("SELECT name, topic, active FROM services WHERE name LIKE '%-after-guard'"), aud = await w.owner("SELECT actor, action, entity FROM audit_log WHERE action = 'g2.after_guard'"); assert.equal(svc.length, 1); assert.deepEqual([svc[0].topic, svc[0].active], ['g2', false]); assert.deepEqual(aud.map((a) => [a.actor, a.action, a.entity]), [['g2@example.test', 'g2.after_guard', 'service']]);
    for (const t of ['professionals', 'provider_profiles', 'provider_services', 'provider_service_prices', 'service_settings', 'pricing', 'catalog_imports', 'provider_service_compensation']) assert.equal(await w.count(t), 0, t + ' has no row: no provider, engagement, price, commission or import-log row was kept');
    assert.equal((await w.owner("SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.import.apply'"))[0].n, 0, 'no import audit row'); assert.equal((await w.owner("SELECT count(*)::int AS n FROM services WHERE name ~ '-guard[12]$'"))[0].n, 0, 'no service of the guard batches');
    // sequences, apart from the rows: 1 + 1 + 2 + 1 service ids, 2 provider ids, 1 audit id (the ordinary write); the import-log sequence untouched
    const seq1 = await seqs4(w); assert.deepEqual({ s: seq1.s - seq0.s, p: seq1.p - seq0.p, a: seq1.a - seq0.a, c: seq1.c - seq0.c }, { s: 5, p: 2, a: 1, c: 0 }, 'sequences only moved by the reserved ids and the one audit insert');
    // the requests: exactly four write batches, in a fixed shape; the guard is the FIFTH statement and every write statement comes after it
    const reqs = em.requests.slice(n0), batches = writeBatches(em, n0); assert.equal(batches.length, 4, 'exactly four write batches, once each'); assert.deepEqual(batches.map((b) => b.statements.length), [8, 8, 17, 4]);
    for (const b of batches.slice(0, 3)) {
      assert.deepEqual(b.statements.slice(0, 2), IMPORT_TIMEOUTS); assert.equal(b.isolation, 'ReadCommitted');
      assert.equal(b.statements[2], 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN SHARE ROW EXCLUSIVE MODE'); assert.equal(b.statements[3], "SELECT set_config('kaspchem.expect', $1, true)"); assert.match(b.statements[4], /^DO \$guard\$ BEGIN IF \(SELECT /);
      assert.ok(b.statements.slice(5).every((s) => /^INSERT INTO (services|professionals|provider_profiles|provider_services|provider_service_prices|audit_log|catalog_imports) /.test(s)), 'after the guard only inserts of the import'); assert.match(b.statements[b.statements.length - 1], /^INSERT INTO catalog_imports/);
    }
    assert.deepEqual(batches[3].statements.slice(0, 2), ["SET LOCAL lock_timeout = '1500ms'", "SET LOCAL statement_timeout = '4000ms'"]); assert.match(batches[3].statements[2], /^INSERT INTO services/); assert.match(batches[3].statements[3], /^INSERT INTO audit_log/);
    const expectOf = (b) => b.params[3][0]; assert.equal(expectOf(batches[0]), '0'.repeat(32), 'scenario 1 carries the WRONG fingerprint'); assert.equal(expectOf(batches[1]), oldFp, 'scenario 2 carries the OLD fingerprint'); assert.equal(expectOf(batches[2]), oldFp, 'scenario 3 carries the OLD fingerprint');
    for (const b of batches.slice(0, 3)) assert.notEqual(expectOf(b), nowFp, 'the expected fingerprint is never the data\'s own');
    assert.ok(batches[2].statements.some((s) => /^INSERT INTO provider_service_prices/.test(s)) && batches[2].statements.some((s) => /^INSERT INTO professionals/.test(s)) && batches[2].statements.some((s) => /^INSERT INTO provider_services/.test(s)), 'the third batch carries the whole import, and none of it was kept');
    // an id reservation per send (and two for the 2-row import), always right after the rows were read again
    const nvS = reqs.map((q, i) => (isNextvalOf('services_id_seq')(q) ? i : -1)).filter((i) => i >= 0), nvP = reqs.map((q, i) => (isNextvalOf('professionals_id_seq')(q) ? i : -1)).filter((i) => i >= 0); assert.equal(nvS.length, 4); assert.equal(nvP.length, 1);
    for (const i of nvS) assert.ok(isContent(reqs[i - 1]), 'the rows are read once more right before each send'); assert.ok(nvP[0] === nvS[2] + 1, 'the provider ids are reserved with the 2-row import');
    assert.ok(reqs.every((q) => !q.statements.some((s) => /\b(delete|truncate|drop|alter|grant)\b/i.test(s.replace(G.IDENTITY_SQL, '')))), 'nothing destructive'); assert.ok(reqs.every((q) => !q.statements.some((s) => /^\s*(insert into|update)\s+(pricing|settings|provider_service_compensation|schema_migrations|service_settings)\b/i.test(s))), 'nothing written to prices, settings, commissions or service settings');
    assert.ok(G.passed(G.readState(file), 'atomic-guard', EP, MARKER));
    const again = fakeClipboard([GOOD]), n1 = em.requests.length, r2 = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(again, em.fetch, { releaseFile: rel })); assert.equal(r2.code, 2); assert.match(text(r2), /already PASSED/); assert.equal(again.log.reads, 0); assert.equal(em.requests.length, n1);
    { const g2 = await L.run(argv(['--state=' + file, '--stages=atomic-import', '--allow-writes=atomic-import']), deps(fakeClipboard([GOOD]), em.fetch)); assert.equal(g2.code, 2); assert.match(text(g2), /only these stages/, 'atomic-import (C4) is still not reachable'); assert.equal(em.requests.length, n1); }
    await w.pg.close();
  } finally { G.main = realMain; }
});

test('C3 release protocol: each send is released ONLY by "go <the code of that very pause>"; "stop", "go" without the code, a wrong code, the code of an EARLIER pause, a file from before the run, junk and silence all stop the stage, and nothing more is sent', async () => {
  const S1 = 'the independent check released scenario 1', S2 = 'the independent check released scenario 2', S3 = 'the independent check released scenario 3', W4 = 'the independent check released the ordinary write';
  const cases = [   // [name, answers, pre-existing file, quiet, write batches sent, the check that must have failed]
    ['stop', ['stop'], null, false, 0, S1], ['bare go', ['bare-go'], null, false, 0, S1], ['wrong code', ['wrong-code'], null, false, 0, S1], ['junk', ['ok, continue'], null, false, 0, S1], ['empty file', [''], null, false, 0, S1],
    ['an old "go" file from before', [], 'go', true, 0, S1], ['an old "go <code>" file from before', [], 'go 00000000', true, 0, S1], ['silence', [], null, true, 0, S1],
    ['the code of the EARLIER pause', ['go', 'previous-code'], null, false, 1, S2], ['stop at scenario 3', ['go', 'go', 'stop'], null, false, 2, S3], ['wrong code at scenario 3', ['go', 'go', 'wrong-code'], null, false, 2, S3],
    ['stop at the ordinary write', ['go', 'go', 'go', 'stop'], null, false, 3, W4], ['wrong code at the ordinary write', ['go', 'go', 'go', 'wrong-code'], null, false, 3, W4], ['the earlier code at the ordinary write', ['go', 'go', 'go', 'previous-code'], null, false, 3, W4],
  ];
  for (const [name, answers, preexisting, quiet, sent, failedAt] of cases) {
    const { w, em, file } = await afterC2(), rel = releaseTmp(), before = await w.fingerprint(), n0 = em.requests.length;
    if (preexisting !== null) fs.writeFileSync(rel, preexisting);   // present BEFORE the run began: must never release anything
    const extra = { releaseFile: rel, write: quiet ? () => {} : releasing(rel, answers) }; if (quiet) extra.pauseSeconds = 3;
    const r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, extra));
    assert.equal(r.code, 1, name + '\n' + text(r)); assert.match(text(r), new RegExp('FAIL\\s+' + failedAt)); assert.match(text(r), /STOPPED at stage atomic-guard/);
    assert.equal(writeBatches(em, n0).length, sent, name + ': ' + sent + ' batch(es) were sent and no more'); assert.deepEqual(await w.fingerprint(), before, name + ': nothing kept, not even the ordinary write');
    assert.ok(!G.passed(G.readState(file), 'atomic-guard', EP, MARKER), 'a stopped stage is not recorded as passed'); noSecrets(text(r), name); assert.ok(!fs.existsSync(rel) || preexisting === null, name); await w.pg.close();
  }
});

test('C3 stops at anything unexpected and never retries: an UNKNOWN outcome, a guard batch that unexpectedly SUCCEEDS, another code, another P0001, rows or content changed before or after a send, any of the four sequences moving unexpectedly, an ordinary write that fails or that is accompanied by another change', async () => {
  const ctl = { on: false, batches: 0, reads: 0, seqReads: 0 }, ref = {}, NTH = { changed: 2, content: 2, 'changed-after': 3, 'content-after': 3, 'seq-services': 3, 'seq-audit': 3, 'seq-catalog': 3, 'seq-professionals': 3, 'extra-at-end': 9, 'extra-service-at-end': 9, 'active-at-end': 9, 'seq-end-audit': 9, 'seq-end-catalog': 9 };
  const SEQNAME = { 'seq-services': 'services_id_seq', 'seq-audit': 'audit_log_id_seq', 'seq-catalog': 'catalog_imports_id_seq', 'seq-professionals': 'professionals_id_seq', 'seq-end-audit': 'audit_log_id_seq', 'seq-end-catalog': 'catalog_imports_id_seq' };
  const hooks = {
    onRequest: async (body, h) => { if (!ctl.on) return; const write = Array.isArray(body.queries) && String(h['Neon-Batch-Read-Only']) !== 'true'; if (write) ctl.batches++;
      if (ctl.mode === 'seq-unreadable' && !Array.isArray(body.queries) && /^SELECT sequencename, last_value FROM pg_sequences/.test(body.query) && ++ctl.seqReads === 2) throw new Error('socket hang up');   // the read of the sequences right after scenario 1 fails
      if (ctl.mode === 'unknown' && write && ctl.batches === 2) throw new Error('socket hang up'); if (ctl.mode === 'unknown-write' && write && ctl.batches === 4) throw new Error('socket hang up');
      if (NTH[ctl.mode] && !Array.isArray(body.queries) && /^SELECT jsonb_build_object\('services', jsonb_build_object\('rows'/.test(body.query) && ++ctl.reads === NTH[ctl.mode]) {   // the Nth read of the rows: somebody changes something at that moment
        if (ctl.mode.startsWith('changed')) await ref.w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('g2.test.leak', '1'::jsonb, 'x')");
        else if (ctl.mode.startsWith('content')) await ref.w.owner("UPDATE services SET description = 'changed in place'");
        else if (ctl.mode === 'extra-at-end') await ref.w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('g2.test.leak', '1'::jsonb, 'x')");
        else if (ctl.mode === 'extra-service-at-end') await ref.w.owner("INSERT INTO services (name) VALUES ('extra')");
        else if (ctl.mode === 'active-at-end') await ref.w.owner("UPDATE services SET active = true WHERE name LIKE '%-after-guard'");
        else await ref.w.owner("SELECT nextval('" + SEQNAME[ctl.mode] + "')");
      } },
    respond: async (body, h) => { if (!ctl.on || !Array.isArray(body.queries) || String(h['Neon-Batch-Read-Only']) === 'true') return null;
      if (ctl.mode === 'success' && ctl.batches === 1) return json(200, { results: body.queries.map(() => ({ command: 'INSERT', rowCount: 0, rows: [], fields: [] })) });
      if (ctl.mode === 'wrongcode' && ctl.batches === 1) return json(400, { message: 'permission denied for table services', severity: 'ERROR', code: '42501' });
      if (ctl.mode === 'otherp0001' && ctl.batches === 1) return json(400, { message: 'no_rows', severity: 'ERROR', code: 'P0001' });
      if (ctl.mode === 'locktimeout' && ctl.batches === 1) return json(400, { message: 'canceling statement due to lock timeout', severity: 'ERROR', code: '55P03' });
      if (ctl.mode === 'write-fails' && ctl.batches === 4) return json(400, { message: 'canceling statement due to lock timeout', severity: 'ERROR', code: '55P03' }); return null; },
  };
  const before1 = /FAIL\s+just before sending scenario 1 the rows are still exactly/, ONLY = /FAIL\s+ROWS: the ONLY change is that write/;
  for (const [mode, re, batchesSent, pauses] of [['unknown', /UNKNOWN/, 2, 2], ['success', /IT SUCCEEDED/, 1, 1], ['wrongcode', /FAIL\s+scenario 1 .*the server answers P0001/, 1, 1], ['otherp0001', /FAIL\s+scenario 1 .*the message is the guard's own/, 1, 1], ['locktimeout', /FAIL\s+scenario 1 .*the server answers P0001/, 1, 1], ['bad-mapping', /FAIL\s+scenario 1 .*mapped to 409 preview_stale/, 1, 1],
    ['changed', before1, 0, 1], ['content', before1, 0, 1], ['changed-after', /FAIL\s+scenario 1 .*ROWS unchanged/, 1, 1], ['content-after', /FAIL\s+scenario 1 .*ROWS unchanged/, 1, 1], ['seq-unreadable', /FAIL\s+scenario 1 .*the sequences can still be read/, 1, 1],
    ['seq-services', /FAIL\s+scenario 1 .*services_id_seq advanced by exactly 1/, 1, 1], ['seq-audit', /FAIL\s+scenario 1 .*audit_log_id_seq advanced by exactly 0/, 1, 1], ['seq-catalog', /FAIL\s+scenario 1 .*catalog_imports_id_seq advanced by exactly 0/, 1, 1], ['seq-professionals', /FAIL\s+scenario 1 .*professionals_id_seq advanced by exactly 0/, 1, 1],
    ['write-fails', /FAIL\s+an ordinary write works straight afterwards/, 4, 4], ['unknown-write', /UNKNOWN outcome/, 4, 4], ['extra-at-end', ONLY, 4, 4], ['extra-service-at-end', ONLY, 4, 4], ['active-at-end', /FAIL\s+and the new service exists, is inactive/, 4, 4],
    ['seq-end-audit', /FAIL\s+SEQUENCES \(apart from the rows\) after the ordinary write: audit_log_id_seq advanced by exactly 1/, 4, 4], ['seq-end-catalog', /FAIL\s+SEQUENCES \(apart from the rows\) after the ordinary write: catalog_imports_id_seq advanced by exactly 0/, 4, 4]]) {
    Object.assign(ctl, { on: false, batches: 0, reads: 0, seqReads: 0, mode }); const { w, em, file } = await afterC2(hooks); ref.w = w; const rel = releaseTmp(), before = await w.fingerprint(), n0 = em.requests.length; ctl.on = true;
    const WM = require('../netlify/functions/_kaspchem/catalog-writes.js'), realMap = WM.mapError; if (mode === 'bad-mapping') WM.mapError = () => ({ status: 500, code: 'server_error' });   // the product would answer something else than 409 preview_stale
    let r; try { r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: rel, write: releasing(rel, ['go', 'go', 'go', 'go']) })); } finally { WM.mapError = realMap; } ctl.on = false;
    assert.equal(r.code, 1, mode + '\n' + text(r)); assert.match(text(r), re, mode); assert.match(text(r), /STOPPED at stage atomic-guard/); assert.equal(writeBatches(em, n0).length, batchesSent, mode + ': no retry, nothing further sent'); assert.equal((text(r).match(PAUSES3) || []).length, pauses, mode);
    if (!/^(changed|content|extra|seq)|write|-at-end$/.test(mode)) assert.deepEqual(await w.fingerprint(), before, mode + ': the database was not touched by the stage'); assert.ok(!G.passed(G.readState(file), 'atomic-guard', EP, MARKER)); noSecrets(text(r), mode);
    if (mode === 'unknown' || mode === 'unknown-write') assert.match(text(r), /check what was kept before anything else/);
    if (mode === 'write-fails') assert.deepEqual(await w.fingerprint(), before, 'a failed ordinary write kept nothing'); await w.pg.close();
  }
});

test('C3 refuses to start, with nothing written and not even a pause, when the starting point is not the state after C2, when the OLD fingerprint is not old, or when the planner does not detect the conflict', async () => {
  const start = /FAIL\s+the starting point is the state after atomic-rollback/, seqLeft = /FAIL\s+the sequences can be read, and services_id_seq and audit_log_id_seq are exactly where atomic-rollback left them/, ctlRe = /FAIL\s+the atomic-control service exists and is inactive/, onRecord = /FAIL\s+the earlier stages are on record/;
  const tweaks = [['an extra service', "INSERT INTO services (name) VALUES ('extra')", start], ['an extra audit row', "INSERT INTO audit_log (actor, action) VALUES ('x', 'extra')", start], ['a catalog row', "INSERT INTO professionals (name) VALUES ('extra')", start], ['a settings row', "INSERT INTO settings (key, value, updated_by) VALUES ('x', '1'::jsonb, 'x')", start],
    ['the control service switched on (same counts)', 'UPDATE services SET active = true', ctlRe], ['the control service changed topic (same counts)', "UPDATE services SET topic = 'other'", ctlRe],
    ['the services sequence moved since atomic-rollback', "SELECT nextval('services_id_seq')", seqLeft], ['the audit sequence moved since atomic-rollback', "SELECT nextval('audit_log_id_seq')", seqLeft]];
  for (const [what, tweak, re] of tweaks) {
    const { w, em, file } = await afterC2(); await w.owner(tweak); const n0 = em.requests.length, r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: releaseTmp() }));
    assert.equal(r.code, 1, what + '\n' + text(r)); assert.match(text(r), re, what); assert.equal(writeBatches(em, n0).length, 0, what + ': nothing was written'); assert.ok(!/^PAUSE/m.test(text(r)), what + ': no pause: the starting point is refused first'); await w.pg.close();
  }
  // the state file's notes: a missing / unusable old fingerprint, or an old fingerprint that equals the data's fingerprint now
  const edit = (file, fn) => { const s = JSON.parse(fs.readFileSync(file, 'utf8')); fn(s); fs.writeFileSync(file, JSON.stringify(s)); };
  for (const [what, fn, re] of [['no fingerprint recorded at the identity stage', (s) => { s.runs.filter((r) => r.stage === 'identity').forEach((r) => { delete r.notes.fingerprint; }); }, onRecord], ['a fingerprint that is not 32 hex characters', (s) => { s.runs.filter((r) => r.stage === 'identity').forEach((r) => { r.notes.fingerprint = 'not-a-fingerprint'; }); }, onRecord],
    ['the sequences atomic-rollback left are not on record', (s) => { s.runs.filter((r) => r.stage === 'atomic-rollback').forEach((r) => { delete r.notes.sequences_after_scenario_3; }); }, onRecord],
    ['an old fingerprint that equals the data now', (s, now) => { s.runs.filter((r) => r.stage === 'identity').forEach((r) => { r.notes.fingerprint = now; }); }, /FAIL\s+the OLD fingerprint .*so it really is out of date/]]) {
    const { w, em, file } = await afterC2(), now = (await w.owner(STORE.FINGERPRINT_SQL))[0].fingerprint; edit(file, (s) => fn(s, now));
    const n0 = em.requests.length, r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: releaseTmp() }));
    assert.equal(r.code, 1, what + '\n' + text(r)); assert.match(text(r), re, what); assert.equal(writeBatches(em, n0).length, 0, what + ': nothing was written'); assert.ok(!/^PAUSE/m.test(text(r)), what + ': no pause'); await w.pg.close();
  }
  // the planner's own conflict detection: if it did NOT refuse a plan made on a moved snapshot, the stage stops before it builds or sends anything
  { const { w, em, file } = await afterC2(), original = Imp.planApply; Imp.planApply = (p, a, s, o) => { const real = original(p, a, s, o); return (s.services || []).some((x) => x.name === 'g2 moved') ? Object.assign({}, real, { ok: true, reason: undefined, operations: [{}] }) : real; };
    try { const n0 = em.requests.length, r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: releaseTmp() })); assert.equal(r.code, 1, text(r)); assert.match(text(r), /FAIL\s+CONFLICT DETECTED BEFORE SAVING/); assert.equal(writeBatches(em, n0).length, 0); assert.ok(!/^PAUSE/m.test(text(r))); } finally { Imp.planApply = original; } await w.pg.close(); }
  // a file that would need a manual decision (a service with a similar name already exists) is refused before anything is sent
  { const { w, em, file } = await afterC2(); const original = Imp.buildPreview; Imp.buildPreview = (i) => { const p = original(i); p.rows.forEach((x) => { x.decisions = [{ entity: 'service' }]; }); return p; };
    try { const n0 = em.requests.length, r = await L.run(argv(['--state=' + file].concat(WRITE3)), deps(fakeClipboard([GOOD]), em.fetch, { releaseFile: releaseTmp() })); assert.equal(r.code, 1, text(r)); assert.match(text(r), /FAIL\s+both rows can be approved without a manual decision/); assert.equal(writeBatches(em, n0).length, 0); assert.ok(!/^PAUSE/m.test(text(r))); } finally { Imp.buildPreview = original; } await w.pg.close(); }
});
