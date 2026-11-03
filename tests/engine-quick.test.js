'use strict';
// Stage 4: the quick check ("quick", kind "router") as content for the SAME engine. Static checks of the questionnaire, a full walk over every answer
// path with counters (about 3 million paths: never stored), and a few hand-written personas. Nothing here publishes anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');
const GM = require('../scripts/golden-master.js');

const CONTENT = path.join(__dirname, '..', 'kaspchem', 'content');
const TEN = JSON.parse(fs.readFileSync(path.join(CONTENT, 'topics.json'), 'utf8')).topics;        // topics.json: exactly the ten check topics
const ROUTES = JSON.parse(fs.readFileSync(path.join(CONTENT, 'routes.json'), 'utf8')).topics;     // routes.json: entry routes (the quick check)
const Q = ROUTES.find((t) => t.id === 'quick');
const TEN_IDS = TEN.map((t) => t.id);
const PRIORITY = ['lost-funds', 'tax-refunds', 'national-insurance', 'mortgage', 'insurance-pension', 'banking-loans', 'household', 'housing', 'payslip-rights', 'education-work'];

// Walk every complete answer path with counters. A multi-select question never changes which questions are visible (asserted below), so it is
// represented by ONE of its answers (`multi: 'first'`) with a multiplicity equal to the number of allowed answers, or by each single pick (`multi: 'singles'`).
function walk(cfg, onLeaf, multi) {
  (function go(ans, mult, len) {
    const q = E.nextQuestion(cfg, ans);
    if (!q) { onLeaf(ans, mult, len); return; }
    const cs = GM.choices(q);
    if (!q.multi) cs.forEach((c) => go(Object.assign({}, ans, { [q.id]: c }), mult, len + 1));
    else if (multi === 'singles') cs.filter((c) => c.length === 1).forEach((c) => go(Object.assign({}, ans, { [q.id]: c }), mult, len + 1));
    else go(Object.assign({}, ans, { [q.id]: cs[0] }), mult * cs.length, len + 1);
  })({}, 1, 0);
}
function condQs(c, out) { if (!c) return out; if (c.all) c.all.forEach((x) => condQs(x, out)); else if (c.any) c.any.forEach((x) => condQs(x, out)); else if (c.not) condQs(c.not, out); else if (c.q) out.add(c.q); return out; }
const hasNot = (c) => !!c && (!!c.not || (c.all || c.any || []).some(hasNot));

test('the quick check lives in routes.json (kind router), lints clean; topics.json holds exactly the ten and no router', () => {
  assert.ok(Q, 'route quick exists');
  assert.equal(Q.kind, 'router'); assert.equal(ROUTES.length, 1);
  assert.equal(TEN.length, 10); assert.ok(TEN.every((t) => t.kind === undefined && t.id !== 'quick'));
  assert.deepEqual(E.lint(Q), []);
  assert.deepEqual(require('../netlify/functions/_kaspchem/content').routeProblems({ topics: TEN }, { topics: ROUTES }), []);
});

test('every finding.topic is one of the ten published topics, and the card group is that same topic', () => {
  Q.rules.forEach((r) => {
    assert.ok(TEN_IDS.includes(r.finding.topic), r.id + ' points at an unknown topic: ' + r.finding.topic);
    assert.equal(r.finding.group, r.finding.topic, r.id + ': group must equal topic so that there is one card per topic and the card link is right');
    assert.ok(r.finding.groupTitle && r.finding.title && r.finding.why && r.finding.section, r.id + ' is missing wording');
  });
  assert.equal(new Set(Q.rules.map((r) => r.id)).size, Q.rules.length, 'rule ids unique');
});

test('the card title is exactly the name of the topic it opens (the button says the same name)', () => {
  Q.rules.forEach((r) => {
    const t = TEN.find((x) => x.id === r.finding.topic);
    assert.equal(r.finding.groupTitle, t.name, r.id + ': card title differs from the topic name "' + t.name + '"');
  });
});

test('no dead question: every question is used by at least one rule', () => {
  const used = new Set();
  Q.rules.forEach((r) => condQs(r.when, used));
  Q.questions.forEach((q) => assert.ok(used.has(q.id), 'question ' + q.id + ' is not used by any rule'));
});

