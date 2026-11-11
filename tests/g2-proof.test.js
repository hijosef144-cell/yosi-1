'use strict';
// The PROOF SEQUENCE of the isolated-branch run (scripts/kaspchem-g2-clipboard.js --sequence=proof): one copy of the connection string for the whole chain, no pause between the stages, the proof stages through the
// product's own routes (scripts/kaspchem-g2-proof.js). Here it runs on the in-memory Postgres through the Neon HTTP emulator, with a FAKE clipboard: no network, no real string.
// What the emulator can NOT show (two real connections: waits, timeouts, the race) is named, and the checks that depend on it are the only ones allowed to differ here; they are what the isolated Neon branch is for.
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

const PW = 'SEQ-TEST-PASSWORD-77cd', EP = 'ep-child-test-123456', HOST = EP + '.c-2.us-east-1.aws.neon.tech', MARKER = 'abc123def456ghi789';
const GOOD = 'postgresql://kaspchem_app:' + PW + '@' + HOST + '/postgres?sslmode=require';
const argv = (extra) => ['--expect-endpoint=' + EP, '--expect-env=test', '--marker=' + MARKER].concat(extra || []);
const SEQ = ['--sequence=proof', '--allow-writes=sequence-proof'];
const stateFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-seq-')), 'state.json');
const fakeClipboard = () => { let content = GOOD; return { read: async () => content, clear: async () => { content = ''; }, historyEnabled: async () => false }; };
const serialized = (em) => { let q = Promise.resolve(); return (u, i) => { const r = q.then(() => em.fetch(u, i)); q = r.catch(() => {}); return r; }; };   // one connection: requests one after the other
async function seqWorld(o) {
  const w = await world({ seed: false, guard003: !!(o && o.guard003) });
  await w.owner('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY)');
  await w.owner("INSERT INTO settings (key, value, updated_by) VALUES ('meta.environment', '\"test\"'::jsonb, 'test')");
  await w.owner("COMMENT ON DATABASE postgres IS 'kaspchem-g2-child:" + MARKER + "'");
  await w.open(); if (!o || o.activation !== false) await w.setSetting('private.catalog_activation_enabled', true);
  return { w, em: emulator(w.pg) };
}
const deps = (em, extra) => Object.assign({ clipboard: fakeClipboard(), fetch: serialized(em), write: () => {}, sleep: async () => {}, clock: (() => { let t = 0; return () => (t += 1000); })(), now: () => 1762600000000, env: {} }, extra || {});
const text = (r) => r.lines.join('\n');
// the checks that need TWO REAL CONNECTIONS (waits, timeouts, a lock that really blocks, a race): a single emulated connection cannot make them true
const NEEDS_REAL_CONNECTIONS = [/^LOCK: a single WRITE during the lock waits/, /^the activation was NOT held up by the price edit/, /^in PLAIN order the older edit of a price linked to an ACTIVE engagement is refused/];

test('the argument rules of the sequence: it is named exactly, approved by its OWN name, never combined with --stages, never with a bare --allow-writes or another stage\'s approval', () => {
  const ok = L.parseArgs(argv(SEQ)); assert.deepEqual(ok.stages, L.PROOF_SEQUENCE); assert.equal(ok.stages[0], 'identity'); assert.equal(ok.stages.length, 12);
  for (const extra of [['--sequence=proof'], ['--sequence=proof', '--allow-writes=atomic-control'], ['--sequence=proof', '--allow-writes=sequence-proof', '--stages=identity'], ['--sequence=other', '--allow-writes=sequence-proof'], ['--sequence=proof', '--allow-writes'], ['--stages=atomic-control,proof-crud', '--allow-writes=atomic-control'], ['--stages=proof-crud', '--allow-writes=proof-crud']])
    assert.throws(() => L.parseArgs(argv(extra)), (e) => /sequence|allow-writes|stage/.test(e.message), JSON.stringify(extra));
  for (const s of ['proof-crud', 'proof-twin', 'proof-r12', 'proof-concurrency', 'proof-race']) assert.equal(L.WRITE_STAGES.includes(s) || L.ALLOWED_STAGES.includes(s), false, s + ' cannot be named on its own: only the sequence runs it');
  assert.throws(() => L.parseArgs(argv(['--sequence=proof', '--allow-writes=sequence-proof', 'postgres://u:p@h/db'])), /connection string/);
});

