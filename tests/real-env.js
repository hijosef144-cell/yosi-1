// Real-environment smoke test: a Netlify Deploy Preview + the ISOLATED Neon "test" branch. Test data only.
//
//   BASE=https://deploy-preview-N--site.netlify.app KASPCHEM_DATABASE_URL=<test-branch url> node tests/real-env.js
//
// Safety rails (every one aborts BEFORE anything is written):
//   1. BASE must be a deploy preview / branch deploy / localhost — never the production domain.
//   2. The database must carry the marker  settings['meta.environment'] = "test"  (production carries "production").
//   3. The database must contain no data other than rows this test itself creates (phones 0531230xxx).
// Cleanup deletes only the rows this test created (by its own phone prefix) and rate-limit rows created during the run.
// The launch gate is restored to its ORIGINAL state in a finally block and on SIGINT/SIGTERM, then verified.
const { neon } = require('@neondatabase/serverless');
const assert = require('node:assert');

const BASE = process.env.BASE;
const URL_DB = process.env.KASPCHEM_DATABASE_URL;
const PREFIX = '0531230'; // every phone this test uses starts with this
const startedAt = new Date().toISOString();

function refuse(msg) { console.error('✘ REFUSING TO RUN: ' + msg); process.exit(3); }

if (!BASE || !URL_DB) refuse('set BASE and KASPCHEM_DATABASE_URL');
const host = new URL(BASE).hostname;
if (!(/^deploy-preview-\d+--/.test(host) || /^[a-z0-9-]+--[a-z0-9-]+\.netlify\.app$/.test(host) || host === 'localhost')) refuse('BASE is not a deploy preview / branch deploy / localhost: ' + host);
if (/^(www\.)?matzpenkalkali\.com$/.test(host) || host === 'main--matzpenkalkali.netlify.app') refuse('BASE is the production site');

const sql = neon(URL_DB);
const post = (p, b, h) => fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, h || {}), body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const lead = (phone, over) => post('/api/kaspchem/lead', Object.assign({ topic: 'mortgage', answers: { has: 'yes', when: 'old', reviewed: 'no', know: 'yes' }, name: 'בדיקה אוטומטית', phone, consentContact: true, consentMarketing: false }, over || {}));
const log = (m) => console.log('✔', m);

let gateBefore; // undefined = row absent
let gateTouched = false;