test('branching only depends on single-select questions, and rules are positive (no "not"), so a multi answer can only add findings', () => {
  const multiIds = Q.questions.filter((q) => q.multi).map((q) => q.id);
  assert.deepEqual(multiIds.sort(), ['events', 'lost']);
  Q.questions.forEach((q) => condQs(q.showIf, new Set()).forEach((id) => assert.ok(!multiIds.includes(id), q.id + ' is shown depending on a multi-select question')));
  Q.rules.forEach((r) => assert.ok(!hasNot(r.when), r.id + ' uses "not"'));
});

test('every option can be chosen: there is a complete valid path that includes it', () => {
  const missing = [];
  Q.questions.forEach((q) => q.options.forEach((o) => {
    let ok = false;
    // try each work/home skeleton, put this option on question q, complete the rest with the first answer of each question
    const works = Q.questions[0].options.map((x) => x.id), homes = Q.questions[1].options.map((x) => x.id);
    works.forEach((w) => homes.forEach((h) => {
      if (ok) return;
      let ans = { work: w, home: h }; if (q.id === 'work') ans.work = o.id; if (q.id === 'home') ans.home = o.id;
      let nq;
      while ((nq = E.nextQuestion(Q, ans))) {
        const pick = nq.id === q.id ? o.id : nq.options[0].id;
        ans = Object.assign({}, ans, { [nq.id]: nq.multi ? [pick] : pick });
      }
      if (Object.prototype.hasOwnProperty.call(ans, q.id) && [].concat(ans[q.id]).includes(o.id) && E.validateAnswers(Q, ans)) ok = true;
    }));
    if (!ok) missing.push(q.id + '.' + o.id);
  }));
  assert.deepEqual(missing, []);
});

test('path length: every complete path shows 7 to 10 questions, never more than 10; about 3 million paths in all', () => {
  const hist = {}; let total = 0;
  walk(Q, (a, m, len) => { hist[len] = (hist[len] || 0) + m; total += m; }, 'first');
  const lens = Object.keys(hist).map(Number);
  assert.equal(Math.min(...lens), 7); assert.equal(Math.max(...lens), 10);
  assert.ok(Math.max(...lens) <= 10);
  assert.equal(total, Object.values(hist).reduce((s, n) => s + n, 0));
  assert.ok(total > 3000000 && total < 3100000, 'path count ' + total);
  console.log('paths: ' + total + ' by length ' + JSON.stringify(hist));
  // the shortest and the longest path, by construction
  assert.equal(E.visibleQuestions(Q, { work: 'retired', home: 'other' }).length, 7);
  assert.equal(E.visibleQuestions(Q, { work: 'employee', home: 'rent' }).length, 10);
});

test('every rule can fire (on a path with single picks), and it fires for the reason written in it', () => {
  const fires = {};
  walk(Q, (a) => { E.evaluate(Q, a).findings.forEach((f) => { fires[f.id] = (fires[f.id] || 0) + 1; }); }, 'singles');
  Q.rules.forEach((r) => assert.ok(fires[r.id] > 0, 'rule ' + r.id + ' can never fire'));
});

