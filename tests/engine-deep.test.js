'use strict';
// Stage 5: the deep check on the shared engine. Pure engine tests (no browser, no server): derive, compose, gating, three-valued logic, tiers, the property
// "high tier == the findings of each topic evaluated alone" on many sampled paths, lint rules (i)-(v), path-length statistics.
// The V6 draft (unpublished, in the private research folder) is used when present; the published ten are always used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');
const L = require('../kaspchem/assets/engine-deep-lint.js');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const TEN = read(path.join(root, 'kaspchem', 'content', 'topics.json')).topics;
const ROUTE = read(path.join(root, 'kaspchem', 'content', 'routes.json')).topics.find((t) => t.id === 'deep');
const V6F = path.join(root, 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
const SKIP_V6 = fs.existsSync(V6F) ? false : 'V6 draft not available in this checkout (the private research folder is not linked)';
const V6 = SKIP_V6 ? null : read(V6F).topics;
// The real route needs the V6 shapes (`requires`): against the published ten it is NOT AVAILABLE. The reduced run against the ten is a TEST-ONLY mode: the same route without `requires`.
const ROUTE_DEG = Object.assign({}, ROUTE, { requires: [] });
const SETS = [['published ten', TEN, ROUTE_DEG]].concat(SKIP_V6 ? [] : [['V6 draft', V6, ROUTE]]);

// ---------- helpers ----------
const rule = (id, when, extra) => Object.assign({ id: id, when: when, finding: { title: 't-' + id, why: 'w-' + id } }, extra || {});
const Q = (id, opts, extra) => Object.assign({ id: id, text: id, options: opts.map((o) => (typeof o === 'string' ? { id: o, label: o } : o)) }, extra || {});
function toy() { // three single questions: a (yes/no/unk), b (yes/no), c (yes/no), shown only when a = yes
  return { questions: [Q('a', ['yes', 'no', { id: 'unk', label: 'unk', unknown: true }]), Q('b', ['yes', 'no']), Q('c', ['yes', 'no'], { showIf: { q: 'a', in: ['yes'] } })], rules: [] };
}
// the three values as conditions over toy(): T = a∈yes (answered yes), F = a∈no... built per test
const V = { T: true, F: false, U: null };

function perTopic(cfg, merged) {
  const out = {};
  cfg.topics.forEach((t) => {
    const local = {};
    Object.keys(merged).forEach((k) => { if (k.indexOf(t + '.') === 0) local[k.slice(t.length + 1)] = merged[k]; });
    const src = cfgSource(cfg, t);
    E.evaluate(src, local).findings.forEach((f) => { out[t + '.' + f.id] = true; });
  });
  return out;
}
let SRC = null;
function cfgSource(cfg, t) { return SRC.filter((x) => x.id === t)[0]; }
function setSrc(topics) { SRC = topics; }

// a seeded sampler that also picks unknown-flagged options now and then
function sampler(cfg, seed, pUnknown) {
  const rand = L.rng(seed);
  return function () {
    const ans = {}; let q, n = 0;
    while ((q = E.deepNext(cfg, ans))) {
      const unk = q.options.filter((o) => o.unknown);
      if (unk.length && rand() < pUnknown) ans[q.id] = q.multi ? [unk.filter((o) => o.exclusive).concat(unk)[0].id] : unk[Math.floor(rand() * unk.length)].id;
      else ans[q.id] = pickPlain(q, rand);
      if (++n > 400) throw new Error('no termination');
    }
    return ans;
  };
}
function pickPlain(q, rand) {
  const plain = q.options.filter((o) => !o.unknown);
  if (!q.multi) return plain[Math.floor(rand() * plain.length)].id;
  const chosen = plain.filter((o) => !o.exclusive && rand() < 0.3).map((o) => o.id);
  if (chosen.length) return chosen;
  const ex = plain.filter((o) => o.exclusive);
  return [(ex.length ? ex : plain)[Math.floor(rand() * (ex.length ? ex.length : plain.length))].id];
}

// ---------- three-valued logic ----------
test('truth tables (Kleene): all / any / not over true, false and unknown', () => {
  // atoms over a toy question set: x answered "in" the list = T, answered "not in" = F, answered with an unknown option = U
  const qs = [Q('x', ['t', 'f', { id: 'u', label: 'u', unknown: true }])];
  const atom = (v) => ({ q: 'x', in: ['t'] }), val = { T: { x: 't' }, F: { x: 'f' }, U: { x: 'u' } };
  const run = (cond, a) => E.check3(cond, qs, a).value;
  // single atoms
  assert.equal(run(atom(), val.T), true); assert.equal(run(atom(), val.F), false); assert.equal(run(atom(), val.U), null);
  // two independent atoms: x and y
  const qs2 = [qs[0], Q('y', ['t', 'f', { id: 'u', label: 'u', unknown: true }])];
  const A = { q: 'x', in: ['t'] }, B = { q: 'y', in: ['t'] };
  const AND = { T: { T: true, F: false, U: null }, F: { T: false, F: false, U: false }, U: { T: null, F: false, U: null } };
  const OR = { T: { T: true, F: true, U: true }, F: { T: true, F: false, U: null }, U: { T: true, F: null, U: null } };
  ['T', 'F', 'U'].forEach((p) => ['T', 'F', 'U'].forEach((q) => {
    const a = { x: val[p].x, y: val[q].x };
    assert.equal(E.check3({ all: [A, B] }, qs2, a).value, AND[p][q], 'all ' + p + q);
    assert.equal(E.check3({ any: [A, B] }, qs2, a).value, OR[p][q], 'any ' + p + q);
  }));
  assert.equal(E.check3({ not: A }, qs2, { x: 't' }).value, false);
  assert.equal(E.check3({ not: A }, qs2, { x: 'f' }).value, true);
  assert.equal(E.check3({ not: A }, qs2, { x: 'u' }).value, null);
  assert.equal(E.check3({ not: { not: A } }, qs2, { x: 'u' }).value, null);
});

test('what is unknown: unanswered, an unknown option, "prefer not to answer"; an unknown option that the rule lists is a plain match; hidden is false', () => {
  const cfg = toy();
  // unanswered visible question → unknown, and it is named
  let r = E.check3({ q: 'b', in: ['yes'] }, cfg, {}); assert.equal(r.value, null); assert.deepEqual(r.missing, ['b']);
  // unknown option not listed → unknown; listed → true (authored on purpose, same as the per-topic engine)
  assert.equal(E.check3({ q: 'a', in: ['yes'] }, cfg, { a: 'unk' }).value, null);
  assert.equal(E.check3({ q: 'a', in: ['yes', 'unk'] }, cfg, { a: 'unk' }).value, true);
  // a hidden question is false (nothing was asked), also under "not" (exactly like the per-topic engine)
  assert.equal(E.check3({ q: 'c', in: ['yes'] }, cfg, { a: 'no' }).value, false);
  assert.equal(E.check3({ not: { q: 'c', in: ['yes'] } }, cfg, { a: 'no' }).value, true);
  // a question that would be shown only if an unknown answer were something else is unknown and names the answer that decides it
  r = E.check3({ q: 'c', in: ['yes'] }, cfg, { a: 'unk' }); assert.equal(r.value, null); assert.deepEqual(r.missing, ['a']);
  // an unanswered question that is hidden stays false
  assert.equal(E.check3({ q: 'c', in: ['yes'] }, cfg, { a: 'no' }).value, false);
  // an undefined question is false, a malformed condition is false, no condition is true
  assert.equal(E.check3({ q: 'zz', in: ['yes'] }, cfg, {}).value, false); assert.equal(E.check3({ q: 'a' }, cfg, { a: 'yes' }).value, false); assert.equal(E.check3(null, cfg, {}).value, true);
  // multi: any selected option counts; an exclusive unknown option alone is unknown
  const m = { questions: [Q('m', ['x', 'y', { id: 'unk', label: 'unk', unknown: true, exclusive: true }], { multi: true })] };
  assert.equal(E.check3({ q: 'm', in: ['y'] }, m, { m: ['x', 'y'] }).value, true);
  assert.equal(E.check3({ q: 'm', in: ['y'] }, m, { m: ['x'] }).value, false);
  assert.equal(E.check3({ q: 'm', in: ['y'] }, m, { m: ['unk'] }).value, null);
});

test('where every relevant answer is known, the three-valued value equals the two-valued check (exhaustive on a toy set)', () => {
  const cfg = toy();
  const conds = [{ q: 'a', in: ['yes'] }, { not: { q: 'a', in: ['no'] } }, { all: [{ q: 'a', in: ['yes'] }, { q: 'c', in: ['yes'] }] }, { any: [{ q: 'b', in: ['yes'] }, { not: { q: 'c', in: ['no'] } }] }, { all: [{ not: { q: 'c', in: ['yes'] } }, { q: 'b', in: ['no'] }] }];
  ['yes', 'no'].forEach((a) => ['yes', 'no'].forEach((b) => ['yes', 'no', undefined].forEach((c) => {
    const ans = { a: a, b: b }; if (a === 'yes' && c) ans.c = c; if (a === 'yes' && !c) return;
    conds.forEach((cond) => assert.equal(E.check3(cond, cfg, ans).value, E.check(cond, ans), JSON.stringify([ans, cond])));
  })));
});

// ---------- composing, facts, gates ----------
test('compose: question and rule ids are qualified, the profile has its own namespace, nothing is merged by name', () => {
  setSrc(TEN);
  const cfg = E.buildDeep(ROUTE_DEG, TEN);
  const ids = cfg.questions.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-z-]+\.[A-Za-z0-9_-]+$/.test(id)));
  assert.ok(ids.some((id) => id.indexOf('profile.') === 0));
  // the ten topics use the local id `work` for different questions (tax: the last years; national insurance: now): they stay different questions
  assert.ok(ids.includes('tax-refunds.work') && ids.includes('national-insurance.work'));
  assert.notEqual(cfg.questions.find((q) => q.id === 'tax-refunds.work').text, cfg.questions.find((q) => q.id === 'national-insurance.work').text);
  cfg.rules.forEach((r) => E.condQs(r.when, (id) => assert.ok(ids.includes(id), r.id + ' → ' + id)));
  // the composition did not touch the source topics
  assert.equal(JSON.stringify(TEN), JSON.stringify(read(path.join(root, 'kaspchem', 'content', 'topics.json')).topics));
});