test('THE WHOLE SEQUENCE on the in-memory database: the earlier stages pass again on the new code, then the proof stages; only the checks that need two real connections may differ; one clipboard string, consumed once, never shown', async () => {
  const { w, em } = await seqWorld(), file = stateFile(), calls = [], realMain = G.main;
  G.main = async (a, e, dd) => { calls.push(a[0]); return realMain(a, e, dd); };
  let r; try { r = await L.run(argv(['--state=' + file].concat(SEQ)), deps(em)); } finally { G.main = realMain; }
  assert.deepEqual(calls, L.PROOF_SEQUENCE.map((s) => '--run=' + s), 'every stage once, in order');
  const out = text(r); for (const x of [PW, GOOD, HOST]) assert.ok(!out.includes(x), 'a secret leaked'); assert.ok(!/postgres(ql)?:\/\/\S/i.test(out));
  const res = Object.fromEntries(r.results); for (const s of ['identity', 'headers', 'lock-probe', 'atomic-control', 'atomic-rollback', 'atomic-guard', 'atomic-import', 'proof-crud', 'proof-twin', 'proof-r12']) assert.equal(res[s], 0, s + ' passed');
  const failed = out.split('\n').filter((l) => /^  FAIL  /.test(l)).map((l) => l.replace(/^  FAIL  /, ''));
  for (const f of failed) assert.ok(NEEDS_REAL_CONNECTIONS.some((re) => re.test(f)), 'a check failed that is not one of the real-connection ones: ' + f.slice(0, 160));
  assert.equal(r.code, failed.length ? 1 : 0); assert.ok(failed.length <= 3, 'at most the three checks that need real connections');
  const st = G.readState(file); assert.deepEqual(G.STAGES['proof-twin'].independent, true);
  // the twin: exactly 3 providers, 22 services, 21 engagements, 21 reported prices
  const n = async (sql) => (await w.owner(sql))[0].n;
  assert.equal(await n("SELECT count(*)::int AS n FROM professionals WHERE name LIKE '[דמו] %'"), 3); assert.equal(await n("SELECT count(*)::int AS n FROM services WHERE name LIKE '[דמו] %'"), 22);
  assert.equal(await n("SELECT count(*)::int AS n FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id WHERE p.name LIKE '[דמו] %'"), 21); assert.equal(await n("SELECT count(*)::int AS n FROM provider_service_prices l JOIN professionals p ON p.id = l.professional_id WHERE p.name LIKE '[דמו] %'"), 21);
  assert.equal(await n("SELECT count(*)::int AS n FROM services WHERE name LIKE '[דמו] %' AND active"), 0); assert.equal(await n("SELECT count(*)::int AS n FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id WHERE p.name LIKE '[דמו] %' AND ps.activation <> 'pending'"), 0);
  assert.equal(await n('SELECT count(*)::int AS n FROM provider_service_compensation'), 0, 'no commission anywhere');
  assert.equal(await n("SELECT count(*)::int AS n FROM pricing WHERE public"), 0, 'nothing public');
  assert.ok(st.runs.filter((x) => x.stage === 'proof-twin' && x.pass).length === 1);
  // a second run: every stage that PASSED is skipped (a write stage is approved once, nothing is written again); only the ones that failed run again
  const again = []; G.main = async (a, e, dd) => { again.push(a[0]); return realMain(a, e, dd); };
  let r2; try { r2 = await L.run(argv(['--state=' + file].concat(SEQ)), deps(em)); } finally { G.main = realMain; }
  assert.deepEqual(again, failed.length ? ['--run=proof-concurrency', '--run=proof-race'] : [], 'only the stages that failed are run again');
  assert.ok(/SKIPPED identity/.test(text(r2)) && /SKIPPED atomic-import/.test(text(r2)) && /SKIPPED proof-twin/.test(text(r2)) && /SKIPPED proof-crud/.test(text(r2)));
  assert.equal(await n("SELECT count(*)::int AS n FROM services WHERE name LIKE '[דמו] %'"), 22, 'the twin was not saved a second time'); assert.equal(await n("SELECT count(*)::int AS n FROM professionals WHERE name LIKE '[דמו] %'"), 3);
});

