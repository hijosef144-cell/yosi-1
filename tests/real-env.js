// Real-environment smoke test against a Netlify Deploy Preview + the dedicated Neon DB. Test data only; cleans up after itself.
// Usage: BASE=https://deploy-preview-N--site.netlify.app KASPCHEM_DATABASE_URL=... node tests/real-env.js
const { neon } = require('@neondatabase/serverless');
const assert = require('node:assert');

const BASE = process.env.BASE;
const sql = neon(process.env.KASPCHEM_DATABASE_URL);
const post = (p, b, h) => fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const lead = (phone, over) => post('/api/kaspchem/lead', Object.assign({ topic: 'mortgage', answers: { has: 'yes', when: 'old', reviewed: 'no', know: 'yes' }, name: 'בדיקה אוטומטית', phone, consentContact: true, consentMarketing: false }, over || {}));

(async () => {
  const log = (m) => console.log('✔', m);
  await sql.query("DELETE FROM rate_limits");

  // 1. launch gate closed by default
  await sql.query("DELETE FROM settings WHERE key = 'public.legal_approved'");
  let r = await lead('0531230001');
  assert.equal(r.s, 403); assert.equal(r.j.error, 'not_open'); log('gate closed: lead refused (403 not_open)');

  // 2. open the gate (test DB only), real submission is stored with consents
  await sql.query("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', 'true', 'real-env-test') ON CONFLICT (key) DO UPDATE SET value = 'true'");
  r = await lead('0531230001', { outcome: 'none' });
  assert.equal(r.s, 200, JSON.stringify(r));
  const row = (await sql.query('SELECT r.outcome, r.findings, a.name, a.phone, (SELECT count(*)::int FROM consents c WHERE c.request_id = r.id) AS consents FROM treatment_requests r JOIN applicants a ON a.id = r.applicant_id WHERE r.id = $1', [r.j.ref]))[0];
  assert.equal(row.outcome, 'found'); assert.deepEqual(row.findings, ['mg-refi']); assert.equal(row.consents, 2);
  log('lead stored in Neon: outcome recomputed server-side, 2 consent rows');

  // 3. validation + spam protection on the real platform
  assert.equal((await lead('12')).j.error, 'bad_phone');
  assert.equal((await lead('0531230002', { consentContact: false })).j.error, 'consent_required');
  assert.equal((await lead('0531230002', { answers: { has: 'zzz' } })).j.error, 'bad_answers');
  const before = (await sql.query('SELECT count(*)::int n FROM treatment_requests'))[0].n;
  assert.equal((await lead('0531230003', { website: 'spam.example' })).s, 200);
  assert.equal((await sql.query('SELECT count(*)::int n FROM treatment_requests'))[0].n, before);
  log('validation errors and silent honeypot behave');

  // 4. rate limit (5/hour per IP) actually fires on Netlify, where the client IP comes from x-nf-client-connection-ip
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await lead('05312300' + (10 + i))).s);
  console.log('   statuses after the first accepted lead:', codes.join(','));
  assert.ok(codes.includes(429), 'rate limit never triggered');
  const hashes = (await sql.query('SELECT DISTINCT ip_hash FROM rate_limits')).length;
  assert.ok(hashes >= 1 && hashes <= 2, 'hash buckets: ' + hashes); // dual-stack clients may present two addresses
  log('rate limit returned 429; hashed buckets only (no raw IPs stored)');
  const raw = await sql.query("SELECT count(*)::int n FROM rate_limits WHERE ip_hash ~ '^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$'");
  assert.equal(raw[0].n, 0);

  // 5. admin API is closed to anonymous callers and to cross-site style calls
  assert.equal((await fetch(BASE + '/api/kaspchem/admin/requests')).status, 401);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' })).s, 403);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' }, { 'x-kaspchem': '1' })).s, 401);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' }, { 'x-kaspchem': '1', origin: 'https://evil.example' })).s, 403);
  for (const p of ['/requests', '/stats', '/pricing', '/settings', '/audit', '/questionnaires', '/services', '/professionals']) assert.equal((await fetch(BASE + '/api/kaspchem/admin' + p)).status, 401, p);
  log('admin API: 401 anonymous, 403 CSRF/foreign origin, on every sampled route');

  // 6. cleanup: remove test rows and CLOSE the gate again
  await sql.query("DELETE FROM revenues"); await sql.query("DELETE FROM treatment_requests"); await sql.query("DELETE FROM applicants"); await sql.query("DELETE FROM rate_limits");
  await sql.query("DELETE FROM settings WHERE key = 'public.legal_approved'");
  log('test data removed, gate closed again');
})().catch((e) => { console.error('✘', e.message); process.exit(1); });