test('facts: a profile answer fills the declared topic questions, which are then not asked; the first matching fact wins; nothing by name similarity', () => {
  const topics = [{ id: 't1', name: 't1', questions: [Q('home', ['own', 'rent']), Q('rent_aid', ['yes', 'no'], { showIf: { q: 'home', in: ['rent'] } }), Q('work', ['a', 'b'])], rules: [rule('r1', { q: 'home', in: ['rent'] })] }];
  const route = { id: 'deep', name: 'deep', topics: ['t1'], profile: { questions: [Q('living', ['own', 'rent', 'other'])] },
    facts: [{ id: 'f1', from: 'profile.living', map: { own: { 't1.home': 'own' }, rent: { 't1.home': 'rent' } } }, { id: 'f2', from: 'profile.living', map: { own: { 't1.home': 'rent' } } }] };
  const cfg = E.buildDeep(route, topics);
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.living': 'own' }), { 't1.home': 'own' }); // f1 wins over f2
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.living': 'rent' }), { 't1.home': 'rent' });
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.living': 'other' }), {}); // not mapped: the question is asked
  assert.deepEqual(E.deriveAnswers(cfg, {}), {});
  // the same local id "work" in t1 is NOT filled by anything: no similarity matching
  assert.equal(E.deepNext(cfg, { 'profile.living': 'rent' }).id, 't1.rent_aid'); // t1.home was derived (skipped), the follow-up it makes visible is next
  assert.equal(E.deepNext(cfg, { 'profile.living': 'other' }).id, 't1.home');
  const e = E.deepEffective(cfg, { 'profile.living': 'rent' });
  assert.equal(e.merged['t1.home'], 'rent'); assert.ok(e.derived['t1.home']); assert.deepEqual(e.answers, { 'profile.living': 'rent' });
  // a typed answer to a derived question is dropped (derived wins), a stale answer to a hidden question is dropped
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.living': 'own', 't1.home': 'rent' }), { 't1.home': 'own' });
  assert.deepEqual(E.deepPrune(cfg, { 'profile.living': 'own', 't1.home': 'rent', 't1.rent_aid': 'yes' }), { 'profile.living': 'own' });
  // validation: exactly what must be answered, nothing derived, nothing hidden
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'own', 't1.work': 'a' }), true);
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'own', 't1.work': 'a', 't1.home': 'own' }), false);
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'own' }), false);
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'rent', 't1.work': 'a', 't1.rent_aid': 'no' }), true);
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'own', 't1.work': 'a', 't1.rent_aid': 'no' }), false);
  assert.equal(E.deepValidate(cfg, { 'profile.living': 'nope', 't1.work': 'a' }), false);
  assert.equal(E.deepValidate(cfg, null), false);
});

test('facts: a multi profile answer fills a multi target only when every picked option maps it; an exclusive option never mixes; sensitive "prefer not to answer" maps through', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('kind', ['emp', 'self', { id: 'none', label: 'none', exclusive: true }], { multi: true })], rules: [] }];
  const route = { id: 'deep', name: 'deep', topics: ['t'], profile: { questions: [Q('hist', ['emp', 'self', 'other', { id: 'none', label: 'none', exclusive: true }], { multi: true })] },
    facts: [{ id: 'f', from: 'profile.hist', map: { emp: { 't.kind': ['emp'] }, self: { 't.kind': ['self'] }, none: { 't.kind': ['none'] } } }] };
  const cfg = E.buildDeep(route, topics);
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.hist': ['emp'] }), { 't.kind': ['emp'] });
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.hist': ['self', 'emp'] }), { 't.kind': ['emp', 'self'] }); // in the target's own option order
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.hist': ['emp', 'other'] }), {}); // "other" has no mapping: the target is asked
  assert.deepEqual(E.deriveAnswers(cfg, { 'profile.hist': ['none'] }), { 't.kind': ['none'] });
  // a mapping that would combine an exclusive option with another is not used
  const bad = E.buildDeep(Object.assign({}, route, { facts: [{ id: 'f', from: 'profile.hist', map: { emp: { 't.kind': ['emp', 'none'] } } }] }), topics);
  assert.deepEqual(E.deriveAnswers(bad, { 'profile.hist': ['emp'] }), {});
});

test('gates: a topic is shown only while the profile condition holds; a gate on a missing topic or question is skipped, never an error', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('x', ['a', 'b']), Q('y', ['a', 'b'])], rules: [] }];
  const route = { id: 'deep', name: 'deep', topics: ['t'], profile: { questions: [Q('s', ['on', 'off'])] }, facts: [],
    gates: [{ id: 'g', topic: 't', show: { q: 'profile.s', in: ['on'] } }, { id: 'g2', topic: 'zzz', show: { q: 'profile.s', in: ['on'] } }, { id: 'g3', questions: ['t.nope'], show: { q: 'profile.s', in: ['on'] } }] };
  const cfg = E.buildDeep(route, topics);
  assert.deepEqual(cfg.gates.map((g) => g.id), ['g']); assert.deepEqual(cfg.skipped.filter((s) => s.kind === 'gate').map((s) => s.id).sort(), ['g2', 'g3']);
  // the profile question is used by the live gate, so it stays
  assert.equal(E.deepNext(cfg, {}).id, 'profile.s');
  assert.equal(E.deepNext(cfg, { 'profile.s': 'on' }).id, 't.x');
  assert.equal(E.deepNext(cfg, { 'profile.s': 'off' }), null);
  assert.equal(E.deepValidate(cfg, { 'profile.s': 'off' }), true);
  assert.equal(E.deepValidate(cfg, { 'profile.s': 'off', 't.x': 'a', 't.y': 'a' }), false);
});

test('a route that points at nothing that is served is skipped as a whole: no crash, an empty but valid flow; unused profile questions are not asked', () => {
  const cfg = E.buildDeep(ROUTE, []);
  assert.deepEqual(cfg.topics, []); assert.deepEqual(cfg.questions, []); assert.equal(E.deepNext(cfg, {}), null);
  assert.equal(E.deepValidate(cfg, {}), true);
  const r = E.evaluateDeep(cfg, {}); assert.equal(r.outcome, 'none'); assert.equal(r.counts.high, 0);
  // a route without any section
  const c2 = E.buildDeep({ id: 'deep', name: 'x' }, TEN); assert.deepEqual(c2.topics, []);
});

