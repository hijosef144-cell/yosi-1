'use strict';
// Stage 4: alignment of the quick check with the ten full questionnaires.
//
// STRICT TRANSLATION (stage 4b): "not sure" stays "not sure" (unk -> unk, never unk -> no). A recommendation in the FIRM tier must be backed by a full-topic finding
// on those answers; a "not sure" that the full topic does not count is only ever a needs-info item (second tier), which makes no claim.
//
// Every quick answer is translated into the equivalent answer(s) of the topic's OWN questionnaire (rules of translation below; a question the quick
// check does not ask counts as that question's "unknown" option where it has one, otherwise as its benign option). For every quick path we then ask:
//   PRECISION: a topic the quick check recommends must really find something when the full check is run on the translated answers (no empty recommendation);
//   RECALL:    when the translated answers make a signal marked with a check mark in the owner document fire, the quick check must recommend that topic.
// A topic may need several translations (a quick answer that spans two answers of the topic, e.g. "birth" and "layoff" are one pick each in the
// national-insurance topic): `variants`. Precision needs ONE variant that finds something; recall must hold for EVERY variant.
// Walks: exhaustive over every combination of single answers (the multi-select questions taken one pick at a time, including "none"), then a large
// seeded sample of complete paths with arbitrary multi-select subsets. Prints a per-topic table. Nothing is published.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');
const GM = require('../scripts/golden-master.js');

const CONTENT = path.join(__dirname, '..', 'kaspchem', 'content');
const Q = JSON.parse(fs.readFileSync(path.join(CONTENT, 'routes.json'), 'utf8')).topics.find((t) => t.id === 'quick');
const TOPIC = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(CONTENT, 'topics.json'), 'utf8')).topics.map((t) => [t.id, t]));
const has = (a, x) => [].concat(a || []).includes(x);

// Complete a topic's answers: take `given`, then `dflt` (explicit, per topic) for every visible question the quick check does not ask.
function fill(topic, given, dflt) {
  const ans = {};
  let q;
  while ((q = E.nextQuestion(topic, ans))) {
    const v = given[q.id] !== undefined ? given[q.id] : dflt[q.id];
    if (v === undefined) throw new Error(topic.id + '.' + q.id + ' has no translation');
    ans[q.id] = v;
  }
  if (!E.validateAnswers(topic, ans)) throw new Error('translated answers are not valid for ' + topic.id + ': ' + JSON.stringify(ans));
  return ans;
}

