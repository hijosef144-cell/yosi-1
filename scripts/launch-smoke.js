// Post-deploy smoke test for Kaspchem. Safe to run against preview or production: read-only requests, plus ONE lead POST that is
// rejected before anything is written (gate closed, or - with --gate-open - an invalid phone). It never creates data.
// Usage: node scripts/launch-smoke.js <baseUrl> [--gate-open]
const CORE = ['lost-funds', 'tax-refunds', 'housing', 'mortgage', 'insurance-pension', 'payslip-rights', 'national-insurance', 'banking-loans', 'household', 'education-work'];

// The checks on the public config answer, as a pure function (so they can be tested without a network): [{ pass: true|false|null, msg }], pass null = information only.
// The ten core topics are required. The quick check ("quick", kind router) is OPTIONAL: a deployment that does not have it yet (an older preview) is fine and only
// gets an informational line; if it IS present its shape is validated (kind, questions, rules, and every finding.topic must be one of the ten).
function configChecks(cfg) {
  const out = [], topics = cfg && Array.isArray(cfg.topics) ? cfg.topics : null;
  if (!cfg || cfg.ok !== true || !topics) return [{ pass: false, msg: 'config API answers ok with a topics list' }];
  const ids = topics.map((t) => t.id);
  const missing = CORE.filter((id) => !ids.includes(id));
  out.push({ pass: missing.length === 0, msg: 'config API returns the ten core topics' + (missing.length ? ' (missing: ' + missing.join(', ') + ')' : '') });
  const q = topics.find((t) => t.id === 'quick');
  if (!q) out.push({ pass: null, msg: 'the quick check ("quick") is not in this deployment (fine for a build from before the quick check)' });
  else {
    const bad = [];
    if (q.kind !== 'router') bad.push('kind is not router');
    if (!Array.isArray(q.questions) || q.questions.length < 3) bad.push('no questions');
    if (!Array.isArray(q.rules) || !q.rules.length) bad.push('no rules');
    (q.rules || []).forEach((r) => { const t = r.finding && r.finding.topic; if (!CORE.includes(t)) bad.push('rule ' + r.id + ' points at "' + t + '", not one of the ten'); });
    out.push({ pass: bad.length === 0, msg: 'quick check is present and well-formed (router, questions, rules, every finding.topic among the ten)' + (bad.length ? ' -> ' + bad.slice(0, 3).join('; ') : '') });
  }
  out.push({ pass: topics.every((t) => Array.isArray(t.questions) && t.questions.length >= 3), msg: 'every topic has questions' });
  return out;
}
module.exports = { configChecks, CORE };
if (require.main !== module) return; // required by a test: only the pure checks above are exported

const base = (process.argv[2] || '').replace(/\/$/, '');
const gateOpen = process.argv.includes('--gate-open');
if (!/^https:\/\//.test(base)) { console.error('usage: node scripts/launch-smoke.js https://host [--gate-open]'); process.exit(2); }

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m + (extra && !c ? '  -> ' + extra : '')); };
const get = (p, o) => fetch(base + p, Object.assign({ redirect: 'manual' }, o));

(async () => {
  console.log('Smoke test: ' + base + (gateOpen ? '  (expecting the lead gate OPEN)' : '  (expecting the lead gate CLOSED)'));

  // public pages
  // /kaspchem/check/quick is the same shell page as every check page, so it is 200 whether or not this deployment has the quick check yet
  for (const p of ['/kaspchem/', '/kaspchem/check/mortgage', '/kaspchem/check/quick', '/kaspchem/privacy.html', '/kaspchem/terms.html', '/']) {
    const r = await get(p); ok(r.status === 200, `public page ${p} is 200`, r.status);
  }
  const r404 = await get('/kaspchem/check/does-not-exist'); ok(r404.status === 200, 'unknown topic page still renders a friendly message (200)');

  // config API: the ten core topics (required) and the quick check (optional, validated when present); no prices unless approved
  const cfg = await (await get('/api/kaspchem/config')).json().catch(() => ({}));
  configChecks(cfg).forEach((c) => { if (c.pass === null) console.log('INFO ' + c.msg); else ok(c.pass, c.msg); });
  ok(Array.isArray(cfg.prices || []) && (cfg.prices || []).every((x) => x && x.price != null), 'no price is published without a value');

  // lead gate
  const lead = await get('/api/kaspchem/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'mortgage', answers: {}, name: 'בדיקת עשן', phone: '123', consentContact: true }) });
  const lj = await lead.json().catch(() => ({}));
  if (gateOpen) ok(lj.error === 'bad_phone' || lj.error === 'bad_answers', 'lead endpoint is open and validates input (nothing stored)', JSON.stringify(lj).slice(0, 80));
  else ok(lead.status === 403 && lj.error === 'not_open', 'lead endpoint is CLOSED (not_open)', lead.status + ' ' + JSON.stringify(lj).slice(0, 80));

  // admin is locked
  for (const p of ['/api/kaspchem/admin/me', '/api/kaspchem/admin/requests', '/api/kaspchem/admin/settings', '/api/kaspchem/admin/audit']) {
    const r = await get(p); ok(r.status === 401, `admin API ${p} refuses an anonymous caller (401)`, r.status);
  }
  const csrf = await get('/api/kaspchem/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(csrf.status === 403, 'admin write without the CSRF header is refused (403)', csrf.status);
  const adm = await get('/admin/kaspchem/'); ok(adm.status === 200, 'admin sign-in page is served (200)', adm.status);

  // internal files are not public
  for (const p of ['/tests/backend.test.js', '/scripts/launch-smoke.js', '/package.json', '/netlify.toml', '/db/kaspchem-schema.sql', '/docs/research/REPORT.md', '/netlify/functions/kaspchem-lead.js', '/.git/config', '/node_modules/@netlify/identity/package.json']) {
    const r = await get(p); ok(r.status === 404, `internal file ${p} is not public (404)`, r.status);
  }

  // headers
  for (const p of ['/kaspchem/', '/admin/kaspchem/']) {
    const h = (await get(p)).headers; const csp = h.get('content-security-policy') || '';
    ok(/default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /script-src 'self'/.test(csp), `${p} has a strict Content-Security-Policy`, csp.slice(0, 60));
    ok(/nosniff/i.test(h.get('x-content-type-options') || ''), `${p} sets X-Content-Type-Options`);
    ok(/DENY|SAMEORIGIN/i.test(h.get('x-frame-options') || ''), `${p} sets X-Frame-Options`);
  }

  // identity: invite-only
  const id = await (await get('/.netlify/identity/settings')).json().catch(() => ({}));
  ok(id.disable_signup === true, 'Netlify Identity registration is invite-only (disable_signup)', JSON.stringify(id).slice(0, 80));

  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('smoke test crashed:', e.message); process.exit(2); });
