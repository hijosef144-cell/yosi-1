'use strict';
// The EXISTING route PATCH /api/kaspchem/admin/services/{id}. Part 1 records how it behaves today (it passed on the code before the change and must keep passing, so the change is
// proved to be only the owner-approved block). Part 2 is the block: the name or the topic of a service tied to a price the public site shows cannot be changed, on the server, in SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./dev-server');

let srv, base;
const A = '/api/kaspchem/admin';
const OWNER = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' }, OWNER2 = { 'x-test-user': 'avi@example.test|admin', 'x-kaspchem': '1' };
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const svc = async (id) => (await srv.pg.query('SELECT id, name, topic, description, active FROM services WHERE id = $1', [id])).rows[0];
const audits = async (action) => (await srv.pg.query('SELECT actor, entity, entity_id FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

test.before(async () => { srv = await start(0); base = 'http://localhost:' + srv.server.address().port; });
test.after(async () => { srv.server.close(); await srv.pg.close(); });

test('PART 1 (how it behaves today): a full edit changes the four fields, answers {ok:true}, and writes one audit row; "active" stays true unless it is exactly false', async () => {
  const made = await call('POST', A + '/services', { topic: 'insurance-pension', name: 'שירות לעריכה', description: 'תיאור' }, OWNER); assert.equal(made.status, 200); const id = made.body.id;
  let r = await call('PATCH', A + '/services/' + id, { topic: 'mortgage', name: 'שם חדש', description: 'תיאור חדש', active: false }, OWNER); assert.deepEqual([r.status, r.body], [200, { ok: true }]);
  assert.deepEqual(await svc(id), { id: String(id) === String(id) ? (await svc(id)).id : null, name: 'שם חדש', topic: 'mortgage', description: 'תיאור חדש', active: false });
  r = await call('PATCH', A + '/services/' + id, { topic: '', name: 'שם חדש', description: '' }, OWNER2); assert.equal(r.status, 200);
  const row = await svc(id); assert.deepEqual([row.name, row.topic, row.description, row.active], ['שם חדש', null, null, true], 'empty topic/description become null; active defaults to true');
  r = await call('PATCH', A + '/services/' + id, { name: 'שם חדש', active: 'no' }, OWNER); assert.equal((await svc(id)).active, true, 'only the boolean false switches it off');
  assert.deepEqual((await audits('service.update')).map((a) => [a.actor, a.entity, a.entity_id]), [['yosi@example.test', 'service', String(id)], ['avi@example.test', 'service', String(id)], ['yosi@example.test', 'service', String(id)]]);
});

test('PART 1: validation, a missing id, and access are as they were: a bad name is 400, an id that does not exist still answers {ok:true} (and is audited), anonymous 401, outsider 403, no CSRF header 403', async () => {
  const id = (await call('POST', A + '/services', { name: 'שירות שלישי' }, OWNER)).body.id;
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(121) }, { name: 'ok', topic: 'x'.repeat(41) }, { name: 'ok', description: 'x'.repeat(601) }, { name: '<>' }]) { const r = await call('PATCH', A + '/services/' + id, body, OWNER); assert.deepEqual([r.status, r.body.error], [400, 'bad_text'], JSON.stringify(body)); }
  assert.equal((await svc(id)).name, 'שירות שלישי', 'nothing changed');
  const before = (await audits('service.update')).length; const missing = await call('PATCH', A + '/services/987654', { name: 'אין כזה' }, OWNER); assert.deepEqual([missing.status, missing.body], [200, { ok: true }]); assert.equal((await audits('service.update')).length, before + 1);
  assert.equal((await call('PATCH', A + '/services/' + id, { name: 'x' }, { 'x-kaspchem': '1' })).status, 401); assert.equal((await call('PATCH', A + '/services/' + id, { name: 'x' })).status, 403, 'the cross-site check comes first');
  assert.equal((await call('PATCH', A + '/services/' + id, { name: 'x' }, { 'x-test-user': 'stranger@example.test|admin', 'x-kaspchem': '1' })).status, 403);
  assert.equal((await call('PATCH', A + '/services/' + id, { name: 'x' }, { 'x-test-user': 'yosi@example.test|admin' })).status, 403);
  assert.equal((await call('PATCH', A + '/services/abc', { name: 'x' }, OWNER)).status, 404);
});

