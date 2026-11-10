'use strict';
// Creating an engagement through the catalog (stage 5b-2a, the hardening round): ONE atomic action that can end PENDING, a provider that is archived or paused gets no new engagement (the rule is in the INSERT, so it holds on the
// server and not only on the screen), and the service is marked when it is not set up for an activation. In-memory Postgres (PGlite) with the real tables and the real grants, running as kaspchem_app; synthetic data; no network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, closeAll, YOSI, AVI, STRANGER } = require('./fixtures/catalog-world.js');
const States = require('../netlify/functions/_kaspchem/catalog/states.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const CREATE = '/catalog/engagements';
const DATA = ['provider_services', 'audit_log', 'provider_service_prices', 'service_settings', 'provider_profiles', 'services'];
const rowOf = async (w, p, s) => (await w.owner('SELECT activation, contact_state, agreement_state, pricing_model, pricing_id, external_ref, priority, updated_by FROM provider_services WHERE professional_id = ' + p + ' AND service_id = ' + s))[0];
const journal = (w, p, s) => w.audits("entity = 'engagement' AND entity_id = '" + p + '/' + s + "'");
const post = (w, body, who) => w.call('POST', CREATE, who === undefined ? YOSI : who, j(body));

test('one atomic action that ends PENDING: the row, both steps of the journal, one transaction; without the field nothing changes (still a draft, one journal row); "active" and everything else is refused', async () => {
  const w = await world(); await w.open(); const writeTxs = () => w.txs.filter((t) => !t.readOnly).length;
  const before = writeTxs(), r = await post(w, { provider_id: 23, service_id: 12, external_ref: 'P-1', activation: 'pending' });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { ok: true, provider_id: 23, service_id: 12, activation: 'pending', service_ready: false, service_missing: ['settings'] });
  assert.equal(writeTxs() - before, 1, 'one transaction for the whole creation');
  assert.deepEqual(await rowOf(w, 23, 12), { activation: 'pending', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, external_ref: 'P-1', priority: 100, updated_by: YOSI });
  assert.deepEqual((await journal(w, 23, 12)).map((a) => [a.actor, a.action, a.detail]), [[YOSI, 'catalog.engagement.create', {}], [YOSI, 'catalog.engagement.submit', { from: 'draft', to: 'pending' }]]);
  // compatible with older callers: no field, a draft and one journal row; "draft" written out is the same
  for (const [p, s, body] of [[23, 13, {}], [24, 12, { activation: 'draft' }]]) {
    const d = await post(w, Object.assign({ provider_id: p, service_id: s }, body)); assert.equal(d.status, 200); assert.equal(d.body.activation, 'draft');
    assert.equal((await rowOf(w, p, s)).activation, 'draft'); assert.deepEqual((await journal(w, p, s)).map((a) => a.action), ['catalog.engagement.create']);
  }
  // nothing but draft or pending is accepted, and a refused request writes nothing
  const fp = await w.fingerprint(DATA);
  for (const v of ['active', 'paused', 'retired', 'Pending', 'PENDING', ' pending', '', null, 5, true, {}, []]) assert.deepEqual([(await post(w, { provider_id: 24, service_id: 13, activation: v })).status, (await post(w, { provider_id: 24, service_id: 13, activation: v })).body.error], [400, 'bad_activation'], JSON.stringify(v));
  assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written by the refusals');
  assert.equal((await post(w, { provider_id: 24, service_id: 13, activation: 'pending', status: 'active' })).body.error, 'unknown_field'); assert.equal((await post(w, { provider_id: 24, service_id: 13, pricing_id: 7 })).body.error, 'unknown_field');
  await w.pg.close();
});