// ---- translations. `qa` = the quick answers. Each returns the topic's answer sets; `tick` = the rules of the topic marked with a check mark in the owner document. ----
const NI_EVENTS = { birth: 'birth', job: 'layoff', health: 'illness' };
const TR = {
  'lost-funds': {
    tick: ['lf-jobs', 'lf-forgot', 'lf-inherit', 'lf-acc'],
    variants: (qa) => [fill(TOPIC['lost-funds'], {
      jobs: has(qa.lost, 'jobs') ? 'few' : 'one', forgotten: has(qa.lost, 'forgot') ? 'yes' : 'no', inherit: has(qa.lost, 'inherit') ? 'yes' : 'no', oldacc: has(qa.lost, 'oldacc') ? 'yes' : 'no' },
      { checked: 'unk' })] // "did you check your pension in the last two years" is not asked: unknown
  },
  'tax-refunds': {
    tick: ['tx-nofile', 'tx-family'],
    // work: employee -> full, self -> self; "not working now" (seeking) -> part of the year (it was asked because they filed or not in recent years); retired/student -> did not work
    variants: (qa) => [fill(TOPIC['tax-refunds'], {
      work: { employee: 'full', self: 'self', seeking: process.env.QUICK_SEEKING_NONE ? 'none' : 'part', retired: 'none', student: 'none' }[qa.work],
      filed: qa.taxfile, family: has(qa.events, 'birth') || has(qa.events, 'family') ? 'yes' : 'no' },
      { multi: 'no', deposits: 'unk' })]
  },
  'national-insurance': {
    tick: ['ni-birth', 'ni-layoff', 'ni-ill', 'ni-ret'],
    variants: (qa) => {
      const evs = ['birth', 'job', 'health'].filter((e) => has(qa.events, e)).map((e) => NI_EVENTS[e]);
      const work = { employee: 'employee', self: 'self', seeking: 'unemployed', retired: 'retired', student: 'unemployed' }[qa.work];
      return (evs.length ? evs : ['none']).map((event) => fill(TOPIC['national-insurance'], { work, event }, { kids: 'no', asked: 'unk' }));
    }
  },
  mortgage: {
    tick: ['mg-refi'],
    // taken or changed 5 years ago or more: not reviewed since (as in the owner's mapping); taken or changed in the last 5 years: that IS a review (two sub-cases of the topic)
    variants: (qa) => qa.home === 'mortgage_old' ? [fill(TOPIC.mortgage, { has: 'yes', when: 'old', reviewed: 'no' }, { know: 'unk' })]
      : qa.home === 'mortgage_new' ? ['mid', 'new'].map((when) => fill(TOPIC.mortgage, { has: 'yes', when, reviewed: 'yes' }, { know: 'unk' }))
        : [fill(TOPIC.mortgage, { has: 'no' }, {})]
  },
  'insurance-pension': {
    tick: ['ip-review'],
    variants: (qa) => [fill(TOPIC['insurance-pension'], { age: { recent: 'no', old: 'yes', never: 'unk' }[qa.cover] }, { policies: 'unk', funds: 'unk' })]
  },
  'banking-loans': {
    tick: ['bk-fees'],
    variants: (qa) => [fill(TOPIC['banking-loans'], { fees: qa.bank }, { loans: 'no', idle: 'unk', cards: 'unk' })]
  },
  household: {
    tick: ['hh-bills', 'hh-ins'],
    // the quick question names the home insurance too: "recently" = both checked, otherwise the home insurance counts as not checked
    variants: (qa) => [fill(TOPIC.household, { bills: qa.bills, homeins: qa.bills === 'recent' ? 'yes' : 'no' }, { subs: 'unk', mobile: 'unk' })]
  },
  housing: {
    tick: ['hs-disc', 'hs-never', 'hs-rent'],
    variants: (qa) => {
      if (qa.home === 'other') return [fill(TOPIC.housing, { status: 'other' }, {})];
      const status = qa.home === 'rent' ? 'renter' : 'owner';
      // strict: "yes" -> yes, "no" -> no, "not sure" -> not sure, for both the discount question and (renters) the renters' benefit question; the situation is not asked: unknown
      const hb = qa.housebenefit;
      return [fill(TOPIC.housing, { status, discount: hb, rentaid: hb }, { situation: 'unk', empty: 'no' })];
    }
  },
  'payslip-rights': {
    tick: ['ps-monthly', 'ps-ended'],
    variants: (qa) => [fill(TOPIC['payslip-rights'], {
      emp: { employee: 'employee', self: 'self' }[qa.work] || 'none', monthly: qa.payslip, ended: has(qa.events, 'job') ? 'yes' : 'no' },
      { sections: 'unk', overtime: 'no' })]
  },
  'education-work': {
    tick: ['ed-study', 'ed-soldier', 'ed-income'],
    variants: (qa) => {
      const income = has(qa.events, 'income') ? 'yes' : 'no';
      if (qa.work === 'student') return ['student', 'soldier'].map((who) => fill(TOPIC['education-work'], { who, income }, { study: 'unk', soldier: 'unk' }));
      return [fill(TOPIC['education-work'], { who: qa.work === 'seeking' ? 'jobseeker' : 'worker', income }, { train: 'no' })];
    }
  }
};

