'use strict';
// THE SAFE TRANSITION from the older "services" / "professionals" screens to the catalog.
//   Part 1 PINS what the older routes do while the catalog switch is not exactly true, so any change of that behaviour is caught at once.
//   Part 2 proves that nothing else writes the shared tables or the settings table, and that the list of locked routes is exact.
//   Part 3 is THE LOCK: while the switch is exactly JSON true the four older write routes of services and professionals are closed (409), a switch that cannot be read closes them too (503), and the
//          general settings route can never set a catalog switch (400), alone or together with other settings, whatever the switch says.
// Everything runs on the real admin entry point over an in-memory Postgres (PGlite) with the base schema and invented data. No Neon, no network, nothing deployed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const db = require('../netlify/functions/_kaspchem/db');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'netlify', 'functions');
const lockTest = (name, fn) => test('LOCK: ' + name, fn);
const OWNER = 'yosi@example.test|admin', STRANGER = 'stranger@example.test|admin';

let dev, base, rec, failSwitch = false;
const q = async (text, params) => (await dev.pg.query(text, params || [])).rows;
const raw = async (method, url, body, who, extra) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, who === undefined ? { 'x-test-user': OWNER } : who ? { 'x-test-user': who } : {}, method !== 'GET' ? { 'x-kaspchem': '1' } : {}, extra || {}), body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  let b = null; try { b = await r.json(); } catch (e) { /* not json */ } return { status: r.status, body: b };
};
const call = (method, p, body, who, extra) => raw(method, '/api/kaspchem/admin' + p, body, who, extra);
const setSwitch = async (valueJson) => { await dev.pg.exec("DELETE FROM settings WHERE key = 'private.catalog_enabled'"); if (valueJson !== undefined) await dev.pg.query("INSERT INTO settings (key, value, updated_by) VALUES ('private.catalog_enabled', $1::jsonb, 'test')", [valueJson]); };
const writes = (from) => rec.slice(from).filter((r) => !/^\s*(select|with)\b/i.test(r.t));
const counts = async () => { const o = {}; for (const t of ['services', 'professionals', 'pricing', 'audit_log', 'treatment_requests', 'settings']) o[t] = (await q('SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, \'|\' ORDER BY x::text), \'\')) AS h FROM ' + t + ' x'))[0]; return o; };

test.before(async () => {
  dev = await require('./dev-server').start(0); base = 'http://127.0.0.1:' + dev.server.address().port; rec = [];
  db.setDriver(async (t, p) => { rec.push({ t, p }); if (failSwitch && /FROM settings WHERE key = \$1/.test(t) && p && p[0] === 'private.catalog_enabled') throw new Error('simulated outage of the switch read'); return (await dev.pg.query(t, p)).rows; });
});
test.after(async () => { await new Promise((r) => dev.server.close(r)); await dev.pg.close(); });

