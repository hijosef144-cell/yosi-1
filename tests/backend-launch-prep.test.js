'use strict';
// Launch-preparation mechanics: referral compensation blocked by default, access logging, export, applicant correction.
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./dev-server');

let srv, base;
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const lead = (over) => Object.assign({ topic: 'mortgage', answers: { has: 'yes', when: 'old', reviewed: 'no', know: 'yes' }, name: 'ישראל ישראלי', phone: '0501234567', email: '', consentContact: true, consentMarketing: false }, over || {});
const A = '/api/kaspchem/admin';

test.before(async () => {
  srv = await start(0); base = 'http://localhost:' + srv.server.address().port;
  await call('POST', '/api/kaspchem/lead', lead());
  await call('POST', '/api/kaspchem/lead', lead({ name: 'דינה לוי', phone: '0527654321', email: 'dina@example.test' }));
});
test.after(async () => { srv.server.close(); });

test('compensation: a referral fee is refused for every topic until that topic is explicitly enabled', async () => {
  const sv = await call('POST', A + '/services', { topic: 'insurance-pension', name: 'בדיקת ביטוח' }, ADMIN);
  const blocked = await call('POST', A + '/pricing', { label: 'עמלת הפניה', service_id: sv.body.id, commission: 120 }, ADMIN);
  assert.equal(blocked.status, 422); assert.equal(blocked.body.error, 'compensation_blocked');
  // no service at all: also refused
  assert.equal((await call('POST', A + '/pricing', { label: 'ללא שירות', commission: 5 }, ADMIN)).body.error, 'compensation_blocked');
  // a price with no commission, or a zero commission, is fine
  assert.equal((await call('POST', A + '/pricing', { label: 'מחיר בלבד', service_id: sv.body.id, price: 200 }, ADMIN)).status, 200);
  assert.equal((await call('POST', A + '/pricing', { label: 'עמלה אפס', service_id: sv.body.id, price: 200, commission: 0 }, ADMIN)).status, 200);
  // enabling a DIFFERENT topic does not unblock this one
  assert.equal((await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: ['mortgage'] }, ADMIN)).status, 200);
  assert.equal((await call('POST', A + '/pricing', { label: 'עדיין חסום', service_id: sv.body.id, commission: 120 }, ADMIN)).body.error, 'compensation_blocked');
  // enabling the topic (after written legal approval, in real life) allows it, and editing is checked the same way
  await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: ['insurance-pension'] }, ADMIN);
  const ok = await call('POST', A + '/pricing', { label: 'מאושר', service_id: sv.body.id, commission: 120 }, ADMIN);
  assert.equal(ok.status, 200);
  await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: [] }, ADMIN);
  assert.equal((await call('PATCH', A + '/pricing/' + ok.body.id, { label: 'מאושר', service_id: sv.body.id, commission: 130 }, ADMIN)).body.error, 'compensation_blocked');
  // the setting itself only accepts a list of topic ids
  assert.equal((await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: 'all' }, ADMIN)).body.error, 'bad_value');
  assert.equal((await call('PUT', A + '/settings', { key: 'private.compensation_topics', value: [{ x: 1 }] }, ADMIN)).body.error, 'bad_value');
});

test('access logging: viewing a request is recorded without personal data', async () => {
  const id = (await call('GET', A + '/requests', null, ADMIN)).body.requests[0].id;
  await call('GET', A + '/requests/' + id, null, ADMIN);
  const rows = (await srv.pg.query("SELECT actor, action, entity_id, detail FROM audit_log WHERE action = 'request.view' ORDER BY id DESC LIMIT 1")).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].actor, 'yosi@example.test'); assert.equal(String(rows[0].entity_id), String(id));
  assert.ok(!/ישראל|0501234567/.test(JSON.stringify(rows[0])));
});

test('export: returns the applicant\'s own data only, and logs the export without that data', async () => {
  const dina = (await srv.pg.query("SELECT id FROM applicants WHERE phone = '0527654321'")).rows[0].id;
  const r = await call('GET', `${A}/applicants/${dina}/export`, null, ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.applicant.name, 'דינה לוי');
  assert.equal(r.body.requests.length, 1); assert.equal(r.body.consents.length, 2);
  assert.ok(!JSON.stringify(r.body).includes('ישראל ישראלי') && !JSON.stringify(r.body).includes('0501234567'), 'another applicant must not appear');
  const a = (await srv.pg.query("SELECT detail FROM audit_log WHERE action = 'applicant.export' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.ok(a && !JSON.stringify(a.detail).includes('דינה'));
  assert.equal((await call('GET', `${A}/applicants/99999/export`, null, ADMIN)).status, 404);
  assert.equal((await call('GET', `${A}/applicants/${dina}/export`)).status, 401); // no login
});

test('correction: validated, refuses a phone that belongs to someone else, and logs only the field names', async () => {
  const dina = (await srv.pg.query("SELECT id FROM applicants WHERE phone = '0527654321'")).rows[0].id;
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { phone: '123' }, ADMIN)).body.error, 'bad_phone');
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { email: 'nope' }, ADMIN)).body.error, 'bad_email');
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, {}, ADMIN)).body.error, 'nothing_to_update');
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { phone: '050-123 4567' }, ADMIN)).body.error, 'phone_exists');
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { name: 'דינה כהן', email: '' }, ADMIN)).status, 200);
  const row = (await srv.pg.query('SELECT name, email FROM applicants WHERE id = $1', [dina])).rows[0];
  assert.equal(row.name, 'דינה כהן'); assert.equal(row.email, null);
  const log = (await srv.pg.query("SELECT detail FROM audit_log WHERE action = 'applicant.update' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.deepEqual(log.detail, { fields: ['name', 'email'] });
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { name: 'x' }, { 'x-kaspchem': '1' })).status, 401); // not logged in (and the CSRF header alone is not enough)
  assert.equal((await call('PATCH', `${A}/applicants/${dina}`, { name: 'x' })).status, 403); // no CSRF header
});

test('audit: listing requests, adding a note and discarding a draft are logged, without personal text', async () => {
  const id = (await call('GET', A + '/requests', null, ADMIN)).body.requests[0].id;
  await call('POST', `${A}/requests/${id}/notes`, { body: 'הערה פנימית סודית' }, ADMIN);
  await call('POST', A + '/questionnaires/household/discard', {}, ADMIN);
  const acts = (await srv.pg.query("SELECT action, detail FROM audit_log WHERE action IN ('request.list','note.create','questionnaire.discard')")).rows;
  assert.ok(['request.list', 'note.create', 'questionnaire.discard'].every((a) => acts.some((r) => r.action === a)), 'all three actions are logged');
  assert.ok(!JSON.stringify(acts).includes('סודית') && !JSON.stringify(acts).includes('0501234567'));
});