async function restoreGate() {
  if (!gateTouched) return;
  if (gateBefore === undefined) await sql.query("DELETE FROM settings WHERE key = 'public.legal_approved'");
  else await sql.query("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', $1::jsonb, 'real-env-test') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(gateBefore)]);
  const now = (await sql.query("SELECT value FROM settings WHERE key = 'public.legal_approved'"))[0];
  assert.deepEqual(now ? now.value : undefined, gateBefore, 'launch gate not restored');
  gateTouched = false;
}

// Only rows created by this test: applicants with our phone prefix (+ dependents), and rate-limit rows written since start.
async function cleanup() {
  const ids = (await sql.query('SELECT id FROM applicants WHERE phone LIKE $1', [PREFIX + '%'])).map((r) => r.id);
  if (ids.length) {
    await sql.query('DELETE FROM revenues WHERE request_id IN (SELECT id FROM treatment_requests WHERE applicant_id = ANY($1::bigint[]))', [ids]);
    await sql.query('DELETE FROM request_notes WHERE request_id IN (SELECT id FROM treatment_requests WHERE applicant_id = ANY($1::bigint[]))', [ids]);
    await sql.query('DELETE FROM consents WHERE applicant_id = ANY($1::bigint[])', [ids]);
    await sql.query('DELETE FROM treatment_requests WHERE applicant_id = ANY($1::bigint[])', [ids]);
    await sql.query('DELETE FROM applicants WHERE id = ANY($1::bigint[])', [ids]);
  }
  await sql.query('DELETE FROM rate_limits WHERE hit_at >= $1::timestamptz', [startedAt]);
}

async function main() {
  // ---- guards ----
  const env = (await sql.query("SELECT value FROM settings WHERE key = 'meta.environment'"))[0];
  if (!env || env.value !== 'test') refuse('database is not marked as a test database (settings meta.environment = "test"); found: ' + JSON.stringify(env && env.value));
  const foreign = (await sql.query('SELECT count(*)::int n FROM applicants WHERE phone NOT LIKE $1', [PREFIX + '%']))[0].n;
  if (foreign) refuse(foreign + ' applicant(s) exist that this test did not create');
  const stale = (await sql.query('SELECT count(*)::int n FROM rate_limits WHERE hit_at < now() - interval \'1 day\''))[0].n; void stale;
  log('guards passed: preview host ' + host + ', database marked "test", no foreign data');

  const g = (await sql.query("SELECT value FROM settings WHERE key = 'public.legal_approved'"))[0];
  gateBefore = g ? g.value : undefined;
  await cleanup(); // leftovers of an earlier aborted run of THIS test

  // 1. gate closed (as shipped) → refused
  gateTouched = true;
  await sql.query("DELETE FROM settings WHERE key = 'public.legal_approved'");
  let r = await lead(PREFIX + '001');
  assert.equal(r.s, 403); assert.equal(r.j.error, 'not_open'); log('gate closed: lead refused (403 not_open)');

  // 2. gate temporarily open (test database only)
  await sql.query("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', 'true', 'real-env-test') ON CONFLICT (key) DO UPDATE SET value = 'true'");
  r = await lead(PREFIX + '001', { outcome: 'none' });
  assert.equal(r.s, 200, JSON.stringify(r));
  const row = (await sql.query('SELECT r.outcome, r.findings, (SELECT count(*)::int FROM consents c WHERE c.request_id = r.id) AS consents FROM treatment_requests r WHERE r.id = $1', [r.j.ref]))[0];
  assert.equal(row.outcome, 'found'); assert.deepEqual(row.findings, ['mg-refi']); assert.equal(row.consents, 2);
  log('lead stored: outcome recomputed server-side, 2 consent rows');

  // 3. validation + spam protection
  assert.equal((await lead('12')).j.error, 'bad_phone');
  assert.equal((await lead(PREFIX + '002', { consentContact: false })).j.error, 'consent_required');
  assert.equal((await lead(PREFIX + '002', { answers: { has: 'zzz' } })).j.error, 'bad_answers');
  const before = (await sql.query('SELECT count(*)::int n FROM treatment_requests'))[0].n;
  assert.equal((await lead(PREFIX + '003', { website: 'spam.example' })).s, 200);
  assert.equal((await sql.query('SELECT count(*)::int n FROM treatment_requests'))[0].n, before);
  log('validation errors and silent honeypot behave');

  // 4. rate limit on the real platform (client IP comes from x-nf-client-connection-ip)
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await lead(PREFIX + '01' + i)).s);
  console.log('   statuses:', codes.join(','));
  assert.ok(codes.includes(429), 'rate limit never triggered');
  const hashes = (await sql.query('SELECT DISTINCT ip_hash FROM rate_limits WHERE hit_at >= $1::timestamptz', [startedAt]));
  assert.ok(hashes.length >= 1 && hashes.length <= 2);
  assert.equal((await sql.query("SELECT count(*)::int n FROM rate_limits WHERE ip_hash ~ '^[0-9.]+$'"))[0].n, 0);
  log('rate limit returned 429; only hashed buckets stored');

  // 5. admin API closed to anonymous / cross-site callers
  assert.equal((await fetch(BASE + '/api/kaspchem/admin/requests')).status, 401);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' })).s, 403);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' }, { 'x-kaspchem': '1' })).s, 401);
  assert.equal((await post('/api/kaspchem/admin/services', { name: 'x' }, { 'x-kaspchem': '1', origin: 'https://evil.example' })).s, 403);
  for (const p of ['/requests', '/stats', '/pricing', '/settings', '/audit', '/questionnaires', '/services', '/professionals']) assert.equal((await fetch(BASE + '/api/kaspchem/admin' + p)).status, 401, p);
  log('admin API: 401 anonymous, 403 CSRF/foreign origin');

  // 6. internal files are not publicly served
  for (const p of ['/tests/real-env.js', '/scripts/kaspchem-migrate.js', '/db/kaspchem-schema.sql', '/docs/KASPCHEM.md', '/package.json', '/package-lock.json', '/netlify.toml', '/playwright.config.js', '/netlify/functions/kaspchem-lead.js', '/node_modules/nodemailer/package.json'])
    assert.equal((await fetch(BASE + p)).status, 404, p + ' is publicly reachable');
  log('internal scripts, tests, config and sources return 404');
}

let exiting = false;
async function finish(code) {
  if (exiting) return; exiting = true;
  try { await cleanup(); log('test rows removed (only rows created by this test)'); } catch (e) { console.error('cleanup failed:', e.message); code = code || 1; }
  try { await restoreGate(); log('launch gate restored to its original state and verified'); } catch (e) { console.error('✘ GATE RESTORE FAILED:', e.message); code = 1; }
  process.exit(code);
}
process.on('SIGINT', () => finish(130)); process.on('SIGTERM', () => finish(143));
main().then(() => finish(0)).catch((e) => { console.error('✘', e.message); finish(1); });