test('PART 1: the other service routes and the pricing routes are as they were (list, create, create price, approve, unpublish)', async () => {
  const id = (await call('POST', A + '/services', { topic: 'household', name: 'שירות למחיר' }, OWNER)).body.id;
  assert.ok((await call('GET', A + '/services', null, OWNER)).body.services.some((s) => String(s.id) === String(id)));
  const p = await call('POST', A + '/pricing', { service_id: id, label: 'מחיר', price: 500, cost: 100 }, OWNER); assert.equal(p.status, 200);
  assert.equal((await call('POST', A + '/pricing/' + p.body.id + '/approve', { public: true }, OWNER)).status, 200);
  assert.equal((await call('POST', A + '/pricing/' + p.body.id + '/unpublish', {}, OWNER)).status, 200);
  assert.deepEqual((await srv.pg.query('SELECT approved, public FROM pricing WHERE id = $1', [p.body.id])).rows, [{ approved: true, public: false }]);
});

// ---- PART 2: the owner-approved block ---------------------------------------------------------------------------------------------------------------------------------------------
async function publicService(topic, name) {
  const id = (await call('POST', A + '/services', { topic, name }, OWNER)).body.id;
  const p = await call('POST', A + '/pricing', { service_id: id, label: 'מחיר ציבורי', price: 700 }, OWNER);
  await call('POST', A + '/pricing/' + p.body.id + '/approve', { public: true }, OWNER);
  return { id, price: p.body.id };
}
const publicPrices = async () => JSON.parse((await require('../netlify/functions/kaspchem-config.js').handler({ httpMethod: 'GET', queryStringParameters: {} })).body).prices;

test('PART 2: a service tied to a public price cannot change its name or its topic (409), by the existing route, in SQL; nothing is written and nothing is audited; the public list is untouched', async () => {
  const { id } = await publicService('mortgage', 'שירות עם מחיר ציבורי'); const before = await svc(id), publicBefore = JSON.stringify(await publicPrices()), auditsBefore = (await audits('service.update')).length;
  assert.deepEqual((await publicPrices()).map((p) => p.topic), ['mortgage'], 'the public site groups the price by the topic of the service');
  for (const body of [{ topic: 'mortgage', name: 'שם אחר', description: before.description }, { topic: 'household', name: before.name }, { topic: 'household', name: 'שם אחר' }, { topic: '', name: before.name }, { name: before.name }]) {
    const r = await call('PATCH', A + '/services/' + id, body, OWNER2); assert.deepEqual([r.status, r.body.error], [409, 'service_has_public_price'], JSON.stringify(body)); assert.match(r.body.message, /מחיר שמוצג באתר/);
  }
  assert.deepEqual(await svc(id), before, 'the row is exactly as it was'); assert.equal(JSON.stringify(await publicPrices()), publicBefore); assert.equal((await audits('service.update')).length, auditsBefore, 'a refused edit writes no audit row');
});

