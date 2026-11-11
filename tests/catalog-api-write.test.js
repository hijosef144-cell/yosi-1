'use strict';
// Catalog server, stage 4b, WRITE routes for services, providers, engagements, price layers and the lifecycle. In-memory Postgres (PGlite) with the real tables and the real grants, running as
// kaspchem_app; synthetic data; no network. The import has its own file (catalog-api-import.test.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, closeAll, YOSI, AVI, STRANGER } = require('./fixtures/catalog-world.js');
const router = require('../netlify/functions/_kaspchem/admin-catalog-router.js');
const store = require('../netlify/functions/_kaspchem/catalog-store.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const PATH = (m, p, who, b, w) => w.call(m, p, who, j(b));

test('permissions: every write route refuses the anonymous caller (401), an outsider (403), a missing cross-site header (403) and a closed switch (403, same answer for every route); both administrators are equal when it is open', async () => {
  const w = await world(); const DATA = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'audit_log'], before = await w.fingerprint(DATA);
  for (const r of router.WRITE_ROUTES) {
    const s = r.sample;
    for (const who of [YOSI, AVI]) { const x = await w.call(r.method, s.path, who, j(s.body)); assert.deepEqual([x.status, x.body.error], [403, 'catalog_disabled'], r.name + ' closed ' + who); }
    assert.equal((await w.call(r.method, s.path, null, j(s.body))).status, 401, r.name + ' anonymous');
    assert.equal((await w.call(r.method, s.path, null, { body: s.body, noCsrf: true })).status, 403, r.name + ' anonymous without the header');
    const out = await w.call(r.method, s.path, STRANGER, j(s.body)); assert.deepEqual([out.status, out.body.error], [403, 'forbidden'], r.name + ' outsider');
    const csrf = await w.call(r.method, s.path, YOSI, { body: s.body, noCsrf: true }); assert.deepEqual([csrf.status, csrf.body.error], [403, 'csrf'], r.name + ' cross-site');
  }
  assert.deepEqual(await w.fingerprint(DATA), before, 'nothing changed while closed');
  for (const v of [false, 'true', 1, null, {}]) { await w.setSetting('private.catalog_enabled', v); for (const r of router.WRITE_ROUTES) assert.equal((await w.call(r.method, r.sample.path, YOSI, j(r.sample.body))).body.error, 'catalog_disabled', r.name + ' ' + JSON.stringify(v)); }
  assert.deepEqual(await w.fingerprint(DATA), before);
  await w.open();
  for (const r of router.WRITE_ROUTES) for (const who of [YOSI, AVI]) { const x = await w.call(r.method, r.sample.path, who, j(r.sample.body)); assert.ok(![401, 403, 503].includes(x.status), r.name + ' ' + who + ' got ' + x.status + ' ' + x.body.error); }
  await w.pg.close();
});

test('services: create (starts switched off, duplicate names are a question), update with compare-and-set (a stale edit changes nothing, not even its other fields), one audit row per change', async () => {
  const w = await world(); await w.open();
  let r = await PATH('POST', '/catalog/services', YOSI, { name: '  שירות   חדש  ', topic: 'ביטוח', description: 'תיאור' }, w); assert.equal(r.status, 200); const id = r.body.id; assert.ok(id > 1000);
  assert.deepEqual((await w.owner('SELECT name, topic, active FROM services WHERE id = $1', [id]))[0], { name: 'שירות חדש', topic: 'ביטוח', active: false });
  r = await PATH('POST', '/catalog/services', AVI, { name: 'שירות חדש' }, w); assert.deepEqual([r.status, r.body.error], [409, 'similar_service_exists']); assert.match(r.body.message, /allow_duplicate/);
  assert.equal((await PATH('POST', '/catalog/services', AVI, { name: 'שירות חדש', allow_duplicate: true }, w)).status, 200, 'the owner can say "yes, a second one"');
  for (const [body, code] of [[{}, 'bad_name'], [{ name: '' }, 'bad_name'], [{ name: 'x'.repeat(121) }, 'bad_name'], [{ name: 'ok', topic: 'x'.repeat(41) }, 'bad_topic'], [{ name: 'ok', active: true }, 'unknown_field'], [{ name: 'ok', id: 5 }, 'unknown_field'], ['x', 'bad_body'], [[], 'bad_body']]) { r = await PATH('POST', '/catalog/services', YOSI, body, w); assert.deepEqual([r.status, r.body.error], [400, code], JSON.stringify(body)); }
  const upd = (id2, changes, expected, who) => PATH('PATCH', '/catalog/services/' + id2, who || YOSI, { changes, expected }, w);
  assert.equal((await upd(13, { description: 'א' }, { description: null })).status, 200); assert.equal((await w.owner('SELECT description FROM services WHERE id = 13'))[0].description, 'א');
  r = await upd(13, { description: 'ב' }, { description: null }); assert.deepEqual([r.status, r.body.error], [409, 'conflict']); assert.equal((await w.owner('SELECT description FROM services WHERE id = 13'))[0].description, 'א', 'the stale edit changed nothing');
  r = await upd(13, { name: 'שם חדש', description: 'ג' }, { name: 'לא זה', description: 'א' }); assert.equal(r.status, 409); assert.deepEqual((await w.owner('SELECT name, description FROM services WHERE id = 13'))[0], { name: 'הגשת ערר ארנונה', description: 'א' }, 'one stale field stops the whole edit');
  assert.equal((await upd(13, { active: false }, { active: true }, AVI)).status, 200); assert.equal((await w.owner('SELECT active FROM services WHERE id = 13'))[0].active, false);
  for (const [changes, expected, code] of [[{ description: 'x' }, {}, 'expected_required'], [{}, {}, 'nothing_to_change'], [{ foo: 1 }, { foo: 1 }, 'unknown_field'], [{ name: '' }, { name: 'x' }, 'bad_name'], [{ active: 'yes' }, { active: true }, 'bad_active'], [{ id: 5 }, { id: 5 }, 'unknown_field']]) { r = await upd(13, changes, expected); assert.deepEqual([r.status, r.body.error], [400, code], JSON.stringify(changes)); }
  r = await upd(999, { description: 'x' }, { description: null }); assert.deepEqual([r.status, r.body.error], [404, 'not_found']);
  const rows = await w.audits("action LIKE 'catalog.service.%'"); assert.deepEqual(rows.map((x) => x.action), ['catalog.service.create', 'catalog.service.create', 'catalog.service.update', 'catalog.service.update'], 'one row per successful change, none for a refused one');
  assert.deepEqual(rows[3].detail, { fields: ['active'], from: { active: true }, to: { active: false } }); assert.deepEqual(rows[3].actor, AVI); await w.pg.close();
});