// ---- part 1: what the older routes do, for every value the switch can have except exactly true -----------------------------------------------------------------------------------
const NOT_OPEN = [['absent', undefined], ['false', 'false'], ['the text "true"', '"true"'], ['the number 1', '1'], ['null', 'null'], ['an empty list', '[]'], ['an object', '{"on":true}'], ['the text "yes"', '"yes"']];
for (const [label, value] of NOT_OPEN) {
  test('TODAY (pinned), the catalog switch is ' + label + ': the four older write routes work exactly as before, with their audit rows', async () => {
    await setSwitch(value);
    const s = await call('POST', '/services', { name: 'Svc ' + label, topic: 'housing', description: 'd1' }); assert.equal(s.status, 200); const sid = s.body.id; assert.ok(Number.isInteger(sid));
    assert.deepEqual((await q('SELECT name, topic, description, active FROM services WHERE id = $1', [sid]))[0], { name: 'Svc ' + label, topic: 'housing', description: 'd1', active: true }, 'a service made here is ACTIVE at once, with no settings row');
    const u = await call('PATCH', '/services/' + sid, { name: 'Svc2 ' + label, topic: 'housing', description: 'd2', active: false }); assert.equal(u.status, 200);
    assert.deepEqual((await q('SELECT name, description, active FROM services WHERE id = $1', [sid]))[0], { name: 'Svc2 ' + label, description: 'd2', active: false });
    assert.equal((await call('PATCH', '/services/' + sid, { name: 'Svc3 ' + label, topic: 'housing' })).status, 200);
    assert.equal((await q('SELECT active FROM services WHERE id = $1', [sid]))[0].active, true, 'a request without "active" switches the service ON (existing behaviour, pinned)');
    const p = await call('POST', '/professionals', { name: 'Pro ' + label, contact: 'free text', topics: ['housing'], agreement_status: 'in_talks' }); assert.equal(p.status, 200); const pid = p.body.id;
    assert.deepEqual((await q('SELECT name, contact, topics, agreement_status, agreement_notes, routing_enabled FROM professionals WHERE id = $1', [pid]))[0], { name: 'Pro ' + label, contact: 'free text', topics: ['housing'], agreement_status: 'in_talks', agreement_notes: null, routing_enabled: false });
    assert.equal((await call('PATCH', '/professionals/' + pid, { name: 'Pro2 ' + label, contact: 'c2', topics: [], agreement_status: 'signed', agreement_notes: 'n', routing_enabled: true })).status, 200);
    assert.deepEqual((await q('SELECT name, contact, agreement_status, agreement_notes, routing_enabled FROM professionals WHERE id = $1', [pid]))[0], { name: 'Pro2 ' + label, contact: 'c2', agreement_status: 'signed', agreement_notes: 'n', routing_enabled: true });
    assert.equal((await call('PATCH', '/professionals/' + pid, { name: 'Pro3 ' + label })).status, 200);
    assert.deepEqual((await q('SELECT contact, agreement_status, agreement_notes, routing_enabled FROM professionals WHERE id = $1', [pid]))[0], { contact: null, agreement_status: 'none', agreement_notes: null, routing_enabled: false }, 'a save without the other fields empties them (existing behaviour, pinned)');
    const log = (await q("SELECT action FROM audit_log WHERE (entity = 'service' AND entity_id = $1) OR (entity = 'professional' AND entity_id = $2) ORDER BY id", [String(sid), String(pid)])).map((r) => r.action);
    assert.deepEqual(log, ['service.create', 'service.update', 'service.update', 'professional.create', 'professional.update', 'professional.update']);
    assert.deepEqual([(await call('POST', '/services', { name: '' })).status, (await call('POST', '/professionals', { name: 'x', agreement_status: 'bogus' })).body.error, (await call('PATCH', '/services/0', { name: 'x' })).body.error, (await call('PATCH', '/services/abc', { name: 'x' })).body.error], [400, 'bad_agreement', 'bad_id', 'not_found']);
  });
}