test('PART 2: what is still allowed: the same name and topic with a new description or the active flag; any edit once the price is not public (not approved, approved but not public, or unpublished); and a service with no price at all', async () => {
  const { id, price } = await publicService('mortgage', 'שירות לעריכה חלקית'); const row = await svc(id);
  let r = await call('PATCH', A + '/services/' + id, { topic: 'mortgage', name: row.name, description: 'תיאור שונה', active: false }, OWNER); assert.deepEqual([r.status, (await svc(id)).description, (await svc(id)).active], [200, 'תיאור שונה', false], 'description and the active flag are free');
  assert.equal((await call('PATCH', A + '/services/' + id, { topic: 'mortgage', name: row.name }, OWNER)).status, 200, 'sending the same name and topic is not a change');
  await call('POST', A + '/pricing/' + price + '/unpublish', {}, OWNER); r = await call('PATCH', A + '/services/' + id, { topic: 'household', name: 'שם חדש אחרי הסרה' }, OWNER); assert.equal(r.status, 200, 'after unpublishing it can be edited'); assert.equal((await svc(id)).name, 'שם חדש אחרי הסרה');
  await call('POST', A + '/pricing/' + price + '/approve', { public: true }, OWNER); assert.equal((await call('PATCH', A + '/services/' + id, { topic: 'x', name: 'עוד שם' }, OWNER)).status, 409, 'published again: blocked again');
  await call('PATCH', A + '/pricing/' + price, { service_id: id, label: 'ערוך', price: 701 }, OWNER);   // editing a price resets its approval
  assert.equal((await call('PATCH', A + '/services/' + id, { topic: 'x', name: 'עוד שם' }, OWNER)).status, 200, 'an edited price loses its approval, so the service is free');
  const free = (await call('POST', A + '/services', { name: 'בלי מחיר' }, OWNER)).body.id; assert.equal((await call('PATCH', A + '/services/' + free, { name: 'בלי מחיר שונה', topic: 'a' }, OWNER)).status, 200);
  const approvedOnly = (await call('POST', A + '/services', { name: 'מאושר ולא ציבורי', topic: 'a' }, OWNER)).body.id; const q = await call('POST', A + '/pricing', { service_id: approvedOnly, label: 'x', price: 5 }, OWNER); await call('POST', A + '/pricing/' + q.body.id + '/approve', { public: false }, OWNER);
  assert.equal((await call('PATCH', A + '/services/' + approvedOnly, { name: 'שם אחר', topic: 'b' }, OWNER)).status, 200, 'approved but not public is not shown on the site');
});

test('PART 2: the rule is exactly the public site\'s own condition: a service is blocked if and only if the public configuration shows a price grouped under it; another service\'s price never unlocks or locks it', async () => {
  const a = await publicService('household', 'שירות א של המבחן'), b = await publicService('mortgage', 'שירות ב של המבחן'); const free = (await call('POST', A + '/services', { name: 'שירות חופשי של המבחן', topic: 'z' }, OWNER)).body.id;
  const shown = async () => new Set((await publicPrices()).map((p) => String(p.id)));
  const blockedBy = async (id) => (await call('PATCH', A + '/services/' + id, { name: 'שם-' + id + '-' + Math.random(), topic: 'zz' }, OWNER)).status === 409;
  for (const [svcId, priceId, expectBlocked] of [[a.id, a.price, true], [b.id, b.price, true], [free, null, false]]) { assert.equal(await blockedBy(svcId), expectBlocked, 'service ' + svcId); assert.equal(priceId === null ? false : (await shown()).has(String(priceId)), expectBlocked, 'the public site shows its price exactly when it is blocked'); }
  await call('POST', A + '/pricing/' + a.price + '/unpublish', {}, OWNER); assert.equal(await blockedBy(a.id), false); assert.equal((await shown()).has(String(a.price)), false); assert.equal(await blockedBy(b.id), true, 'b is unaffected by a');
  assert.equal((await srv.pg.query('SELECT count(*)::int AS n FROM pricing WHERE id = $1 AND approved AND public', [b.price])).rows[0].n, 1);
});

test('PART 2: a rename racing with a publication cannot slip through: the check is part of the UPDATE statement itself, not a separate read before it', async () => {
  const { id } = await publicService('mortgage', 'שירות למרוץ'); const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', '_kaspchem', 'admin-router.js'), 'utf8');
  const patch = sql.slice(sql.indexOf("on('PATCH', '/services/(\\\\d+)'"), sql.indexOf('// Professionals'));
  assert.match(patch, /serviceGuard\.allowsChange\(/); assert.match(patch, /UPDATE services s SET/); assert.match(patch, /WHERE s\.id = \$5 AND/);
  const before = await svc(id); await call('PATCH', A + '/services/' + id, { topic: 'other', name: 'x' }, OWNER); assert.deepEqual(await svc(id), before);
});