// ---------- tiers ----------
function tierCfg() {
  const topics = [{ id: 't', name: 't', questions: [Q('a', ['yes', 'no', { id: 'unk', label: 'unk', unknown: true }]), Q('b', ['yes', 'no']), Q('c', ['yes', 'no'], { showIf: { q: 'a', in: ['yes'] } })],
    rules: [rule('hi', { q: 'a', in: ['yes'] }), rule('both', { all: [{ q: 'a', in: ['yes'] }, { q: 'b', in: ['yes'] }] }), rule('negb', { all: [{ q: 'a', in: ['yes'] }, { not: { q: 'b', in: ['yes'] } }] }), rule('off', { q: 'a', in: ['yes'] }, { status: 'inactive' }), rule('dep', { all: [{ q: 'c', in: ['yes'] }] })] }];
  const route = { id: 'deep', name: 'deep', topics: ['t'], profile: { questions: [] }, weak: [{ id: 'w', like: 't.hi', when: { all: [{ q: 't.a', in: ['no'] }, { q: 't.b', in: ['yes'] }] } }] };
  return E.buildDeep(route, topics);
}
test('tiers: high = true, missing = not false but depends on an unknown answer (named), low = only a weak rule that is true; false yields nothing; inactive never fires', () => {
  const cfg = tierCfg(), ids = (l) => l.map((f) => f.id).sort();
  let r = E.evaluateDeep(cfg, { 't.a': 'yes', 't.b': 'yes', 't.c': 'no' });
  assert.deepEqual(ids(r.high), ['t.both', 't.hi']); assert.deepEqual(r.missing, []); assert.deepEqual(r.low, []); assert.equal(r.outcome, 'found');
  // a = unknown: hi/both/negb/dep depend on it → missing, naming "t.a"; nothing is high
  r = E.evaluateDeep(cfg, { 't.a': 'unk', 't.b': 'yes' });
  assert.deepEqual(r.high, []); assert.deepEqual(ids(r.missing), ['t.both', 't.dep', 't.hi']); // negb is FALSE (b is known to be yes), so it is not even missing assert.equal(r.outcome, 'insufficient');
  r.missing.forEach((f) => assert.deepEqual(f.missing.map((m) => m.id), ['t.a']));
  assert.ok(r.missing.every((f) => f.missing[0].text === 'a'));
  // a = no: a is known, so every rule that needs a = yes is FALSE, not missing: nothing is invented
  r = E.evaluateDeep(cfg, { 't.a': 'no', 't.b': 'no' });
  assert.deepEqual(r.high, []); assert.deepEqual(r.missing, []); assert.deepEqual(r.low, []); assert.equal(r.outcome, 'none');
  // weak rule: true → low only (never high, never missing); unknown → nothing at all
  r = E.evaluateDeep(cfg, { 't.a': 'no', 't.b': 'yes' }); assert.deepEqual(ids(r.low), ['weak.w']); assert.deepEqual(r.high, []); assert.equal(r.outcome, 'none');
  assert.equal(r.low[0].title, 't-hi'); assert.equal(r.low[0].weak, true); // reuses the finding of the rule it is like
  r = E.evaluateDeep(cfg, { 't.a': 'unk', 't.b': 'yes' }); assert.ok(!r.low.length);
  // partial answers (the running count): only what is already certain is high; unanswered questions are unknown, not false
  r = E.evaluateDeep(cfg, { 't.a': 'yes' }); assert.deepEqual(ids(r.high), ['t.hi']); assert.ok(ids(r.missing).includes('t.both'));
  r = E.evaluateDeep(cfg, {}); assert.deepEqual(r.high, []); assert.ok(r.missing.length > 0);
  // inactive rules never fire, unless asked for (admin preview)
  assert.ok(!E.evaluateDeep(cfg, { 't.a': 'yes', 't.b': 'yes', 't.c': 'no' }).high.some((f) => f.id === 't.off'));
  assert.ok(E.evaluateDeep(cfg, { 't.a': 'yes', 't.b': 'yes', 't.c': 'no' }, { includeInactive: true }).high.some((f) => f.id === 't.off'));
  // the stored form
  assert.deepEqual(E.deepFindingIds(E.evaluateDeep(cfg, { 't.a': 'yes', 't.b': 'no', 't.c': 'no' })), ['high:t.hi', 'high:t.negb']);
});

test('a missing answer is named even when the decisive question is a follow-up that was never shown because of an unknown earlier answer', () => {
  const cfg = tierCfg();
  const r = E.evaluateDeep(cfg, { 't.a': 'unk', 't.b': 'no' });
  const dep = r.missing.find((f) => f.id === 't.dep');
  assert.ok(dep, 'rule on the follow-up c is open because a is unknown'); assert.deepEqual(dep.missing.map((m) => m.id), ['t.a']);
});

test('display-only fields: option group and hint are ignored by the engine core (same flow, same result with or without them)', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('m', [{ id: 'x', label: 'x', group: 'G1', hint: 'h1' }, { id: 'y', label: 'y', group: 'G2' }, { id: 'none', label: 'none', exclusive: true }], { multi: true })], rules: [rule('r', { q: 'm', in: ['y'] })] }];
  const stripped = JSON.parse(JSON.stringify(topics)); stripped[0].questions[0].options.forEach((o) => { delete o.group; delete o.hint; });
  const route = { id: 'deep', name: 'd', topics: ['t'], profile: { questions: [] }, tune: { 't.m': { groups: { x: 'Z' }, hints: { y: 'H' } } } };
  const a = E.buildDeep(route, topics), b = E.buildDeep({ id: 'deep', name: 'd', topics: ['t'], profile: { questions: [] } }, stripped);
  [['y'], ['x', 'y'], ['x'], ['none']].forEach((v) => {
    const ra = E.evaluateDeep(a, { 't.m': v }), rb = E.evaluateDeep(b, { 't.m': v });
    assert.deepEqual(ra.high.map((f) => f.id), rb.high.map((f) => f.id));
    assert.equal(E.deepValidate(a, { 't.m': v }), E.deepValidate(b, { 't.m': v }));
  });
  assert.equal(a.questions[0].options[0].group, 'Z'); assert.equal(a.questions[0].options[1].hint, 'H');
  // the per-topic engine still reads such a question without caring about the extra fields
  assert.equal(E.evaluate(topics[0], { m: ['y'] }).count, 1);
});

test('sensitive questions get a "prefer not to answer" option that is unknown (not false), exclusive on multi questions', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('s', ['yes', 'no']), Q('m', ['p', 'q', { id: 'none', label: 'none', exclusive: true }], { multi: true })], rules: [rule('r1', { q: 's', in: ['yes'] }), rule('r2', { q: 'm', in: ['p'] })] }];
  const route = { id: 'deep', name: 'd', topics: ['t'], profile: { questions: [] }, tune: { 't.s': { sensitive: { why: 'w' } }, 't.m': { sensitive: { why: 'w' } } } };
  const cfg = E.buildDeep(route, topics), s = cfg.questions[0], m = cfg.questions[1];
  assert.ok(s.sensitive && s.options[s.options.length - 1].pna && s.options[s.options.length - 1].unknown);
  assert.ok(m.options[m.options.length - 1].exclusive);
  assert.equal(E.deepValidate(cfg, { 't.s': 'pna', 't.m': ['pna'] }), true);
  assert.equal(E.deepValidate(cfg, { 't.s': 'pna', 't.m': ['p', 'pna'] }), false);
  const r = E.evaluateDeep(cfg, { 't.s': 'pna', 't.m': ['pna'] });
  assert.deepEqual(r.high, []); assert.deepEqual(r.missing.map((f) => f.id).sort(), ['t.r1', 't.r2']); assert.ok(r.missing.every((f) => f.missing[0].sensitive));
  // the per-topic engine never sees these options: the original questions are untouched
  assert.ok(!topics[0].questions[0].options.some((o) => o.pna));
});