test('a stage that the next ones depend on stops the chain; a proof stage that fails is recorded and the others still run; the string is used for the whole chain', async () => {
  { const { w, em } = await seqWorld(), file = stateFile(); await w.owner("UPDATE settings SET value = '\"production\"'::jsonb WHERE key = 'meta.environment'");
    const calls = [], realMain = G.main; G.main = async (a, e, dd) => { calls.push(a[0]); return realMain(a, e, dd); };
    let r; try { r = await L.run(argv(['--state=' + file].concat(SEQ)), deps(em)); } finally { G.main = realMain; }
    assert.equal(r.code, 2, 'the environment says production: refused before any statement'); assert.deepEqual(calls, ['--run=identity'], 'the chain stops at the first stage'); assert.ok(/STOPPED at stage identity/.test(text(r))); assert.equal((await w.owner('SELECT count(*)::int AS n FROM services'))[0].n, 0); }
  { const { w, em } = await seqWorld({ activation: false }), file = stateFile(), calls = [], realMain = G.main; G.main = async (a, e, dd) => { calls.push(a[0]); return realMain(a, e, dd); };
    let r; try { r = await L.run(argv(['--state=' + file].concat(SEQ)), deps(em)); } finally { G.main = realMain; }
    assert.ok(calls.includes('--run=proof-race'), 'the race stage ran even though an earlier proof stage may have failed');
    const res = Object.fromEntries(r.results); assert.equal(res['proof-race'], 1, 'without the activation switch the race setup cannot be completed: recorded as FAILED'); assert.equal(res['proof-twin'], 0, 'and the other proof stages are not affected'); assert.equal(r.code, 1); assert.ok(/FAILED proof-race \(recorded\)/.test(text(r))); }
});