test('TODAY (pinned), with the switch OPEN nothing else changes: lists, request assignment, prices (create, approve, publish, edit), other settings and the audit list all work', async () => {
  await setSwitch(undefined);   // the rows are made while the older routes are still open to writing; the switch is opened for everything after
  const s = (await call('POST', '/services', { name: 'Neighbour svc', topic: 'housing' })).body.id, p = (await call('POST', '/professionals', { name: 'Neighbour pro' })).body.id;
  await setSwitch('true');
  assert.ok((await call('GET', '/services')).body.services.some((x) => x.id === s)); assert.ok((await call('GET', '/professionals')).body.professionals.some((x) => x.id === p));
  const a = (await q("INSERT INTO applicants (name, phone) VALUES ('Test applicant', '0500000000') RETURNING id"))[0].id;
  const r = (await q("INSERT INTO treatment_requests (applicant_id, topic, answers, outcome, consent_contact) VALUES ($1, 'housing', '{}', 'found', true) RETURNING id", [a]))[0].id;
  assert.equal((await call('PATCH', '/requests/' + r, { service_id: s, professional_id: p })).status, 200, 'assigning a request still works');
  assert.deepEqual((await q('SELECT service_id::int AS s, professional_id::int AS p FROM treatment_requests WHERE id = $1', [r]))[0], { s, p });
  const price = await call('POST', '/pricing', { label: 'Neighbour price', service_id: s, professional_id: p, price: 100, cost: 0, commission: 0 }); assert.equal(price.status, 200);
  assert.equal((await call('POST', '/pricing/' + price.body.id + '/approve', { public: false })).status, 200);
  assert.deepEqual((await q('SELECT approved, public FROM pricing WHERE id = $1', [price.body.id]))[0], { approved: true, public: false });
  assert.equal((await call('POST', '/pricing/' + price.body.id + '/unpublish', {})).status, 200);
  assert.equal((await call('PATCH', '/pricing/' + price.body.id, { label: 'edited', service_id: s, professional_id: p, price: 120, cost: 0, commission: 0 })).status, 200);
  assert.deepEqual((await q('SELECT approved, public FROM pricing WHERE id = $1', [price.body.id]))[0], { approved: false, public: false }, 'an edit still cancels the approval');
  for (const [key, value] of [['public.org_details', 'x'], ['public.legal_approved', false], ['private.compensation_topics', []], ['private.catalogue_note', 'a different name, not the catalog namespace']]) assert.equal((await call('PUT', '/settings', { key, value })).status, 200, key);
  assert.equal((await call('GET', '/audit')).status, 200);
});

test('TODAY (pinned), refused callers get the same refusals with the switch open: not signed in 401, not on the owners list 403, no CSRF header 403, and the answer never mentions the switch', async () => {
  await setSwitch('true');
  const four = [['POST', '/services', { name: 'x' }], ['PATCH', '/services/1', { name: 'x' }], ['POST', '/professionals', { name: 'x' }], ['PATCH', '/professionals/1', { name: 'x' }], ['PUT', '/settings', { key: 'private.catalog_enabled', value: true }]];
  const mark = rec.length, before = await counts();
  for (const [m, p, b] of four) {
    const none = await call(m, p, b, null); assert.deepEqual([none.status, none.body.error], [401, 'unauthenticated'], 'no identity ' + m + ' ' + p);
    const stranger = await call(m, p, b, STRANGER); assert.deepEqual([stranger.status, stranger.body.error], [403, 'forbidden'], 'stranger ' + m + ' ' + p);
    const csrf = await fetch(base + '/api/kaspchem/admin' + p, { method: m, headers: { 'content-type': 'application/json', 'x-test-user': OWNER }, body: JSON.stringify(b) }); assert.equal(csrf.status, 403, 'no CSRF header ' + m + ' ' + p);
  }
  assert.deepEqual(writes(mark), [], 'nothing was written'); assert.deepEqual(await counts(), before);
});