// ---------- the property: high tier == the topic evaluated alone ----------
function property(name, topics, n, seed, pUnknown, route) {
  setSrc(topics);
  const cfg = E.buildDeep(route || ROUTE, topics), draw = sampler(cfg, seed, pUnknown), stat = { paths: 0, withUnknown: 0, equal: 0, strictlyMore: 0 };
  for (let i = 0; i < n; i++) {
    const ans = draw(), e = E.deepEffective(cfg, ans), r = E.evaluateDeep(cfg, ans);
    assert.ok(E.deepValidate(cfg, ans), name + ': a path the flow produced must validate');
    const alone = perTopic(cfg, e.merged), high = {}, miss = {};
    r.high.forEach((f) => { high[f.id] = true; }); r.missing.forEach((f) => { miss[f.id] = true; });
    const hasUnknown = cfg.questions.some((q) => e.merged[q.id] != null && [].concat(e.merged[q.id]).some((id) => q.options.some((o) => o.id === id && o.unknown)));
    // always: high ⊆ alone (never a finding the topic itself would not give), and what the topic gives but is not high is open because of an unknown answer
    Object.keys(high).forEach((id) => assert.ok(alone[id], name + ' path ' + i + ': ' + id + ' is high but the topic alone does not give it'));
    Object.keys(alone).forEach((id) => { if (!high[id]) assert.ok(miss[id] && hasUnknown, name + ' path ' + i + ': ' + id + ' is given by the topic but is neither high nor missing (or there is no unknown answer)'); });
    // missing items must name at least one question, and that question must hold an unknown answer or be a follow-up gated by one
    r.missing.forEach((f) => assert.ok(f.missing.length > 0));
    if (!hasUnknown) {
      // every relevant answer known → exactly the same findings, no missing item
      assert.deepEqual(Object.keys(high).sort(), Object.keys(alone).sort(), name + ' path ' + i);
      assert.equal(r.missing.length, 0, name + ' path ' + i + ': nothing is missing when nothing is unknown');
      stat.equal++;
    } else stat.withUnknown++;
    stat.paths++;
  }
  return stat;
}
for (const [name, topics, route] of SETS) {
  test('property (' + name + '): the high tier equals the findings of every topic evaluated alone on the same answers, over 4000 seeded paths with no unknown answer', () => {
    const s = property(name, topics, 4000, 1 + topics.length, 0, route);
    assert.equal(s.equal, 4000); console.log('   ' + name + ': ' + s.paths + ' paths, high tier identical to the per-topic findings on all of them');
  });
  test('property (' + name + '): with unknown answers mixed in, high ⊆ topic alone and the rest of the topic findings are open (missing), over 4000 seeded paths', () => {
    const s = property(name, topics, 4000, 777 + topics.length, 0.2, route);
    assert.ok(s.withUnknown > 1000); console.log('   ' + name + ': ' + s.paths + ' paths, ' + s.withUnknown + ' with an unknown answer');
  });
}

// ---------- lint ----------
for (const [name, topics, route] of SETS) {
  test('lint (' + name + '): the route is clean — minimal collection, sensitive questions, ids, facts, path length', () => {
    const r = L.lintDeep(route, topics, { samples: 1500 });
    assert.deepEqual(r.errors, []);
    assert.ok(r.stats.exactMax <= 60, 'longest path ' + r.stats.exactMax);
    // every profile question that is asked is used; every sensitive question is optional
    r.cfg.questions.filter((q) => q.topicId === 'profile').forEach((q) => assert.ok(r.used[q.id]));
    r.cfg.questions.filter((q) => q.sensitive).forEach((q) => assert.ok(q.options.some((o) => o.pna && o.unknown) && r.used[q.id]));
    console.log('   ' + name + ': questions ' + r.cfg.questions.length + ', rules ' + r.cfg.rules.length + ', skipped parts ' + r.skipped.length + '; path length exact ' + r.stats.exactMin + '..' + r.stats.exactMax + ', sampled median ' + r.stats.median + ', p90 ' + r.stats.p90);
  });
}

test('lint (i): a profile question nothing uses, or a derived or gated question no active rule uses, is an error', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('x', ['a', 'b']), Q('dead', ['a', 'b'])], rules: [rule('r', { q: 'x', in: ['a'] })] }];
  const base = { id: 'deep', name: 'd', topics: ['t'], profile: { questions: [Q('p', ['a', 'b'])] }, facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.x': 'a' }, b: { 't.x': 'b' } } }] };
  assert.deepEqual(L.lintDeep(base, topics, { noStats: true }).errors, []);
  // a derived question that no rule uses
  const f2 = Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.dead': 'a' }, b: { 't.dead': 'b' } } }] });
  assert.ok(L.lintDeep(f2, topics, { noStats: true }).errors.some((e) => /נגזרת t\.dead/.test(e)));
  // a gated question that no rule uses
  const g2 = Object.assign({}, base, { gates: [{ id: 'g', questions: ['t.dead'], show: { q: 'profile.p', in: ['a'] } }] });
  assert.ok(L.lintDeep(g2, topics, { noStats: true }).errors.some((e) => /מסוננת t\.dead/.test(e)));
  // the same profile question when a fact exists but its target is not served: the question is simply not asked (no error, listed as skipped)
  const r3 = L.lintDeep(base, [], { noStats: true }); assert.deepEqual(r3.errors, []); assert.ok(r3.skipped.some((s) => s.kind === 'profile'));
  // an unused profile question: nothing uses it → not asked (skipped) when the build can see it is unused
  const p4 = Object.assign({}, base, { profile: { questions: [Q('p', ['a', 'b']), Q('orphan', ['a', 'b'])] } });
  const r4 = L.lintDeep(p4, topics, { noStats: true }); assert.deepEqual(r4.errors, []); assert.ok(r4.skipped.some((s) => s.id === 'profile.orphan'));
  assert.ok(!r4.cfg.questions.some((q) => q.id === 'profile.orphan'));
});

test('lint (ii): a sensitive question needs the optional answer, a reason, a rule that uses it, and no gate may depend on it', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('x', ['a', 'b']), Q('unused', ['a', 'b'])], rules: [rule('r', { q: 'x', in: ['a'] })] }];
  const mk = (over) => Object.assign({ id: 'deep', name: 'd', topics: ['t'], profile: { questions: [] }, tune: { 't.x': { sensitive: { why: 'because' } } } }, over || {});
  assert.deepEqual(L.lintDeep(mk(), topics, { noStats: true }).errors, []);
  // sensitive flagged in the content itself without the option
  const raw = JSON.parse(JSON.stringify(topics)); raw[0].questions[0].sensitive = true;
  assert.ok(L.lintDeep(mk({ tune: {} }), raw, { noStats: true }).errors.some((e) => /ללא אפשרות/.test(e)));
  // no reason
  assert.ok(L.lintDeep(mk({ tune: { 't.x': { sensitive: { why: '' } } } }), topics, { noStats: true }).errors.some((e) => /משפט הסבר/.test(e)));
  // sensitive but no active rule depends on it
  assert.ok(L.lintDeep(mk({ tune: { 't.unused': { sensitive: { why: 'w' } } } }), topics, { noStats: true }).errors.some((e) => /אינה משמשת אף כלל/.test(e)));
  // a gate that depends on a sensitive profile question
  const prof = { questions: [Q('s', ['a', 'b'])] };
  const gated = mk({ profile: prof, tune: { 'profile.s': { sensitive: { why: 'w' } } }, gates: [{ id: 'g', topic: 't', show: { q: 'profile.s', in: ['a'] } }] });
  assert.ok(L.lintDeep(gated, topics, { noStats: true }).errors.some((e) => /שער מסתמך על שאלה רגישה/.test(e)));
});

test('lint (iii)/(iv): id collisions after qualification and facts that target a missing question or option are errors', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('x', ['a', 'b'])], rules: [rule('r', { q: 'x', in: ['a'] })] }];
  const base = { id: 'deep', name: 'd', topics: ['t'], profile: { questions: [Q('p', ['a', 'b'])] } };
  const ok = Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.x': 'a' }, b: { 't.x': 'b' } } }] });
  assert.deepEqual(L.lintDeep(ok, topics, { noStats: true }).errors, []);
  // missing target option: the fact is applied (the question exists) so this is an error
  const badOpt = Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.x': 'zzz' } } }] });
  assert.ok(L.lintDeep(badOpt, topics, { noStats: true }).errors.some((e) => /תשובת יעד לא קיימת zzz/.test(e)));
  // missing target question: the fact is skipped (that is how an older content set is served), not an error
  const noQ = Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.nope': 'a' } } }] });
  const r = L.lintDeep(noQ, topics, { noStats: true }); assert.deepEqual(r.errors, []); assert.ok(r.skipped.some((s) => s.kind === 'fact'));
  // a fact whose source or source option does not exist is an error in the route itself
  assert.ok(L.lintDeep(Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.zz', map: { a: { 't.x': 'a' } } }] }), topics, { noStats: true }).errors.some((e) => /מקור לא קיים/.test(e)));
  assert.ok(L.lintDeep(Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { zz: { 't.x': 'a' } } }] }), topics, { noStats: true }).errors.some((e) => /תשובה לא קיימת בשאלת הפרופיל/.test(e)));
  // an invalid derived value (exclusive mixed with another option) is caught by the exhaustive check over the source question
  const tm = [{ id: 't', name: 't', questions: [Q('m', ['a', { id: 'none', label: 'n', exclusive: true }], { multi: true })], rules: [rule('r', { q: 'm', in: ['a'] })] }];
  const mix = Object.assign({}, base, { facts: [{ id: 'f', from: 'profile.p', map: { a: { 't.m': ['a', 'none'] }, b: { 't.m': ['none'] } } }] });
  assert.ok(L.lintDeep(mix, tm, { noStats: true }).errors.some((e) => /ערך לא תקין/.test(e)) || E.deriveAnswers(L.lintDeep(mix, tm, { noStats: true }).cfg, { 'profile.p': 'a' })['t.m'] === undefined);
  // two profile questions with the same id
  assert.ok(L.lintDeep(Object.assign({}, base, { profile: { questions: [Q('p', ['a', 'b']), Q('p', ['a', 'b'])] } }), topics, { noStats: true }).errors.some((e) => /כפול/.test(e)));
});

