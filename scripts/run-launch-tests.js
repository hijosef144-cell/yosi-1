// One command for the launch test suite: server + engine tests, the public browser tests, and (if present locally) the PRIVATE draft-questionnaire
// tests that live in the gitignored research folder. Prints a coverage summary with the REASON for every skipped test, and keeps the artifacts
// (traces) of any failing run in test-results-failed/ so a failure is never lost to the next run. It never hides a failure: any failure or any
// skip with an unexpected reason makes the exit code non-zero.
// Usage: node scripts/run-launch-tests.js [--repeat N]
const { spawnSync } = require('child_process');
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const repeat = Math.max(1, Number((process.argv.find((a) => /^--repeat=?/.test(a)) || '').split('=')[1]) || (process.argv.includes('--repeat') ? Number(process.argv[process.argv.indexOf('--repeat') + 1]) : 1));
const privateDir = path.join(root, 'docs', 'research', 'private-tests');
const allWidths = process.argv.includes('--all-widths'); // run the width-restricted specs at all four widths too (no skip is then expected)
const ALLOWED_SKIP = (allWidths ? [] : [/checked on desktop and one phone width/, /admin checked on desktop and one phone width/]).concat([/the private research folder is not linked/]); // the deep-check tests on the V6 draft need the local research folder; without it they skip with that reason
const sh = (cmd, args, opts) => spawnSync(cmd, args, Object.assign({ cwd: root, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, shell: process.platform === 'win32' }, opts || {}));

// Keeps the traces, screenshots and the JSON report of a failed browser run under test-results-failed/<time>-<label>, right away: the next browser run
// (private tests) empties test-results, which used to erase the public run's failure details.
function playwrightRun(label, configArgs) {
  const res = playwrightRunInner(label, configArgs);
  if (res.failed.length || res.crashed) {
    const dest = path.join(root, 'test-results-failed', new Date().toISOString().replace(/[:.]/g, '-') + '-' + label);
    try { fs.mkdirSync(dest, { recursive: true }); fs.cpSync(path.join(root, 'test-results'), dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'FAILED.txt'), res.failed.join('\n') + (res.crashText ? '\n' + res.crashText : '') + '\n'); res.keptIn = path.relative(root, dest); } catch (e) { res.keptIn = 'could not copy artifacts: ' + e.message; }
  }
  return res;
}
function playwrightRunInner(label, configArgs) {
  const out = path.join(root, 'test-results', 'json-' + label + '.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = sh('npx', ['--no-install', 'playwright', 'test', ...configArgs, '--workers=1', '--retries=0', '--reporter=json'], { env: Object.assign({}, process.env, { PLAYWRIGHT_JSON_OUTPUT_NAME: out }, allWidths ? { ALL_WIDTHS: '1' } : {}) });
  let j = null; try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (e) { try { j = JSON.parse(r.stdout); } catch (e2) {} }
  const res = { label, passed: 0, failed: [], skipped: {}, crashed: !j };
  if (!j) { res.crashText = (r.stderr || r.stdout || '').slice(-400); return res; }
  (function walk(suites) { (suites || []).forEach((s) => { walk(s.suites); (s.specs || []).forEach((sp) => (sp.tests || []).forEach((t) => {
    const last = (t.results || [])[(t.results || []).length - 1] || {}; const st = t.status === 'skipped' || last.status === 'skipped' ? 'skipped' : (t.status === 'expected' ? 'passed' : 'failed');
    if (st === 'passed') res.passed++;
    else if (st === 'skipped') { const why = ((t.annotations || []).find((a) => a.type === 'skip') || {}).description || 'no reason recorded'; res.skipped[why] = (res.skipped[why] || 0) + 1; }
    else res.failed.push(`[${t.projectName}] ${sp.title}`.slice(0, 200));
  })); }); })(j.suites);
  return res;
}

let exit = 0;
for (let n = 1; n <= repeat; n++) {
  console.log(`\n=== run ${n}/${repeat}  ${new Date().toISOString()} ===`);
  const u = sh('node', ['--test', '--test-concurrency=1', 'tests/backend.test.js', 'tests/backend-launch-prep.test.js', 'tests/backend-ops-alerts.test.js', 'tests/backend-impact.test.js', 'tests/engine.test.js', 'tests/engine-identity.test.js', 'tests/engine-quick.test.js', 'tests/quick-alignment.test.js', 'tests/backend-quick.test.js', 'tests/engine-deep.test.js', 'tests/deep-alignment.test.js', 'tests/backend-deep.test.js', 'tests/routes.test.js', 'tests/published-content.test.js', 'tests/selfhelp.test.js', 'tests/migrate.test.js', 'tests/grants.test.js', 'tests/grants-apply.test.js', 'tests/launch-smoke.test.js']);
  const pass = Number((/ℹ pass (\d+)/.exec(u.stdout) || [])[1] || 0), fail = Number((/ℹ fail (\d+)/.exec(u.stdout) || [])[1] || 0);
  console.log(`server + engine tests: ${pass} passed, ${fail} failed`);
  const results = [playwrightRun('public', [])];
  if (fs.existsSync(privateDir)) results.push(playwrightRun('private', ['-c', 'playwright.private.config.js'])); else console.log('private draft tests: NOT RUN (no local research folder in this checkout; link docs/research to run them)');
  let bad = fail > 0 || u.status !== 0;
  for (const r of results) {
    const sk = Object.entries(r.skipped); const skTotal = sk.reduce((s, [, c]) => s + c, 0);
    console.log(`browser tests (${r.label}): ${r.passed} passed, ${r.failed.length} failed, ${skTotal} skipped${r.crashed ? '  (RUNNER CRASHED)' : ''}`);
    sk.forEach(([why, c]) => { const ok = ALLOWED_SKIP.some((re) => re.test(why)); console.log(`   skipped ${c}: ${why}${ok ? '  (by design)' : '  <-- UNEXPECTED REASON'}`); if (!ok) bad = true; });
    r.failed.forEach((f) => console.log('   FAILED ' + f));
    if (r.keptIn) console.log('   failure details (trace, screenshot, report) kept in ' + r.keptIn);
    if (r.failed.length || r.crashed) { bad = true; if (r.crashText) console.log('   ' + r.crashText.replace(/\n/g, ' ')); }
  }
  if (bad) {
    const dest = path.join(root, 'test-results-failed', new Date().toISOString().replace(/[:.]/g, '-') + '-run' + n);
    try { fs.mkdirSync(dest, { recursive: true }); fs.cpSync(path.join(root, 'test-results'), dest, { recursive: true }); console.log('artifacts (traces) kept in ' + path.relative(root, dest)); } catch (e) { console.log('could not copy artifacts: ' + e.message); }
    exit = 1;
  }
}
console.log(exit ? '\nRESULT: FAILURES OR UNEXPECTED SKIPS (see above)' : '\nRESULT: ALL PASSED, every skip has an expected reason');
process.exit(exit);
