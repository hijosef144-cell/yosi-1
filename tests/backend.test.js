'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./dev-server');

let srv, base;
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const goodLead = (over) => Object.assign({
  topic: 'mortgage', answers: { has: 'yes', when: 'old', reviewed: 'no', know: 'yes' },
  name: 'ישראל ישראלי', phone: '050-123 4567', email: '', consentContact: true, consentMarketing: false
}, over || {});

test.before(async () => { srv = await start(0); base = 'http://localhost:' + srv.server.address().port; });
test.after(async () => { srv.server.close(); });

test('public config serves 10 published topics', async () => {
  const r = await call('GET', '/api/kaspchem/config');
  assert.equal(r.body.topics.length, 10);
  assert.ok(r.body.topics.every((t) => t.questions.length >= 3));
});

test('lead: valid submission stores applicant, request, two consents; server recomputes outcome', async () => {
  const r = await call('POST', '/api/kaspchem/lead', goodLead({ outcome: 'none', claimedOutcome: 'none' }));
  assert.equal(r.status, 200);
  const [row] = (await srv.pg.query('SELECT outcome, findings, consent_marketing FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
  assert.equal(row.outcome, 'found');
  assert.deepEqual(row.findings, ['mg-refi']);
  const consents = (await srv.pg.query('SELECT kind, granted, text_version FROM consents WHERE request_id = $1 ORDER BY kind', [r.body.ref])).rows;
  assert.equal(consents.length, 2);
  assert.equal(consents[0].kind, 'contact'); assert.equal(consents[0].granted, true);
  assert.equal(consents[1].granted, false);
  const [a] = (await srv.pg.query('SELECT phone FROM applicants')).rows;
  assert.equal(a.phone, '0501234567');
});

test('lead: rejects missing consent, bad phone, bad answers, bad topic; honeypot is silent', async () => {
  assert.equal((await call('POST', '/api/kaspchem/lead', goodLead({ consentContact: false }))).body.error, 'consent_required');
  assert.equal((await call('POST', '/api/kaspchem/lead', goodLead({ phone: '123' }))).body.error, 'bad_phone');
  assert.equal((await call('POST', '/api/kaspchem/lead', goodLead({ answers: { has: 'yes', when: 'old' } }))).body.error, 'bad_answers');
  assert.equal((await call('POST', '/api/kaspchem/lead', goodLead({ answers: { has: 'bogus' } }))).body.error, 'bad_answers');
  assert.equal((await call('POST', '/api/kaspchem/lead', goodLead({ topic: 'nope' }))).body.error, 'bad_topic');
  const before = (await srv.pg.query('SELECT count(*)::int n FROM treatment_requests')).rows[0].n;
  const hp = await call('POST', '/api/kaspchem/lead', goodLead({ website: 'http://spam' }));
  assert.equal(hp.status, 200);
  assert.equal((await srv.pg.query('SELECT count(*)::int n FROM treatment_requests')).rows[0].n, before);
});

test('lead: closed until legal approval is switched on', async () => {
  await srv.pg.query("DELETE FROM settings WHERE key = 'public.legal_approved'");
  const r = await call('POST', '/api/kaspchem/lead', goodLead({ phone: '0539999999' }));
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_open');
  await srv.pg.query("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', 'true', 'test')");
});

test('lead: same phone reuses the applicant and never overwrites the name', async () => {
  await call('POST', '/api/kaspchem/lead', goodLead({ name: 'שם אחר לגמרי', topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' } }));
  const a = (await srv.pg.query("SELECT name FROM applicants WHERE phone = '0501234567'")).rows;
  assert.equal(a.length, 1); assert.equal(a[0].name, 'ישראל ישראלי');
});

test('admin: every endpoint demands auth + admin role + allow-listed email', async () => {
  for (const u of ['/me', '/requests', '/pricing', '/settings', '/audit', '/stats']) {
    assert.equal((await call('GET', '/api/kaspchem/admin' + u)).status, 401, u);
    process.env.KASPCHEM_REQUIRE_ROLE = '1';
    assert.equal((await call('GET', '/api/kaspchem/admin' + u, null, { 'x-test-user': 'yosi@example.test|', 'x-kaspchem': '1' })).status, 403, u + ' no role (role enforcement on)');
    delete process.env.KASPCHEM_REQUIRE_ROLE;
    assert.equal((await call('GET', '/api/kaspchem/admin' + u, null, { 'x-test-user': 'stranger@example.test|admin', 'x-kaspchem': '1' })).status, 403, u + ' not allow-listed');
    assert.equal((await call('GET', '/api/kaspchem/admin' + u, null, ADMIN)).status, 200, u + ' ok');
  }
  assert.equal((await call('POST', '/api/kaspchem/admin/services', { name: 'x' }, { 'x-kaspchem': '1' })).status, 401);
  // CSRF: a state-changing call without the custom header is refused even for a valid admin
  assert.equal((await call('POST', '/api/kaspchem/admin/services', { name: 'x' }, { 'x-test-user': 'yosi@example.test|admin' })).status, 403);
  // allow-list is mandatory and fails closed
  const saved = process.env.KASPCHEM_ADMIN_EMAILS; process.env.KASPCHEM_ADMIN_EMAILS = '';
  assert.equal((await call('GET', '/api/kaspchem/admin/me', null, ADMIN)).status, 403);
  process.env.KASPCHEM_ADMIN_EMAILS = saved;
});

test('admin: request lifecycle, notes, revenue approval gate', async () => {
  const list = await call('GET', '/api/kaspchem/admin/requests', null, ADMIN);
  const id = list.body.requests[0].id;
  const detail = await call('GET', '/api/kaspchem/admin/requests/' + id, null, ADMIN);
  assert.ok(detail.body.request.readable.length >= 1);
  assert.equal((await call('PATCH', '/api/kaspchem/admin/requests/' + id, { status: 'contacted', assignee: 'יוסי' }, ADMIN)).status, 200);
  assert.equal((await call('PATCH', '/api/kaspchem/admin/requests/' + id, { status: 'hax' }, ADMIN)).body.error, 'bad_status');
  await call('POST', `/api/kaspchem/admin/requests/${id}/notes`, { body: 'התקשרתי' }, ADMIN);
  await call('POST', `/api/kaspchem/admin/requests/${id}/revenues`, { amount: 100, cost: 30 }, ADMIN);
  let s = await call('GET', '/api/kaspchem/admin/stats', null, ADMIN);
  assert.equal(s.body.approved.revenue, 0); // pending revenue is not counted
  const rev = (await srv.pg.query('SELECT id FROM revenues')).rows[0].id;
  await call('POST', `/api/kaspchem/admin/revenues/${rev}/decide`, { status: 'approved' }, ADMIN);
  s = await call('GET', '/api/kaspchem/admin/stats', null, ADMIN);
  assert.equal(s.body.approved.profit, 70);
});

test('pricing: never public without approval; editing resets approval', async () => {
  const c = await call('POST', '/api/kaspchem/admin/pricing', { label: 'בדיקה', price: 250 }, ADMIN);
  await assert.rejects(srv.pg.query('UPDATE pricing SET public = true WHERE id = $1', [c.body.id])); // DB CHECK constraint
  assert.equal((await call('GET', '/api/kaspchem/config')).body.prices.length, 0);
  await call('POST', `/api/kaspchem/admin/pricing/${c.body.id}/approve`, { public: true }, ADMIN);
  assert.equal((await call('GET', '/api/kaspchem/config')).body.prices.length, 1);
  await call('PATCH', '/api/kaspchem/admin/pricing/' + c.body.id, { label: 'בדיקה', price: 300 }, ADMIN);
  assert.equal((await call('GET', '/api/kaspchem/config')).body.prices.length, 0);
});

test('questionnaire: draft is private, publish goes live, lint blocks bad content', async () => {
  const live = (await call('GET', '/api/kaspchem/admin/questionnaires/household', null, ADMIN)).body.live;
  const edited = JSON.parse(JSON.stringify(live)); edited.questions[0].text = 'נוסח חדש לבדיקה?';
  assert.equal((await call('PUT', '/api/kaspchem/admin/questionnaires/household/draft', { content: edited }, ADMIN)).status, 200);
  const pubText = async () => (await call('GET', '/api/kaspchem/config')).body.topics.find((t) => t.id === 'household').questions[0].text;
  assert.ok(!(await pubText()).includes('נוסח חדש'));
  assert.equal((await call('POST', '/api/kaspchem/admin/questionnaires/household/publish', {}, ADMIN)).body.ok, true);
  assert.ok((await pubText()).includes('נוסח חדש'));
  const broken = JSON.parse(JSON.stringify(live)); broken.rules[0].when = { q: 'ghost', in: ['x'] };
  await call('PUT', '/api/kaspchem/admin/questionnaires/household/draft', { content: broken }, ADMIN);
  const pub = await call('POST', '/api/kaspchem/admin/questionnaires/household/publish', {}, ADMIN);
  assert.equal(pub.body.ok, false); assert.ok(pub.body.errors.length);
  await call('POST', '/api/kaspchem/admin/questionnaires/household/discard', {}, ADMIN);
  const v = await call('GET', '/api/kaspchem/admin/questionnaires', null, ADMIN);
  const archived = v.body.topics.find((t) => t.id === 'household').versions;
  assert.equal(archived.length, 1);
});

test('lead: rate limit after 5 per hour', async () => {
  let last;
  for (let i = 0; i < 7; i++) last = await call('POST', '/api/kaspchem/lead', goodLead({ phone: '052-000 00' + (10 + i) }));
  assert.equal(last.status, 429);
});

test('erasure removes applicant and dependent rows', async () => {
  const a = (await srv.pg.query('SELECT id FROM applicants LIMIT 1')).rows[0].id;
  assert.equal((await call('POST', `/api/kaspchem/admin/applicants/${a}/erase`, {}, ADMIN)).body.error, 'confirmation_required');
  assert.equal((await call('POST', `/api/kaspchem/admin/applicants/${a}/erase`, { confirm: 'ERASE' }, ADMIN)).status, 200);
  assert.equal((await srv.pg.query('SELECT count(*)::int n FROM consents WHERE applicant_id = $1', [a])).rows[0].n, 0);
});