test('it goes through the state machine: the step is decided by States.act ("submit" from a draft), a draft is made without it, and a refusal of the machine writes nothing', async () => {
  const w = await world(); await w.open(); const real = States.act, seen = [];
  try {
    States.act = (e, action, input, ctx) => { seen.push([e.activation, action]); return real(e, action, input, ctx); };
    assert.equal((await post(w, { provider_id: 23, service_id: 12, activation: 'pending' })).status, 200); assert.deepEqual(seen, [['draft', 'submit']]);
    seen.length = 0; assert.equal((await post(w, { provider_id: 23, service_id: 13 })).status, 200); assert.deepEqual(seen, [], 'a plain draft needs no step');
    const fp = await w.fingerprint(DATA); States.act = () => ({ ok: false, errors: ['transition_not_allowed:draft->pending'] });
    const refused = await post(w, { provider_id: 24, service_id: 12, activation: 'pending' }); assert.deepEqual([refused.status, refused.body.error], [422, 'transition_refused']); assert.deepEqual(refused.body.errors, ['transition_not_allowed:draft->pending']); assert.deepEqual(await w.fingerprint(DATA), fp, 'the machine said no: nothing exists');
  } finally { States.act = real; }
  // the same machine runs the later steps: back to draft, pending again; and no creation can ever be active; activation stays behind its own switch
  assert.equal((await w.call('POST', '/catalog/engagements/23/12/actions/withdraw', YOSI, j({ expected_activation: 'pending' }))).body.activation, 'draft'); assert.equal((await w.call('POST', '/catalog/engagements/23/12/actions/submit', YOSI, j({ expected_activation: 'draft' }))).body.activation, 'pending');
  assert.deepEqual((await w.owner("SELECT activation FROM provider_services WHERE activation = 'active'")), []);
  assert.equal((await w.call('POST', '/catalog/engagements/23/12/actions/activate', YOSI, j({ expected_activation: 'pending', confirm: 'activate', seen: 'x' }))).body.error, 'activation_disabled');
  await w.pg.close();
});

test('a failure at any point of the creation leaves nothing behind (no partial draft, no half journal); a lost reply leaves a consistent PENDING engagement, never a draft', async () => {
  const w = await world(); await w.open(); const fp = await w.fingerprint(DATA);
  // statements: 0 and 1 are the two timeouts, 2 and 3 the counted insert and its guard, 4 the journal row of the creation, 5 the journal row of the step
  for (const at of [2, 3, 4, 5, 'commit']) {
    w.failAt = at; const r = await post(w, { provider_id: 23, service_id: 12, activation: 'pending' }); w.failAt = null;
    assert.ok([500, 502].includes(r.status), 'the failure is reported (' + at + '): ' + r.status); assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing left behind when it fails at ' + at);
  }
  assert.equal((await post(w, { provider_id: 23, service_id: 12, activation: 'pending' })).status, 200, 'and the same request works afterwards: no leftover blocks it');
  assert.equal((await w.owner('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 23 AND service_id = 12'))[0].n, 1);
  // the reply is lost after the commit: the person is told the result is unknown, and what exists is complete
  w.failAfterCommit = true; w.failWith = { code: null, message: 'fetch failed' }; const lost = await post(w, { provider_id: 24, service_id: 13, activation: 'pending' }); w.failAfterCommit = false; w.failWith = null;
  assert.deepEqual([lost.status, lost.body.error], [502, 'result_unknown']); assert.equal((await rowOf(w, 24, 13)).activation, 'pending'); assert.deepEqual((await journal(w, 24, 13)).map((a) => a.action), ['catalog.engagement.create', 'catalog.engagement.submit']);
  await w.pg.close();
});

