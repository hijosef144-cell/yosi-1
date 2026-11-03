'use strict';
// Stage 4: the quick check as a lead. Same endpoint, same table (treatment_requests), no new table: topic "quick", findings = the ids of the rules that fired.
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./dev-server');
const ops = require('../netlify/functions/_kaspchem/ops-alert');

let srv, base; const sent = [];
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
// an employee who rents, lost the job and never filed a tax report: tax, national insurance, housing, payslip rights
const ANSWERS = { work: 'employee', home: 'rent', housebenefit: 'no', events: ['job'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent', taxfile: 'no', payslip: 'yes' };
const lead = (over) => Object.assign({ topic: 'quick', answers: ANSWERS, name: 'דנה סודית', phone: '0503330001', email: 'dana@example.test', consentContact: true, consentMarketing: false }, over || {});

test.before(async () => { srv = await start(0); base = 'http://localhost:' + srv.server.address().port; ops.setSender(async (m) => { sent.push(m); }); });
test.after(async () => { ops.setSender(null); srv.server.close(); });

test('a quick-check lead is stored in the existing table with topic quick, the outcome and the ids of the rules that fired', async () => {
  const r = await call('POST', '/api/kaspchem/lead', lead());
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  const [row] = (await srv.pg.query('SELECT topic, outcome, findings, answers, consent_contact, consent_marketing FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
  assert.equal(row.topic, 'quick'); assert.equal(row.outcome, 'found');
  assert.deepEqual([...row.findings].sort(), ['q-hs-rent', 'q-ni-job', 'q-ps-ended', 'q-tx-nofile']);
  assert.deepEqual(row.answers.events, ['job']);
  assert.equal(row.consent_contact, true); assert.equal(row.consent_marketing, false);
  // no new table: the schema is untouched by this stage
  const tables = (await srv.pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((x) => x.table_name);
  assert.ok(!tables.some((t) => /quick/.test(t)));
});

test('the outcome comes from the server: whatever the browser claims is ignored, and answers that are not valid for the quick check are refused', async () => {
  const none = { work: 'employee', home: 'owned', housebenefit: 'yes', events: ['none'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent', taxfile: 'yes', payslip: 'yes' };
  const r = await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330002', answers: none, outcome: 'found', findings: ['q-lf-jobs'] }));
  assert.equal(r.status, 200);
  const [row] = (await srv.pg.query('SELECT outcome, findings FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
  assert.equal(row.outcome, 'none'); assert.deepEqual(row.findings, []);
  const bad = async (answers) => assert.equal((await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330003', answers }))).body.error, 'bad_answers');
  await bad(Object.assign({}, ANSWERS, { taxfile: 'maybe' }));
  await bad(Object.assign({}, ANSWERS, { events: ['job', 'none'] }));            // exclusive option combined with another
  await bad(Object.assign({}, ANSWERS, { events: 'job' }));                      // string for a multi-select
  await bad(Object.assign({}, ANSWERS, { work: 'retired' }));                    // taxfile/payslip are not asked of a retiree
  const missing = Object.assign({}, ANSWERS); delete missing.bank; await bad(missing);
});

test('the admin list names the topic "בדיקה מהירה", can filter on it, and the request shows which topics were recommended', async () => {
  const qs = (await call('GET', A + '/questionnaires', null, ADMIN)).body.topics;
  assert.equal(qs.find((t) => t.id === 'quick').name, 'בדיקה מהירה');
  const list = (await call('GET', A + '/requests?topic=quick', null, ADMIN)).body.requests;
  assert.ok(list.length >= 2); assert.ok(list.every((x) => x.topic === 'quick'));
  const id = list.find((x) => x.outcome === 'found').id;
  const d = (await call('GET', A + '/requests/' + id, null, ADMIN)).body.request;
  assert.deepEqual(d.findingTitles.slice().sort(), ['דיור וארנונה: הטבות לשוכרים', 'ביטוח לאומי: סיום עבודה', 'מסים והחזרים: דוח שנתי והחזר מס', 'תלושי שכר וזכויות עובדים: זכויות בסיום העסקה'].sort());
  assert.equal(d.findingDetails.length, 4);
  assert.ok(d.readable.some((x) => /פיטורים/.test(x.answer)), 'the answers are shown with their wording');
  const stats = (await call('GET', A + '/stats', null, ADMIN)).body;
  assert.ok(stats.byTopic.some((t) => t.topic === 'quick' && t.n >= 2));
});

test('the alert for a quick lead carries the topic name and request number, and no personal data or answers', async () => {
  sent.length = 0;
  const r = await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330004' }));
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1); assert.equal(sent[0].subject, 'כספכם: התקבלה פנייה חדשה');
  assert.ok(sent[0].text.includes('"בדיקה מהירה"') && sent[0].text.includes(String(r.body.ref)));
  assert.ok(!/דנה|סודית|0503330|dana@|פיטורים|rent|taxfile|q-tx|מסים/.test(sent[0].subject + sent[0].text), 'no name, phone, e-mail, answers or findings in the alert');
});

test('the lead gate still applies to the quick check (closed gate: not_open, nothing stored)', async () => {
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: false }, ADMIN);
  const before = (await srv.pg.query('SELECT count(*)::int AS n FROM treatment_requests')).rows[0].n;
  const r = await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330005' }));
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: true }, ADMIN);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_open');
  assert.equal((await srv.pg.query('SELECT count(*)::int AS n FROM treatment_requests')).rows[0].n, before);
});

test('public config: the quick check is served with its rules (the browser evaluates them with the shared engine), questions are those of the draft', async () => {
  const q = (await call('GET', '/api/kaspchem/config')).body.topics.find((t) => t.id === 'quick');
  assert.equal(q.kind, 'router'); assert.equal(q.questions.length, 10); assert.equal(q.rules.length, 25);
  assert.ok(q.rules.every((r) => r.finding.topic));
});

test('a lead with only needs-info items is stored with outcome "insufficient" and the needs-info rule ids; the dashboard marks them "(חסר מידע)"', async () => {
  const retiree = { work: 'retired', home: 'other', events: ['none'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent' };
  const r = await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330006', name: 'פורש בדיקה', answers: retiree }));
  assert.equal(r.status, 200);
  const [row] = (await srv.pg.query('SELECT outcome, findings FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
  assert.equal(row.outcome, 'insufficient'); assert.deepEqual(row.findings, ['q-ni-ret']);
  const d = (await call('GET', A + '/requests/' + r.body.ref, null, ADMIN)).body.request;
  assert.deepEqual(d.findingTitles, ['ביטוח לאומי: גיל פרישה (חסר מידע)']);
  // retiree + health: firm outcome, both rules stored (the retirement one is the flagged needs-info rule)
  const r2 = await call('POST', '/api/kaspchem/lead', lead({ phone: '0503330007', name: 'פורש חולה', answers: Object.assign({}, retiree, { events: ['health'] }) }));
  const [row2] = (await srv.pg.query('SELECT outcome, findings FROM treatment_requests WHERE id = $1', [r2.body.ref])).rows;
  assert.equal(row2.outcome, 'found'); assert.deepEqual([...row2.findings].sort(), ['q-ni-health', 'q-ni-ret']);
});