test('the HTTP guard lets a stage send only the single (non-read) statements it was approved to send: the price statements of the race stage are refused in every other stage', async () => {
  const conn = G.parseConnection(GOOD), db = require('../netlify/functions/_kaspchem/db.js'), calls = [];
  const priceInsert = 'INSERT INTO pricing (service_id, professional_id, label, price, cost, commission, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id';
  const body = JSON.stringify({ query: priceInsert, params: ['1', null, 'x', 1, 0, 0, null] });
  const headers = { 'Neon-Connection-String': GOOD, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' };
  const mk = (extra) => G.makeGuard({ conn, baseFetch: async () => { calls.push(1); return new Response('{}', { status: 200 }); }, db, extraSingle: extra }), url = 'https://' + conn.apiHost + '/sql';
  { const g = mk([]); g.state.phase = 'stage'; await assert.rejects(() => g.fetch(url, { method: 'POST', headers, body }), /blocked_by_g2_guard/); assert.equal(calls.length, 0, 'not sent'); }
  { const g = mk([{ test: (x) => x === priceInsert }]); g.state.phase = 'stage'; await g.fetch(url, { method: 'POST', headers, body }); assert.equal(calls.length, 1, 'only the exact approved text goes through'); }
  { const g = mk([{ test: (x) => x === priceInsert }]); g.state.phase = 'stage'; const other = JSON.stringify({ query: priceInsert + ' ', params: [] }), other2 = JSON.stringify({ query: 'DELETE FROM pricing', params: [] }); for (const b of [other.replace(' ', ''), other2]) await assert.rejects(() => g.fetch(url, { method: 'POST', headers, body: b }), /blocked_by_g2_guard/); }
  for (const id of ['proof-crud', 'proof-twin', 'proof-r12', 'proof-concurrency']) assert.ok(!(G.STAGES[id].allowSingle || []).some((re) => re.test(priceInsert)), id + ' may not write a price');
  assert.ok((G.STAGES['proof-race'].allowSingle || []).some((re) => re.test(priceInsert)), 'only the race stage may');
  for (const id of Object.keys(G.STAGES).filter((k) => /^proof-/.test(k))) { assert.ok(G.STAGES[id].maxRequests >= 200, id + ' has its own request cap'); assert.deepEqual(G.STAGES[id].needs, ['atomic-import']); assert.equal(G.STAGES[id].independent, true); }
});

test('a clipboard that another program holds for a moment is retried; a lock that does not end still stops the run before anything is sent', async () => {
  { const { em } = await seqWorld(), file = stateFile(); let reads = 0, content = GOOD;
    const clip = { read: async () => { reads++; if (reads >= 2 && reads <= 6) throw new Error('clipboard_unavailable'); return content; }, clear: async () => { content = ''; }, historyEnabled: async () => false };
    const r = await L.run(argv(['--state=' + file]), deps(em, { clipboard: clip })); assert.equal(r.code, 0, text(r)); assert.ok(reads > 6, 'it read again after the failures'); assert.equal(content, '', 'and the string was cleared'); }
  { const { em } = await seqWorld(), file = stateFile(); let reads = 0;
    const clip = { read: async () => { reads++; if (reads >= 2) throw new Error('clipboard_unavailable'); return ''; }, clear: async () => {}, historyEnabled: async () => false };
    const r = await L.run(argv(['--state=' + file]), deps(em, { clipboard: clip })); assert.equal(r.code, 2); assert.ok(/clipboard could not be read/.test(text(r))); assert.equal(em.requests.length, 0, 'nothing was sent'); assert.ok(reads <= 43, 'it gave up after a bounded number of tries'); }
});

// ---- the migration 003 sequence (the dedicated branch where the branch owner applied 003 before the run) ------------------------------------------------------------------------------------------------------------
const NEEDS_REAL_003 = [/^LOCK: the activation behind a row lock/, /^LOCK: nothing was saved by the refused activation/, /^LOCK: after the lock the very same activation works/, /^SHARE: the older price edit waits/, /^DEADLOCK: the database detects it/, /^OLDER WRITE FIRST: the UPDATE that opens the catalog WAITED/, /^OPENING FIRST: an older write that started before the opening was visible WAITED/];
test('the argument rules of the 003 sequence: its own name and its own approval, never the other sequence\'s approval', () => {
  const ok = L.parseArgs(argv(['--sequence=proof003', '--allow-writes=sequence-proof003'])); assert.deepEqual(ok.stages, L.PROOF003_SEQUENCE); assert.equal(ok.stages.length, 15); assert.ok(!ok.stages.includes('proof-race'), 'the race stage that shows the violation WITHOUT the triggers is not in it');
  for (const extra of [['--sequence=proof003', '--allow-writes=sequence-proof'], ['--sequence=proof', '--allow-writes=sequence-proof003'], ['--sequence=proof003'], ['--sequence=proof003', '--allow-writes=sequence-proof003', '--stages=identity']]) assert.throws(() => L.parseArgs(argv(extra)), /sequence|allow-writes|stage/, JSON.stringify(extra));
  for (const id of ['proof003-race', 'proof003-guard', 'proof003-locks', 'proof003-switch']) { assert.equal(L.WRITE_STAGES.includes(id) || L.ALLOWED_STAGES.includes(id), false); assert.equal(G.STAGES[id].independent, true); assert.deepEqual(G.STAGES[id].needs, ['atomic-import']); assert.ok(G.STAGES[id].maxRequests >= 200); }
  const priceInsert = 'INSERT INTO pricing (service_id, professional_id, label, price, cost, commission, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id';
  for (const id of ['proof003-race', 'proof003-guard', 'proof003-locks']) assert.ok(G.STAGES[id].allowSingle.some((re) => re.test(priceInsert)), id + ' makes its prices through the older route'); assert.ok(!G.STAGES['proof003-switch'].allowSingle.some((re) => re.test(priceInsert)), 'the switch stage writes no price');
});

test('THE WHOLE 003 SEQUENCE on the in-memory database with the guard installed: the mechanics of every stage work and the HTTP guard blocks nothing; the race in both orders and the burst, the direct writes, the role checks all pass; only the checks that need two REAL connections (waits, a deadlock) may differ here', async () => {
  const { w, em } = await seqWorld({ guard003: true }), file = stateFile(), calls = [], realMain = G.main;
  G.main = async (a, e, dd) => { calls.push(a[0]); return realMain(a, e, dd); };
  let r; try { r = await L.run(argv(['--state=' + file, '--sequence=proof003', '--allow-writes=sequence-proof003']), deps(em)); } finally { G.main = realMain; }
  assert.deepEqual(calls, L.PROOF003_SEQUENCE.map((s) => '--run=' + s)); const out = text(r); for (const x of [PW, GOOD, HOST]) assert.ok(!out.includes(x)); assert.ok(!/postgres(ql)?:\/\/\S/i.test(out)); assert.ok(/blocked by the guard: 0\)/.test(out) && !/blocked by the guard: [1-9]/.test(out), 'the HTTP guard blocked nothing');
  const res = Object.fromEntries(r.results); for (const s of ['identity', 'atomic-import', 'proof-crud', 'proof-twin', 'proof-r12', 'proof003-race', 'proof003-guard']) assert.equal(res[s], 0, s + ' passed');
  const failed = out.split('\n').filter((l) => /^  FAIL  /.test(l)).map((l) => l.replace(/^  FAIL  /, ''));
  for (const f of failed) assert.ok(NEEDS_REAL_CONNECTIONS.concat(NEEDS_REAL_003).some((re) => re.test(f)), 'a check failed that is not a real-connection one: ' + f.slice(0, 180));
  assert.equal((await w.owner("SELECT value::text AS v FROM settings WHERE key = 'private.catalog_enabled'"))[0].v, 'true', 'the switch ends open, as it was found');
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active'  AND pricing_id IN (SELECT id FROM pricing WHERE NOT approved)"))[0].n, 0, 'no active engagement has an unapproved price');
});

