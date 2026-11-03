'use strict';
// Stage 5: content alignment of the deep check. Every active rule of the served topics must be reachable in the deep flow, every HIGH finding of a deep path
// must be a finding of the same topic evaluated alone on the same answers, and nothing the deep check shows may come from outside the topics' own rules
// (the only extra rules are the weak ones, which can only land in the low tier). Reports the coverage per topic.
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
// the real route is not available against the published ten (it requires V6 shapes); the reduced run is TEST-ONLY: the same route without `requires`
const ROUTE_DEG = Object.assign({}, ROUTE, { requires: [] });
const SETS = [['published ten', TEN, ROUTE_DEG]].concat(SKIP_V6 ? [] : [['V6 draft', read(V6F).topics, ROUTE]]);

// positive atoms of a rule: question → options that make it fire (atoms under "not" are skipped)
function targets(cond, out, neg) {
  out = out || {};
  if (!cond) return out;
  if (cond.all) cond.all.forEach((c) => targets(c, out, neg)); else if (cond.any) cond.any.forEach((c) => targets(c, out, neg));
  else if (cond.not) targets(cond.not, out, !neg);
  else if (cond.q && !neg) { out[cond.q] = (out[cond.q] || []).concat(cond.in || []); }
  return out;
}
function biasedPath(cfg, rand, want) {
  const ans = {}; let q, n = 0;
  while ((q = E.deepNext(cfg, ans))) {
    const w = want[q.id], plain = q.options.filter((o) => !o.unknown || (w && w.includes(o.id)));
    if (w && rand() < 0.8) {
      const hit = plain.filter((o) => w.includes(o.id));
      if (q.multi) { const pick = hit.filter(() => rand() < 0.7).map((o) => o.id); ans[q.id] = pick.length ? pick : [hit[0].id]; if (ans[q.id].length > 1 && q.options.some((o) => o.exclusive && ans[q.id].includes(o.id))) ans[q.id] = [hit[0].id]; }
      else ans[q.id] = hit[Math.floor(rand() * hit.length)].id;
    } else if (q.multi) {
      const free = plain.filter((o) => !o.exclusive && rand() < 0.3).map((o) => o.id);
      const ex = plain.filter((o) => o.exclusive);
      ans[q.id] = free.length ? free : [(ex.length ? ex : plain)[0].id];
    } else ans[q.id] = plain[Math.floor(rand() * plain.length)].id;
    if (++n > 400) throw new Error('no termination');
  }
  return ans;
}

for (const [name, topics, route] of SETS) {
  test('alignment (' + name + '): every active rule is reachable as HIGH in the deep check, and every HIGH finding is a finding of its topic alone', () => {
    const cfg = E.buildDeep(route, topics), byTopic = {}, srcOf = {}; topics.forEach((t) => { srcOf[t.id] = t; });
    const rand = L.rng(20261103), reached = {}, active = cfg.rules.filter((r) => !r.weak && r.status !== 'inactive');
    active.forEach((r) => {
      const want = targets(r.when);
      for (let i = 0; i < 12000 && !reached[r.id]; i++) {
        const a = biasedPath(cfg, rand, want), res = E.evaluateDeep(cfg, a);
        res.high.forEach((f) => {
          // alignment: the same topic evaluated alone on the same answers gives this finding
          const e = E.deepEffective(cfg, a), local = {};
          Object.keys(e.merged).forEach((k) => { if (k.indexOf(f.topicId + '.') === 0) local[k.slice(f.topicId.length + 1)] = e.merged[k]; });
          assert.ok(E.evaluate(srcOf[f.topicId], local).findings.some((x) => x.id === f.localId), f.id + ' is high but its topic alone does not give it');
          reached[f.id] = true;
        });
      }
    });
    const missing = active.filter((r) => !reached[r.id]).map((r) => r.id);
    active.forEach((r) => { (byTopic[r.topicId] = byTopic[r.topicId] || { rules: 0, reached: 0 }); byTopic[r.topicId].rules++; if (reached[r.id]) byTopic[r.topicId].reached++; });
    console.log('   ' + name + ' coverage (active rules reachable as HIGH / active rules) per topic: ' + Object.keys(byTopic).map((t) => t + ' ' + byTopic[t].reached + '/' + byTopic[t].rules).join(', '));
    // a rule that is unreachable in the deep check but reachable in its topic alone would mean the profile or a gate cuts it off
    assert.deepEqual(missing, [], 'rules never reached in the deep check: ' + missing.join(', '));
  });

  test('alignment (' + name + '): the deep check adds no finding of its own: every high or missing item is a rule of a served topic; low items only come from the declared weak rules', () => {
    const cfg = E.buildDeep(route, topics), rules = {}; cfg.rules.forEach((r) => { rules[r.id] = r; });
    const rand = L.rng(5);
    for (let i = 0; i < 3000; i++) {
      const a = biasedPath(cfg, rand, {}), r = E.evaluateDeep(cfg, a);
      r.high.concat(r.missing).forEach((f) => { assert.ok(rules[f.id] && !rules[f.id].weak && rules[f.id].status !== 'inactive'); });
      r.low.forEach((f) => assert.ok(rules[f.id].weak));
      assert.equal(new Set(r.high.map((f) => f.id)).size, r.high.length);
    }
  });
}