test('outcomes: "none" on exactly 12 skeleton paths; "insufficient" on exactly 96, always with a needs-info item and never with a firm one', () => {
  let none = 0, insufficient = 0, found = 0; const unknownSets = new Set();
  walk(Q, (a, m) => { const r = E.evaluate(Q, a), o = r.outcome; if (o === 'none') none += m; else if (o === 'insufficient') { insufficient += m; unknownSets.add(r.unknown.join(',')); assert.equal(r.count, 0); assert.ok(r.infoCardCount > 0, 'insufficient without any needs-info card: ' + JSON.stringify(a)); } else { found += m; assert.ok(r.count > 0); } }, 'singles');
  // 'singles' counts each single pick once; "none" needs both multi questions on their exclusive "none" option, so it is one path per skeleton
  assert.equal(none, 12);
  // every "not sure" answer (tax report, housing benefit, payslip, insurance check) now yields a needs-info item (second tier) and never a finding
  assert.equal(insufficient, 96);
  assert.ok(['taxfile', 'payslip', 'cover', 'housebenefit'].every((u) => [...unknownSets].some((s) => s.split(',').includes(u))));
  assert.ok(found > 0);
  // a path with any non-"none" multi pick always finds something, because the rules are positive and each multi option has a rule
  Q.questions.filter((q) => q.multi).forEach((q) => q.options.filter((o) => !o.exclusive).forEach((o) => {
    const base = { work: 'employee', home: 'mortgage_new', housebenefit: 'yes', events: ['none'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent', taxfile: 'yes', payslip: 'yes' };
    assert.equal(E.evaluate(Q, Object.assign({}, base, { [q.id]: [o.id] })).outcome, 'found', q.id + '.' + o.id + ' leads nowhere');
  }));
});

test('cards come out in the fixed priority order, one card per topic', () => {
  let n = 0;
  walk(Q, (a) => {
    const r = E.evaluate(Q, a); n++;
    const topics = r.cards.map((c) => c.topic);
    assert.equal(new Set(topics).size, topics.length, 'one card per topic');
    const idx = topics.map((t) => PRIORITY.indexOf(t));
    assert.ok(idx.every((i) => i >= 0));
    assert.deepEqual(idx.slice().sort((x, y) => x - y), idx, 'cards out of priority order: ' + topics.join(','));
    assert.equal(r.cardCount, topics.length);
  }, 'singles');
  assert.ok(n > 1000);
});

// ---- personas ----
const base = { work: 'employee', home: 'owned', housebenefit: 'yes', events: ['none'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent', taxfile: 'yes', payslip: 'yes' };
const ev = (over) => { const a = Object.assign({}, base, over); Object.keys(a).forEach((k) => { if (a[k] === undefined) delete a[k]; }); assert.ok(E.validateAnswers(Q, a), 'persona answers are valid: ' + JSON.stringify(a)); return E.evaluate(Q, a); };
const tops = (r) => r.cards.map((c) => c.topic);

test('persona: an employed owner with no mortgage who ticked nothing and checked everything recently gets "none" (one of the 12)', () => {
  const r = ev({});
  assert.equal(r.outcome, 'none'); assert.equal(r.count, 0); assert.equal(r.cardCount, 0);
});

test('persona: a retiree with everything else benign gets "insufficient" with ONLY a needs-info national-insurance item (the status alone is not a finding)', () => {
  const r = ev({ work: 'retired', taxfile: undefined, payslip: undefined });
  assert.equal(r.outcome, 'insufficient'); assert.equal(r.count, 0); assert.equal(r.cardCount, 0);
  assert.deepEqual(r.infoCards.map((c) => c.topic), ['national-insurance']); assert.deepEqual(r.findings.map((f) => f.id), ['q-ni-ret']);
  assert.ok(r.findings[0].needsInfo);
});

test('persona: a retiree with a health event gets a FIRM national-insurance card whose reason is the health one; the retirement item is not repeated as needs-info', () => {
  const r = ev({ work: 'retired', taxfile: undefined, payslip: undefined, events: ['health'] });
  assert.equal(r.outcome, 'found'); assert.deepEqual(tops(r), ['national-insurance']);
  assert.deepEqual(r.cards[0].parts.map((p) => p.id), ['q-ni-health']);
  assert.match(r.cards[0].parts[0].why, /מחלה או פגיעה/); assert.ok(!/פרישה/.test(r.cards[0].parts[0].why));
  assert.deepEqual(r.infoCards, []); assert.equal(r.count, 1);
  // the retirement rule still matched (it is listed in findings, flagged), it just adds nothing to the count
  assert.ok(r.findings.some((f) => f.id === 'q-ni-ret' && f.needsInfo));
});

test('persona: an employee who rents, lost the job, never filed and does not read the payslip: tax, national insurance, housing, payslip rights', () => {
  const r = ev({ home: 'rent', housebenefit: 'no', events: ['job'], taxfile: 'no', payslip: 'no' });
  assert.deepEqual(tops(r), ['tax-refunds', 'national-insurance', 'housing', 'payslip-rights']);
  assert.equal(r.outcome, 'found');
  // payslip-rights has two reasons (monthly check, rights at the end of employment) in ONE card; the card carries its topic
  const ps = r.cards.find((c) => c.topic === 'payslip-rights');
  assert.equal(ps.parts.length, 2); assert.equal(ps.title, 'תלושי שכר וזכויות עובדים');
  assert.ok(r.findings.every((f) => f.topic));
});

test('persona: an employee who rents and lost the job but filed taxes: no tax card', () => {
  const r = ev({ home: 'rent', housebenefit: 'yes', events: ['job'] });
  assert.deepEqual(tops(r), ['national-insurance', 'payslip-rights']);
});

test('persona: a student with a old mortgage and a birth: education, tax (family), national insurance (birth), mortgage', () => {
  const r = ev({ work: 'student', taxfile: undefined, payslip: undefined, home: 'mortgage_old', events: ['birth'] });
  assert.deepEqual(tops(r), ['tax-refunds', 'national-insurance', 'mortgage', 'education-work']);
});

test('persona: everything ticked and nothing checked recently lists all ten topics, in priority order', () => {
  const r = ev({ work: 'student', home: 'rent', housebenefit: 'no', events: ['birth', 'job', 'health', 'income', 'family'], lost: ['jobs', 'forgot', 'inherit', 'oldacc'], cover: 'old', bank: 'never', bills: 'never', taxfile: undefined, payslip: undefined });
  assert.deepEqual(tops(r), ['lost-funds', 'tax-refunds', 'national-insurance', 'insurance-pension', 'banking-loans', 'household', 'housing', 'payslip-rights', 'education-work']);
  // student: the payslip question is not asked, but "job ended" still points at payslip rights; mortgage needs the old-mortgage answer
  const r2 = ev({ work: 'student', home: 'mortgage_old', housebenefit: 'no', events: ['birth', 'job', 'health', 'income'], lost: ['jobs'], cover: 'old', bank: 'old', bills: 'old', taxfile: undefined, payslip: undefined });
  assert.equal(r2.cardCount, 10);
  assert.deepEqual(tops(r2), PRIORITY);
});

test('the finding.topic extension is purely additive: findings and cards of the ten topics carry no topic field', () => {
  let n = 0;
  TEN.forEach((t) => {
    let seen = 0;
    (function go(ans) {
      const q = E.nextQuestion(t, ans);
      if (!q) { seen++; n++; const r = E.evaluate(t, ans); r.findings.forEach((f) => assert.ok(!('topic' in f))); r.cards.forEach((c) => assert.ok(!('topic' in c))); return; }
      GM.choices(q).forEach((c) => go(Object.assign({}, ans, { [q.id]: c })));
    })({});
  });
  assert.equal(n, 937, 'all 937 answer paths of the ten topics');
});

test('the lead endpoint\'s stored shape: finding ids only (the topic comes from the rule), and they are all rule ids of the quick check', () => {
  const r = ev({ home: 'rent', housebenefit: 'no', events: ['job'] });
  r.findings.forEach((f) => assert.ok(Q.rules.some((x) => x.id === f.id)));
});

// ---- stage 4b: the second tier ("needs information") ----
const INFO_RULES = Q.rules.filter((r) => r.finding.needsInfo);

test('needs-info rules: exactly the "not sure" answers that the full topic does not count, plus the retirement status; each points at a topic; none sits in the ten', () => {
  assert.deepEqual(INFO_RULES.map((r) => r.id).sort(), ['q-hs-own-unk', 'q-ip-unk', 'q-ni-ret', 'q-ps-unk', 'q-tx-unk']);
  // every needs-info rule (except the retirement one) is triggered by an answer that is an "unknown" option of its question
  INFO_RULES.filter((r) => r.id !== 'q-ni-ret').forEach((r) => {
    const refs = []; (function f(c) { if (c.all) c.all.forEach(f); else if (c.any) c.any.forEach(f); else refs.push(c); })(r.when);
    assert.ok(refs.some((c) => { const q = Q.questions.find((x) => x.id === c.q); return c.in.every((id) => (q.options.find((o) => o.id === id) || {}).unknown); }), r.id + ' is not triggered by an unknown option');
  });
  // and no firm rule is triggered by an unknown option alone... except the renters one, whose full-topic rule (hs-rent) counts "not sure"
  Q.rules.filter((r) => !r.finding.needsInfo).forEach((r) => {
    const refs = []; (function f(c) { if (c.all) c.all.forEach(f); else if (c.any) c.any.forEach(f); else refs.push(c); })(r.when);
    refs.forEach((c) => { const q = Q.questions.find((x) => x.id === c.q); c.in.forEach((id) => { if ((q.options.find((o) => o.id === id) || {}).unknown) assert.equal(r.id, 'q-hs-rent-unk', r.id + ' fires firmly on an unknown option'); }); });
  });
});

test('(a) a needs-info item never changes N, the cards counted, or the "found" outcome: removing every needs-info rule gives the same count, cards and found-ness', () => {
  const firmOnly = Object.assign({}, Q, { rules: Q.rules.filter((r) => !r.finding.needsInfo) });
  let n = 0;
  walk(Q, (a) => {
    const r = E.evaluate(Q, a), f = E.evaluate(firmOnly, a); n++;
    assert.equal(r.count, f.count); assert.equal(r.cardCount, f.cardCount);
    assert.deepEqual(r.cards.map((c) => c.topic), f.cards.map((c) => c.topic));
    assert.equal(r.outcome === 'found', f.outcome === 'found');
    assert.equal(r.outcome === 'found', r.count > 0);
    r.infoCards.forEach((c) => { assert.ok(c.topic); assert.ok(!r.cards.some((x) => x.topic === c.topic), 'a topic is never in both tiers'); assert.ok(c.parts.every((p) => p.needsInfo)); });
    assert.ok(r.infoCardCount <= 4);
  }, 'singles');
  assert.ok(n > 100000);
});

test('(c) a needs-info recommendation exists only where the path has a matching unknown answer (or the retirement status)', () => {
  walk(Q, (a) => {
    const r = E.evaluate(Q, a);
    r.infoCards.forEach((c) => {
      const unkAnswered = Q.questions.some((q) => (q.options || []).some((o) => o.unknown && [].concat(a[q.id] || []).includes(o.id)));
      assert.ok(unkAnswered || a.work === 'retired', 'needs-info for ' + c.topic + ' with no unknown answer: ' + JSON.stringify(a));
    });
    // and the reverse: no unknown answer and not retired -> no needs-info item at all
    const unk = Q.questions.some((q) => (q.options || []).some((o) => o.unknown && [].concat(a[q.id] || []).includes(o.id)));
    if (!unk && a.work !== 'retired') assert.equal(r.infoCards.length, 0);
  }, 'singles');
});

test('wording: no finding title, reason or section anywhere claims an approved or granted entitlement', () => {
  const BAD = /מגיע(ים|ות)? לכם|זכאים|זכאית|זכאי\b|אושר|מאושר|זכיתם|הוענק|בוודאות|בטוח שיש/;
  const bad = [];
  Q.rules.forEach((r) => ['title', 'why', 'section', 'groupTitle', 'groupIntro'].forEach((k) => { if (BAD.test(r.finding[k] || '')) bad.push(r.id + '.' + k + ': ' + r.finding[k]); }));
  assert.deepEqual(bad, []);
  // needs-info wording says "not sure / worth continuing" and nothing that sounds like a result
  INFO_RULES.forEach((r) => assert.match(r.finding.why, /כדאי להמשיך לבדיקה|כדאי להמשיך לבדיקת/));
  INFO_RULES.forEach((r) => assert.ok(!/זיהינו|נמצא|יש לכם/.test(r.finding.why)));
});

test('the second tier is additive: the ten topics carry no needsInfo flag, no infoCards content, and identical counts', () => {
  TEN.forEach((t) => t.rules.forEach((r) => assert.ok(!('needsInfo' in (r.finding || {})))));
  (function go(t, ans) {
    const q = E.nextQuestion(t, ans);
    if (!q) { const r = E.evaluate(t, ans); assert.equal(r.infoCardCount, 0); assert.equal(r.count, r.findings.length); assert.equal(r.outcome === 'found', r.findings.length > 0); return; }
    GM.choices(q).forEach((c) => go(t, Object.assign({}, ans, { [q.id]: c })));
  })(TEN[0], {});
});
