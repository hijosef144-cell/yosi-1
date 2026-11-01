// Post-deploy smoke test for Kaspchem. Safe to run against preview or production: read-only requests, plus ONE lead POST that is
// rejected before anything is written (gate closed, or - with --gate-open - an invalid phone). It never creates data.
// Usage: node scripts/launch-smoke.js <baseUrl> [--gate-open]
const base = (process.argv[2] || '').replace(/\/$/, '');
const gateOpen = process.argv.includes('--gate-open');
if (!/^https:\/\//.test(base)) { console.error('usage: node scripts/launch-smoke.js https://host [--gate-open]'); process.exit(2); }

let fails = 0;
const ok = (c, m, extra) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + m + (extra && !c ? '  -> ' + extra : '')); };
const get = (p, o) => fetch(base + p, Object.assign({ redirect: 'manual' }, o));

(async () => {
  console.log('Smoke test: ' + base + (gateOpen ? '  (expecting the lead gate OPEN)' : '  (expecting the lead gate CLOSED)'));

  // public pages
  for (const p of ['/kaspchem/', '/kaspchem/check/mortgage', '/kaspchem/privacy.html', '/kaspchem/terms.html', '/']) {
    const r = await get(p); ok(r.status === 200, `public page ${p} is 200`, r.status);
  }
  const r404 = await get('/kaspchem/check/does-not-exist'); ok(r404.status === 200, 'unknown topic page still renders a friendly message (200)');

  // config API: ten topics, no prices unless approved
  const cfg = await (await get('/api/kaspchem/config')).json().catch(() => ({}));
  ok(cfg.ok === true && Array.isArray(cfg.topics) && cfg.topics.length === 10, 'config API returns the ten topics', JSON.stringify(cfg).slice(0, 100));
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