// ---- measuring ----
const memo = new Map();
const run = (tid, ans) => { const k = tid + JSON.stringify(ans); let r = memo.get(k); if (!r) { r = E.evaluate(TOPIC[tid], ans).findings.map((f) => f.id); memo.set(k, r); } return r; };

function newStats() { return Object.fromEntries(Object.keys(TR).map((t) => [t, { rec: 0, prec: 0, precTick: 0, info: 0, infoEmpty: 0, tickFires: 0, recalled: 0, anyFindingNotRec: 0, ex: { prec: null, recall: null } }])); }
function observe(stats, qa) {
  const r0 = E.evaluate(Q, qa);
  const rec = new Set(r0.cards.map((c) => c.topic)), inf = new Set(r0.infoCards.map((c) => c.topic));
  Object.keys(TR).forEach((tid) => {
    const s = stats[tid], vs = TR[tid].variants(qa), res = vs.map((v) => run(tid, v));
    const firm = rec.has(tid), recommended = firm || inf.has(tid);   // recall counts either tier: the topic was pointed at
    if (inf.has(tid)) { s.info++; if (!res.some((r) => r.length)) s.infoEmpty++; }
    if (firm) {
      s.rec++;
      if (res.some((r) => r.length)) s.prec++; else if (!s.ex.prec) s.ex.prec = JSON.stringify(qa);
      if (res.some((r) => r.some((id) => TR[tid].tick.includes(id)))) s.precTick++;
    } else if (!recommended && res.some((r) => r.length)) s.anyFindingNotRec++;
    // recall: for every variant that fires a check-marked rule, the topic must be recommended
    const firesTick = res.some((r) => r.some((id) => TR[tid].tick.includes(id)));
    if (firesTick) { s.tickFires++; if (recommended) s.recalled++; else if (!s.ex.recall) s.ex.recall = JSON.stringify(qa); }
  });
}
function table(label, stats, n) {
  const pct = (a, b) => (b ? (100 * a / b).toFixed(2) + '%' : 'n/a');
  const rows = Object.keys(stats).map((t) => { const s = stats[t]; return t.padEnd(19) + String(s.rec).padStart(9) + '  ' + pct(s.prec, s.rec).padStart(8) + '  ' + pct(s.precTick, s.rec).padStart(8) + '  ' + pct(s.recalled, s.tickFires).padStart(8) + String(s.tickFires).padStart(9) + (String(s.info) + '(' + s.infoEmpty + ')').padStart(18) + String(s.anyFindingNotRec).padStart(11); });
  console.log('\nalignment, ' + label + ' (' + n + ' quick paths)\n' + 'topic'.padEnd(19) + 'firm-rec'.padStart(11) + ' precision  strict-prec  recall  checked-fires  needs-info(no finding)  other-findings-not-recommended\n' + rows.join('\n'));
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function exhaustiveSingles(stats) {
  let n = 0;
  (function go(ans) {
    const q = E.nextQuestion(Q, ans);
    if (!q) { n++; observe(stats, ans); return; }
    GM.choices(q).filter((c) => !q.multi || c.length === 1).forEach((c) => go(Object.assign({}, ans, { [q.id]: c })));
  })({});
  return n;
}
function sample(stats, count, seed) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    let ans = {}, q;
    while ((q = E.nextQuestion(Q, ans))) { const cs = GM.choices(q); ans = Object.assign({}, ans, { [q.id]: cs[Math.floor(r() * cs.length)] }); }
    observe(stats, ans);
  }
}

test('every translation yields valid, complete answers for its topic on every skeleton (a mistake here would silently weaken the checks below)', () => {
  let n = 0;
  (function go(ans) {
    const q = E.nextQuestion(Q, ans);
    if (!q) { n++; Object.keys(TR).forEach((t) => TR[t].variants(ans).forEach((v) => assert.ok(E.validateAnswers(TOPIC[t], v)))); return; }
    GM.choices(q).filter((c) => !q.multi || c.length === 1).forEach((c) => go(Object.assign({}, ans, { [q.id]: c })));
  })({});
  assert.ok(n > 100000, 'skeleton paths: ' + n);
});