test('the same pair twice (a double click, a second tab, another admin): one engagement, one pair of journal rows, and the second answer says it exists; a taken sheet id is its own answer', async () => {
  const w = await world(); await w.open();
  assert.equal((await post(w, { provider_id: 23, service_id: 12, activation: 'pending', external_ref: 'S-1' })).status, 200);
  const fp = await w.fingerprint(DATA);
  for (const body of [{ activation: 'pending' }, {}, { activation: 'draft' }]) { const again = await post(w, Object.assign({ provider_id: 23, service_id: 12 }, body), AVI); assert.deepEqual([again.status, again.body.error], [409, 'engagement_exists'], JSON.stringify(body)); }
  const taken = await post(w, { provider_id: 24, service_id: 12, activation: 'pending', external_ref: 'S-1' }); assert.deepEqual([taken.status, taken.body.error], [409, 'external_ref_in_use']);
  assert.deepEqual(await w.fingerprint(DATA), fp, 'the refusals wrote nothing'); assert.equal((await journal(w, 23, 12)).length, 2);
  // created by someone else a moment before (the pair exists as a draft): refused as well, and the draft is left as it was
  await w.owner("INSERT INTO provider_services (professional_id, service_id) VALUES (24, 13)"); const fp2 = await w.fingerprint(DATA);
  assert.equal((await post(w, { provider_id: 24, service_id: 13, activation: 'pending' })).body.error, 'engagement_exists'); assert.deepEqual(await w.fingerprint(DATA), fp2); assert.equal((await rowOf(w, 24, 13)).activation, 'draft');
  await w.pg.close();
});

test('an archived provider gets no new engagement and a paused one none until the pause ends, for a draft and for a pending one; unknown providers and services still get "not found"; existing engagements of such a provider are untouched and still editable', async () => {
  const w = await world(); await w.open();
  await w.owner("UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 22; UPDATE provider_profiles SET paused_until = now() + interval '10 days' WHERE professional_id = 21");
  const fp = await w.fingerprint(DATA);
  for (const body of [{}, { activation: 'pending' }, { activation: 'draft', external_ref: 'X-1' }]) {
    const arch = await post(w, Object.assign({ provider_id: 22, service_id: 13 }, body)), paus = await post(w, Object.assign({ provider_id: 21, service_id: 13 }, body));
    assert.deepEqual([arch.status, arch.body.error], [409, 'provider_archived'], 'archived ' + JSON.stringify(body)); assert.deepEqual([paus.status, paus.body.error], [409, 'provider_paused'], 'paused ' + JSON.stringify(body));
  }
  assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written, nothing journaled');
  assert.equal((await post(w, { provider_id: 999, service_id: 13 })).body.error, 'provider_or_service_not_found'); assert.equal((await post(w, { provider_id: 23, service_id: 999 })).body.error, 'provider_or_service_not_found');
  // a provider with no profile at all, one whose pause ended, one that is back from the archive: available
  assert.equal((await post(w, { provider_id: 23, service_id: 13, activation: 'pending' })).status, 200, 'no profile = available');
  await w.owner("UPDATE provider_profiles SET paused_until = now() - interval '1 minute' WHERE professional_id = 21"); assert.equal((await post(w, { provider_id: 21, service_id: 13, activation: 'pending' })).status, 200, 'a pause that ended is over');
  await w.owner('UPDATE provider_profiles SET archived_at = NULL WHERE professional_id = 22'); assert.equal((await post(w, { provider_id: 22, service_id: 13, activation: 'pending' })).status, 200, 'back from the archive');
  // what already exists is left alone: an engagement of a provider that is archived now is still read, still edited by hand, still submitted from a draft
  await w.owner("INSERT INTO provider_services (professional_id, service_id) VALUES (22, 14); UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 22");
  assert.equal((await w.call('GET', '/catalog/engagements/22/14', YOSI)).status, 200);
  assert.equal((await w.call('PATCH', '/catalog/engagements/22/14', YOSI, j({ changes: { contact_state: 'contacted' }, expected: { contact_state: 'none' } }))).status, 200);
  assert.equal((await w.call('POST', '/catalog/engagements/22/14/actions/submit', YOSI, j({ expected_activation: 'draft' }))).status, 200);
  await w.pg.close();
});

