'use strict';
// Stage 4b: entry routes (the quick check) live in kaspchem/content/routes.json, separate from topics.json (the ten check topics), so that replacing
// or regenerating topics.json (for example publishing V6) can never drop a route. These tests prove that, and that a route pointing at a topic which
// is not in the topics file fails loudly. Nothing here publishes anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../kaspchem/assets/engine.js');
const GM = require('../scripts/golden-master.js');
const content = require('../netlify/functions/_kaspchem/content');

const root = path.join(__dirname, '..');
const TOPICS = path.join(root, 'kaspchem', 'content', 'topics.json'), ROUTES = path.join(root, 'kaspchem', 'content', 'routes.json');
const V6 = path.join(root, 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
const SKIP_V6 = fs.existsSync(V6) ? false : 'V6 draft not available in this checkout (the private research folder is not linked)';
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const topics = read(TOPICS), routes = read(ROUTES);
const origSeed = content.seed;

test.after(() => content.setSeed(origSeed));

test('topics.json is exactly the ten check topics; routes.json holds the quick check and the deep check; ids never overlap', () => {
  assert.equal(topics.topics.length, 10); assert.ok(topics.topics.every((t) => t.kind === undefined));
  assert.deepEqual(routes.topics.map((t) => t.id), ['quick', 'deep']); assert.equal(routes.topics[0].kind, 'router'); assert.equal(routes.topics[1].kind, 'deep');
  assert.deepEqual(content.routeProblems(topics, routes), []);
});

test('a route that points at a topic missing from the topics file is reported, loudly and specifically', () => {
  const without = { topics: topics.topics.filter((t) => t.id !== 'housing') };
  const problems = content.routeProblems(without, routes);
  assert.ok(problems.length >= 2 && problems.every((p) => /housing/.test(p)), problems.join('\n'));
  assert.ok(content.routeProblems(topics, { topics: [{ id: 'x', rules: [{ id: 'r', finding: {} }] }] })[0].includes('no finding.topic'));
  assert.ok(content.routeProblems(topics, { topics: [{ id: 'mortgage', rules: [] }] })[0].includes('same id'));
});

test('the server serves the ten topics and then the routes (config order), and resolves a route like any topic', async () => {
  content.setSeed(topics);
  const all = await content.loadTopics();
  assert.deepEqual(all.map((t) => t.id), topics.topics.map((t) => t.id).concat(['quick', 'deep']));
  assert.equal((await content.loadTopic('quick')).kind, 'router');
  assert.ok(content.seedTopic('quick') && content.seedTopic('mortgage'));
});

test('V6: replacing topics.json by the V6 publishable draft still serves quick, and quick still points only at topics that exist in the new file', { skip: SKIP_V6 }, async () => {
  const v6 = read(V6);
  assert.deepEqual(content.routeProblems(v6, routes), [], 'quick points at a topic that the V6 topics file does not have');
  content.setSeed(v6);
  const all = await content.loadTopics();
  assert.equal(all.length, v6.topics.length + 2);
  const q = all.find((t) => t.id === 'quick');
  assert.ok(q && q.kind === 'router' && q.rules.length === routes.topics[0].rules.length);
  // the V6 topics are the ones served, quick is untouched
  assert.deepEqual(all.filter((t) => t.id !== 'quick' && t.id !== 'deep').map((t) => t.name), v6.topics.map((t) => t.name));
  const ids = new Set(all.map((t) => t.id));
  q.rules.forEach((r) => assert.ok(ids.has(r.finding.topic)));
  content.setSeed(origSeed);
});

test('no script that writes or regenerates topics.json can touch routes.json: only gen-kaspchem-seed.js writes topics.json, and it never mentions routes', () => {
  const dir = path.join(root, 'scripts');
  const writers = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).filter((f) => { const s = fs.readFileSync(path.join(dir, f), 'utf8'); return /content[\/'",\s]+topics\.json/.test(s) && /writeFileSync/.test(s) && /dest\b/.test(s) && /gen-kaspchem-seed/.test(f); });
  assert.deepEqual(writers, ['gen-kaspchem-seed.js']);
  fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'launch-smoke.js').forEach((f) => {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/routes\.json/.test(s)) assert.ok(f === 'gen-kaspchem-seed.js' || !/writeFileSync\([^)]*routes/.test(s), f + ' writes routes.json');
  });
});

test('golden master for routes: the quick check still returns exactly what was recorded (sampled paths), before and after the deep route was added to the file', () => {
  // routes-v1.json was recorded when routes.json held only the quick check: compare per-topic digests only (the file has grown). routes-v2.json is the recorded snapshot of the file as it is now.
  const old = spawnSync('node', [path.join(root, 'scripts', 'golden-master.js'), 'check', ROUTES, path.join(__dirname, 'fixtures', 'golden', 'routes-v1.json'), '--topics-only'], { encoding: 'utf8' });
  assert.equal(old.status, 0, old.stdout + old.stderr);
  const r = spawnSync('node', [path.join(root, 'scripts', 'golden-master.js'), 'check', ROUTES, path.join(__dirname, 'fixtures', 'golden', 'routes-v2.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const snap = read(path.join(__dirname, 'fixtures', 'golden', 'routes-v2.json')), snap1 = read(path.join(__dirname, 'fixtures', 'golden', 'routes-v1.json'));
  assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(ROUTES)).digest('hex'), snap.contentSha256, 'routes content changed: re-record routes-v2.json on purpose');
  const got = GM.topicSnapshot(E, routes.topics[0]);
  assert.equal(got.digest, snap.topics.quick.digest);
  assert.equal(got.digest, snap1.topics.quick.digest, 'the quick check must give exactly what it gave before the deep route existed');
});

test('the published ten keep their original golden master (the snapshot file is the one recorded before the quick check existed)', () => {
  const snap = read(path.join(__dirname, 'fixtures', 'golden', 'published-v1.json'));
  assert.deepEqual(Object.keys(snap.topics), topics.topics.map((t) => t.id));
  assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(TOPICS)).digest('hex'), snap.contentSha256);
});

test('ids: the quick check collides with the ten only on local ids (never merged); composing all eleven lints clean', () => {
  const c = E.idCollisions(topics.topics.concat(routes.topics));
  assert.deepEqual(c.map((x) => x.id).sort(), ['bills', 'fees', 'work']);
  c.forEach((x) => assert.equal(x.same, false));
  assert.deepEqual(E.lint(E.composeTopics(topics.topics.concat(routes.topics))), []);
});