test('OWNER DECISION, catalog route: the name or topic of a service tied to a public price cannot change (409, nothing written, nothing audited); description and the active flag stay free; unpublish unlocks it; the old route gives the same answer on the same database', async () => {
  const w = await world(); await w.open(); await w.owner('UPDATE pricing SET public = true WHERE id = 7');   // price 7 belongs to service 11 and is now shown on the public site
  assert.deepEqual((await w.publicPrices()).map((p) => p.topic), ['מיסים'], 'the public site groups price 7 under the topic of service 11');
  const before = await w.fingerprint(), pub = JSON.stringify(await w.publicPrices());
  const upd = (changes, expected) => PATCH_SERVICE(w, 11, changes, expected);
  for (const [changes, expected] of [[{ name: 'שם אחר' }, { name: 'בדיקת זכאות להחזר מס' }], [{ topic: 'פנסיה' }, { topic: 'מיסים' }], [{ topic: null }, { topic: 'מיסים' }], [{ name: 'שם אחר', topic: 'פנסיה' }, { name: 'בדיקת זכאות להחזר מס', topic: 'מיסים' }], [{ name: 'שם אחר', description: 'x' }, { name: 'בדיקת זכאות להחזר מס', description: 'בדיקה של החזרי מס לשכירים' }]]) {
    const r = await upd(changes, expected); assert.deepEqual([r.status, r.body.error], [409, 'service_has_public_price'], JSON.stringify(changes)); assert.match(r.body.message, /מחיר שמוצג באתר/);
  }
  assert.deepEqual(await w.fingerprint(), before, 'not one field of the refused edits was written'); assert.equal(JSON.stringify(await w.publicPrices()), pub);
  assert.equal((await upd({ description: 'תיאור חדש' }, { description: 'בדיקה של החזרי מס לשכירים' })).status, 200, 'a description is free');
  assert.equal((await upd({ active: false }, { active: true })).status, 200, 'the active flag is free');
  assert.equal((await upd({ name: 'בדיקת זכאות להחזר מס', topic: 'מיסים' }, { name: 'בדיקת זכאות להחזר מס', topic: 'מיסים' })).status, 200, 'saying the same name and topic is not a change');
  const OLD_BODY = j({ topic: 'פנסיה', name: 'בדיקת זכאות להחזר מס' });
  const old = await w.call('PATCH', '/services/11', YOSI, OLD_BODY); assert.deepEqual([old.status, old.body.error], [409, 'managed_in_catalog'], 'with the catalog open the existing route is closed for writing (the lock); nothing is written');
  await w.setSetting('private.catalog_enabled', false); const oldClosed = await w.call('PATCH', '/services/11', YOSI, OLD_BODY); assert.deepEqual([oldClosed.status, oldClosed.body.error], [409, 'service_has_public_price'], 'with the catalog closed the existing route has its own guard, exactly as before'); await w.open();
  await w.owner('UPDATE pricing SET public = false WHERE id = 7');
  assert.equal((await upd({ topic: 'פנסיה' }, { topic: 'מיסים' })).status, 200, 'once the price is off the public list the service can be edited'); assert.equal((await w.owner('SELECT topic FROM services WHERE id = 11'))[0].topic, 'פנסיה');
  await w.pg.close();
});
const PATCH_SERVICE = (w, id, changes, expected) => w.call('PATCH', '/catalog/services/' + id, YOSI, j({ changes, expected }));

test('service settings and clearance: created once, code unique and fixed, tags validated; the clearance is recorded with the signed-in owner (never a name from the request) and cannot be withdrawn while an engagement of the service is active', async () => {
  const w = await world(); await w.open(); const put = (id, body, who) => w.call('PUT', '/catalog/services/' + id + '/settings', who || YOSI, j(body));
  let r = await put(12, { code: 'mortgage-advice', finding_tags: ['m1', 'm1', 'm2'], topics: ['mortgage'] }); assert.equal(r.status, 200); assert.deepEqual((await w.owner('SELECT code, finding_tags, topics, legal_cleared, offered FROM service_settings WHERE service_id = 12'))[0], { code: 'mortgage-advice', finding_tags: ['m1', 'm2'], topics: ['mortgage'], legal_cleared: false, offered: false });
  assert.deepEqual([(await put(12, { code: 'other-code' })).body.error, (await put(13, { code: 'mortgage-advice' })).body.error, (await put(999, { code: 'zz-code' })).body.error], ['settings_exist', 'code_in_use', 'not_found']);
  for (const [body, code] of [[{}, 'bad_code'], [{ code: 'X' }, 'bad_code'], [{ code: 'has space' }, 'bad_code'], [{ code: 'ok-code', finding_tags: ['A b'] }, 'bad_tags'], [{ code: 'ok-code', topics: Array(13).fill('a') }, 'bad_topics'], [{ code: 'ok-code', offered: true }, 'unknown_field'], [{ code: 'ok-code', share_questions: ['q1'] }, 'unknown_field']]) assert.equal((await put(14, body)).body.error, code, JSON.stringify(body));
  r = await put(12, { finding_tags: ['m1', 'm3'], expected: { finding_tags: ['m1', 'm2'] } }); assert.equal(r.status, 200); assert.deepEqual((await w.owner('SELECT finding_tags FROM service_settings WHERE service_id = 12'))[0].finding_tags, ['m1', 'm3']);
  assert.equal((await put(12, { finding_tags: ['x'], expected: { finding_tags: ['m1', 'm2'] } })).body.error, 'conflict'); assert.equal((await put(12, { code: 'new-code', expected: {} })).body.error, 'bad_body', 'the code is fixed once set');
  const clr = (id, body, who) => w.call('POST', '/catalog/services/' + id + '/clearance', who || AVI, j(body));
  assert.equal((await clr(12, { cleared: true, expected_cleared: false, note: 'אושר בכתב' })).status, 200); assert.deepEqual((await w.owner('SELECT legal_cleared, legal_cleared_by, legal_note, offered FROM service_settings WHERE service_id = 12'))[0], { legal_cleared: true, legal_cleared_by: AVI, legal_note: 'אושר בכתב', offered: false });
  assert.equal((await clr(12, { cleared: true, expected_cleared: true, legal_cleared_by: 'someone-else' })).body.error, 'unknown_field'); assert.equal((await clr(12, { cleared: true, expected_cleared: false })).body.error, 'conflict'); assert.equal((await clr(14, { cleared: true, expected_cleared: false })).body.error, 'settings_required');
  assert.equal((await clr(11, { cleared: false, expected_cleared: true })).status, 200, 'withdrawn while nothing of service 11 is active'); await w.owner("UPDATE service_settings SET legal_cleared = true, legal_cleared_by = 'x', legal_cleared_at = now() WHERE service_id = 11; UPDATE provider_services SET activation = 'paused' WHERE service_id = 11");
  assert.equal((await w.audits("action = 'catalog.service.clearance'")).length, 2);
  assert.deepEqual((await w.audits("action = 'catalog.service.settings.create'"))[0].detail, { code: 'mortgage-advice', finding_tags: 2, topics: 1 }); await w.pg.close();
});

