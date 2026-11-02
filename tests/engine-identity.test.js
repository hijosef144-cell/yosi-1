'use strict';
// Question identity across topics (stage 0). Proves that qualifying ids (topic.id) changes no meaning, answer or result, that composing topics
// is collision-free, and that the engine still matches the recorded golden master for the published questionnaires and (when the private
// research folder is linked) for the unpublished V6 draft. Nothing here publishes anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const E = require('../kaspchem/assets/engine.js');
const GM = require('../scripts/golden-master.js');

const root = path.join(__dirname, '..');
const PUBLISHED = path.join(root, 'kaspchem', 'content', 'topics.json');
const V6 = path.join(root, 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
const hasV6 = fs.existsSync(V6);
const SKIP_V6 = hasV6 ? false : 'V6 draft not available in this checkout (private research folder not linked); published content is still checked';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).topics;

// Every complete answer path of a topic, or a deterministic spread of them when there are very many.
function paths(t, limit) {
  const all = [];
  (function walk(ans) {
    if (all.length >= limit) return;
    const q = E.nextQuestion(t, ans);
    if (!q) { all.push(ans); return; }
    GM.choices(q).forEach((c) => walk(Object.assign({}, ans, { [q.id]: c })));
  })({});
  return all;
}
const qualifyAnswers = (tid, a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [E.qualifyId(tid, k), v]));
const shape = (r, strip) => JSON.stringify({ o: r.outcome, f: r.findings.map((x) => strip(x.id)).sort(), n: r.count, c: r.cardCount, u: r.unknown.map(strip).sort() });

function equivalence(topics, perTopic) {
  topics.forEach((t) => {
    const q = E.qualifyTopic(t), strip = (id) => id.slice(t.id.length + 1);
    assert.deepEqual(E.lint(q), [], 'qualified ' + t.id + ' must lint clean');
    paths(t, perTopic).forEach((a) => {
      assert.ok(E.validateAnswers(q, qualifyAnswers(t.id, a)), t.id + ': qualified answers must stay valid');
      assert.equal(shape(E.evaluate(q, qualifyAnswers(t.id, a)), strip), shape(E.evaluate(t, a), (x) => x), t.id + ' ' + JSON.stringify(a));
    });
  });
}

test('published: the colliding local ids are exactly work and fees, and they are different questions', () => {
  const c = E.idCollisions(load(PUBLISHED));
  assert.deepEqual(c.map((x) => x.id).sort(), ['fees', 'work']);
  c.forEach((x) => assert.equal(x.same, false, x.id + ' is a different question in each topic and must never be merged'));
});

test('a plain merge of the published topics collides; the composed config does not', () => {
  const topics = load(PUBLISHED);
  const naive = { questions: [].concat(...topics.map((t) => t.questions)), rules: [].concat(...topics.map((t) => t.rules)) };
  assert.ok(E.lint(naive).some((e) => /work|fees/.test(e)), 'the naive merge must report the duplicate ids');
  const composed = E.composeTopics(topics);
  assert.deepEqual(E.lint(composed), []);
  assert.equal(new Set(composed.questions.map((q) => q.id)).size, composed.questions.length);
  assert.equal(composed.questions.length, topics.reduce((n, t) => n + t.questions.length, 0), 'no question lost or merged');
  assert.equal(composed.rules.length, topics.reduce((n, t) => n + t.rules.length, 0), 'no rule lost or merged');
});

test('qualifying ids changes no outcome, finding or card for any published answer path', () => {
  equivalence(load(PUBLISHED), 100000);
});

test('qualifyTopic does not modify its input, and refuses a topic id that would make ids ambiguous', () => {
  const t = load(PUBLISHED)[0], before = JSON.stringify(t);
  E.qualifyTopic(t);
  assert.equal(JSON.stringify(t), before);
  assert.throws(() => E.qualifyTopic({ id: 'a.b', questions: [], rules: [] }));
  assert.throws(() => E.composeTopics([t, t]));
});

test('answers of all published topics in one map: work and fees keep their own meaning, every topic result is unchanged', () => {
  const topics = load(PUBLISHED), composed = E.composeTopics(topics);
  [0, 'last', 'mid'].forEach((pick) => {
    let merged = {}; const expected = {};
    topics.forEach((t) => {
      const ps = paths(t, 100000), a = ps[pick === 'last' ? ps.length - 1 : pick === 'mid' ? Math.floor(ps.length / 2) : 0];
      merged = Object.assign(merged, qualifyAnswers(t.id, a)); expected[t.id] = E.evaluate(t, a);
    });
    assert.ok(E.validateAnswers(composed, merged), 'one combined answer map must be valid');
    assert.notDeepEqual(merged['tax-refunds.work'], undefined); assert.notDeepEqual(merged['national-insurance.work'], undefined);
    topics.forEach((t) => {
      const slice = { questions: composed.questions.filter((q) => q.topicId === t.id), rules: composed.rules.filter((r) => r.topicId === t.id) };
      const strip = (id) => id.slice(t.id.length + 1);
      assert.equal(shape(E.evaluate(slice, merged), strip), shape(expected[t.id], (x) => x), t.id);
    });
  });
});

test('golden master: the engine still returns exactly what was recorded for the published questionnaires (all answer paths)', () => {
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'published-v1.json'), 'utf8'));
  const topics = load(PUBLISHED);
  assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(PUBLISHED)).digest('hex'), snap.contentSha256, 'published content changed: re-record the golden master on purpose, never silently');
  topics.forEach((t) => {
    const got = GM.topicSnapshot(E, t), want = snap.topics[t.id];
    assert.equal(got.paths, want.paths, t.id + ' path count');
    assert.equal(got.digest, want.digest, t.id + ' results differ from the recorded ones');
  });
});

test('V6 draft (unpublished): composed ids are unique, qualifying changes no result, and the golden master is identical', { skip: SKIP_V6 }, () => {
  const topics = load(V6);
  assert.deepEqual(E.idCollisions(topics).map((x) => x.id), ['events']);
  assert.ok(E.idCollisions(topics).every((x) => !x.same));
  assert.deepEqual(E.lint(E.composeTopics(topics)), []);
  equivalence(topics, 4000);
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'v6-draft.json'), 'utf8'));
  assert.equal(require('crypto').createHash('sha256').update(fs.readFileSync(V6)).digest('hex'), snap.contentSha256, 'V6 draft content differs from the recorded one');
  const r = spawnSync('node', [path.join(root, 'scripts', 'golden-master.js'), 'check', V6, path.join(__dirname, 'fixtures', 'golden', 'v6-draft.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
