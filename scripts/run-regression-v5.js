// Runs the v5 regression suite (docs/research/scenarios-v5/regression-v5.json) against a questionnaire file.
// Usage: node scripts/run-regression-v5.js <topics.json> <regression-v5.json> [--v4] [--quiet]
//   --v4  evaluates the "answersV4" translation of every family (the BEFORE run against the v4 questionnaire).
// Extra expectation keys on top of run-scenarios.js:
//   expect.maxQuestions     the family must answer at most this many questions (number of visible questions on its path)
//   expect.textMustMatch / textMustNotMatch   regex strings over everything the result screen shows (outcome title+body, finding title/why/step/refer/official label)
//   copyCheck {topic, fields[], mustNotMatch[], mustMatch[]}   static check of topic copy: intro, messages.X, help:<qid>, rules (all rule copy)
const fs = require('fs');
const E = require('../kaspchem/assets/engine.js');

const [topicsFile, regFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const v4 = process.argv.includes('--v4');
const quiet = process.argv.includes('--quiet');
const topics = Object.fromEntries(JSON.parse(fs.readFileSync(topicsFile, 'utf8')).topics.map((t) => [t.id, t]));
const scenarios = JSON.parse(fs.readFileSync(regFile, 'utf8'));

function resultText(t, r) {
  const m = t.messages || {};
  const parts = [m[r.outcome], m[r.outcome + 'Body']];
  r.findings.forEach((f) => { parts.push(f.title, f.why, f.step, f.refer, f.official && f.official.label); });
  return parts.filter(Boolean).join(' \n ');
}
function fieldText(t, f) {
  if (f === 'intro') return t.intro || '';
  if (f === 'rules') return t.rules.map((r) => ['title', 'why', 'step', 'refer'].map((k) => (r.finding || {})[k] || '').join(' ')).join(' \n ');
  if (f.indexOf('messages.') === 0) return (t.messages || {})[f.slice(9)] || '';
  if (f.indexOf('help:') === 0) { const q = t.questions.find((x) => x.id === f.slice(5)); return q ? (q.help || '') : ''; }
  return '';
}

const rows = []; let bad = 0;
scenarios.forEach((s) => {
  const t = topics[s.topic]; const problems = [];
  const answers = v4 ? s.answersV4 : s.answers;
  if (!t) problems.push('unknown topic');
  else if (!answers || !E.validateAnswers(t, answers)) problems.push('the family cannot be expressed as a valid answer path in this questionnaire (' + JSON.stringify(answers) + ')');
  else {
    const r = E.evaluate(t, answers); const ids = r.findings.map((x) => x.id); const e = s.expect || {};
    if (e.outcome && e.outcome !== r.outcome) problems.push(`outcome ${r.outcome} != expected ${e.outcome}`);
    (e.mustInclude || []).forEach((id) => { if (ids.indexOf(id) === -1) problems.push('MISSING finding ' + id); });
    (e.mustNotInclude || []).forEach((id) => { if (ids.indexOf(id) !== -1) problems.push('FALSE ALARM ' + id); });
    if (e.exactFindings && JSON.stringify(e.exactFindings.slice().sort()) !== JSON.stringify(ids.slice().sort())) problems.push('findings [' + ids + '] != exact [' + e.exactFindings + ']');
    if (e.maxQuestions != null) { const n = Object.keys(answers).length; if (n > e.maxQuestions) problems.push(`answers ${n} questions (max ${e.maxQuestions})`); }
    const txt = resultText(t, r);
    (e.textMustMatch || []).forEach((p) => { if (!new RegExp(p).test(txt)) problems.push('result text lacks /' + p + '/'); });
    (e.textMustNotMatch || []).forEach((p) => { if (new RegExp(p).test(txt)) problems.push('result text contains /' + p + '/'); });
  }
  if (s.copyCheck) {
    const c = s.copyCheck; const ct = topics[c.topic];
    if (!ct) problems.push('copyCheck: unknown topic');
    else {
      const blob = c.fields.map((f) => fieldText(ct, f)).join(' \n ');
      (c.mustNotMatch || []).forEach((p) => { if (blob.indexOf(p) !== -1) problems.push(`COPY contains stale phrase "${p}" in ${c.fields.join(',')}`); });
      (c.mustMatch || []).forEach((p) => { if (blob.indexOf(p) === -1) problems.push(`COPY lacks "${p}"`); });
    }
  }
  if (problems.length) bad++;
  rows.push({ s, problems });
});

const items = {};
rows.forEach(({ s, problems }) => {
  const k = s.item; items[k] = items[k] || { n: 0, bad: 0, roles: {} };
  items[k].n++; if (problems.length) items[k].bad++;
  const r = items[k].roles[s.role] = items[k].roles[s.role] || { n: 0, bad: 0 }; r.n++; if (problems.length) r.bad++;
  if (problems.length) console.log('FAIL ' + s.id + ' [item ' + s.item + ', ' + s.role + '] ' + s.title.slice(0, 90) + '\n      ' + problems.join('\n      '));
  else if (!quiet) console.log('ok   ' + s.id + ' [item ' + s.item + ', ' + s.role + ']');
});
console.log('\n' + (v4 ? 'BEFORE (v4 questionnaire, answersV4)' : 'AFTER (v5 questionnaire)') + ': ' + (rows.length - bad) + '/' + rows.length + ' passed');
Object.keys(items).sort().forEach((k) => console.log('  item ' + k + ': ' + (items[k].n - items[k].bad) + '/' + items[k].n + '   ' + Object.entries(items[k].roles).map(([r, v]) => r + ' ' + (v.n - v.bad) + '/' + v.n).join(', ')));
process.exit(bad ? 1 : 0);
