'use strict';
// Operational and security alerts (to both owners) and the real health check. Alerts never carry personal data about applicants.
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./dev-server');
const db = require('../netlify/functions/_kaspchem/db');
const ops = require('../netlify/functions/_kaspchem/ops-alert');

let srv, base; const sent = [];
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const STRANGER = { 'x-test-user': 'stranger@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const lead = (over) => Object.assign({ topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: 'שירה סודית', phone: '0502220001', email: 'shira@example.test', consentContact: true }, over || {});
const subjects = () => sent.map((s) => s.subject);
const noPii = () => sent.every((s) => !/שירה|סודית|0502220|shira@/.test(s.subject + s.text));
const realDriver = (t, p) => srv.pg.query(t, p).then((r) => r.rows);

test.before(async () => {
  process.env.KASPCHEM_RATE_GLOBAL = '3'; process.env.KASPCHEM_RATE_MAX = '1000';
  srv = await start(0); base = 'http://localhost:' + srv.server.address().port;
  ops.setSender(async (m) => { sent.push(m); });
});
test.after(async () => { ops.setSender(null); delete process.env.KASPCHEM_RATE_GLOBAL; delete process.env.KASPCHEM_RATE_MAX; srv.server.close(); });

test('gate and compensation switch changes alert both owners (who, what), nothing else', async () => {
  sent.length = 0;
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: false }, ADMIN);
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: true }, ADMIN);
  await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: ['mortgage'] }, ADMIN);
  await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: [] }, ADMIN);
  await call('PUT', A + '/settings', { key: 'public.something_else', value: 1 }, ADMIN); // not a sensitive switch: no alert
  assert.deepEqual(subjects(), ['כספכם: שער קבלת הפניות נסגר', 'כספכם: שער קבלת הפניות נפתח', 'כספכם: שונתה הפעלת תגמול על הפניות לתחומים', 'כספכם: שונתה הפעלת תגמול על הפניות לתחומים']);
  assert.ok(sent[0].text.includes('yosi@example.test')); assert.ok(sent[2].text.includes('mortgage')); assert.ok(sent[3].text.includes('הכול חסום'));
});

test('publishing alerts without applicant data', async () => {
  sent.length = 0;
  const live = (await call('GET', A + '/questionnaires/household', null, ADMIN)).body.live;
  const edited = JSON.parse(JSON.stringify(live)); edited.questions[0].text = 'נוסח לבדיקת התראה?';
  await call('PUT', A + '/questionnaires/household/draft', { content: edited }, ADMIN);
  assert.equal((await call('POST', A + '/questionnaires/household/publish', {}, ADMIN)).body.ok, true);
  const r = await call('POST', '/api/kaspchem/lead', lead()); assert.equal(r.status, 200);
  assert.ok(subjects().includes('כספכם: פורסם שאלון'));
  assert.ok(noPii(), 'no name, phone or e-mail in any alert');
});

test('a signed-in user who is not an admin triggers an alert (without their address); an anonymous call does not', async () => {
  sent.length = 0;
  assert.equal((await call('GET', A + '/me', null, STRANGER)).status, 403);
  assert.equal((await call('GET', A + '/me')).status, 401);
  assert.deepEqual(subjects(), ['כספכם: ניסיון כניסה של משתמש לא מורשה']);
  assert.ok(!sent[0].text.includes('stranger@'));
});

test('a flood of different senders alerts once per hour, and the visitor is still refused politely', async () => {
  sent.length = 0;
  await srv.pg.query("DELETE FROM rate_limits");
  for (let i = 1; i <= 3; i++) assert.equal((await call('POST', '/api/kaspchem/lead', lead({ phone: '050222000' + (i + 1) }))).status, 200);
  const blocked = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220009' })); assert.equal(blocked.status, 429);
  const again = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220008' })); assert.equal(again.status, 429);
  assert.deepEqual(subjects().filter((x) => !/פנייה חדשה/.test(x)), ['כספכם: חריגה ממגבלת הפניות הכללית (חשד לספאם)']);
  assert.equal(subjects().filter((x) => /פנייה חדשה/.test(x)).length, 3, 'one alert per accepted lead, none for the refused ones');
  assert.ok(noPii());
});

test('an unexpected server error while taking a lead alerts, and the visitor gets the generic message', async () => {
  sent.length = 0;
  await srv.pg.query("DELETE FROM rate_limits");
  db.setDriver(async (t, p) => { if (/INSERT INTO applicants/.test(t)) throw new Error('simulated outage'); return realDriver(t, p); });
  const r = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220010' }));
  db.setDriver(realDriver);
  assert.equal(r.status, 500); assert.equal(r.body.error, 'server_error');
  assert.deepEqual(subjects(), ['כספכם: תקלה בקליטת פנייה']);
  assert.ok(noPii());
});

test('a failing mail transport never breaks the request that triggered the alert', async () => {
  ops.setSender(async () => { throw new Error('smtp down'); });
  const r = await call('PUT', A + '/settings', { key: 'public.legal_approved', value: true }, ADMIN);
  ops.setSender(async (m) => { sent.push(m); });
  assert.equal(r.status, 200);
});