test('providers: create (contact details normalised, near-duplicates are a question), edit with compare-and-set across both tables (all or nothing), a provider without a profile gets one; no contact detail or note ever reaches the audit log', async () => {
  const w = await world(); await w.open();
  let r = await PATH('POST', '/catalog/providers', YOSI, { name: 'ספק חדש', business_name: 'עסק חדש', contact_phone: '050-765 4321', contact_email: 'NEW@Example.TEST', internal_notes: 'הערה פנימית סודית', capacity_open: 3 }, w); assert.equal(r.status, 200); const id = r.body.id;
  assert.deepEqual((await w.owner('SELECT pp.contact_phone, pp.contact_email, pp.internal_notes, pp.capacity_open, pp.delivery_method, p.name FROM provider_profiles pp JOIN professionals p ON p.id = pp.professional_id WHERE p.id = $1', [id]))[0], { contact_phone: '0507654321', contact_email: 'new@example.test', internal_notes: 'הערה פנימית סודית', capacity_open: 3, delivery_method: 'portal', name: 'ספק חדש' });
  assert.deepEqual([(await PATH('POST', '/catalog/providers', YOSI, { name: 'ספק חדש', business_name: 'עסק חדש' }, w)).body.error, (await PATH('POST', '/catalog/providers', YOSI, { name: 'ספק חדש', business_name: 'עסק אחר' }, w)).body.error, (await PATH('POST', '/catalog/providers', YOSI, { name: 'ספק חדש', business_name: 'עסק אחר', allow_duplicate: true }, w)).status], ['similar_provider_exists', 'similar_provider_exists', 200]);
  for (const [body, code] of [[{ name: 'ספק', contact_phone: '123' }, 'bad_phone'], [{ name: 'ספק', contact_email: 'x@' }, 'bad_email'], [{ name: 'ספק', delivery_method: 'fax' }, 'bad_delivery_method'], [{ name: 'ספק', capacity_open: -1 }, 'bad_capacity'], [{ name: 'ספק', foo: 1 }, 'unknown_field'], [{}, 'bad_name'], [{ name: 'ספק', routing_enabled: true }, 'unknown_field']]) assert.equal((await PATH('POST', '/catalog/providers', YOSI, body, w)).body.error, code, JSON.stringify(body));
  const upd = (pid, changes, expected, who) => PATH('PATCH', '/catalog/providers/' + pid, who || AVI, { changes, expected }, w);
  assert.equal((await upd(21, { contact_phone: '052-999 8888', name: 'דנה לבני-כהן' }, { contact_phone: '0501234567', name: 'דנה לבני' })).status, 200); assert.deepEqual((await w.owner('SELECT p.name, pp.contact_phone FROM professionals p JOIN provider_profiles pp ON pp.professional_id = p.id WHERE p.id = 21'))[0], { name: 'דנה לבני-כהן', contact_phone: '0529998888' });
  r = await upd(21, { contact_email: 'other@example.test', name: 'שם שלישי' }, { contact_email: 'dana@example.test', name: 'לא השם הנוכחי' }); assert.equal(r.status, 409); assert.deepEqual((await w.owner('SELECT p.name, pp.contact_email FROM professionals p JOIN provider_profiles pp ON pp.professional_id = p.id WHERE p.id = 21'))[0], { name: 'דנה לבני-כהן', contact_email: 'dana@example.test' }, 'a stale name stops the profile change too: all or nothing');
  assert.equal((await upd(23, { internal_notes: 'x' }, { internal_notes: null })).status, 200); assert.equal((await w.owner('SELECT internal_notes FROM provider_profiles WHERE professional_id = 23'))[0].internal_notes, 'x', 'the profile of a provider that had none was created');
  assert.equal((await upd(999, { internal_notes: 'x' }, { internal_notes: null })).body.error, 'not_found'); assert.equal((await upd(21, { routing_enabled: true }, { routing_enabled: false })).body.error, 'unknown_field'); assert.equal((await upd(21, { contact_phone: 'abc' }, { contact_phone: '0529998888' })).body.error, 'bad_phone');
  const log = JSON.stringify(await w.audits()); for (const secret of ['0507654321', '0529998888', '0501234567', 'new@example', 'dana@example', 'הערה פנימית סודית']) assert.equal(log.includes(secret), false, 'not in the audit log: ' + secret);
  assert.deepEqual((await w.audits("action = 'catalog.provider.update'"))[0].detail, { fields: ['contact_phone', 'name'], to: {} }, 'field names only'); await w.pg.close();
});

test('provider state: pause until a date, resume, archive, unarchive; reasons are required and are in the history, not on the provider; archiving is refused while an engagement of the provider is active', async () => {
  const w = await world(); await w.open(); const act = (id, a, body, who) => w.call('POST', '/catalog/providers/' + id + '/' + a, who || YOSI, j(body || {}));
  const soon = new Date(Date.now() + 30 * 86400000).toISOString();
  assert.equal((await act(22, 'pause', { until: soon, reason: 'חופשה' })).status, 200); assert.equal((await w.call('GET', '/catalog/providers?state=paused', YOSI)).body.providers.map((p) => p.id).join(), '22');
  for (const [body, code] of [[{ reason: 'x' }, 'bad_until'], [{ until: 'yesterday', reason: 'x' }, 'bad_until'], [{ until: '2020-01-01T00:00:00Z', reason: 'x' }, 'bad_until'], [{ until: new Date(Date.now() + 400 * 86400000).toISOString(), reason: 'x' }, 'bad_until'], [{ until: soon }, 'reason_required']]) assert.equal((await act(22, 'pause', body)).body.error, code, JSON.stringify(body));
  assert.equal((await act(22, 'resume')).status, 200); assert.equal((await act(22, 'resume')).body.error, 'not_paused');
  assert.equal((await act(24, 'archive', {})).body.error, 'reason_required'); assert.equal((await act(24, 'archive', { reason: 'עזב' }, AVI)).status, 200); assert.equal((await act(24, 'archive', { reason: 'עזב' })).body.error, 'already_archived'); assert.equal((await act(24, 'pause', { until: soon, reason: 'x' })).body.error, 'provider_archived');
  assert.equal((await act(24, 'unarchive')).status, 200); assert.equal((await act(24, 'unarchive')).body.error, 'not_archived'); assert.equal((await act(999, 'archive', { reason: 'x' })).body.error, 'not_found');
  await w.owner("UPDATE service_settings SET legal_cleared = true WHERE service_id = 11; UPDATE provider_services SET agreement_state = 'signed', contact_state = 'active', activation = 'active' WHERE professional_id = 21 AND service_id = 11");
  assert.equal((await act(21, 'archive', { reason: 'x' })).body.error, 'active_engagements_exist', 'a provider with an active engagement cannot be archived'); assert.equal((await w.owner('SELECT archived_at FROM provider_profiles WHERE professional_id = 21'))[0].archived_at, null);
  assert.deepEqual((await w.audits("action = 'catalog.provider.archive'"))[0].detail, { reason: 'עזב' }); await w.pg.close();
});

