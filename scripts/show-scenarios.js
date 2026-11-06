// Prints, for each scenario, the engine's outcome and finding titles next to the author's expectation (concept strings), for human review.
// Usage: node scripts/show-scenarios.js <topics.json> <scenarios.json> [--include-inactive]
const fs = require('fs'); const E = require('../kaspchem/assets/engine.js');
const [tf, sf] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const topics = Object.fromEntries(JSON.parse(fs.readFileSync(tf, 'utf8')).topics.map((t) => [t.id, t]));
JSON.parse(fs.readFileSync(sf, 'utf8')).forEach((s) => {
  const t = topics[s.topic]; const ok = t && E.validateAnswers(t, s.answers);
  console.log(`\n[${s.topic}/${s.id}] (${s.kind}) ${s.title}`);
  if (!ok) { console.log('  !! answers are not a valid complete path for the current questionnaire'); return; }
  const r = E.evaluate(t, s.answers, { includeInactive: process.argv.includes('--include-inactive') });
  console.log('  expected: ' + (s.expect && s.expect.outcome) + ' | ' + JSON.stringify((s.expect && s.expect.concepts) || []));
  console.log('  actual  : ' + r.outcome + ' | ' + r.findings.map((f) => f.id + ' «' + f.title + '»').join(' ; '));
});