test('the marked rules named in the translations exist in the topics', () => {
  Object.keys(TR).forEach((t) => TR[t].tick.forEach((id) => assert.ok(TOPIC[t].rules.some((r) => r.id === id), t + ' has no rule ' + id)));
});

test('exhaustive over every combination of single answers: precision and recall are perfect for every topic', () => {
  const stats = newStats();
  const n = exhaustiveSingles(stats);
  table('exhaustive, multi-select one pick at a time', stats, n);
  Object.keys(stats).forEach((t) => {
    const s = stats[t];
    assert.equal(s.prec, s.rec, t + ': recommended without any finding in the full check, e.g. ' + s.ex.prec);
    assert.equal(s.recalled, s.tickFires, t + ': a marked signal fires in the full check but the quick check does not recommend the topic, e.g. ' + s.ex.recall);
    assert.ok(s.rec > 0, t + ' is never recommended');
  });
});

test('seeded sample of 40000 complete paths with arbitrary multi-select subsets: precision and recall are perfect for every topic', () => {
  const stats = newStats();
  sample(stats, 40000, 20261103);
  table('seeded sample with multi-select subsets', stats, 40000);
  Object.keys(stats).forEach((t) => {
    const s = stats[t];
    assert.equal(s.prec, s.rec, t + ': recommended without any finding, e.g. ' + s.ex.prec);
    assert.equal(s.recalled, s.tickFires, t + ': marked signal missed, e.g. ' + s.ex.recall);
  });
});

test('the wording of each card reason is about the same signal as the topic rule it mirrors (ids in the owner mapping)', () => {
  // each quick rule names the topic rule(s) it mirrors; a typo in a topic id or a rule that mirrors nothing would show here
  const MIRROR = {
    'q-lf-jobs': ['lost-funds', 'lf-jobs'], 'q-lf-forgot': ['lost-funds', 'lf-forgot'], 'q-lf-inherit': ['lost-funds', 'lf-inherit'], 'q-lf-acc': ['lost-funds', 'lf-acc'],
    'q-tx-nofile': ['tax-refunds', 'tx-nofile'], 'q-tx-family': ['tax-refunds', 'tx-family'],
    'q-ni-birth': ['national-insurance', 'ni-birth'], 'q-ni-job': ['national-insurance', 'ni-layoff'], 'q-ni-health': ['national-insurance', 'ni-ill'], 'q-ni-ret': ['national-insurance', 'ni-ret'],
    'q-mg-refi': ['mortgage', 'mg-refi'], 'q-ip-review': ['insurance-pension', 'ip-review'], 'q-bk-fees': ['banking-loans', 'bk-fees'], 'q-hh-bills': ['household', 'hh-bills'],
    'q-hs-rent': ['housing', 'hs-rent'], 'q-hs-own': ['housing', 'hs-never'], 'q-ps-monthly': ['payslip-rights', 'ps-monthly'], 'q-ps-ended': ['payslip-rights', 'ps-ended'],
    'q-ed-study': ['education-work', 'ed-study'], 'q-ed-income': ['education-work', 'ed-income'],
    'q-tx-unk': ['tax-refunds', 'tx-nofile'], 'q-ip-unk': ['insurance-pension', 'ip-review'], 'q-hs-rent-unk': ['housing', 'hs-rent'], 'q-hs-own-unk': ['housing', 'hs-never'], 'q-ps-unk': ['payslip-rights', 'ps-monthly']
  };
  Q.rules.forEach((r) => { const m = MIRROR[r.id]; assert.ok(m, r.id + ' mirrors no topic rule'); assert.equal(r.finding.topic, m[0]); assert.ok(TOPIC[m[0]].rules.some((x) => x.id === m[1])); });
  assert.equal(Object.keys(MIRROR).length, Q.rules.length);
});