test('a switched-off service may get a PENDING engagement and is never activated by it; a service without its settings is marked not ready (in the answer and on every read of its engagements)', async () => {
  const w = await world(); await w.open();
  await w.owner("UPDATE services SET active = false WHERE id = 12");
  const off = await post(w, { provider_id: 23, service_id: 12, activation: 'pending' }); assert.equal(off.status, 200); assert.equal(off.body.activation, 'pending');
  assert.deepEqual((await w.owner('SELECT active FROM services WHERE id = 12'))[0], { active: false }, 'the mark of the service is untouched'); assert.equal((await rowOf(w, 23, 12)).activation, 'pending');
  // no settings: not ready, and the engagement says so on every read; settings without tags or topics: "matching"; with a tag or a topic: ready
  assert.deepEqual([off.body.service_ready, off.body.service_missing], [false, ['settings']]);
  const card = (await w.call('GET', '/catalog/engagements/23/12', YOSI)).body; assert.deepEqual([card.engagement.service_ready, card.engagement.service_missing], [false, ['settings']]); assert.equal(card.checklist.items.find((i) => i.key === 'service_cleared').ok, false);
  assert.equal((await w.call('PUT', '/catalog/services/13/settings', YOSI, j({ code: 'svc-13' }))).status, 200);
  const empty = await post(w, { provider_id: 23, service_id: 13, activation: 'pending' }); assert.deepEqual([empty.body.service_ready, empty.body.service_missing], [false, ['matching']]);
  assert.equal((await w.call('PUT', '/catalog/services/14/settings', YOSI, j({ code: 'svc-14', finding_tags: ['tag-a'] }))).status, 200);
  const tagged = await post(w, { provider_id: 23, service_id: 14, activation: 'pending' }); assert.deepEqual([tagged.body.service_ready, tagged.body.service_missing], [true, []]);
  assert.deepEqual([(await w.call('GET', '/catalog/engagements/21/11', YOSI)).body.engagement.service_ready, (await w.call('GET', '/catalog/engagements/22/12', YOSI)).body.engagement.service_missing], [true, ['settings']]);
  // "ready" is only a marker: the activation checklist still decides, and nothing became active
  assert.deepEqual(await w.owner("SELECT activation FROM provider_services WHERE activation = 'active'"), []);
  await w.pg.close();
});

test('permissions and the journal: the anonymous caller 401, an outsider 403, a closed switch 403, no anti-forgery header 403, nothing written; the journal rows carry the signed-in owner and no contact detail; only owners read them', async () => {
  const w = await world(); const fp = await w.fingerprint(DATA); const body = { provider_id: 23, service_id: 12, activation: 'pending', external_ref: 'J-1' };
  assert.deepEqual([(await post(w, body, YOSI)).status, (await post(w, body, YOSI)).body.error], [403, 'catalog_disabled']);   // closed
  await w.open();
  assert.equal((await post(w, body, null)).status, 401); const out = await post(w, body, STRANGER); assert.deepEqual([out.status, out.body.error], [403, 'forbidden']);
  const csrf = await w.call('POST', CREATE, YOSI, { body, noCsrf: true }); assert.deepEqual([csrf.status, csrf.body.error], [403, 'csrf']); assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written by any of them');
  assert.equal((await post(w, body, AVI)).status, 200);   // both owners are equal
  assert.deepEqual((await journal(w, 23, 12)).map((a) => [a.actor, a.action]), [[AVI, 'catalog.engagement.create'], [AVI, 'catalog.engagement.submit']]);
  const log = JSON.stringify(await w.audits()); for (const secret of ['0501234567', '0521112233', 'dana@example', 'J-1']) assert.equal(log.includes(secret), false, 'not in the journal: ' + secret);   // not even the sheet id: field names only
  const h = await w.call('GET', '/catalog/history?entity=engagement&entity_id=23%2F12', YOSI); assert.equal(h.status, 200); assert.deepEqual(h.body.history.map((x) => x.action).sort(), ['catalog.engagement.create', 'catalog.engagement.submit']);
  assert.equal((await w.call('GET', '/catalog/history?entity=engagement&entity_id=23%2F12', STRANGER)).status, 403);
  await w.pg.close();
});