test('without the triggers on the branch the 003 stages say so and write nothing: the first check fails and the stage stops', async () => {
  const { w, em } = await seqWorld(), file = stateFile(); const base = await w.fingerprint();   // no guard003
  const state = { runs: ['identity', 'headers', 'lock-probe', 'atomic-control', 'atomic-rollback', 'atomic-guard', 'atomic-import'].map((s) => ({ stage: s, pass: true, endpoint: EP, marker: G.sha8(MARKER), utc: 'x', run: 'x', notes: {} })) }; fs.writeFileSync(file, JSON.stringify(state));
  const url = GOOD, env = { KASPCHEM_G2_DATABASE_URL: url };
  for (const id of ['proof003-race', 'proof003-guard', 'proof003-locks']) {
    const r = await G.main(['--run=' + id, '--approved-stages=' + id, '--expect-endpoint=' + EP, '--expect-env=test', '--marker=' + MARKER, '--state=' + file, '--allow-writes'], env, { fetch: serialized(em), now: () => 1762600000000 });
    assert.equal(r.code, 1, id); assert.ok(r.lines.some((l) => /migration 003 is in place on this branch/.test(l) && /FAIL/.test(l)), id);
  }
  assert.deepEqual(await w.fingerprint(), base, 'nothing was written');
});