test('lint (v): path lengths are measured exactly and the maximum is enforced', () => {
  const r = L.lintDeep(ROUTE_DEG, TEN, { samples: 500 });
  assert.ok(r.stats.exactMin >= 3 && r.stats.exactMax >= r.stats.exactMin);
  const tight = L.lintDeep(ROUTE_DEG, TEN, { samples: 100, maxPath: 5 });
  assert.ok(tight.errors.some((e) => /חורג/.test(e)));
  // the exact bounds contain every sampled path
  const s = L.pathStats(r.cfg, 800, 5); assert.ok(s.min >= s.exactMin && s.max <= s.exactMax);
});

test('path length report (printed): the number of questions a visitor answers, for the published ten and for V6', { skip: false }, () => {
  for (const [name, topics, route] of SETS) {
    const cfg = E.buildDeep(route, topics), s = L.pathStats(cfg, 6000, 99);
    const lines = Object.keys(s.histogram).map(Number).sort((a, b) => a - b).map((k) => k + ':' + s.histogram[k]).join(' ');
    console.log('   ' + name + ': exact min ' + s.exactMin + ', exact max ' + s.exactMax + '; 6000 simulated visitors: min ' + s.min + ', p10 ' + s.p10 + ', median ' + s.median + ', mean ' + s.mean + ', p90 ' + s.p90 + ', max ' + s.max);
    console.log('   histogram (questions:visitors) ' + lines);
    assert.ok(s.exactMax <= 60);
  }
});

// ---------- the same route against the published ten ----------
test('TEST-ONLY reduced mode on the published ten: parts that need V6 shapes are skipped, the rest runs, nothing throws. The real route is NOT AVAILABLE against the ten.', () => {
  setSrc(TEN);
  const real = E.buildDeep(ROUTE, TEN);
  assert.equal(real.unavailable, true); assert.ok(real.requiresMissing.length > 0);
  const cfg = E.buildDeep(ROUTE_DEG, TEN);
  assert.equal(cfg.topics.length, 10);
  assert.ok(cfg.skipped.length > 0 && cfg.skipped.every((s) => ['tune', 'gate', 'fact', 'weak', 'profile', 'person'].includes(s.kind)));
  assert.deepEqual(cfg.profileIds.slice().sort(), ['profile.home', 'profile.mortgage', 'profile.worknow']);
  // worknow pre-fills two questions of the ten
  const d = E.deriveAnswers(cfg, { 'profile.worknow': 'retired', 'profile.home': 'owner', 'profile.mortgage': 'no' });
  assert.deepEqual(d, { 'payslip-rights.emp': 'none', 'national-insurance.work': 'retired', 'housing.status': 'owner', 'mortgage.has': 'no' });
  const s = property('ten', TEN, 300, 5, 0.1, ROUTE_DEG); assert.ok(s.paths === 300);
});

test('nothing depends on the order the served topics arrive in, or on extra topics: the same answers give the same result', () => {
  const cfg1 = E.buildDeep(ROUTE_DEG, TEN), cfg2 = E.buildDeep(ROUTE_DEG, TEN.slice().reverse());
  const draw = sampler(cfg1, 3, 0.1);
  for (let i = 0; i < 100; i++) {
    const a = draw(), r1 = E.evaluateDeep(cfg1, a), r2 = E.evaluateDeep(cfg2, a);
    assert.deepEqual(r1.high.map((f) => f.id).sort(), r2.high.map((f) => f.id).sort());
  }
  const extra = TEN.concat([{ id: 'zzz', name: 'zzz', questions: [Q('q', ['a', 'b'])], rules: [] }, { id: 'quick', kind: 'router', name: 'quick', questions: [Q('q', ['a', 'b'])], rules: [] }]);
  assert.deepEqual(E.buildDeep(ROUTE_DEG, extra).topics, E.buildDeep(ROUTE_DEG, TEN).topics); // only the topics the route names, routes ignored
});

// ---------- V6 specifics ----------
test('V6: the profile pre-fills what it is declared to, the rest of those topic questions are asked', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6);
  const d = E.deriveAnswers(cfg, { 'profile.home': 'renter', 'profile.mortgage': 'plan', 'profile.worknow': 'employee', 'profile.workhist': ['emp', 'self'], 'profile.family': ['birth', 'kids'] });
  assert.deepEqual(d, { 'housing.status': 'renter', 'mortgage.has': 'plan', 'payslip-rights.emp': 'now', 'tax-refunds.kind': ['emp', 'self'], 'national-insurance.now': ['birth', 'kids'] });
  // a retiree: payslip-rights.emp is asked (not derived), but the topic is hidden unless the person worked as an employee in the last six years
  assert.equal(E.deriveAnswers(cfg, { 'profile.worknow': 'retired' })['payslip-rights.emp'], undefined);
  const base = { 'profile.home': 'other', 'profile.mortgage': 'no', 'profile.worknow': 'retired', 'profile.workhist': ['none'], 'profile.family': ['none'] };
  const vis = (a) => E.deepEffective(cfg, a).visible;
  assert.ok(!Object.keys(vis(base)).some((k) => k.indexOf('payslip-rights.') === 0), 'a retiree without employee work in six years is not asked about payslips');
  assert.ok(vis(base)['household.homeins'], 'home/contents insurance is asked also of someone who lives with family');
  assert.ok(vis(Object.assign({}, base, { 'profile.workhist': ['emp'] }))['payslip-rights.emp']);
  assert.ok(vis(Object.assign({}, base, { 'profile.worknow': 'employee', 'profile.workhist': ['none'] }))['payslip-rights.slip'] || E.deepEffective(cfg, Object.assign({}, base, { 'profile.worknow': 'employee' })).merged['payslip-rights.emp'] === 'now');
  // the family question is sensitive and optional: "prefer not to answer" flows through to the national-insurance question as unknown
  const pna = Object.assign({}, base, { 'profile.family': ['pna'] });
  assert.equal(E.deepValidate(cfg, completeFrom(cfg, pna)), true);
  const r = E.evaluateDeep(cfg, completeFrom(cfg, pna));
  assert.ok(r.missing.some((f) => f.id === 'national-insurance.ni-oldage'), 'a retirement-age rule is open, not false, when the family question was declined');
  assert.ok(r.missing.filter((f) => f.id.indexOf('national-insurance.') === 0).every((f) => f.missing.every((m) => m.ask === 'profile.family')));
});
function completeFrom(cfg, start) { const a = Object.assign({}, start); let q; while ((q = E.deepNext(cfg, a))) a[q.id] = q.multi ? [q.options.filter((o) => o.exclusive)[0].id] : q.options[0].id; return a; }

// The two weak rules that were proposed are NOT in the route (the low tier is off). The engine capability stays and is tested here with fixture rules.
const WEAK_FIXTURE = Object.assign({}, ROUTE, { weak: [
  { id: 'ps-hrs-mgr', like: 'payslip-rights.ps-hrs', needs: ['payslip-rights.hours#mgr'], note: 'test note: weak sign', when: { all: [{ q: 'payslip-rights.emp', in: ['now'] }, { q: 'payslip-rights.hours', in: ['ot', 'rest'] }, { q: 'payslip-rights.hours', in: ['mgr'] }, { not: { q: 'payslip-rights.hours', in: ['glob'] } }, { not: { q: 'payslip-rights.lines', in: ['otline', 'unk'] } }] } },
  { id: 'bk-credit-some', like: 'banking-loans.bk-credit-overview', needs: ['banking-loans.overdraft#some'], note: 'test note: weaker', when: { all: [{ q: 'banking-loans.overdraft', in: ['some'] }, { q: 'banking-loans.credit', in: ['bank', 'card', 'nonbank'] }] } }] });