// ---- part 2: nothing else writes these tables, and the lists are exact ----------------------------------------------------------------------------------------------------------
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const routerSource = () => fs.readFileSync(path.join(FN, '_kaspchem', 'admin-router.js'), 'utf8').split('\r\n').join('\n');
const blocksOf = (src) => src.split(/^(?=on\()/m).filter((b) => b.startsWith('on('));
const nameOf = (b) => { const m = /^on\('([A-Z]+)', '([^']+)'/.exec(b); return m[1] + ' ' + m[2]; };
const OLD_FOUR = ['POST /services', 'PATCH /services/(\\\\d+)', 'POST /professionals', 'PATCH /professionals/(\\\\d+)'];
test('WHO WRITES services AND professionals: exactly four older routes in admin-router.js, the catalog write module, and no other runtime file (a new writer must be added to this list on purpose)', () => {
  const blocks = blocksOf(routerSource());
  const hits = blocks.filter((b) => /(INSERT INTO|UPDATE)\s+(services|professionals)\b/.test(stripComments(b))).map(nameOf);
  assert.deepEqual(hits.sort(), OLD_FOUR.slice().sort(), 'the older routes that write the two shared tables');
  assert.deepEqual(blocks.filter((b) => /(INSERT INTO|UPDATE)\s+pricing\b/.test(stripComments(b))).map(nameOf).sort(), ['PATCH /pricing/(\\\\d+)', 'POST /pricing', 'POST /pricing/(\\\\d+)/approve', 'POST /pricing/(\\\\d+)/unpublish'].sort());
  assert.deepEqual(blocks.filter((b) => /UPDATE treatment_requests SET/.test(b) && /professional_id/.test(b)).map(nameOf), ['PATCH /requests/(\\\\d+)']);
  const offenders = [];
  (function walk(dir) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue; } if (!/\.(js|mjs)$/.test(f.name)) continue; const rel = path.relative(FN, p).split(path.sep).join('/'); if (['_kaspchem/admin-router.js', '_kaspchem/admin-catalog-writes.js', '_kaspchem/catalog-writes.js', '_kaspchem/db.js'].includes(rel)) continue; if (/(INSERT INTO|UPDATE|DELETE FROM)\s+(services|professionals)\b/i.test(stripComments(fs.readFileSync(p, 'utf8')))) offenders.push(rel); } })(FN);
  assert.deepEqual(offenders, [], 'no other runtime file writes services or professionals');
});

test('WHO WRITES settings: the general settings route, and the internal upsert that only the impact routes call, with fixed impact keys; no other runtime file, and the catalog code never', () => {
  const src = routerSource(), blocks = blocksOf(src);
  const WRITE_SETTINGS = /(INSERT INTO|UPDATE|DELETE FROM)\s+settings\b/g;
  assert.equal((stripComments(src).match(WRITE_SETTINGS) || []).length, 2, 'exactly two statements in the router write settings');
  assert.match(src, /^const upsertSetting = \(key, value, email\) => db\.query\('INSERT INTO settings/m, 'one is the internal upsert');
  assert.equal((stripComments(blocks.find((b) => nameOf(b) === 'PUT /settings')).match(WRITE_SETTINGS) || []).length, 1, 'the other is inside PUT /settings');
  assert.deepEqual([...src.matchAll(/upsertSetting\(([^,)]+)/g)].map((m) => m[1]).filter((x) => x !== 'key'), ['impact.KEY.cutoff', 'impact.KEY.reference', 'impact.KEY.flag'], 'the internal upsert is only called with the impact keys');
  const offenders = [];
  (function walk(dir) { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); continue; } if (!/\.(js|mjs)$/.test(f.name)) continue; const rel = path.relative(FN, p).split(path.sep).join('/'); if (rel === '_kaspchem/admin-router.js') continue; if (/(INSERT INTO|UPDATE|DELETE FROM)\s+settings\b/i.test(stripComments(fs.readFileSync(p, 'utf8')))) offenders.push(rel); } })(FN);
  assert.deepEqual(offenders, [], 'no other runtime file writes settings');
});

test('THE LOCK LIST is exactly the four routes: the constant in admin-router.js holds those four patterns, each matches its own route (with a trailing slash too) and nothing else', () => {
  const src = routerSource(), m = /const catalogOwnedWrites = (\[\[.*?\]\]);/.exec(src); assert.ok(m, 'the list is in admin-router.js');
  const list = (0, eval)(m[1]);   // four [method, RegExp] pairs written in the source (not data from outside)
  assert.equal(list.length, 4);
  const hit = (method, p) => list.filter(([lm, re]) => lm === method && re.test(p.replace(/\/$/, '') || '/')).length;
  for (const [method, p] of [['POST', '/services'], ['PATCH', '/services/7'], ['POST', '/professionals'], ['PATCH', '/professionals/7'], ['POST', '/services/'], ['PATCH', '/professionals/12/']]) assert.equal(hit(method, p), 1, method + ' ' + p);
  for (const [method, p] of [['GET', '/services'], ['GET', '/professionals'], ['PUT', '/services/7'], ['DELETE', '/services/7'], ['PATCH', '/services'], ['POST', '/services/7'], ['PATCH', '/services/7/x'], ['PATCH', '/requests/7'], ['POST', '/pricing'], ['PATCH', '/pricing/7'], ['POST', '/pricing/7/approve'], ['PUT', '/settings'], ['POST', '/catalog/services']]) assert.equal(hit(method, p), 0, 'not locked: ' + method + ' ' + p);
});