test('health check really touches the database and returns no data', async () => {
  const ok = await call('GET', '/api/kaspchem/config?health=1');
  assert.equal(ok.status, 200); assert.deepEqual(ok.body, { ok: true });
  db.setDriver(async () => { throw new Error('db gone'); });
  const down = await call('GET', '/api/kaspchem/config?health=1');
  db.setDriver(realDriver);
  assert.equal(down.status, 503); assert.deepEqual(down.body, { ok: false });
  // the normal config call still falls back to the bundled questionnaires (so the public site keeps working); the health check is what exposes the outage
  assert.equal((await call('GET', '/api/kaspchem/config')).body.topics.length, 10);
});

test('every successfully received lead alerts once (request number and field only); refused leads do not', async () => {
  sent.length = 0;
  await srv.pg.query('DELETE FROM rate_limits');
  const bad = [lead({ phone: '123' }), lead({ consentContact: false }), lead({ website: 'http://spam' }), lead({ topic: 'nope' })];
  for (const b of bad) await call('POST', '/api/kaspchem/lead', b);
  assert.equal(sent.length, 0, 'validation failures, missing consent, honeypot and unknown topic send nothing');
  const ok = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220021' }));
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'כספכם: התקבלה פנייה חדשה');
  assert.ok(sent[0].text.includes('מספר פנייה ' + ok.body.ref), 'carries the request number');
  assert.ok(/בתחום "/.test(sent[0].text), 'carries the field of the check');
  assert.ok(noPii(), 'no name, phone, e-mail or answers');
  assert.ok(!/bills|old|answers/.test(sent[0].text));
});

test('the real mail path sends to EVERYONE in KASPCHEM_NOTIFY_EMAILS (both owners)', async () => {
  const nodemailer = require('nodemailer'); const realCreate = nodemailer.createTransport; const captured = [];
  const saved = { u: process.env.GMAIL_USER, p: process.env.GMAIL_APP_PASSWORD, n: process.env.KASPCHEM_NOTIFY_EMAILS };
  nodemailer.createTransport = () => ({ sendMail: async (o) => { captured.push(o); } });
  process.env.GMAIL_USER = 'sender@example.test'; process.env.GMAIL_APP_PASSWORD = 'not-a-real-password'; process.env.KASPCHEM_NOTIFY_EMAILS = 'owner-one@example.test,owner-two@example.test';
  ops.setSender(null); // use the real path (only the transport is faked)
  try {
    await srv.pg.query('DELETE FROM rate_limits');
    const ok = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220022' }));
    assert.equal(ok.status, 200);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].to.split(',').map((x) => x.trim()), ['owner-one@example.test', 'owner-two@example.test']);
    assert.equal(captured[0].subject, 'כספכם: התקבלה פנייה חדשה');
    assert.ok(!/שירה|סודית|0502220|shira@/.test(captured[0].subject + captured[0].text));
  } finally {
    nodemailer.createTransport = realCreate; ops.setSender(async (m) => { sent.push(m); });
    for (const [k, v] of [['GMAIL_USER', saved.u], ['GMAIL_APP_PASSWORD', saved.p], ['KASPCHEM_NOTIFY_EMAILS', saved.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('health answer exposes nothing but ok / not ok, with no caching, even when the failure message is revealing', async () => {
  db.setDriver(async () => { throw new Error('password authentication failed for user "secret_user" at ep-secret-host.neon.tech'); });
  const down = await fetch(base + '/api/kaspchem/config?health=1');
  db.setDriver(realDriver);
  const raw = await down.text();
  assert.equal(down.status, 503); assert.equal(raw, JSON.stringify({ ok: false }));
  assert.ok(!/secret|neon|password|postgres/i.test(raw + [...down.headers.values()].join(' ')));
  assert.match(down.headers.get('cache-control') || '', /no-store/);
  const ok = await fetch(base + '/api/kaspchem/config?health=1');
  assert.equal(await ok.text(), JSON.stringify({ ok: true }));
});

test('a lead is received and stored when the alert mail fails, and also when the mail server hangs (bounded wait)', async () => {
  await srv.pg.query('DELETE FROM rate_limits');
  ops.setSender(async () => { throw new Error('smtp down'); });
  const a = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220031' }));
  assert.equal(a.status, 200); assert.equal(a.body.ok, true);
  process.env.KASPCHEM_ALERT_TIMEOUT_MS = '300';
  ops.setSender(() => new Promise(() => {})); // never answers
  const t0 = Date.now();
  const b = await call('POST', '/api/kaspchem/lead', lead({ phone: '0502220032' }));
  const took = Date.now() - t0;
  delete process.env.KASPCHEM_ALERT_TIMEOUT_MS;
  ops.setSender(async (m) => { sent.push(m); });
  assert.equal(b.status, 200); assert.equal(b.body.ok, true);
  assert.ok(took < 3000, 'the visitor is not kept waiting for a stuck mail server (took ' + took + ' ms)');
  const rows = (await srv.pg.query("SELECT count(*)::int n FROM applicants WHERE phone IN ('0502220031','0502220032')")).rows[0].n;
  assert.equal(rows, 2, 'both leads were stored');
});
