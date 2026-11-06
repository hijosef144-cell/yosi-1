// Runs representative family scenarios against a questionnaire file and compares with the expected outcome.
// Scenario files are written from the OFFICIAL rules (an independent oracle), not from the rule logic being tested.
// Usage: node scripts/run-scenarios.js <topics.json> <scenarios-dir-or-file> [--include-inactive] [--quiet]
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');

const [topicsFile, scnPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const includeInactive = process.argv.includes('--include-inactive');
const quiet = process.argv.includes('--quiet');
const topics = Object.fromEntries(JSON.parse(fs.readFileSync(topicsFile, 'utf8')).topics.map((t) => [t.id, t]));
const files = fs.statSync(scnPath).isDirectory() ? fs.readdirSync(scnPath).filter((f) => f.endsWith('.json')).map((f) => path.join(scnPath, f)) : [scnPath];

let total = 0, bad = 0; const byKind = {};
files.forEach((f) => {
  JSON.parse(fs.readFileSync(f, 'utf8')).forEach((s) => {
    total++; const t = topics[s.topic]; const problems = [];
    if (!t) problems.push('unknown topic ' + s.topic);
    else {
      if (!E.validateAnswers(t, s.answers)) problems.push('answers are not a valid complete path (' + JSON.stringify(s.answers) + ')');
      else {
        const r = E.evaluate(t, s.answers, { includeInactive });
        const ids = r.findings.map((x) => x.id);
        const e = s.expect || {};
        if (e.outcome && e.outcome !== r.outcome) problems.push(`outcome ${r.outcome} ≠ expected ${e.outcome}`);
        (e.mustInclude || []).forEach((id) => { if (ids.indexOf(id) === -1) problems.push('MISSING finding ' + id + ' (missed opportunity)'); });
        (e.mustNotInclude || []).forEach((id) => { if (ids.indexOf(id) !== -1) problems.push('FALSE ALARM ' + id); });
        if (e.exactFindings && JSON.stringify(e.exactFindings.slice().sort()) !== JSON.stringify(ids.slice().sort())) problems.push('findings [' + ids + '] ≠ exact [' + e.exactFindings + ']');
      }
    }
    const k = s.kind || 'other'; byKind[k] = byKind[k] || { n: 0, bad: 0 }; byKind[k].n++;
    if (problems.length) { bad++; byKind[k].bad++; console.log('✘ ' + s.topic + ' / ' + s.id + ' — ' + s.title + '\n    ' + problems.join('\n    ')); }
    else if (!quiet) console.log('✔ ' + s.topic + ' / ' + s.id + ' [' + k + '] ' + s.title);
  });
});
console.log(`\n${total} scenarios, ${total - bad} passed, ${bad} failed. By kind: ` + Object.entries(byKind).map(([k, v]) => `${k} ${v.n - v.bad}/${v.n}`).join(', '));
process.exit(bad ? 1 : 0);
