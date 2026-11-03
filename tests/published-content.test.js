'use strict';
// The ten published topics. The content may differ from the version that was published (fixture published-v1.content.json, recorded from commit e951bed)
// ONLY by (a) a `step` or `official` added to a finding (version 1.0: what a family can do by itself) and (b) the wording fixes listed below that removed
// promises of personal help. Any other difference fails, so the published questions, conditions, rules and findings can never change silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ORIGINAL = read(path.join(__dirname, 'fixtures', 'golden', 'published-v1.content.json'));
const CURRENT = read(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'));

function keyed(x) {
  if (Array.isArray(x) && x.length && x.every((o) => o && typeof o === 'object' && !Array.isArray(o) && typeof o.id === 'string')) { const m = {}; x.forEach((o) => { m[o.id] = keyed(o); }); return m; }
  if (Array.isArray(x)) return x.map(keyed);
  if (x && typeof x === 'object') { const m = {}; Object.keys(x).forEach((k) => { m[k] = keyed(x[k]); }); return m; }
  return x;
}
function walk(a, b, p, out) {
  const obj = (v) => v && typeof v === 'object';
  if (obj(a) && obj(b)) {
    if (Array.isArray(a) !== Array.isArray(b)) { out.changed.push({ path: p, old: a, now: b }); return; }
    const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
    keys.forEach((k) => {
      if (!(k in a)) out.added.push(p + '.' + k);
      else if (!(k in b)) out.removed.push(p + '.' + k);
      else walk(a[k], b[k], p + '.' + k, out);
    });
    return;
  }
  if (a !== b) out.changed.push({ path: p, old: a, now: b });
}

const NEW_INSUFFICIENT_TAIL = ['או להשאיר פרטים ונעזור להשלים את התמונה.', 'או לבדוק תחום אחר.'];
const WORDING = {
  'topics.national-insurance.intro': ['נעזור לכוון איפה כדאי לבדוק זכאות.', 'הבדיקה מכוונת לאן כדאי לבדוק זכאות.'],
  'topics.payslip-rights.rules.ps-monthly.finding.why': ['מומלץ להתחיל לעבור עליו, ואנחנו נעזור להבין מה כדאי לבדוק.', 'מומלץ להתחיל לעבור עליו מדי חודש ולברר כל רכיב שאינו ברור.'],
  'topics.education-work.rules.ed-soldier.finding.why': ['שוחררים זכאים להטבות שונות שלעיתים מתקבלות רק לאחר פנייה.', 'לשוחררים קיימות הטבות שונות, ולעיתים הן ניתנות רק לאחר פנייה.'],
  'topics.banking-loans.rules.bk-idle.finding.why': ['להתאים להשקעה שמתאימה לצורכי הנזילות שלכם.', 'להתאים לחיסכון או לפיקדון שמתאימים לצורכי הנזילות שלכם.']
};
ORIGINAL.topics.forEach((t) => { WORDING['topics.' + t.id + '.messages.insufficientBody'] = NEW_INSUFFICIENT_TAIL; });

test('the ten published topics keep their order, questions, conditions and rules; same ids everywhere', () => {
  assert.deepEqual(CURRENT.topics.map((t) => t.id), ORIGINAL.topics.map((t) => t.id));
  CURRENT.topics.forEach((t, i) => {
    assert.deepEqual(t.rules.map((r) => r.id), ORIGINAL.topics[i].rules.map((r) => r.id), t.id + ' rules');
    assert.deepEqual(t.questions.map((q) => q.id), ORIGINAL.topics[i].questions.map((q) => q.id), t.id + ' questions');
    t.rules.forEach((r, j) => assert.deepEqual(r.when, ORIGINAL.topics[i].rules[j].when, r.id + ' condition'));
  });
});

test('the ten published topics differ from what was published only by added steps/links and the listed wording fixes', () => {
  const out = { added: [], removed: [], changed: [] };
  walk(keyed(ORIGINAL), keyed(CURRENT), 'root', out);
  const clean = (p) => p.replace(/^root\./, '');
  assert.deepEqual(out.removed, [], 'nothing published may be removed');
  out.added.forEach((p) => assert.match(clean(p), /^topics\.[a-z-]+\.rules\.[a-z-]+\.finding\.(step|official|officialMore)$/, 'only a finding may gain a step or official links: ' + p));
  const expectedPaths = Object.keys(WORDING).sort();
  assert.deepEqual(out.changed.map((c) => clean(c.path)).sort(), expectedPaths, 'the changed texts are exactly the listed wording fixes');
  out.changed.forEach((c) => {
    const w = WORDING[clean(c.path)];
    assert.equal(c.now, c.old.replace(w[0], w[1]), clean(c.path));
    assert.notEqual(c.now, c.old, clean(c.path));
  });
});
