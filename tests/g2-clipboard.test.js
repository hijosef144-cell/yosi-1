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
  assert.throws(() => L.parseArgs(argv([GOOD])), /command line/); assert.throws(() => L.parseArgs(argv(['--stages=atomic-control'])), /only these stages/); assert.throws(() => L.parseArgs(argv(['--stages=identity,atomic-import'])), /only these stages/);
  assert.throws(() => L.parseArgs(argv(['--allow-writes'])), /unknown option/); assert.throws(() => L.parseArgs(['--expect-env=test', '--marker=' + MARKER]), /expect-endpoint/); assert.throws(() => L.parseArgs(argv(['--wait-seconds=1'])), /between/);
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