// ---- part 3: the lock ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const FOUR = [['POST', '/services', { name: 'Locked svc', topic: 'housing' }], ['PATCH', '/services/1', { name: 'Locked svc', topic: 'housing', description: 'x', active: true }], ['POST', '/professionals', { name: 'Locked pro' }], ['PATCH', '/professionals/1', { name: 'Locked pro', contact: 'x' }]];
const fixedRows = () => dev.pg.exec("INSERT INTO services (id, name) VALUES (1, 'Fixed id 1') ON CONFLICT DO NOTHING; INSERT INTO professionals (id, name) VALUES (1, 'Fixed id 1') ON CONFLICT DO NOTHING");
lockTest('while the switch is exactly true, each of the four older write routes answers 409 "managed_in_catalog" in plain words, writes nothing and leaves no audit row, even for a body that would otherwise be refused', async () => {
  await setSwitch(undefined); await fixedRows();
  await setSwitch('true'); const mark = rec.length, before = await counts();
  for (const [m, p, b] of FOUR.concat([['POST', '/services', {}], ['PATCH', '/professionals/1', {}]])) { const r = await call(m, p, b); assert.deepEqual([r.status, r.body.error], [409, 'managed_in_catalog'], m + ' ' + p); assert.match(r.body.message || '', /קטלוג/); }
  assert.deepEqual(writes(mark), [], 'not one statement that writes'); assert.deepEqual(await counts(), before, 'no row, no audit row');
});
lockTest('there is no way round it by the shape of the request: a trailing slash, a query string, a doubled prefix and the other spellings of the same route are locked too; the spellings that reach no route reach no write', async () => {
  await setSwitch(undefined); await fixedRows(); await setSwitch('true'); const mark = rec.length, before = await counts();
  for (const [m, url] of [['POST', '/api/kaspchem/admin/services/'], ['POST', '/api/kaspchem/admin/services?x=1'], ['POST', '/api/kaspchem/admin/api/kaspchem/admin/services'], ['PATCH', '/api/kaspchem/admin/services/1/'], ['PATCH', '/api/kaspchem/admin/services/1?a=b&c=d'], ['POST', '/api/kaspchem/admin/professionals/'], ['PATCH', '/api/kaspchem/admin/professionals/1/?x'], ['PATCH', '/api/kaspchem/admin/api/kaspchem/admin/professionals/1']]) {
    const r = await raw(m, url, { name: 'Round it', topic: 'housing' }); assert.deepEqual([r.status, r.body && r.body.error], [409, 'managed_in_catalog'], m + ' ' + url);
  }
  for (const [m, url] of [['POST', '/api/kaspchem/admin//services'], ['POST', '/api/kaspchem/admin/Services'], ['PATCH', '/api/kaspchem/admin/services/%31'], ['PATCH', '/api/kaspchem/admin/services/1/extra'], ['PUT', '/api/kaspchem/admin/services/1'], ['DELETE', '/api/kaspchem/admin/services/1'], ['DELETE', '/api/kaspchem/admin/professionals/1'], ['POST', '/api/kaspchem/admin/services/1'], ['POST', '/api/kaspchem/admin/professionals/1']]) {
    const r = await raw(m, url, { name: 'Round it' }); assert.ok([404, 405].includes(r.status), m + ' ' + url + ' reaches no route (' + r.status + ')');
  }
  const o = await raw('POST', '/api/kaspchem/admin/services/1', { name: 'Round it' }, undefined, { 'x-http-method-override': 'PATCH', 'x-method-override': 'PATCH' }); assert.equal(o.status, 404, 'a method override header is not honoured');
  assert.deepEqual(writes(mark), [], 'nothing was written by any of these'); assert.deepEqual(await counts(), before);
});
lockTest('the lock follows the switch at once, in both directions (no cache): closed → works, open → refused, closed again → works', async () => {
  await setSwitch(undefined); assert.equal((await call('POST', '/services', { name: 'Flip 1', topic: 'housing' })).status, 200);
  await setSwitch('true'); assert.equal((await call('POST', '/services', { name: 'Flip 2', topic: 'housing' })).status, 409);
  await setSwitch('false'); assert.equal((await call('POST', '/services', { name: 'Flip 3', topic: 'housing' })).status, 200);
  await setSwitch('true'); assert.equal((await call('POST', '/professionals', { name: 'Flip pro' })).status, 409);
  assert.deepEqual((await q("SELECT name FROM services WHERE name LIKE 'Flip %' ORDER BY name")).map((r) => r.name), ['Flip 1', 'Flip 3']);
});
lockTest('if the switch cannot be read the four routes fail CLOSED (503, nothing written) while everything else keeps working', async () => {
  await setSwitch(undefined); await fixedRows(); const mark = rec.length, before = await counts(); failSwitch = true;
  try {
    for (const [m, p, b] of FOUR) { const r = await call(m, p, b); assert.deepEqual([r.status, r.body.error], [503, 'catalog_unavailable'], m + ' ' + p); }
    assert.deepEqual(writes(mark), []); assert.deepEqual(await counts(), before);
    assert.equal((await call('GET', '/services')).status, 200); assert.equal((await call('GET', '/professionals')).status, 200); assert.equal((await call('PUT', '/settings', { key: 'public.org_details', value: 'y' })).status, 200, 'the general settings route does not depend on reading the switch');
    assert.equal((await call('POST', '/pricing', { label: 'p during outage', price: 1, cost: 0, commission: 0 })).status, 200);
  } finally { failSwitch = false; }
  assert.equal((await call('POST', '/services', { name: 'After the outage', topic: 'housing' })).status, 200, 'once the switch can be read again the routes work as before');
});
lockTest('the refusals come BEFORE the lock: a stranger and a missing CSRF header are refused exactly as today, with the switch open, and the answer says nothing about the switch', async () => {
  await setSwitch('true');
  for (const [m, p, b] of FOUR) { const s = await call(m, p, b, STRANGER); assert.deepEqual([s.status, s.body.error], [403, 'forbidden']); const n = await call(m, p, b, null); assert.deepEqual([n.status, n.body.error], [401, 'unauthenticated']); }
});

