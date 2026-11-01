// Exhaustive analysis of questionnaires: enumerates EVERY answer path with the real rules engine.
// Usage: node scripts/analyze-questionnaires.js [topics.json] [--json]
// Reports per topic: path count, questions per path (min/avg/max), outcome mix, per-rule firing rate, dead rules,
// questions that never change the outcome, and "false-alarm pressure" (share of paths ending in 'found').
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');

const file = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json');
const asJson = process.argv.includes('--json');
// --singles: multi-select questions take exactly ONE option per path (a family with one circumstance). Informational only: with multi-select the
// all-pairs enumeration inflates 'found' because every combination counts equally — never tune a questionnaire to any percentage.
const singles = process.argv.includes('--singles');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// Answer alternatives of a question. Multi-select: every single option and every PAIR of non-exclusive options
// (a family matching 2 tracks at once); exclusive options ("none of these", "not sure") alone.
function optionSets(q) {
  if (!q.multi) return q.options.map((o) => o.id);
  if (singles) return q.options.map((o) => [o.id]);
  const free = q.options.filter((o) => !o.exclusive).map((o) => o.id);
  const sets = q.options.map((o) => [o.id]);
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) sets.push([free[i], free[j]]);
  return sets;
}

function enumerate(cfg) {
  const out = [];
  (function walk(ans) {
    const q = E.nextQuestion(cfg, ans);
    if (!q) { out.push(Object.assign({}, ans)); return; }
    optionSets(q).forEach((v) => { ans[q.id] = v; walk(ans); delete ans[q.id]; });
  })({});
  return out;
}

const report = data.topics.map((t) => {
  const paths = enumerate(t);
  const lens = paths.map((a) => Object.keys(a).length);
  const multiQs = t.questions.filter((q) => q.multi).length;
  const outcomes = { found: 0, insufficient: 0, none: 0 };
  const ruleHits = {}; (t.rules || []).forEach((r) => { ruleHits[r.id] = 0; });
  const inactive = (t.rules || []).filter((r) => r.status === 'inactive').map((r) => r.id);
  const findingCounts = [];
  paths.forEach((a) => { const r = E.evaluate(t, a); outcomes[r.outcome]++; r.findings.forEach((f) => { ruleHits[f.id]++; }); findingCounts.push(r.count); });
  // questions that never influence the result: for each question, flipping its answer (others fixed) never changes the outcome or findings
  const noEffect = t.questions.filter((q) => {
    return !paths.some((a) => {
      if (a[q.id] == null) return false;
      return optionSets(q).some((v) => { if (JSON.stringify(v) === JSON.stringify(a[q.id])) return false; const b = E.pruneAnswers(t, Object.assign({}, a, { [q.id]: v })); const x = E.evaluate(t, a), y = E.evaluate(t, b); return JSON.stringify(x.findings.map((f) => f.id)) !== JSON.stringify(y.findings.map((f) => f.id)) || x.outcome !== y.outcome; });
    });
  }).map((q) => q.id);
  const n = paths.length;
  return {
    topic: t.id, name: t.name, paths: n, multiQuestions: multiQs,
    qPerPath: { min: lens.reduce((a, b) => Math.min(a, b), Infinity), avg: +(lens.reduce((s, x) => s + x, 0) / n).toFixed(2), max: lens.reduce((a, b) => Math.max(a, b), 0) },
    outcomePct: Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, Math.round((v / n) * 100)])),
    avgFindings: +(findingCounts.reduce((s, x) => s + x, 0) / n).toFixed(2),
    ruleFirePct: Object.fromEntries(Object.entries(ruleHits).map(([k, v]) => [k, Math.round((v / n) * 100)])),
    deadRules: Object.keys(ruleHits).filter((k) => ruleHits[k] === 0 && inactive.indexOf(k) === -1),
    inactiveRules: inactive,
    alwaysFiringRules: Object.keys(ruleHits).filter((k) => ruleHits[k] === n),
    noEffectQuestions: noEffect,
    lintErrors: E.lint(t)
  };
});

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
console.log('topic'.padEnd(22) + 'paths  q/path(min-avg-max)  found/insuff/none %   avg findings  dead rules  no-effect Qs');
report.forEach((r) => console.log(r.topic.padEnd(22) + String(r.paths).padEnd(7) + `${r.qPerPath.min}-${r.qPerPath.avg}-${r.qPerPath.max}`.padEnd(24) + `${r.outcomePct.found}/${r.outcomePct.insufficient}/${r.outcomePct.none}`.padEnd(22) + String(r.avgFindings).padEnd(14) + (r.deadRules.join(',') || '-').padEnd(12) + (r.noEffectQuestions.join(',') || '-') + (r.lintErrors.length ? '  LINT: ' + r.lintErrors.join('; ') : '')));
console.log('\nrule firing rate (% of all answer paths, uniform weighting):');
report.forEach((r) => console.log('  ' + r.topic + ': ' + Object.entries(r.ruleFirePct).map(([k, v]) => `${k}=${v}%`).join(' ')));