test('the real route has no weak rule, so the low tier can never appear (on any sampled V6 path)', { skip: SKIP_V6 }, () => {
  assert.equal(ROUTE.weak, undefined);
  const cfg = E.buildDeep(ROUTE, V6); assert.equal(cfg.rules.filter((r) => r.weak).length, 0);
  const draw = sampler(cfg, 31, 0.1);
  for (let i = 0; i < 1500; i++) { const r = E.evaluateDeep(cfg, draw()); assert.equal(r.low.length, 0); assert.equal(r.counts.lowCards, 0); }
});
test('engine capability (fixture route): a weak rule reuses the finding of the rule it is like and sits in the low tier only', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(WEAK_FIXTURE, V6), weak = cfg.rules.filter((r) => r.weak);
  assert.deepEqual(weak.map((r) => r.id).sort(), ['weak.bk-credit-some', 'weak.ps-hrs-mgr']);
  weak.forEach((w) => { const base = cfg.rules.find((r) => r.id === w.like); assert.ok(base && !base.weak); const f = Object.assign({}, w.finding); assert.ok(f.weakNote); delete f.weakNote; assert.deepEqual(f, base.finding); });
  const draw = sampler(cfg, 11, 0); let seen = 0;
  for (let i = 0; i < 6000 && seen < 2; i++) { const a = draw(), r = E.evaluateDeep(cfg, a); if (r.low.length) { seen++; r.low.forEach((f) => { assert.ok(f.weak); assert.ok(!r.high.some((h) => h.id === f.id)); }); assert.equal(r.counts.low, r.low.length); } }
  assert.ok(seen > 0, 'a weak rule can fire on a reachable path');
});

test('the wording the route adds never claims an entitlement, an approval, or a certainty', () => {
  const BAD = /מגיע(ים|ות)? לכם|זכאים|זכאית|זכאי\b|אושר|מאושר|זכיתם|הוענק|בוודאות|בטוח שיש|מובטח|תקבלו כסף/;
  const texts = [];
  (function walk(o, p) { if (typeof o === 'string') texts.push([p, o]); else if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k], p + '.' + k)); })(ROUTE, 'deep');
  const bad = texts.filter(([p, s]) => BAD.test(s));
  assert.deepEqual(bad, []);
});

test('missing items that wait for the same question are folded into one item (3 or more), nothing is lost; different questions stay separate', () => {
  const mkc = (id, qs) => ({ id: id, title: 't' + id, missing: qs.map((q) => ({ id: q, text: q, ask: q })) });
  const cards = [mkc('a', ['q1']), mkc('b', ['q1']), mkc('c', ['q2']), mkc('d', ['q1']), mkc('e', ['q1', 'q2'])];
  const items = E.groupMissing(cards, 3);
  assert.equal(items.length, 3);
  assert.equal(items[0].folded, true); assert.deepEqual(items[0].cards.map((c) => c.id), ['a', 'b', 'd']); assert.deepEqual(items[0].missing.map((m) => m.id), ['q1']);
  assert.deepEqual(items.slice(1).map((i) => [i.folded, i.card.id]), [[false, 'c'], [false, 'e']]);
  assert.equal(items.reduce((n, i) => n + (i.folded ? i.cards.length : 1), 0), cards.length);
  assert.equal(E.groupMissing(cards, 4).length, 5 - 0 - 0 > 0 ? E.groupMissing(cards, 4).length : 0);
  const cfg = tierCfg(), r = E.evaluateDeep(cfg, { 't.a': 'unk', 't.b': 'yes' });
  assert.equal(r.counts.missingItems, 1); assert.equal(r.missingItems[0].folded, true); assert.equal(r.missingItems[0].cards.length, r.missingCards.length);
});

// =====================================================================================================================================
// Owner review round: whom a family answer concerns, the gates, the sensitive set, `requires`, wording
// =====================================================================================================================================
// A complete V6 path: every question takes `over[id]` when given, otherwise the benign answer ("none of these" / the first plain option).
function walkV6(cfg, over) {
  const a = {}; let q;
  while ((q = E.deepNext(cfg, a))) {
    if (over[q.id] !== undefined) { a[q.id] = over[q.id]; continue; }
    const plain = q.options.filter((o) => !o.unknown), ex = plain.filter((o) => o.exclusive)[0];
    a[q.id] = q.multi ? [(ex || plain[0]).id] : plain[0].id;
  }
  return a;
}
const BASE = { 'profile.home': 'owner', 'profile.mortgage': 'no', 'profile.worknow': 'employee', 'profile.workhist': ['emp'] };
const ni = (r, tier) => r[tier].filter((f) => f.id.indexOf('national-insurance.') === 0).map((f) => f.localId).sort();
const WHO = (opt, who, extra) => Object.assign({}, BASE, { 'profile.family': [opt], ['profile.who_' + opt]: who }, extra || {});

test('family question: every person-dependent option is followed by ONE question about whom it concerns, asked only when that option was chosen', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6);
  const ids = (a) => { const out = []; let q; const x = Object.assign({}, a); while ((q = E.deepNext(cfg, x))) { out.push(q.id); x[q.id] = q.multi ? [q.options.filter((o) => o.exclusive)[0].id] : q.options[0].id; if (out.length > 80) break; } return out; };
  const after = (fam, extra) => { const a = Object.assign({}, BASE, { 'profile.family': fam }, extra || {}); const q = E.deepNext(cfg, a); return q && q.id; };
  assert.equal(after(['none']), 'lost-funds.events');                    // nothing person-dependent: no follow-up at all
  assert.equal(after(['kids']), 'lost-funds.events');                    // household-level options need no "whom"
  assert.equal(after(['birth', 'death', 'care']), 'lost-funds.events');
  assert.equal(after(['stopped']), 'profile.who_stopped');
  assert.equal(after(['health']), 'profile.who_health');
  assert.equal(after(['reserve']), 'profile.who_reserve');
  assert.equal(after(['retire']), 'profile.who_retire');
  assert.equal(after(['pna']), 'lost-funds.events');                     // declined: not asked again
  // two person-dependent options: two follow-ups, one per option, in order; each exactly once
  const both = ids(Object.assign({}, BASE, { 'profile.family': ['stopped', 'reserve'] })).filter((x) => x.indexOf('profile.who_') === 0);
  assert.deepEqual(both, ['profile.who_stopped', 'profile.who_reserve']);
  // the question and its options
  const q = cfg.questions.find((x) => x.id === 'profile.who_stopped');
  assert.equal(q.multi, true); assert.match(q.text, /מדובר בכם, בבן\/בת הזוג, בילד\/ה או בהורה\?/);
  assert.deepEqual(q.options.map((o) => o.label), ['אני', 'בן/בת הזוג', 'ילד/ה', 'הורה', 'מעדיפ/ה לא לענות']);
  assert.deepEqual(q.options.filter((o) => o.unknown).map((o) => o.id), ['spouse', 'child', 'parent', 'pna']);
  assert.ok(q.options.find((o) => o.id === 'pna').exclusive && q.sensitive);
  // texts differ (two consecutive screens never look the same)
  const texts = cfg.questions.filter((x) => /^profile\.who_/.test(x.id)).map((x) => x.text); assert.equal(new Set(texts).size, texts.length);
});

test('family question, other person: a spouse, child or parent who meets the condition NEVER makes a respondent-only rule high; the rule is missing information that names the question (never false, never invented)', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6);
  const cases = [
    // [family option, follow-up answer, facts answer, rule it feeds]
    ['retire', ['spouse'], { 'national-insurance.retirefacts': ['nopension'] }, 'ni-oldage'],
    ['retire', ['parent'], { 'national-insurance.retirefacts': ['nopension'] }, 'ni-oldage'],
    ['retire', ['parent'], { 'national-insurance.retirefacts': ['onlypension'] }, 'ni-supplement'],
    ['health', ['spouse'], { 'national-insurance.healthfacts': ['inj_noclaim'] }, 'ni-workinjury'],
    ['health', ['child'], { 'national-insurance.healthfacts': ['long_noclaim'] }, 'ni-disability'],
    ['stopped', ['spouse'], { 'national-insurance.stopfacts': ['emp_noreg'] }, 'ni-unemp'],
    ['stopped', ['parent'], { 'national-insurance.stopfacts': ['noinc'] }, 'ni-selfclosed'],
    ['reserve', ['spouse'], { 'national-insurance.reservefacts': ['emp_unpaid'] }, 'ni-reserve-emp'],
    ['reserve', ['child', 'parent'], { 'national-insurance.reservefacts': ['self_unpaid'] }, 'ni-reserve-self']
  ];
  cases.forEach(([opt, who, facts, rule]) => {
    const a = walkV6(cfg, WHO(opt, who, facts)), r = E.evaluateDeep(cfg, a), tag = opt + '/' + who + '/' + rule;
    assert.ok(!ni(r, 'high').includes(rule), tag + ': must not be high');
    assert.ok(ni(r, 'missing').includes(rule), tag + ': must be missing information');
    const f = r.missing.find((x) => x.localId === rule);
    assert.ok(f.missing.some((m) => m.id === 'profile.who_' + opt), tag + ': names the "whom" question');
    // the respondent's own facts are exactly what the respondent said about themselves: nothing was derived from the other person's answer
    assert.deepEqual(E.deriveAnswers(cfg, a), { 'housing.status': 'owner', 'mortgage.has': 'no', 'payslip-rights.emp': 'now', 'tax-refunds.kind': ['emp'], 'national-insurance.now': [opt] }, tag);
    // the same facts when the respondent is the person: high, as before the follow-up existed
    const me = E.evaluateDeep(cfg, walkV6(cfg, WHO(opt, ['me'], facts)));
    assert.ok(ni(me, 'high').includes(rule), tag + ': the respondent themselves → high');
    assert.ok(!ni(me, 'missing').includes(rule), tag + ': and no longer missing');
    // both the respondent and someone else → still high (the respondent is among those concerned)
    assert.ok(ni(E.evaluateDeep(cfg, walkV6(cfg, WHO(opt, ['me', who[0]], facts))), 'high').includes(rule), tag + ': me + other → high');
  });
});