const CATALOG_KEYS = ['private.catalog_enabled', 'private.catalog_activation_enabled'];
const SWITCH_STATES = [['absent', undefined], ['false', 'false'], ['true', 'true'], ['an invalid value', '"yes"']];
lockTest('the general settings route can never set a catalog switch: 400 "use_catalog_switch", nothing written, for either key and any value, whatever the switch is (closed, absent, open, invalid)', async () => {
  for (const [label, state] of SWITCH_STATES) {
    await setSwitch(state); await dev.pg.exec("DELETE FROM settings WHERE key = 'private.catalog_activation_enabled'"); const mark = rec.length, before = await counts();
    for (const key of CATALOG_KEYS) for (const value of [true, false, 'true', 1, null, {}, []]) { const r = await call('PUT', '/settings', { key, value }); assert.deepEqual([r.status, r.body.error], [400, 'use_catalog_switch'], label + ' ' + key + ' ' + JSON.stringify(value)); assert.match(r.body.message || '', /קטלוג/); }
    assert.deepEqual(writes(mark), [], label + ': not one write'); assert.deepEqual(await counts(), before, label);
    assert.deepEqual(await q("SELECT key FROM settings WHERE key = 'private.catalog_activation_enabled'"), []);
  }
});
lockTest('…also in every other shape a request could carry them: an array as the key, upper case, inside the value, in a field of settings, in a list of settings, in an array body, next to a harmless setting: all refused, and NOTHING of the harmless part is saved either', async () => {
  await setSwitch(undefined); const mark = rec.length, before = await counts();
  const bodies = [
    { key: ['private.catalog_enabled'], value: true }, { key: 'PRIVATE.CATALOG_ENABLED', value: true }, { key: 'Private.Catalog_Activation_Enabled', value: true }, { key: 'public.org_details', value: { 'private.catalog_enabled': true } },
    { key: 'public.org_details', value: 'mentions private.catalog_activation_enabled' }, { key: 'public.org_details', value: 'must not be saved', settings: { 'private.catalog_enabled': true } },
    { key: 'public.org_details', value: 'must not be saved', values: [{ key: 'private.catalog_enabled', value: true }, { key: 'public.legal_approved', value: true }] },
    { settings: [{ key: 'public.org_details', value: 'must not be saved' }, { key: 'private.catalog_enabled', value: true }] }, { settings: { 'public.org_details': 'must not be saved', 'private.catalog_activation_enabled': true } },
    { key: 'private.catalog_enabled', value: true }, { key: 'private.catalog_enabled', value: true, extra: [[[['deep']]]] }, { 'private.catalog_enabled': true }, { key: 'public.org_details', value: 'must not be saved', 'private.catalog_enabled': true }
  ];
  for (const b of bodies) { const r = await call('PUT', '/settings', b); assert.deepEqual([r.status, r.body.error], [400, 'use_catalog_switch'], JSON.stringify(b)); }
  const arrayBody = await call('PUT', '/settings', [{ key: 'private.catalog_enabled', value: true }]); assert.ok([400, 413].includes(arrayBody.status), 'an array as the whole body is refused (' + arrayBody.status + ')');
  assert.deepEqual(writes(mark), [], 'no statement that writes'); assert.deepEqual(await counts(), before, 'no setting, no audit row, nothing partial');
  assert.deepEqual(await q("SELECT key FROM settings WHERE key ~ '^private[.]catalog_'"), []); assert.deepEqual(await q("SELECT 1 FROM settings WHERE key = 'public.org_details' AND value::text LIKE '%must not be saved%'"), []);
});
lockTest('every other setting still saves and is audited exactly as before, with the switch absent, closed, open or invalid; a name that only looks alike is not the catalog namespace', async () => {
  for (const [label, state] of SWITCH_STATES) {
    await setSwitch(state);
    for (const [key, value] of [['public.org_details', 'text ' + label], ['public.legal_approved', false], ['private.compensation_topics', []], ['private.catalogue_note', 'alike'], ['public.catalog_note', 'public namespace'], ['private.catalog', 'no underscore after the word']]) {
      const before = Number((await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.update' AND entity_id = $1", [key]))[0].n);
      assert.equal((await call('PUT', '/settings', { key, value })).status, 200, label + ' ' + key);
      assert.deepEqual((await q('SELECT value FROM settings WHERE key = $1', [key]))[0].value, value); assert.equal(Number((await q("SELECT count(*)::int AS n FROM audit_log WHERE action = 'settings.update' AND entity_id = $1", [key]))[0].n), before + 1);
    }
  }
  assert.equal((await call('PUT', '/settings', { key: 'bad key', value: 1 })).body.error, 'bad_key'); assert.equal((await call('PUT', '/settings', { key: 'public.org_details', value: 'x'.repeat(5000) })).body.error, 'too_large'); assert.equal((await call('PUT', '/settings', { key: 'public.counter_enabled', value: true })).body.error, 'use_impact_api');
});
lockTest('the settings refusal also comes after who is asking: a stranger or a missing identity gets the usual 403 / 401, never a hint', async () => {
  const mark = rec.length;
  assert.deepEqual([(await call('PUT', '/settings', { key: 'private.catalog_enabled', value: true }, STRANGER)).body.error, (await call('PUT', '/settings', { key: 'private.catalog_enabled', value: true }, null)).body.error], ['forbidden', 'unauthenticated']);
  assert.deepEqual(writes(mark), []);
});