test('engagements: create is a draft with nothing agreed; duplicates (the pair, the sheet id) and unknown providers or services are refused; the owner may state contact and agreement by hand (an active engagement may not lose what it needs)', async () => {
  const w = await world(); await w.open(); const post = (b, who) => w.call('POST', '/catalog/engagements', who || YOSI, j(b));
  assert.equal((await post({ provider_id: 23, service_id: 12, external_ref: 'EN-9' })).status, 200); assert.deepEqual((await w.owner('SELECT activation, contact_state, agreement_state, pricing_model, pricing_id, external_ref, updated_by FROM provider_services WHERE professional_id = 23 AND service_id = 12'))[0], { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, external_ref: 'EN-9', updated_by: YOSI });
  assert.deepEqual([(await post({ provider_id: 23, service_id: 12 })).body.error, (await post({ provider_id: 23, service_id: 13, external_ref: 'EN-9' })).body.error, (await post({ provider_id: 999, service_id: 12 })).body.error, (await post({ provider_id: 23, service_id: 999 })).body.error, (await post({ provider_id: 'x', service_id: 12 })).body.error, (await post({ provider_id: 23 })).body.error, (await post({ provider_id: 23, service_id: 13, activation: 'active' })).body.error], ['engagement_exists', 'external_ref_in_use', 'provider_or_service_not_found', 'provider_or_service_not_found', 'bad_provider_id', 'bad_service_id', 'bad_activation']);   // the field "activation" is known since 5b-2a (draft or pending only); "active" is refused, never accepted
  const upd = (p, s, changes, expected, who) => w.call('PATCH', '/catalog/engagements/' + p + '/' + s, who || AVI, j({ changes, expected }));
  assert.equal((await upd(23, 12, { contact_state: 'contacted', terms_note: 'התקשרתי' }, { contact_state: 'none', terms_note: null })).status, 200); assert.deepEqual((await w.owner('SELECT contact_state, terms_note, updated_by FROM provider_services WHERE professional_id = 23 AND service_id = 12'))[0], { contact_state: 'contacted', terms_note: 'התקשרתי', updated_by: AVI });
  assert.equal((await upd(23, 12, { contact_state: 'active', agreement_state: 'signed' }, { contact_state: 'contacted', agreement_state: 'not_discussed' })).status, 200, 'the owner may state "active" and "signed" by hand: they are the owner\'s own statements');
  for (const [changes, expected, code] of [[{ contact_state: 'called' }, { contact_state: 'active' }, 'bad_contact_state'], [{ agreement_state: 'verbal' }, { agreement_state: 'signed' }, 'bad_agreement_state'], [{ activation: 'active' }, { activation: 'draft' }, 'unknown_field'], [{ pricing_id: 7 }, { pricing_id: null }, 'unknown_field'], [{ pricing_model: 'fixed' }, { pricing_model: 'tbd' }, 'unknown_field'], [{ priority: -1 }, { priority: 100 }, 'bad_priority'], [{ external_ref: 'x'.repeat(81) }, { external_ref: 'EN-9' }, 'bad_external_ref']]) assert.equal((await upd(23, 12, changes, expected)).body.error, code, JSON.stringify(changes));
  assert.equal((await upd(23, 12, { contact_state: 'none' }, { contact_state: 'contacted' })).body.error, 'conflict'); assert.equal((await upd(9, 9, { priority: 1 }, { priority: 100 })).body.error, 'not_found');
  assert.equal((await upd(23, 12, { external_ref: 'TX-01' }, { external_ref: 'EN-9' })).body.error, 'duplicate', 'a sheet id already used by another engagement');
  await w.owner("UPDATE provider_services SET agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 7, activation = 'active' WHERE professional_id = 21 AND service_id = 11");
  const r = await upd(21, 11, { agreement_state: 'draft' }, { agreement_state: 'signed' }); assert.deepEqual([r.status, r.body.error], [422, 'rule_violation'], 'the database refuses to un-sign an active engagement'); assert.equal((await w.owner('SELECT agreement_state FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0].agreement_state, 'signed');
  await w.pg.close();
});

test('lifecycle without activation: submit, withdraw, pause, retire follow the state machine; every action is compare-and-set on the state the caller saw; reasons are required and kept in the history; retired is final', async () => {
  const w = await world(); await w.open(); const act = (a, body, who) => w.call('POST', '/catalog/engagements/22/12/actions/' + a, who || YOSI, j(body));
  const state = async () => (await w.owner('SELECT activation, paused_reason, retired_reason, retired_at, updated_by FROM provider_services WHERE professional_id = 22 AND service_id = 12'))[0];
  assert.equal((await act('submit', { expected_activation: 'draft' })).body.activation, 'pending'); assert.equal((await act('submit', { expected_activation: 'draft' })).body.error, 'conflict', 'a second click on the same state'); assert.equal((await act('submit', { expected_activation: 'pending' })).body.error, 'transition_refused');
  assert.equal((await act('withdraw', { expected_activation: 'pending' }, AVI)).body.activation, 'draft'); assert.equal((await state()).updated_by, AVI);
  assert.equal((await act('submit', { expected_activation: 'draft' })).status, 200);
  const seenOf = async () => (await w.call('GET', '/catalog/engagements/22/12', YOSI)).body.checklist.seen;   // pausing is a controlled action since 5b-2b-1: it needs its confirmation and the view the owner had
  let r = await act('pause', { expected_activation: 'pending', confirm: 'pause', seen: await seenOf() }); assert.deepEqual([r.status, r.body.error, r.body.errors], [422, 'transition_refused', ['reason_required']]);
  r = await act('pause', { expected_activation: 'pending', reason: 'ממתינים לספק', confirm: 'pause', seen: await seenOf() }); assert.equal(r.body.activation, 'paused'); assert.equal((await state()).paused_reason, 'ממתינים לספק');
  assert.deepEqual([(await act('explode', { expected_activation: 'paused' })).status, (await act('retire', {})).body.error, (await act('retire', { expected_activation: 'live' })).body.error, (await act('retire', { expected_activation: 'paused', foo: 1 })).body.error], [404, 'expected_required', 'expected_required', 'unknown_field']);
  assert.equal((await act('retire', { expected_activation: 'paused' })).body.errors[0], 'reason_required'); r = await act('retire', { expected_activation: 'paused', reason: 'הספק עזב' }); assert.equal(r.body.activation, 'retired'); const st = await state(); assert.deepEqual([st.activation, st.retired_reason, st.retired_at !== null], ['retired', 'הספק עזב', true]);
  for (const a of ['submit', 'withdraw', 'pause', 'retire', 'activate', 'resume']) assert.notEqual((await act(a, { expected_activation: 'retired', reason: 'x', confirm: 'activate', seen: 'x' })).status, 200, 'retired is final: ' + a);
  assert.equal((await w.call('POST', '/catalog/engagements/9/9/actions/submit', YOSI, j({ expected_activation: 'draft' }))).status, 404);
  assert.deepEqual((await w.audits("action LIKE 'catalog.engagement.%'")).map((a) => a.action + ':' + a.detail.to), ['catalog.engagement.submit:pending', 'catalog.engagement.withdraw:draft', 'catalog.engagement.submit:pending', 'catalog.engagement.pause:paused', 'catalog.engagement.retire:retired']);
  assert.equal(w.alerts.length, 1, 'retiring tells both owners'); assert.match(w.alerts[0].text, /22\/12/); assert.equal(/[0-9]{9,}|@/.test(w.alerts[0].text.replace(YOSI, '')), false, 'no personal detail in the alert'); await w.pg.close();
});

test('ACTIVATION: off by default, never by itself; it needs the switch, the typed confirmation, the exact view the owner had, a complete checklist; the server-side checks are repeated INSIDE the update; the public site and the price table do not change', async () => {
  const w = await world(); await w.open(); const E = '/catalog/engagements/21/11'; const act = (a, body, who) => w.call('POST', E + '/actions/' + a, who || YOSI, j(body));
  const card = async () => (await w.call('GET', E, YOSI)).body;
  const publicBefore = JSON.stringify(await w.publicPrices()), pricing = await w.fingerprint(['pricing']), settingsOffered = async () => (await w.owner('SELECT count(*)::int AS n FROM service_settings WHERE offered')) [0].n;
  let seen = (await card()).checklist.seen;
  let r = await act('activate', { expected_activation: 'pending', confirm: 'activate', seen }); assert.deepEqual([r.status, r.body.error], [403, 'activation_disabled'], 'closed by default');
  await w.setSetting('private.catalog_activation_enabled', 'true'); assert.equal((await act('activate', { expected_activation: 'pending', confirm: 'activate', seen })).body.error, 'activation_disabled', 'the string "true" does not open it'); await w.setSetting('private.catalog_activation_enabled', true);
  r = await act('activate', { expected_activation: 'pending', confirm: 'activate', seen }); assert.deepEqual([r.status, r.body.error, r.body.missing], [422, 'transition_refused', ['agreement_signed', 'collaboration_active']], 'the checklist is not complete');
  assert.equal((await w.call('PATCH', E, YOSI, j({ changes: { agreement_state: 'signed', contact_state: 'active' }, expected: { agreement_state: 'draft', contact_state: 'negotiating' } }))).status, 200);
  assert.equal((await act('activate', { expected_activation: 'pending', confirm: 'activate', seen })).body.error, 'seen_changed', 'the owner approved a view that is no longer the current one');
  seen = (await card()).checklist.seen; assert.equal((await card()).checklist.can_activate, true);
  assert.equal((await act('activate', { expected_activation: 'pending', seen })).body.error, 'confirmation_required'); assert.equal((await act('activate', { expected_activation: 'pending', confirm: 'yes', seen })).body.error, 'confirmation_required'); assert.equal((await act('activate', { expected_activation: 'draft', confirm: 'activate', seen })).body.error, 'conflict');
  assert.equal((await w.owner('SELECT activation FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0].activation, 'pending', 'nothing activated so far');
  // a stale read: the provider is archived AFTER the owner's view was read, but the old view is what the route sees: the repeated checks inside the UPDATE stop it
  const stale = await store.loadEngagement(21, 11); await w.owner('UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 21');
  const real = store.loadEngagement; let first = true; store.loadEngagement = async (...a) => { if (first) { first = false; return stale; } return real(...a); };
  try { r = await act('activate', { expected_activation: 'pending', confirm: 'activate', seen }); } finally { store.loadEngagement = real; }
  assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], 'the update itself refused'); assert.equal((await w.owner('SELECT activation FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0].activation, 'pending');
  await w.owner('UPDATE provider_profiles SET archived_at = NULL WHERE professional_id = 21'); seen = (await card()).checklist.seen;
  r = await act('activate', { expected_activation: 'pending', confirm: 'activate', seen }, AVI); assert.deepEqual([r.status, r.body.activation], [200, 'active']);
  assert.deepEqual((await w.audits("action = 'catalog.engagement.activate'"))[0].detail.checklist, ['agreement_signed:ok', 'collaboration_active:ok', 'fixed_price_linked:ok', 'service_cleared:ok', 'provider_available:ok', 'price_approved:ok']); assert.equal((await w.audits("action = 'catalog.engagement.activate'"))[0].actor, AVI);
  assert.equal(w.alerts.length, 1); assert.match(w.alerts[0].subject, /הפעלת התקשרות/);
  assert.equal(JSON.stringify(await w.publicPrices()), publicBefore, 'the public price list is exactly as before'); assert.deepEqual(await w.fingerprint(['pricing']), pricing, 'no price was touched'); assert.equal(await settingsOffered(), 0, 'no service is "offered"');
  assert.equal(await w.count('provider_service_compensation'), 1);
  // while active: the price cannot be swapped, the clearance cannot be withdrawn, the provider cannot be archived; pausing is always allowed, and coming back needs everything again
  assert.equal((await w.call('POST', E + '/unlink-price', YOSI, j({ expected_pricing_id: 7 }))).body.error, 'engagement_active'); assert.equal((await w.call('POST', '/catalog/services/11/clearance', YOSI, j({ cleared: false, expected_cleared: true }))).body.error, 'active_engagements_exist');
  assert.equal((await act('pause', { expected_activation: 'active', reason: 'בדיקה', confirm: 'pause', seen: (await card()).checklist.seen })).body.activation, 'paused');
  await w.setSetting('private.catalog_activation_enabled', false); seen = (await card()).checklist.seen; assert.equal((await act('resume', { expected_activation: 'paused', confirm: 'activate', seen })).body.error, 'activation_disabled', 'coming back to active is an activation too');
  await w.setSetting('private.catalog_activation_enabled', true); assert.equal((await act('resume', { expected_activation: 'paused', confirm: 'activate', seen })).body.activation, 'active'); assert.equal(w.alerts.length, 2);
  await w.pg.close();
});

test('price layers: market, offer to Kaspchem and unclassified are kept apart; create only if absent, update only with the token of what was read; the database rules are checked first; classify moves an unclassified price; none of it touches the approved-price table', async () => {
  const w = await world(); await w.open(); const base = '/catalog/engagements/22/12'; const put = (kind, layer, extra, who) => w.call('PUT', base + '/prices/' + kind, who || YOSI, j(Object.assign({ layer }, extra || {})));
  const pricingBefore = await w.fingerprint(['pricing', 'settings', 'provider_service_compensation']);
  assert.equal((await put('market', { model: 'fixed', amount: 450, source_note: 'אתר הספק', source_date: '2026-10-20' })).status, 200); assert.equal((await put('provider_offer', { model: 'percent_of_result', percent_low: 8, percent_high: 10, status: 'awaiting_response', terms_text: '8%-10% מהחיסכון' }, null, AVI)).status, 200);
  let card = (await w.call('GET', base, YOSI)).body.price_layers; assert.deepEqual([card.market.amount, card.market.source_date, card.provider_offer.percent_high, card.provider_offer.status, card.unclassified, card.market.recorded_by, card.provider_offer.recorded_by], [450, '2026-10-20', 10, 'awaiting_response', null, YOSI, AVI], 'market and offer side by side, the third layer still empty');
  assert.equal((await put('unclassified', { model: 'fixed', amount: 777 })).status, 200); card = (await w.call('GET', base, YOSI)).body.price_layers; assert.deepEqual([card.market.amount, card.provider_offer.percent_low, card.unclassified.amount], [450, 8, 777], 'three layers, three different prices');
  assert.equal((await put('market', { model: 'fixed', amount: 460 })).body.error, 'layer_exists');
  const token = card.market.updated_at; assert.equal((await put('market', { model: 'fixed', amount: 460 }, { expected_updated_at: token })).status, 200); assert.equal((await put('market', { model: 'fixed', amount: 470 }, { expected_updated_at: token })).body.error, 'conflict', 'the token of the first read is stale now'); assert.equal((await w.call('GET', base, YOSI)).body.price_layers.market.amount, 460);
  for (const [layer, status, code] of [[{ model: 'fixed' }, 422, 'layer_invalid'], [{ model: 'fixed', amount: 5, percent_low: 5 }, 422, 'layer_invalid'], [{ model: 'percent_of_result', percent_low: 101 }, 422, 'layer_invalid'], [{ model: 'percent_of_result', percent_low: 10, percent_high: 5 }, 422, 'layer_invalid'], [{ model: 'variable', amount: 5 }, 422, 'layer_invalid'], [{ model: 'fixed', amount: 5, status: 'awaiting_response' }, 422, 'layer_invalid'], [{ model: 'fixed', amount: 5, terms_text: 'ש'.repeat(601) }, 422, 'layer_invalid'], [{ model: 'free' }, 400, 'bad_model'], [{ model: 'fixed', amount: -1 }, 400, 'bad_amount'], [{ model: 'fixed', amount: '5' }, 400, 'bad_amount'], [{ model: 'fixed', amount: 5, source_date: '08/11/2026' }, 400, 'date_format'], [{ model: 'fixed', amount: 5, price: 5 }, 400, 'unknown_field']]) { const r = await put('unclassified', layer); assert.deepEqual([r.status, r.body.error], [status, code], JSON.stringify(layer)); }
  assert.deepEqual((await put('market', { model: 'fixed', amount: 5, status: 'awaiting_response' }, { expected_updated_at: token })).body.codes, ['only_an_offer_can_wait_for_an_answer']); assert.equal((await put('market', { model: 'fixed', amount: 5 }, { expected_updated_at: 'x' })).body.error, 'bad_expected_updated_at');
  assert.equal((await w.call('PUT', '/catalog/engagements/9/9/prices/market', YOSI, j({ layer: { model: 'fixed', amount: 5 } }))).body.error, 'not_found');
  // classify
  assert.equal((await w.call('POST', base + '/prices/unclassified/classify', YOSI, j({ to: 'offer' }))).body.error, 'bad_target'); assert.equal((await w.call('POST', base + '/prices/market/classify', YOSI, j({ to: 'provider_offer' }))).body.error, 'only_unclassified_can_be_classified');
  assert.equal((await w.call('POST', base + '/prices/unclassified/classify', YOSI, j({ to: 'market', expected_updated_at: card.unclassified.updated_at }))).body.error, 'layer_exists', 'the market layer already exists: a person must decide which wins');
  const tok = (await w.call('GET', '/catalog/engagements/21/11', YOSI)).body.price_layers.unclassified.updated_at; assert.equal((await w.call('POST', '/catalog/engagements/21/11/prices/unclassified/classify', YOSI, j({ to: 'market', expected_updated_at: tok }))).status, 200); card = (await w.call('GET', '/catalog/engagements/21/11', YOSI)).body.price_layers; assert.deepEqual([card.market.amount, card.unclassified], [1200, null]); assert.equal((await w.call('POST', '/catalog/engagements/21/11/prices/unclassified/classify', YOSI, j({ to: 'market', expected_updated_at: tok }))).body.error, 'not_found');
  assert.deepEqual(await w.fingerprint(['pricing', 'settings', 'provider_service_compensation']), pricingBefore, 'the approved-price table, the settings and the commission table are exactly as before');
  assert.deepEqual((await w.audits("action LIKE 'catalog.price.%'")).map((a) => a.action), ['catalog.price.create', 'catalog.price.create', 'catalog.price.create', 'catalog.price.update', 'catalog.price.classify']); await w.pg.close();
});

test('linking the approved price: only an existing, approved, priced row of THIS service (general or this provider\'s); never created or changed; not while active; unlinking returns to "not set"', async () => {
  const w = await world(); await w.open(); const link = (p, s, body, who) => w.call('POST', '/catalog/engagements/' + p + '/' + s + '/link-price', who || YOSI, j(body)); const pricing = await w.fingerprint(['pricing']);
  assert.equal((await link(22, 12, { pricing_id: 8, expected_pricing_id: null })).body.error, 'price_not_eligible', 'price 8 exists but is not approved'); assert.equal((await link(22, 12, { pricing_id: 7, expected_pricing_id: null })).body.error, 'price_not_eligible', 'price 7 belongs to another service'); assert.equal((await link(22, 12, { pricing_id: 999, expected_pricing_id: null })).body.error, 'price_not_eligible');
  await w.owner('UPDATE pricing SET approved = true, approved_by = $1, approved_at = now() WHERE id = 8', ['yosi@example.test']); const afterApproval = await w.fingerprint(['pricing']);
  assert.equal((await link(22, 12, { pricing_id: 8, expected_pricing_id: 5 })).body.error, 'conflict'); assert.equal((await link(22, 12, { pricing_id: 8 })).body.error, 'expected_required'); assert.equal((await link(22, 12, { pricing_id: 8, expected_pricing_id: null, price: 5 })).body.error, 'unknown_field'); assert.equal((await link(22, 12, { pricing_id: 'x', expected_pricing_id: null })).body.error, 'bad_pricing_id');
  assert.equal((await link(22, 12, { pricing_id: 8, expected_pricing_id: null }, AVI)).status, 200); assert.deepEqual((await w.owner('SELECT pricing_id::int AS pricing_id, pricing_model, updated_by FROM provider_services WHERE professional_id = 22 AND service_id = 12'))[0], { pricing_id: 8, pricing_model: 'fixed', updated_by: AVI });
  assert.deepEqual(await w.fingerprint(['pricing']), afterApproval, 'linking read the price and changed nothing in it'); assert.equal((await w.call('GET', '/catalog/engagements/22/12', YOSI)).body.approved_price.id, 8);
  assert.equal((await w.call('POST', '/catalog/engagements/22/12/unlink-price', YOSI, j({ expected_pricing_id: 5 }))).body.error, 'conflict'); assert.equal((await w.call('POST', '/catalog/engagements/22/12/unlink-price', YOSI, j({ expected_pricing_id: 8 }))).status, 200);
  assert.deepEqual((await w.owner('SELECT pricing_id, pricing_model FROM provider_services WHERE professional_id = 22 AND service_id = 12'))[0], { pricing_id: null, pricing_model: 'tbd' });
  assert.equal((await link(21, 11, { pricing_id: 7, expected_pricing_id: 7 }, YOSI)).status, 200, 're-linking the same price is allowed while not active'); await w.owner("UPDATE provider_services SET activation = 'paused' WHERE professional_id = 21");
  await w.owner("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11"); assert.equal((await link(21, 11, { pricing_id: 7, expected_pricing_id: 7 })).body.error, 'engagement_active');
  assert.deepEqual(await w.fingerprint(['pricing']), afterApproval); assert.equal((await link(9, 9, { pricing_id: 8, expected_pricing_id: null })).body.error, 'not_found'); await w.pg.close();
});

test('history: every catalog write has its row in the same transaction; the history route lists them newest first (by number, not as text), can be filtered, and never contains a contact detail', async () => {
  const w = await world(); await w.open();
  for (let i = 0; i < 12; i++) assert.equal((await w.call('POST', '/catalog/services', i % 2 ? AVI : YOSI, j({ name: 'שירות מספר ' + i + ' ' + 'אבגדהוזחטיכלמנסעפצקרשת'.slice(i, i + 5) + i, allow_duplicate: true }))).status, 200);
  await w.call('POST', '/catalog/providers', YOSI, j({ name: 'ספק היסטוריה', contact_phone: '0501112222', contact_email: 'h@example.test' }));
  const all = (await w.call('GET', '/catalog/history?limit=200', YOSI)).body; assert.equal(all.total, 13); assert.deepEqual(all.history.map((h) => h.id), all.history.map((h) => h.id).slice().sort((a, b) => b - a), 'newest first, as numbers (9 comes before 10, not after 15)'); assert.equal(all.history[0].action, 'catalog.provider.create');
  assert.equal((await w.call('GET', '/catalog/history?entity=service&limit=5&offset=2', YOSI)).body.history.length, 5); assert.equal((await w.call('GET', '/catalog/history?entity=provider', YOSI)).body.total, 1); assert.equal((await w.call('GET', '/catalog/history?entity=service&entity_id=' + all.history[3].entity_id, YOSI)).body.total, 1);
  assert.equal(JSON.stringify(all).includes('0501112222') || JSON.stringify(all).includes('h@example'), false); await w.owner("INSERT INTO audit_log (actor, action) VALUES ('x', 'request.view')");
  assert.equal((await w.call('GET', '/catalog/history', YOSI)).body.total, 13, 'only catalog rows are listed'); assert.equal((await w.call('GET', '/catalog/history?foo=1', YOSI)).status, 400);
  const imports = await w.call('GET', '/catalog/imports', YOSI); assert.equal(imports.body.total, 0);
  for (let i = 0; i < 11; i++) await w.owner("INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by) VALUES ('csv', $1, 0, 0, 0, 0, 'x')", ['h' + i]);
  const list = (await w.call('GET', '/catalog/imports', YOSI)).body.imports; assert.deepEqual(list.map((x) => x.file_sha256).slice(0, 3), ['h10', 'h9', 'h8'], 'the import log is newest first too'); assert.equal((await w.call('GET', '/catalog/overview', YOSI)).body.last_import.file_sha256, 'h10'); await w.pg.close();
});

test('a failure at ANY position of a single-record write leaves nothing behind (service, provider, engagement action, price, link), and a failure before commit does too', async () => {
  const w = await world(); await w.open(); await w.setSetting('private.catalog_activation_enabled', true);
  await w.call('PATCH', '/catalog/engagements/21/11', YOSI, j({ changes: { agreement_state: 'signed', contact_state: 'active' }, expected: { agreement_state: 'draft', contact_state: 'negotiating' } }));
  await w.owner('UPDATE pricing SET approved = true WHERE id = 8');
  const seen = (await w.call('GET', '/catalog/engagements/21/11', YOSI)).body.checklist.seen;
  const cases = [
    ['service create', 'POST', '/catalog/services', { name: 'שירות שנכשל בכוונה' }], ['service update', 'PATCH', '/catalog/services/13', { changes: { description: 'x' }, expected: { description: null } }], ['settings', 'PUT', '/catalog/services/12/settings', { code: 'fail-code' }],
    ['provider create', 'POST', '/catalog/providers', { name: 'ספק שנכשל', contact_phone: '0501119999' }], ['provider update', 'PATCH', '/catalog/providers/21', { changes: { name: 'שם', internal_notes: 'x' }, expected: { name: 'דנה לבני', internal_notes: null } }], ['provider archive', 'POST', '/catalog/providers/22/archive', { reason: 'x' }],
    ['engagement create', 'POST', '/catalog/engagements', { provider_id: 23, service_id: 13 }], ['engagement update', 'PATCH', '/catalog/engagements/22/12', { changes: { terms_note: 'x' }, expected: { terms_note: null } }], ['action', 'POST', '/catalog/engagements/22/12/actions/submit', { expected_activation: 'draft' }],
    ['activate', 'POST', '/catalog/engagements/21/11/actions/activate', { expected_activation: 'pending', confirm: 'activate', seen }], ['price put', 'PUT', '/catalog/engagements/22/12/prices/market', { layer: { model: 'fixed', amount: 5 } }], ['link', 'POST', '/catalog/engagements/22/12/link-price', { pricing_id: 8, expected_pricing_id: null }],
  ];
  const before = await w.fingerprint(); let checked = 0;
  for (const [name, method, p, body] of cases) {
    let k = 0; for (; ; k++) {
      w.failAt = k; const txsBefore = w.txs.length; const r = await w.call(method, p, YOSI, j(body)); w.failAt = null;
      if (r.status === 200) break;                                    // k is past the last statement: it went through, so every earlier position failed
      assert.equal(r.status, 500, name + ' @' + k + ' ' + JSON.stringify(r.body)); assert.deepEqual(await w.fingerprint(), before, name + ': failure at statement ' + k + ' left something behind'); checked++;
      assert.ok(k < 40, 'runaway');
    }
    assert.ok(k >= 2, name + ' has at least a change and its audit row'); await w.owner('SELECT 1'); Object.assign(before, await w.fingerprint());   // the successful run is the new baseline for the next case
  }
  w.failAt = 'commit'; const r = await w.call('POST', '/catalog/services', YOSI, j({ name: 'כשל לפני אישור' })); w.failAt = null; assert.equal(r.status, 500); assert.deepEqual(await w.fingerprint(), before, 'a failure just before COMMIT');
  assert.ok(checked >= 30, 'positions tried: ' + checked); await w.pg.close();
});

test('a reply lost AFTER the commit: the change is there once, the caller sees an error, and trying again is refused instead of doubling it', async () => {
  const w = await world(); await w.open(); w.failAfterCommit = true;
  const r = await w.call('POST', '/catalog/engagements', YOSI, j({ provider_id: 23, service_id: 13 })); w.failAfterCommit = false; assert.equal(r.status, 500);
  assert.equal((await w.owner('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 23 AND service_id = 13'))[0].n, 1, 'saved once'); assert.equal((await w.audits("action = 'catalog.engagement.create'")).length, 1);
  assert.equal((await w.call('POST', '/catalog/engagements', YOSI, j({ provider_id: 23, service_id: 13 }))).body.error, 'engagement_exists', 'the retry is a plain "already there", not a second row'); await w.pg.close();
});

test('nothing here can reach what it must not: hostile bodies on every write route change nothing; the write routes cannot name a table, a column or a state they do not own', async () => {
  const w = await world(); await w.open(); const before = await w.fingerprint();
  const hostile = [{ approved: true, public: true }, { changes: { 'name = \'x\'; DROP TABLE services; --': 1 }, expected: { 'name = \'x\'; DROP TABLE services; --': 1 } }, { changes: { approved: true }, expected: { approved: false } }, { __proto__: { admin: true }, constructor: { prototype: { x: 1 } } }, { csv: 5, previewId: {}, approvals: [] }, { provider_id: '1; DELETE FROM pricing', service_id: 1 }, { layer: { model: 'fixed', amount: 1, kind: 'provider_offer' } }, { pricing_id: -1, expected_pricing_id: null }, []];
  for (const r of router.WRITE_ROUTES) for (const b of hostile) { const x = await w.call(r.method, r.sample.path.replace(/\/\d+/g, (m) => m), YOSI, { raw: JSON.stringify(b) }); assert.ok([400, 404, 409, 422].includes(x.status), r.name + ' ' + JSON.stringify(b).slice(0, 50) + ' -> ' + x.status); }
  assert.deepEqual(await w.fingerprint(), before, 'not one row changed'); assert.equal((await w.call('POST', '/catalog/services', YOSI, { raw: 'not json' })).body.error, 'bad_json'); assert.equal((await w.call('POST', '/catalog/services', YOSI, { raw: JSON.stringify({ name: 'x'.repeat(70000) }) })).status, 413, 'a small route does not accept a big body');
  await w.pg.close();
});

test('lifecycle actions are compare-and-set inside the UPDATE itself: a state that changed after the page was read is not overwritten even if the read was stale', async () => {
  const w = await world(); await w.open(); assert.equal((await w.call('POST', '/catalog/engagements/22/12/actions/submit', YOSI, j({ expected_activation: 'draft' }))).status, 200);
  const stale = await store.loadEngagement(22, 12); assert.equal(stale.r.activation, 'pending');
  await w.owner("UPDATE provider_services SET activation = 'paused', paused_reason = 'x' WHERE professional_id = 22 AND service_id = 12");
  const real = store.loadEngagement; let first = true; store.loadEngagement = async (...a) => { if (first) { first = false; return stale; } return real(...a); };
  let r; try { r = await w.call('POST', '/catalog/engagements/22/12/actions/withdraw', YOSI, j({ expected_activation: 'pending' })); } finally { store.loadEngagement = real; }
  assert.deepEqual([r.status, r.body.error], [409, 'conflict']); assert.equal((await w.owner('SELECT activation FROM provider_services WHERE professional_id = 22 AND service_id = 12'))[0].activation, 'paused', 'the newer state stands'); await w.pg.close();
});

test('a general price of ANOTHER service cannot be linked either (the service must match, not only the provider)', async () => {
  const w = await world(); await w.open(); await w.owner("INSERT INTO pricing (id, service_id, professional_id, label, price, approved, approved_by, approved_at) VALUES (10, 13, NULL, 'כללי לשירות אחר', 100, true, 'x', now())");
  const r = await w.call('POST', '/catalog/engagements/22/12/link-price', YOSI, j({ pricing_id: 10, expected_pricing_id: null })); assert.deepEqual([r.status, r.body.error], [422, 'price_not_eligible']);
  assert.equal((await w.owner('SELECT pricing_id FROM provider_services WHERE professional_id = 22 AND service_id = 12'))[0].pricing_id, null); await w.pg.close();
});

test('the answer filter also guards the WRITE routes: a write that would answer with a confidential key answers with a plain server error', async () => {
  const w = await world(); await w.open(); const route = router.WRITE_ROUTES.find((x) => x.name === 'services.create'), real = route.run;
  route.run = async () => ({ id: 1, commission_percent: 12.5, note: 'LEAKED-VALUE' });
  try { const r = await w.call('POST', '/catalog/services', YOSI, j({ name: 'כל שם' })); assert.deepEqual([r.status, r.body.error], [500, 'server_error']); assert.equal(JSON.stringify(r.body).includes('LEAKED-VALUE'), false); } finally { route.run = real; }
  await w.pg.close();
});

test('the clearance cannot be attributed to anyone else: no field of the request names who cleared it', async () => {
  const w = await world(); await w.open(); await w.call('PUT', '/catalog/services/12/settings', YOSI, j({ code: 'mortgage-advice' }));
  for (const extra of [{ by: 'someone-else' }, { legal_cleared_by: 'someone-else' }, { actor: 'someone-else' }, { cleared_by: 'someone-else' }]) assert.equal((await w.call('POST', '/catalog/services/12/clearance', YOSI, j(Object.assign({ cleared: true, expected_cleared: false }, extra)))).body.error, 'unknown_field', JSON.stringify(extra));
  assert.equal((await w.owner('SELECT legal_cleared FROM service_settings WHERE service_id = 12'))[0].legal_cleared, false); await w.pg.close();
});

test('classification of a price layer is compare-and-set on the version the person saw: a change made by someone else in between is never classified by mistake (409, nothing saved, a clear sentence), and the comparison is part of the one UPDATE', async () => {
  const w = await world(); await w.open(); const base = '/catalog/engagements/22/12';
  const put = (kind, layer, extra, who) => w.call('PUT', base + '/prices/' + kind, who || YOSI, j(Object.assign({ layer }, extra || {})));
  const cls = (to, at) => w.call('POST', base + '/prices/unclassified/classify', YOSI, j(at === undefined ? { to } : { to, expected_updated_at: at }));
  const layersNow = async () => (await w.call('GET', base, YOSI)).body.price_layers;
  assert.equal((await put('unclassified', { model: 'fixed', amount: 700 })).status, 200);
  // the version is required, and must be a time
  const none = await cls('market'); assert.deepEqual([none.status, none.body.error], [400, 'expected_required']); assert.equal((await cls('market', 'x')).body.error, 'bad_expected_updated_at'); assert.equal((await cls('market', 5)).body.error, 'bad_expected_updated_at');
  const seen = (await layersNow()).unclassified.updated_at;
  // the second owner edits the layer after the first one opened the dialog
  assert.equal((await put('unclassified', { model: 'fixed', amount: 999 }, { expected_updated_at: seen }, AVI)).status, 200);
  const fp = await w.fingerprint(['provider_service_prices', 'pricing', 'settings']), audits = (await w.audits("action = 'catalog.price.classify'")).length;
  const stale = await cls('provider_offer', seen); assert.deepEqual([stale.status, stale.body.error], [409, 'conflict']);
  assert.match(stale.body.message, /הערך שונה מאז שנפתח חלון הסיווג/); assert.match(stale.body.message, /לא נשמר דבר/); assert.match(stale.body.message, /יש לרענן/);
  let layers = await layersNow(); assert.deepEqual([layers.unclassified.amount, layers.provider_offer], [999, null], 'still unclassified, with the value the other owner wrote');
  assert.deepEqual(await w.fingerprint(['provider_service_prices', 'pricing', 'settings']), fp, 'nothing moved'); assert.equal((await w.audits("action = 'catalog.price.classify'")).length, audits, 'no journal row for a classification that did not happen');
  // with the version of what is there now it works, and only then the layer moves, as it is
  const now = layers.unclassified.updated_at; assert.notEqual(now, seen); assert.equal((await cls('provider_offer', now)).status, 200);
  layers = await layersNow(); assert.deepEqual([layers.unclassified, layers.provider_offer.amount, layers.provider_offer.recorded_by], [null, 999, YOSI]);
  // a layer that is gone: 404, not a "changed" message
  assert.equal((await cls('market', now)).body.error, 'not_found');
  // the comparison is inside the UPDATE statement itself, not a look before it
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'netlify', 'functions', '_kaspchem', 'admin-catalog-writes.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/UPDATE provider_service_prices SET kind = \$1[^"]*kind = 'unclassified' AND date_trunc\('milliseconds', updated_at\) = \$5::timestamptz"/.test(src), 'the version is compared in the same UPDATE that classifies');
  await w.pg.close();
});