test('family question, skipped or declined: "prefer not to answer" in the follow-up (or in the family question itself) is unknown: missing information, never high, never "no"', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6);
  const facts = { 'national-insurance.retirefacts': ['nopension'] };
  const r1 = E.evaluateDeep(cfg, walkV6(cfg, WHO('retire', ['pna'], facts)));
  assert.ok(!ni(r1, 'high').includes('ni-oldage')); assert.ok(ni(r1, 'missing').includes('ni-oldage'));
  const r2 = E.evaluateDeep(cfg, walkV6(cfg, Object.assign({}, BASE, { 'profile.family': ['pna'] })));
  assert.deepEqual(ni(r2, 'high'), []); assert.ok(ni(r2, 'missing').length >= 13);
  // the follow-up unanswered (partial answers): not high either
  const part = Object.assign({}, BASE, { 'profile.family': ['retire'] });
  assert.ok(!ni(E.evaluateDeep(cfg, part), 'high').includes('ni-oldage'));
  // a rule that is false stays false (not invented as missing): nobody stopped working
  const none = E.evaluateDeep(cfg, walkV6(cfg, Object.assign({}, BASE, { 'profile.family': ['none'] })));
  assert.deepEqual(ni(none, 'high'), []); assert.deepEqual(ni(none, 'missing'), []);
});

test('family question: household and other-person rules are NOT held back by the follow-up (a child, a birth, a death in the family, the person in need of care)', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6), A = (fam, facts) => E.evaluateDeep(cfg, walkV6(cfg, Object.assign({}, BASE, { 'profile.family': fam }, facts)));
  assert.ok(ni(A(['birth'], { 'national-insurance.birthfacts': ['mom_unpaid'] }), 'high').includes('ni-birth-claim'));
  assert.ok(ni(A(['birth'], { 'national-insurance.birthfacts': ['save_open'] }), 'high').includes('ni-birth-save'));
  assert.ok(ni(A(['kids'], { 'national-insurance.kidsallow': 'missing' }), 'high').includes('ni-kids'));
  assert.ok(ni(A(['death'], { 'national-insurance.survclaim': 'no' }), 'high').includes('ni-survivors'));
  assert.ok(ni(A(['care'], { 'national-insurance.carefacts': ['child_noallow'] }), 'high').includes('ni-child-disabled'));
  assert.ok(ni(A(['care'], { 'national-insurance.carefacts': ['elder_noallow'] }), 'high').includes('ni-ltc'));
  assert.ok(ni(A(['care'], { 'national-insurance.carefacts': ['adult_noallow'] }), 'high').includes('ni-disability')); // the adult described in the care question, not the respondent
});

test('family-rule classification: every national-insurance rule fed by the family question is classified; respondent-only ones are guarded, the others are not', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6), cls = ROUTE.persons.classes;
  const fedRules = cfg.rules.filter((r) => r.topicId === 'national-insurance' && r.status !== 'inactive');
  assert.equal(fedRules.length, 15); assert.equal(Object.keys(cls).length, 15);
  fedRules.forEach((r) => { assert.ok(cls[r.id], r.id + ' is classified'); assert.equal(!!(r.personGuards || []).length, cls[r.id].class === 'respondent', r.id); assert.ok(cls[r.id].why.length > 10); });
  assert.deepEqual(Object.keys(cls).filter((k) => cls[k].class === 'respondent').map((k) => k.split('.')[1]).sort(), ['ni-disability', 'ni-oldage', 'ni-reserve-emp', 'ni-reserve-other', 'ni-reserve-self', 'ni-selfclosed', 'ni-supplement', 'ni-unemp', 'ni-workinjury']);
  assert.deepEqual(L.lintDeep(ROUTE, V6, { noStats: true }).errors, []);
  // lint catches an unclassified rule, and a respondent-only rule without its guard
  const bad = JSON.parse(JSON.stringify(ROUTE)); delete bad.persons.classes['national-insurance.ni-unemp'];
  assert.ok(L.lintDeep(bad, V6, { noStats: true }).errors.some((e) => /ni-unemp.*אינו מסווג/.test(e)));
  const bad2 = JSON.parse(JSON.stringify(ROUTE)); bad2.persons.guards = bad2.persons.guards.filter((g) => g.id !== 'pg-stopped');
  assert.ok(L.lintDeep(bad2, V6, { noStats: true }).errors.some((e) => /ni-unemp.*אינו מוגן/.test(e)));
});

test('person guard (engine): rewrites only positive atoms of the guarded option; an other-person answer is unknown; under "not" it is refused by lint', () => {
  const topics = [{ id: 't', name: 't', questions: [Q('now', ['stop', 'other', { id: 'none', label: 'n', exclusive: true }], { multi: true })], rules: [rule('r', { q: 't.now'.replace('t.', ''), in: ['stop', 'other'] }), rule('neg', { not: { q: 'now', in: ['stop'] } })] }];
  const route = { id: 'deep', name: 'd', topics: ['t'], profile: { questions: [Q('f', ['stop', 'other', { id: 'none', label: 'n', exclusive: true }], { multi: true }), Q('w', ['me', { id: 'sp', label: 'sp', unknown: true }, { id: 'pna', label: 'p', unknown: true, pna: true, exclusive: true }], { multi: true, showIf: { q: 'f', in: ['stop'] } })] },
    facts: [{ id: 'f1', from: 'profile.f', map: { stop: { 't.now': ['stop'] }, other: { 't.now': ['other'] }, none: { 't.now': ['none'] } } }],
    persons: { fedBy: 'profile.f', guards: [{ id: 'g', question: 't.now', option: 'stop', who: 'profile.w' }], classes: {} } };
  const cfg = E.buildDeep(route, topics), r = cfg.rules.find((x) => x.localId === 'r');
  assert.deepEqual(r.when, { any: [{ q: 't.now', in: ['other'] }, { all: [{ q: 't.now', in: ['stop'] }, { q: 'profile.w', in: ['me'] }] }] }); // the other option is untouched
  const ev = (f, w) => E.evaluateDeep(cfg, Object.assign({ 'profile.f': f }, w ? { 'profile.w': w } : {}));
  assert.deepEqual(ev(['stop'], ['me']).high.map((x) => x.localId), ['r', 'neg'].filter((id) => id === 'r'));
  assert.deepEqual(ev(['stop'], ['sp']).missing.map((x) => x.localId), ['r']);
  assert.deepEqual(ev(['other']).high.map((x) => x.localId), ['r', 'neg']); // "other" needs no follow-up and is not guarded
  assert.ok(cfg.rules.find((x) => x.localId === 'neg').personUnsafe);
  assert.ok(L.lintDeep(route, topics, { noStats: true }).errors.some((e) => /תחת שלילה/.test(e)));
});

test('gate g-homeins is gone: the home/contents insurance question is asked for every living situation (no option says "no dwelling at all")', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6);
  assert.ok(!ROUTE.gates.some((g) => g.id === 'g-homeins') && !cfg.gates.some((g) => g.id === 'g-homeins'));
  assert.ok(!cfg.questions.find((q) => q.id === 'household.homeins').gatedBy);
  ['owner', 'renter', 'renter_owns', 'other_bill', 'other'].forEach((home) => {
    const vis = E.deepEffective(cfg, Object.assign({}, BASE, { 'profile.home': home, 'profile.family': ['none'] })).visible;
    assert.ok(vis['household.homeins'], home + ': the insurance question is asked');
  });
  // the V6 question has no "no dwelling" option: "no insurance at all" is an answer, not a reason to hide the question
  const hq = V6.find((t) => t.id === 'household').questions.find((q) => q.id === 'homeins');
  assert.ok(hq.options.some((o) => o.id === 'none') && !hq.options.some((o) => /אין לי דירה|אין דירה|ללא דירה/.test(o.label)));
});

test('gate g-payslip: employee rights are hidden only for someone self-employed or retired who did not work as an employee in six years; everyone else is asked (they may have just left a job)', { skip: SKIP_V6 }, () => {
  const cfg = E.buildDeep(ROUTE, V6), shown = (wn, wh) => !!E.deepEffective(cfg, Object.assign({}, BASE, { 'profile.worknow': wn, 'profile.workhist': wh, 'profile.family': ['none'] })).visible['payslip-rights.emp'];
  ['employee', 'self', 'notworking', 'retired', 'student'].forEach((wn) => assert.equal(shown(wn, ['emp']), true, wn + ' with employee work in six years'));
  assert.equal(shown('employee', ['none']), true);   // a new job this year
  assert.equal(shown('notworking', ['none']), true); // may have just left a first job
  assert.equal(shown('student', ['self']), true);
  assert.equal(shown('self', ['none']), false); assert.equal(shown('retired', ['none']), false); assert.equal(shown('retired', ['self']), false);
});

test('sensitive questions: the final set is exactly this one, each optional with "prefer not to answer" that is unknown (never "no"), and each used by an active rule', { skip: SKIP_V6 }, () => {
  const r = L.lintDeep(ROUTE, V6, { noStats: true }), set = r.cfg.questions.filter((q) => q.sensitive).map((q) => q.id).sort();
  assert.deepEqual(set, ['education-work.ew', 'education-work.vetlen', 'housing.bti', 'housing.household', 'national-insurance.carefacts', 'national-insurance.healthfacts', 'national-insurance.now', 'national-insurance.retirefacts',
    'national-insurance.stopfacts', 'national-insurance.survclaim', 'profile.family', 'profile.who_health', 'profile.who_reserve', 'profile.who_retire', 'profile.who_stopped', 'tax-refunds.grantfam', 'tax-refunds.inc']);
  r.cfg.questions.filter((q) => q.sensitive).forEach((q) => { const p = q.options.find((o) => o.pna); assert.ok(p && p.unknown && p.label === 'מעדיפ/ה לא לענות', q.id); assert.ok(q.sensitiveWhy && q.sensitiveWhy.length > 10, q.id); assert.ok(r.used[q.id], q.id + ' is used by a rule'); });
  assert.deepEqual(r.errors, []);
  // the three newly sensitive questions: declining is unknown, so the rules that depend on them are missing information
  const cfg = r.cfg, decl = (id, v, facts) => E.evaluateDeep(cfg, walkV6(cfg, Object.assign({}, BASE, { 'profile.family': facts.fam, ['profile.who_' + facts.who]: ['me'] }, { [id]: v })));
  assert.ok(ni(decl('national-insurance.survclaim', 'pna', { fam: ['death'] }), 'missing').includes('ni-survivors'));
  assert.ok(!ni(decl('national-insurance.survclaim', 'pna', { fam: ['death'] }), 'high').includes('ni-survivors'));
  assert.ok(ni(decl('national-insurance.retirefacts', ['pna'], { fam: ['retire'], who: 'retire' }), 'missing').includes('ni-oldage'));
  assert.ok(ni(decl('national-insurance.stopfacts', ['pna'], { fam: ['stopped'], who: 'stopped' }), 'missing').includes('ni-unemp'));
  assert.deepEqual(ni(decl('national-insurance.stopfacts', ['pna'], { fam: ['stopped'], who: 'stopped' }), 'high'), []);
});

test('requires: against content that lacks a required topic or shape the route is NOT AVAILABLE (never run reduced); the test-only mode is the same route without requires', () => {
  assert.ok(ROUTE.requires.length >= 10);
  const ten = E.buildDeep(ROUTE, TEN); assert.equal(ten.unavailable, true);
  assert.ok(ten.requiresMissing.includes('tax-refunds.kind#emp'));
  assert.equal(E.buildDeep(ROUTE, TEN, { ignoreRequires: true }).unavailable, false); // only for reading stored requests
  assert.equal(E.buildDeep(ROUTE_DEG, TEN).unavailable, false);
  if (!SKIP_V6) {
    assert.equal(E.buildDeep(ROUTE, V6).unavailable, false);
    const missingTopic = V6.filter((t) => t.id !== 'housing'); const m = E.buildDeep(ROUTE, missingTopic);
    assert.equal(m.unavailable, true); assert.ok(m.requiresMissing.includes('housing'));
    const noQ = JSON.parse(JSON.stringify(V6)); noQ.find((t) => t.id === 'national-insurance').questions = noQ.find((t) => t.id === 'national-insurance').questions.filter((q) => q.id !== 'survclaim');
    assert.equal(E.buildDeep(ROUTE, noQ).unavailable, true);
  }
});

test('wording: every deep string (route, screens, tile, load/unavailable/coming-soon pages) is free of entitlement/approval claims and of any time promise', () => {
  const FORBID = /מגיע(ים|ות)? לכם|זכאים|זכאית|זכאי\b|זכאות|אושר|מאושר|זכיתם|הוענק|בוודאות|בטוח שיש|מובטח|תקבלו/;
  const MINUTES = /(?<![א-ת])(דקות|דקה|שעה|שעות|שניות)(?![א-ת])/;
  const texts = [];
  (function walk(o, p) { if (typeof o === 'string') texts.push([p, o]); else if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k], p + '.' + k)); })(ROUTE, 'route');
  const lits = (file) => { const src = fs.readFileSync(path.join(root, file), 'utf8'); (src.match(/'[^'\n]*[א-ת][^'\n]*'/g) || []).concat(src.match(/"[^"\n]*[א-ת][^"\n]*"/g) || []).forEach((l) => texts.push([file, l])); };
  lits('kaspchem/assets/deep.js');
  const wz = fs.readFileSync(path.join(root, 'kaspchem', 'assets', 'wizard.js'), 'utf8');
  (wz.match(/(dp-soon|dp-fail|loadFail|unavailable)[^\n]*/g) || []).forEach((l) => texts.push(['wizard.js deep/fail lines', l]));
  const tile = /id="dp-tile"[\s\S]*?<\/a>/.exec(fs.readFileSync(path.join(root, 'kaspchem', 'index.html'), 'utf8'));
  assert.ok(tile); texts.push(['index.html deep tile', tile[0]]);
  assert.ok(texts.length > 150);
  const bad = texts.filter(([, s]) => FORBID.test(s) || MINUTES.test(s)).map(([p, s]) => p + ': ' + s.slice(0, 80));
  assert.deepEqual(bad, []);
  // the exact headings the owner approved
  assert.equal(ROUTE.messages.highTitle, 'מצאנו הזדמנויות בסבירות גבוהה שכדאי לבדוק');
  assert.equal(ROUTE.messages.missingTitle, 'חסר מידע — כדאי להשלים בדיקה');
  assert.equal(ROUTE.tagline.includes('מקיפה ומעמיקה יותר'), true);
});

test('wording, V6 finding texts (not ours): the rules that use "מאושר" in a neutral sense are listed so a new offender is noticed; none claims an entitlement', { skip: SKIP_V6 }, () => {
  const BAD = /מגיע(ים|ות)? לכם|זכאים|זכאית|זכאי\b|אושר|מאושר|זכיתם|הוענק|בוודאות|בטוח שיש|מובטח|תקבלו/, out = [];
  V6.forEach((t) => t.rules.filter((r) => r.status !== 'inactive').forEach((r) => ['title', 'why', 'step', 'refer', 'section'].forEach((k) => { if (BAD.test((r.finding || {})[k] || '')) out.push(t.id + '.' + r.id + '.' + k); })));
  assert.deepEqual(out.sort(), ['banking-loans.bk-fees.step', 'banking-loans.bk-fees.why', 'banking-loans.bk-overdraft.step', 'education-work.ed-haredi-academic.step', 'education-work.ed-vet-prep.step']);
});

test('deep golden master: the composed deep check gives exactly what was recorded on 3,000 seeded paths (published ten, and V6 when present)', () => {
  const G = require('../scripts/golden-deep.js'), dir = path.join(root, 'tests', 'fixtures', 'golden');
  assert.ok(G.check(path.join(root, 'kaspchem', 'content', 'topics.json'), path.join(dir, 'deep-published-v1.json')).same, 'published ten: the deep check changed; re-record on purpose');
  if (!SKIP_V6) assert.ok(G.check(V6F, path.join(dir, 'deep-v6.json')).same, 'V6: the deep check changed; re-record on purpose');
});
