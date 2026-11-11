'use strict';
// The controlled lifecycle actions of an engagement (stage 5b-2b-1, SERVER ONLY, no screen yet): REOPEN (retired -> draft, on the same row), RETURN TO REVIEW (paused -> pending) and the controlled PAUSE. Each one needs the owner role, the open
// catalog, a reason, the explicit confirmation and the view the owner had (`seen`); each one is one atomic change with its journal row; none of them can give an active engagement, and the activation switch is not touched.
// In-memory Postgres (PGlite) with the real tables and the real grants, running as kaspchem_app; synthetic data; no network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, closeAll, YOSI, AVI, STRANGER } = require('./fixtures/catalog-world.js');
const store = require('../netlify/functions/_kaspchem/catalog-store.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const E = (p, s) => '/catalog/engagements/' + p + '/' + s;
const DATA = ['provider_services', 'audit_log', 'provider_service_prices', 'provider_service_compensation', 'pricing', 'service_settings', 'provider_profiles', 'services', 'professionals'];
const act = (w, p, s, action, body, who) => w.call('POST', E(p, s) + '/actions/' + action, who === undefined ? YOSI : who, j(body));
const card = async (w, p, s) => (await w.call('GET', E(p, s), YOSI)).body;
const seenOf = async (w, p, s) => (await card(w, p, s)).checklist.seen;
// the full, valid request of a controlled action: its own name as the confirmation, the view as it is right now, a reason
const run = async (w, p, s, action, expected, extra, who) => act(w, p, s, action, Object.assign({ expected_activation: expected, confirm: action, seen: await seenOf(w, p, s), reason: 'סיבה לבדיקה' }, extra || {}), who);
const rowOf = async (w, p, s) => (await w.owner('SELECT activation, contact_state, agreement_state, pricing_model, pricing_id, paused_reason, retired_reason, retired_at, updated_by, updated_at FROM provider_services WHERE professional_id = ' + p + ' AND service_id = ' + s))[0];
const put = (w, p, s, sets) => w.owner('UPDATE provider_services SET ' + sets + ' WHERE professional_id = ' + p + ' AND service_id = ' + s);
const journal = (w, p, s) => w.audits("entity = 'engagement' AND entity_id = '" + p + '/' + s + "'");
const writeTxs = (w) => w.txs.filter((t) => !t.readOnly).length;
// "nothing is active": the only active rows are the ones a test put there itself (seeded: ['24/11'])
const noActive = async (w, seeded) => assert.deepEqual((await w.owner("SELECT professional_id::text || '/' || service_id::text AS k FROM provider_services WHERE activation = 'active' ORDER BY 1")).map((r) => r.k), seeded || [], 'nothing became active');
const WHEN = (d) => new Date(d).getTime();
// rows in every state, beside the seeded ones (21/11 pending, 22/12 draft)
const seedStates = async (w) => {
  await w.owner("INSERT INTO provider_services (professional_id, service_id, activation, paused_reason) VALUES (23, 12, 'paused', 'ספק בחופשה')");
  await w.owner("INSERT INTO provider_services (professional_id, service_id, activation, retired_reason, retired_at) VALUES (23, 13, 'retired', 'הספק עזב', '2026-11-01T10:00:00Z')");
  await w.owner("INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id) VALUES (24, 11, 'active', 'active', 'signed', 'fixed', 7)");
};

test('REOPEN: a retired engagement becomes a DRAFT again on the same row; nothing is given back (not active, no signature, no price approval); the last retirement stays as history and is not read as a current one; one transaction, one journal row', async () => {
  const w = await world(); await w.open(); const pub = JSON.stringify(await w.publicPrices()), money = await w.fingerprint(['pricing', 'provider_service_prices', 'provider_service_compensation']), rows = await w.count('provider_services');
  await put(w, 21, 11, "agreement_state = 'signed', contact_state = 'active'");   // the owners' own statements, made before the retirement
  assert.equal((await act(w, 21, 11, 'retire', { expected_activation: 'pending', reason: 'הספק עזב את הפרויקט' })).status, 200);
  const before = await rowOf(w, 21, 11), c0 = (await card(w, 21, 11)).engagement;
  assert.deepEqual([c0.activation, c0.retired_reason, c0.retired_at !== null, c0.last_retired_at, c0.last_retired_reason, c0.last_reopened_at], ['retired', 'הספק עזב את הפרויקט', true, null, null, null], 'while retired, the retirement is the current one');
  const kept = async () => (await w.owner('SELECT terms_note, external_ref, priority, pricing_id::text AS pricing_id, pricing_model FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0], keptBefore = await kept();
  const t0 = writeTxs(w), r = await run(w, 21, 11, 'reopen', 'retired', { reason: 'חזרנו לעבוד יחד' }, AVI);
  assert.deepEqual([r.status, r.body], [200, { ok: true, activation: 'draft', agreement_state: 'draft', agreement_reset: true, contact_state: 'contacted', contact_reset: true }]); assert.equal(writeTxs(w) - t0, 1, 'one transaction for the whole change');
  const after = await rowOf(w, 21, 11);
  assert.deepEqual([after.activation, after.agreement_state, after.contact_state, after.pricing_model, String(after.pricing_id), after.paused_reason, after.updated_by], ['draft', 'draft', 'contacted', 'fixed', String(before.pricing_id), null, AVI], 'a draft; the signature and the active collaboration of before are not carried over; the price link and model are still there');
  assert.deepEqual(await kept(), keptBefore, 'the terms note, the sheet id, the priority and the price link are exactly as they were: nothing was deleted');
  assert.deepEqual([after.retired_reason, WHEN(after.retired_at)], [before.retired_reason, WHEN(before.retired_at)], 'the date and the reason of the last retirement are still on the row');
  assert.equal(await w.count('provider_services'), rows, 'no row was added or removed: the same pair, no copy'); assert.equal((await w.owner('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0].n, 1);
  // what the card says now: not retired, and what is left of the retirement is named as the last one
  const c1 = (await card(w, 21, 11)); assert.deepEqual([c1.engagement.activation, c1.engagement.retired_reason, c1.engagement.retired_at, c1.engagement.last_retired_reason, WHEN(c1.engagement.last_retired_at), c1.engagement.last_reopened_at !== null], ['draft', null, null, 'הספק עזב את הפרויקט', WHEN(before.retired_at), true], 'history is not a current retirement');
  assert.deepEqual([c1.checklist.can_activate, c1.checklist.missing], [false, ['agreement_signed', 'collaboration_active']], 'the signature and the active collaboration have to be stated again before anything can be activated');
  // the journal: both events, who and why; the date of the retirement that was left behind is in the reopening row; the reason of the retirement is not copied again
  const log = await journal(w, 21, 11); assert.deepEqual(log.map((a) => [a.actor, a.action]), [[YOSI, 'catalog.engagement.retire'], [AVI, 'catalog.engagement.reopen']]);
  assert.deepEqual(log[0].detail, { from: 'pending', to: 'retired', reason: 'הספק עזב את הפרויקט' });
  assert.deepEqual(log[1].detail, { from: 'retired', to: 'draft', reason: 'חזרנו לעבוד יחד', previous_retired_at: new Date(before.retired_at).toISOString(), reset: { agreement_state: ['signed', 'draft'], contact_state: ['active', 'contacted'] } });
  assert.equal(WHEN((await w.owner("SELECT created_at FROM audit_log WHERE action = 'catalog.engagement.retire'"))[0].created_at), WHEN(before.retired_at), 'the journal and the row agree on when it was retired');
  // nothing about money or the public site moved, nothing is active, no alert was sent
  assert.deepEqual(await w.fingerprint(['pricing', 'provider_service_prices', 'provider_service_compensation']), money); assert.equal(JSON.stringify(await w.publicPrices()), pub); await noActive(w); assert.equal(w.alerts.length, 1, 'only the retirement told the owners');
  // the way on is the ordinary one: a draft is submitted to pending first, and activation is a different action behind its own switch
  assert.deepEqual([(await act(w, 21, 11, 'activate', { expected_activation: 'draft', confirm: 'activate', seen: await seenOf(w, 21, 11) })).body.error], ['activation_disabled']);
  await w.setSetting('private.catalog_activation_enabled', true);
  const jump = await act(w, 21, 11, 'activate', { expected_activation: 'draft', confirm: 'activate', seen: await seenOf(w, 21, 11) }); assert.deepEqual([jump.status, jump.body.errors], [422, ['activate_only_from_pending_or_paused']]);
  assert.equal((await act(w, 21, 11, 'submit', { expected_activation: 'draft' })).body.activation, 'pending');
  const need = await act(w, 21, 11, 'activate', { expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w, 21, 11) }); assert.deepEqual([need.status, need.body.missing], [422, ['agreement_signed', 'collaboration_active']]); await noActive(w);
  // the history route shows the events, newest first
  const h = await w.call('GET', '/catalog/history?entity=engagement&entity_id=21%2F11', YOSI); assert.deepEqual(h.body.history.map((x) => x.action).slice(0, 3), ['catalog.engagement.submit', 'catalog.engagement.reopen', 'catalog.engagement.retire']);
  await w.pg.close();
});

test('REOPEN and the agreement: "signed" goes back to "draft" and says so; "ended", "draft" and "not discussed" stay exactly as they were; an ended agreement is never restored to signed', async () => {
  const w = await world(); await w.open();
  for (const [was, now, reset] of [['signed', 'draft', true], ['ended', 'ended', false], ['draft', 'draft', false], ['not_discussed', 'not_discussed', false]]) {
    await put(w, 21, 11, "activation = 'retired', retired_at = now(), retired_reason = 'x', agreement_state = '" + was + "', paused_reason = 'ישן'");
    const r = await run(w, 21, 11, 'reopen', 'retired'); assert.deepEqual([r.status, r.body.agreement_state, r.body.agreement_reset], [200, now, reset], was);
    assert.deepEqual([(await rowOf(w, 21, 11)).agreement_state, (await rowOf(w, 21, 11)).paused_reason], [now, null], was + ': the old pause reason is gone, it is not paused'); const d = (await journal(w, 21, 11)).filter((a) => a.action === 'catalog.engagement.reopen').pop().detail;
    assert.deepEqual(d.reset, reset ? { agreement_state: [was, now] } : undefined, 'the journal says what was reset: ' + was);
  }
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE agreement_state = 'signed' AND activation = 'draft'"))[0].n, 0, 'no reopened draft carries a signature from before'); await noActive(w);
  await w.pg.close();
});

test('RETURN TO REVIEW: a paused engagement goes back to PENDING and nothing else changes; even with a complete checklist, an approved price and the activation switch open it is never made active; one transaction, one journal row', async () => {
  const w = await world(); await w.open(); const money = await w.fingerprint(['pricing', 'provider_service_prices', 'provider_service_compensation']);
  await put(w, 21, 11, "agreement_state = 'signed', contact_state = 'active'"); await w.setSetting('private.catalog_activation_enabled', true);   // everything the checklist asks for, and the switch open
  assert.equal((await card(w, 21, 11)).checklist.can_activate, true);
  assert.equal((await run(w, 21, 11, 'pause', 'pending', { reason: 'ממתינים לתשובת הספק' })).body.activation, 'paused'); const before = await rowOf(w, 21, 11); assert.equal(before.paused_reason, 'ממתינים לתשובת הספק');
  const t0 = writeTxs(w), r = await run(w, 21, 11, 'return_to_review', 'paused', { reason: 'התשובה התקבלה, בודקים מחדש' }, AVI);
  assert.deepEqual([r.status, r.body], [200, { ok: true, activation: 'pending' }]); assert.equal(writeTxs(w) - t0, 1, 'one transaction');
  const after = await rowOf(w, 21, 11); assert.deepEqual([after.activation, after.paused_reason, after.agreement_state, after.contact_state, after.pricing_model, String(after.pricing_id), after.retired_at, after.updated_by], ['pending', null, 'signed', 'active', 'fixed', String(before.pricing_id), null, AVI]);
  await noActive(w); assert.deepEqual(await w.fingerprint(['pricing', 'provider_service_prices', 'provider_service_compensation']), money, 'no price was touched');
  assert.deepEqual((await journal(w, 21, 11)).map((a) => [a.actor, a.action, a.detail]), [[YOSI, 'catalog.engagement.pause', { from: 'pending', to: 'paused', reason: 'ממתינים לתשובת הספק' }], [AVI, 'catalog.engagement.return_to_review', { from: 'paused', to: 'pending', reason: 'התשובה התקבלה, בודקים מחדש' }]]);
  // it is not a way to become active: the activation stays a separate act with its own confirmation and checks
  assert.equal((await act(w, 21, 11, 'resume', { expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w, 21, 11) })).body.errors[0], 'not_allowed_from_pending');
  assert.equal((await act(w, 21, 11, 'return_to_review', { expected_activation: 'pending', confirm: 'return_to_review', seen: await seenOf(w, 21, 11), reason: 'x' })).body.errors[0], 'not_allowed_from_pending', 'and not from pending'); await noActive(w);
  // a paused engagement can still be resumed the ordinary way, and that stays behind the switch
  await w.setSetting('private.catalog_activation_enabled', false); await put(w, 21, 11, "activation = 'paused', paused_reason = 'x'");
  assert.deepEqual([(await act(w, 21, 11, 'resume', { expected_activation: 'paused', confirm: 'activate', seen: await seenOf(w, 21, 11) })).body.error], ['activation_disabled']); await noActive(w);
  await w.pg.close();
});

test('PAUSE is a controlled action: reason, explicit confirmation and the view the owner had; it is recorded with who and when; it is allowed for an unavailable provider (it only reduces what is exposed) and only from the states the machine allows', async () => {
  const w = await world(); await w.open(); await seedStates(w); const t0 = writeTxs(w), time0 = (await rowOf(w, 21, 11)).updated_at;
  const r = await run(w, 21, 11, 'pause', 'pending', { reason: ' ממתינים לספק ' }, AVI); assert.deepEqual([r.status, r.body], [200, { ok: true, activation: 'paused' }]); assert.equal(writeTxs(w) - t0, 1);
  const after = await rowOf(w, 21, 11); assert.deepEqual([after.activation, after.paused_reason, after.updated_by], ['paused', 'ממתינים לספק', AVI]); assert.ok(WHEN(after.updated_at) >= WHEN(time0), 'the time of the change is recorded');
  const log = await journal(w, 21, 11); assert.deepEqual([log[0].actor, log[0].action, log[0].detail], [AVI, 'catalog.engagement.pause', { from: 'pending', to: 'paused', reason: 'ממתינים לספק' }]);
  assert.ok((await w.owner("SELECT created_at FROM audit_log WHERE action = 'catalog.engagement.pause'"))[0].created_at, 'the journal row has its time');
  // the machine decides what can be paused: not a draft, not a paused or retired one
  for (const [p, s, from, why] of [[22, 12, 'draft', 'transition_not_allowed:draft->paused'], [21, 11, 'paused', 'transition_not_allowed:paused->paused'], [23, 13, 'retired', 'transition_not_allowed:retired->paused']]) {
    const fp = await w.fingerprint(DATA), x = await run(w, p, s, 'pause', from); assert.deepEqual([x.status, x.body.error, x.body.errors], [422, 'transition_refused', [why]], from); assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written: ' + from);
  }
  // an active engagement can be paused (the pause does not need the activation switch), and an unavailable provider does not stop a pause
  await w.owner('INSERT INTO provider_profiles (professional_id, archived_at) VALUES (24, now())');
  assert.equal((await run(w, 24, 11, 'pause', 'active', { reason: 'ספק בארכיון' })).body.activation, 'paused'); assert.equal((await rowOf(w, 24, 11)).paused_reason, 'ספק בארכיון');
  await w.pg.close();
});

test('every refusal writes nothing: missing or wrong confirmation, a missing or old view, a missing, blank, long or contact-like reason, unknown fields, a wrong state, an unknown engagement', async () => {
  const w = await world(); await w.open(); await seedStates(w);
  const cases = { reopen: [23, 13, 'retired'], return_to_review: [23, 12, 'paused'], pause: [21, 11, 'pending'] };
  for (const [action, [p, s, state]] of Object.entries(cases)) {
    const fp = await w.fingerprint(DATA), seen = await seenOf(w, p, s), ok = { expected_activation: state, confirm: action, seen, reason: 'סיבה' };
    const probe = async (patch) => { const b = Object.assign({}, ok, patch); for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k]; const r = await act(w, p, s, action, b); return [r.status, r.body.error, r.body.errors]; };
    // the explicit confirmation is the action's own name, nothing else (above all not the word of the activation)
    for (const c of [undefined, '', 'activate', 'yes', true, action.toUpperCase(), ' ' + action, ...Object.keys(cases).filter((x) => x !== action)]) assert.deepEqual((await probe({ confirm: c })).slice(0, 2), [400, 'confirmation_required'], action + ' confirm ' + JSON.stringify(c));
    // the view: missing, empty, not a string -> required; another view -> the page must be read again
    for (const v of [undefined, '', 5, null, {}]) assert.deepEqual((await probe({ seen: v })).slice(0, 2), [400, 'expected_required'], action + ' seen ' + JSON.stringify(v)); assert.deepEqual((await probe({ seen: 'x' + seen })).slice(0, 2), [409, 'seen_changed']);
    // the reason: required (the machine says so), bounded text, and not a contact detail (the journal can never be edited)
    for (const rs of [undefined, '', '   ', '​']) assert.deepEqual(await probe({ reason: rs }), [422, 'transition_refused', ['reason_required']], action + ' reason ' + JSON.stringify(rs));
    for (const rs of [5, true, {}, 'x'.repeat(301)]) assert.deepEqual((await probe({ reason: rs })).slice(0, 2), [400, 'bad_reason'], action + ' reason ' + JSON.stringify(rs).slice(0, 20));
    for (const rs of ['התקשרו אליי 0501234567', 'a@b.co', 'https://x.example/p', '050-123-4567', 'www.example.com', '+972 50 123 4567']) assert.deepEqual((await probe({ reason: rs })).slice(0, 2), [400, 'reason_has_contact_detail'], action + ' reason ' + rs);
    // the state the caller expects: missing or unknown -> required; another one -> conflict
    for (const x of [undefined, '', 'live', 5]) assert.deepEqual((await probe({ expected_activation: x })).slice(0, 2), [400, 'expected_required']); assert.deepEqual((await probe({ expected_activation: state === 'draft' ? 'pending' : 'draft' })).slice(0, 2), [409, 'conflict']);
    // nothing outside the four fields, and nothing that names who did it or what the result is
    for (const extra of ['activation', 'actor', 'agreement_state', 'retired_at', 'paused_reason', 'updated_by']) assert.deepEqual((await probe({ [extra]: 'x' })).slice(0, 2), [400, 'unknown_field'], action + ' ' + extra);
    assert.deepEqual(await w.fingerprint(DATA), fp, action + ': nothing was written by any refusal');
    assert.equal((await act(w, 98, 99, action, ok)).status, 404, 'an engagement that does not exist');
  }
  await w.pg.close();
});

test('who may do it: the anonymous caller 401, an outsider 403, a closed catalog 403, no anti-forgery header 403 (nothing written); both owners may; the actor is the signed-in owner, never a name from the request', async () => {
  const w = await world(); await seedStates(w); const fp = await w.fingerprint(DATA);
  const body = { expected_activation: 'retired', confirm: 'reopen', seen: 'x', reason: 'סיבה' };
  assert.deepEqual([(await act(w, 23, 13, 'reopen', body)).status, (await act(w, 23, 13, 'reopen', body)).body.error], [403, 'catalog_disabled'], 'closed'); await w.open();
  for (const [action, p, s, expected] of [['reopen', 23, 13, 'retired'], ['return_to_review', 23, 12, 'paused'], ['pause', 21, 11, 'pending']]) {
    const b = Object.assign({}, body, { expected_activation: expected, confirm: action });
    assert.equal((await act(w, p, s, action, b, null)).status, 401, action); const out = await act(w, p, s, action, b, STRANGER); assert.deepEqual([out.status, out.body.error], [403, 'forbidden'], action);
    const csrf = await w.call('POST', E(p, s) + '/actions/' + action, YOSI, { body: b, noCsrf: true }); assert.deepEqual([csrf.status, csrf.body.error], [403, 'csrf'], action);
  }
  assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written by any of them');
  assert.equal((await run(w, 23, 13, 'reopen', 'retired', {}, YOSI)).status, 200); assert.equal((await run(w, 23, 12, 'return_to_review', 'paused', {}, AVI)).status, 200); assert.equal((await run(w, 21, 11, 'pause', 'pending', {}, AVI)).status, 200);
  assert.deepEqual((await w.audits("action IN ('catalog.engagement.reopen', 'catalog.engagement.return_to_review', 'catalog.engagement.pause')")).map((a) => [a.actor, a.action]), [[YOSI, 'catalog.engagement.reopen'], [AVI, 'catalog.engagement.return_to_review'], [AVI, 'catalog.engagement.pause']]);
  const everything = JSON.stringify(await w.audits()); for (const secret of ['0501234567', '0521112233', 'dana@example', 'NOTE-SECRET-XYZ', 'PAYER-SECRET', 'שוחחנו בטלפון']) assert.equal(everything.includes(secret), false, 'not in the journal: ' + secret);
  await w.pg.close();
});

test('the provider must be available to reopen or return to review (archived: refused, paused until a day to come: refused, a pause that is over: allowed); the rule is checked again inside the UPDATE, so a stale read does not get past it', async () => {
  const w = await world(); await w.open(); await seedStates(w);
  for (const [action, p, s, expected] of [['reopen', 23, 13, 'retired'], ['return_to_review', 23, 12, 'paused']]) {
    const fp = await w.fingerprint(DATA);
    await w.owner('INSERT INTO provider_profiles (professional_id, archived_at) VALUES (23, now()) ON CONFLICT (professional_id) DO UPDATE SET archived_at = now(), paused_until = NULL');
    let r = await run(w, p, s, action, expected); assert.deepEqual([r.status, r.body.error, r.body.errors], [422, 'transition_refused', ['provider_archived']], action);
    await w.owner("UPDATE provider_profiles SET archived_at = NULL, paused_until = now() + interval '5 days' WHERE professional_id = 23");
    r = await run(w, p, s, action, expected); assert.deepEqual([r.status, r.body.errors], [422, ['provider_paused']], action);
    assert.deepEqual(await w.fingerprint(DATA.filter((t) => t !== 'provider_profiles')), Object.fromEntries(Object.entries(fp).filter(([t]) => t !== 'provider_profiles')), 'nothing written: ' + action);
    // the machine and the UPDATE agree: the owner read the page while the provider was free, and the provider was archived before the click: the UPDATE itself refuses
    await w.owner("UPDATE provider_profiles SET paused_until = NULL WHERE professional_id = 23"); const stale = await store.loadEngagement(p, s);
    await w.owner('UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 23');
    const real = store.loadEngagement; let first = true; store.loadEngagement = async (...a) => { if (first) { first = false; return stale; } return real(...a); };
    try { r = await act(w, p, s, action, { expected_activation: expected, confirm: action, seen: stale.seen, reason: 'סיבה' }); } finally { store.loadEngagement = real; }
    assert.deepEqual([r.status, r.body.error], [409, 'provider_archived'], action + ': the update refused it'); assert.equal((await rowOf(w, p, s)).activation, expected, 'unchanged');
    // the same with a pause that began after the read
    await w.owner('UPDATE provider_profiles SET archived_at = NULL, paused_until = NULL WHERE professional_id = 23'); const stale3 = await store.loadEngagement(p, s);
    await w.owner("UPDATE provider_profiles SET paused_until = now() + interval '5 days' WHERE professional_id = 23"); let once3 = true; store.loadEngagement = async (...a) => { if (once3) { once3 = false; return stale3; } return real(...a); };
    try { r = await act(w, p, s, action, { expected_activation: expected, confirm: action, seen: stale3.seen, reason: 'סיבה' }); } finally { store.loadEngagement = real; }
    assert.deepEqual([r.status, r.body.error], [409, 'provider_paused'], action + ': the update refused it (pause)'); assert.equal((await rowOf(w, p, s)).activation, expected, 'unchanged');
    // a pause that is over does not block
    await w.owner("UPDATE provider_profiles SET archived_at = NULL, paused_until = '2026-11-01T00:00:00Z' WHERE professional_id = 23");
    assert.equal((await run(w, p, s, action, expected)).status, 200, action + ' after the pause ended');
  }
  assert.deepEqual((await w.audits("action IN ('catalog.engagement.reopen', 'catalog.engagement.return_to_review')")).map((a) => a.action), ['catalog.engagement.reopen', 'catalog.engagement.return_to_review'], 'one row for each change, none for a refusal');
  await w.pg.close();
});

test('stale data: whatever the owner saw and then moved (state, signature, price, price approval, provider, pause reason) is refused with "look again"; a second owner who got there first wins, a double click does it once', async () => {
  const w = await world(); await w.open(); await seedStates(w);
  // the page was read, then something else moved: each of these makes the old view invalid
  const moves = [
    ['reopen', 23, 13, 'retired', "agreement_state = 'ended'"], ['reopen', 23, 13, 'retired', "contact_state = 'stopped'"], ['reopen', 23, 13, 'retired', "pricing_model = 'quote'"], ['reopen', 23, 13, 'retired', 'pricing_id = 8, pricing_model = $$fixed$$'],
    ['return_to_review', 23, 12, 'paused', "paused_reason = 'אחרת'"], ['pause', 21, 11, 'pending', "agreement_state = 'ended'"],
  ];
  for (const [action, p, s, expected, sets] of moves) {
    const fp0 = await rowOf(w, p, s), seen = await seenOf(w, p, s); await put(w, p, s, sets); const fp = await w.fingerprint(DATA);
    const r = await act(w, p, s, action, { expected_activation: expected, confirm: action, seen, reason: 'סיבה' }); assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], action + ' after ' + sets);
    assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written'); await put(w, p, s, 'agreement_state = $$' + fp0.agreement_state + '$$, contact_state = $$' + fp0.contact_state + '$$, pricing_model = $$' + fp0.pricing_model + '$$, pricing_id = ' + (fp0.pricing_id === null ? 'NULL' : fp0.pricing_id) + ', paused_reason = ' + (fp0.paused_reason === null ? 'NULL' : '$$' + fp0.paused_reason + '$$'));
  }
  { const seen = await seenOf(w, 23, 13); await w.owner('UPDATE pricing SET approved = false WHERE id = 7'); const fp = await w.fingerprint(DATA); await put(w, 23, 13, 'pricing_id = 7, pricing_model = $$fixed$$'); await w.owner('UPDATE pricing SET approved = true WHERE id = 7');
    const r = await act(w, 23, 13, 'reopen', { expected_activation: 'retired', confirm: 'reopen', seen, reason: 'סיבה' }); assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], 'a price linked or approved since'); assert.notDeepEqual(await w.fingerprint(DATA), fp); assert.equal((await rowOf(w, 23, 13)).activation, 'retired'); await put(w, 23, 13, 'pricing_id = NULL, pricing_model = $$tbd$$'); }
  { const seen = await seenOf(w, 23, 13); await w.owner('INSERT INTO provider_profiles (professional_id, archived_at) VALUES (23, now()) ON CONFLICT (professional_id) DO UPDATE SET archived_at = now()');
    const r = await act(w, 23, 13, 'reopen', { expected_activation: 'retired', confirm: 'reopen', seen, reason: 'סיבה' }); assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], 'a provider archived since'); await w.owner('UPDATE provider_profiles SET archived_at = NULL WHERE professional_id = 23'); }
  // two owners looked at the same retired engagement: the first to act wins, the second is told the state changed and nothing is done twice
  const seenA = await seenOf(w, 23, 13), seenB = await seenOf(w, 23, 13); assert.equal(seenA, seenB);
  const first = await act(w, 23, 13, 'reopen', { expected_activation: 'retired', confirm: 'reopen', seen: seenA, reason: 'ראשון' }, YOSI), second = await act(w, 23, 13, 'reopen', { expected_activation: 'retired', confirm: 'reopen', seen: seenB, reason: 'שני' }, AVI);
  assert.deepEqual([first.status, second.status, second.body.error], [200, 409, 'conflict']); const log = (await journal(w, 23, 13)).filter((a) => a.action === 'catalog.engagement.reopen'); assert.deepEqual(log.map((a) => [a.actor, a.detail.reason]), [[YOSI, 'ראשון']], 'one change, one row, the first owner');
  // a double click: the same request twice, one effect
  const seenC = await seenOf(w, 23, 12), body = { expected_activation: 'paused', confirm: 'return_to_review', seen: seenC, reason: 'בדיקה' };
  assert.deepEqual([(await act(w, 23, 12, 'return_to_review', body)).status, (await act(w, 23, 12, 'return_to_review', body)).body.error], [200, 'conflict']); assert.equal((await journal(w, 23, 12)).filter((a) => a.action === 'catalog.engagement.return_to_review').length, 1);
  // the other owner got in between the read and the UPDATE: the UPDATE itself refuses (the state it saw is not there any more)
  await put(w, 23, 12, "activation = 'paused', paused_reason = 'שוב'"); const stale = await store.loadEngagement(23, 12); await put(w, 23, 12, "activation = 'retired', retired_at = now(), retired_reason = 'בינתיים', paused_reason = NULL");
  const real = store.loadEngagement; let once = true; store.loadEngagement = async (...a) => { if (once) { once = false; return stale; } return real(...a); }; let r;
  try { r = await act(w, 23, 12, 'return_to_review', { expected_activation: 'paused', confirm: 'return_to_review', seen: stale.seen, reason: 'סיבה' }); } finally { store.loadEngagement = real; }
  assert.deepEqual([r.status, r.body.error], [409, 'conflict']); assert.equal((await rowOf(w, 23, 12)).activation, 'retired', 'the other owner\'s change stands');
  // the state is the same but the signature changed between the read and the UPDATE: the UPDATE compares what the decision was made on, and refuses
  await put(w, 21, 11, "activation = 'retired', retired_at = now(), retired_reason = 'x', agreement_state = 'signed', contact_state = 'active', paused_reason = NULL"); const stale2 = await store.loadEngagement(21, 11); await put(w, 21, 11, "agreement_state = 'ended'");
  let again = true; store.loadEngagement = async (...a) => { if (again) { again = false; return stale2; } return real(...a); }; let r2;
  try { r2 = await act(w, 21, 11, 'reopen', { expected_activation: 'retired', confirm: 'reopen', seen: stale2.seen, reason: 'סיבה' }); } finally { store.loadEngagement = real; }
  assert.deepEqual([r2.status, r2.body.error], [409, 'seen_changed']); assert.deepEqual([(await rowOf(w, 21, 11)).activation, (await rowOf(w, 21, 11)).agreement_state], ['retired', 'ended'], 'nothing was decided on a view that was already out of date');
  await w.pg.close();
});

test('a failure at any point leaves nothing behind (no half change, no journal row without its change); a lost reply after the commit leaves one complete change; the same request works afterwards', async () => {
  const w = await world(); await w.open(); await seedStates(w);
  const cases = [['reopen', 23, 13, 'retired', 'draft'], ['return_to_review', 23, 12, 'paused', 'pending'], ['pause', 21, 11, 'pending', 'paused']];
  for (const [action, p, s, from, to] of cases) {
    const fp = await w.fingerprint(DATA), body = { expected_activation: from, confirm: action, seen: await seenOf(w, p, s), reason: 'סיבה' };
    // statements: 0 and 1 are the two timeouts, 2 and 3 the counted update and its guard, 4 the journal row
    for (const at of [2, 3, 4, 'commit']) { w.failAt = at; const r = await act(w, p, s, action, body); w.failAt = null; assert.ok([500, 502].includes(r.status), action + ' failure reported at ' + at + ': ' + r.status); assert.deepEqual(await w.fingerprint(DATA), fp, action + ': nothing left behind when it fails at ' + at); }
    assert.equal((await act(w, p, s, action, body)).status, 200, action + ' works afterwards with the same view: no leftover blocks it'); assert.equal((await rowOf(w, p, s)).activation, to);
  }
  // the reply is lost AFTER the commit: the person is told the result is unknown, and what exists is complete
  await put(w, 22, 12, "activation = 'retired', retired_at = now(), retired_reason = 'x'"); const body = { expected_activation: 'retired', confirm: 'reopen', seen: await seenOf(w, 22, 12), reason: 'סיבה' };
  w.failAfterCommit = true; w.failWith = { code: null, message: 'fetch failed' }; const lost = await act(w, 22, 12, 'reopen', body); w.failAfterCommit = false; w.failWith = null;
  assert.deepEqual([lost.status, lost.body.error], [502, 'result_unknown']); assert.equal((await rowOf(w, 22, 12)).activation, 'draft'); assert.equal((await journal(w, 22, 12)).filter((a) => a.action === 'catalog.engagement.reopen').length, 1, 'the change and its row are both there, once');
  assert.equal((await act(w, 22, 12, 'reopen', body)).body.error, 'conflict', 'sending it again is refused by the data, never doubled');
  await w.pg.close();
});

test('nothing here gives an active engagement, deletes anything or opens the switch: no combination of the new actions reaches "active"; the pair is never copied; the old actions work as before; the new actions are the only ones that need a confirmation and a view', async () => {
  const w = await world(); await w.open(); await seedStates(w); const switchBefore = await w.owner("SELECT value FROM settings WHERE key = 'private.catalog_activation_enabled'");
  await put(w, 23, 13, "agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 7"); await w.setSetting('private.catalog_activation_enabled', true);   // the most favourable case: a complete checklist, an approved price, the switch open
  const rows = await w.count('provider_services');
  // reopen -> draft -> (submit) pending -> pause -> return_to_review -> pending: at no point active
  assert.equal((await run(w, 23, 13, 'reopen', 'retired')).body.activation, 'draft'); await noActive(w, ['24/11']);
  assert.equal((await act(w, 23, 13, 'submit', { expected_activation: 'draft' })).body.activation, 'pending'); await noActive(w, ['24/11']);
  assert.equal((await run(w, 23, 13, 'pause', 'pending')).body.activation, 'paused'); assert.equal((await run(w, 23, 13, 'return_to_review', 'paused')).body.activation, 'pending'); await noActive(w, ['24/11']);
  // the old six keep their rules: submit, withdraw and retire need no confirmation and no view, as before; the activation actions still need the activation confirmation
  assert.equal((await act(w, 23, 13, 'withdraw', { expected_activation: 'pending' })).body.activation, 'draft'); assert.equal((await act(w, 23, 13, 'submit', { expected_activation: 'draft' })).status, 200); assert.equal((await act(w, 23, 13, 'retire', { expected_activation: 'pending', reason: 'סגירה' })).body.activation, 'retired');
  for (const action of ['reopen', 'return_to_review', 'pause']) assert.equal((await act(w, 23, 13, action, { expected_activation: 'retired', confirm: 'activate', seen: await seenOf(w, 23, 13), reason: 'x' })).body.error, 'confirmation_required', action + ' with the word of the activation');
  assert.equal((await act(w, 23, 13, 'activate', { expected_activation: 'retired', confirm: 'reopen', seen: await seenOf(w, 23, 13) })).body.error, 'confirmation_required');
  for (const old of ['submit', 'withdraw', 'activate', 'pause', 'resume']) assert.notEqual((await act(w, 23, 13, old, { expected_activation: 'retired', reason: 'x', confirm: old === 'pause' ? 'pause' : 'activate', seen: await seenOf(w, 23, 13) })).status, 200, 'a retired engagement refuses ' + old);
  await noActive(w, ['24/11']);
  // the pair is unique and nothing is deleted: a new engagement for a reopened or retired pair is "already exists"; there is no delete route; the count of rows only grew by what the tests inserted
  assert.equal((await w.call('POST', '/catalog/engagements', YOSI, j({ provider_id: 23, service_id: 13, activation: 'pending' }))).body.error, 'engagement_exists'); assert.equal((await w.call('DELETE', E(23, 13), YOSI)).status, 404);
  assert.equal(await w.count('provider_services'), rows); assert.deepEqual((await w.owner("SELECT value FROM settings WHERE key = 'private.catalog_activation_enabled'")).length, 1);
  assert.deepEqual(switchBefore, [], 'the switch did not exist before the test opened it: no action created or changed it');
  // an unknown action is still "not found"; the route list did not grow (the same route, two more words)
  assert.equal((await act(w, 23, 13, 'explode', { expected_activation: 'retired' })).status, 404); assert.equal((await act(w, 23, 13, 'Reopen', { expected_activation: 'retired' })).status, 404); assert.equal((await act(w, 23, 13, 'reopen/x', { expected_activation: 'retired' })).status, 404); assert.equal((await act(w, 23, 13, 'reopen', { expected_activation: 'retired' })).body.error, 'confirmation_required', 'the route is the same one, and it asks for the confirmation');
  await w.pg.close();
});

test('the engagement card keeps a past retirement apart from a current one (a reopened engagement is not "retired"), and the view token covers the pause reason and the retirement date', async () => {
  const w = await world(); await w.open(); await seedStates(w);
  const retired = (await card(w, 23, 13)).engagement; assert.deepEqual([retired.activation, retired.retired_reason, retired.retired_at !== null, retired.last_retired_at, retired.last_retired_reason, retired.last_reopened_at], ['retired', 'הספק עזב', true, null, null, null]);
  assert.equal((await run(w, 23, 13, 'reopen', 'retired', { reason: 'חזרה' })).status, 200);
  const reopened = (await card(w, 23, 13)).engagement; assert.deepEqual([reopened.activation, reopened.retired_reason, reopened.retired_at, reopened.last_retired_reason, WHEN(reopened.last_retired_at), reopened.last_reopened_at !== null], ['draft', null, null, 'הספק עזב', WHEN('2026-11-01T10:00:00Z'), true]);
  // never retired: the fields of a past retirement are empty, not invented
  const fresh = (await card(w, 22, 12)).engagement; assert.deepEqual([fresh.retired_at, fresh.retired_reason, fresh.last_retired_at, fresh.last_retired_reason, fresh.last_reopened_at], [null, null, null, null, null]);
  // retired again: the current retirement is the new one; the journal still has the earlier one
  assert.equal((await act(w, 23, 13, 'retire', { expected_activation: 'draft', reason: 'שוב הוצאה' })).status, 200);
  const again = (await card(w, 23, 13)).engagement; assert.deepEqual([again.activation, again.retired_reason, again.last_retired_at, again.last_reopened_at !== null], ['retired', 'שוב הוצאה', null, true]);
  assert.deepEqual((await journal(w, 23, 13)).map((a) => a.action), ['catalog.engagement.reopen', 'catalog.engagement.retire'], 'the earlier retirement was made by hand here; the later one and the reopening are in the journal');
  // the view token moves with the pause reason and the retirement date (the controlled actions decide on what the owner saw)
  const s1 = await seenOf(w, 23, 12); await put(w, 23, 12, "paused_reason = 'אחרת'"); assert.notEqual(await seenOf(w, 23, 12), s1, 'pause reason'); const s2 = await seenOf(w, 23, 13); await put(w, 23, 13, "retired_at = now() + interval '1 hour'"); assert.notEqual(await seenOf(w, 23, 13), s2, 'retirement date');
  await w.pg.close();
});

test('REOPEN and the contact state: an "active" collaboration goes back to "contacted" (an existing value) and the journal keeps what it was; every other contact state stays as stated; no reopened draft shows an active collaboration', async () => {
  const w = await world(); await w.open();
  for (const [was, now, reset] of [['active', 'contacted', true], ['negotiating', 'negotiating', false], ['contacted', 'contacted', false], ['none', 'none', false], ['stopped', 'stopped', false]]) {
    await put(w, 21, 11, "activation = 'retired', retired_at = now(), retired_reason = 'x', agreement_state = 'draft', contact_state = '" + was + "', paused_reason = NULL");
    const r = await run(w, 21, 11, 'reopen', 'retired'); assert.deepEqual([r.status, r.body.contact_state, r.body.contact_reset, r.body.agreement_reset], [200, now, reset, false], was);
    assert.equal((await rowOf(w, 21, 11)).contact_state, now, was); const d = (await journal(w, 21, 11)).filter((a) => a.action === 'catalog.engagement.reopen').pop().detail;
    assert.deepEqual(d.reset, reset ? { contact_state: [was, now] } : undefined, 'the journal says what was set back: ' + was);
  }
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'draft' AND contact_state = 'active'"))[0].n, 0, 'no reopened draft shows an active collaboration');
  await noActive(w); await w.pg.close();
});

test('REOPEN more than once: retire, reopen, state it all again, retire again, reopen again; each reopening sets back what was stated since; the journal keeps every retirement and every reopening in order, each with its own date; the card names the LAST retirement as history', async () => {
  const w = await world(); await w.open(); await put(w, 21, 11, "agreement_state = 'signed', contact_state = 'active'");
  assert.equal((await act(w, 21, 11, 'retire', { expected_activation: 'pending', reason: 'הוצאה ראשונה' })).status, 200); const first = (await rowOf(w, 21, 11)).retired_at;
  assert.deepEqual([(await run(w, 21, 11, 'reopen', 'retired', { reason: 'פתיחה ראשונה' })).status, (await rowOf(w, 21, 11)).agreement_state, (await rowOf(w, 21, 11)).contact_state], [200, 'draft', 'contacted']);
  // the owners state both again, by hand (the ordinary tracking edit of a draft), and the engagement is retired once more
  const edit = await w.call('PATCH', E(21, 11), YOSI, j({ changes: { agreement_state: 'signed', contact_state: 'active' }, expected: { agreement_state: 'draft', contact_state: 'contacted' } })); assert.equal(edit.status, 200);
  assert.equal((await act(w, 21, 11, 'retire', { expected_activation: 'draft', reason: 'הוצאה שנייה' })).status, 200); const second = (await rowOf(w, 21, 11)).retired_at; assert.ok(WHEN(second) > WHEN(first), 'a later date');
  const r = await run(w, 21, 11, 'reopen', 'retired', { reason: 'פתיחה שנייה' }, AVI); assert.deepEqual([r.status, r.body.agreement_reset, r.body.contact_reset, r.body.agreement_state, r.body.contact_state], [200, true, true, 'draft', 'contacted'], 'what was stated in between is set back again');
  const log = (await journal(w, 21, 11)).filter((a) => a.action !== 'catalog.engagement.update');
  assert.deepEqual(log.map((a) => a.action + ':' + (a.detail.reason || '')), ['catalog.engagement.retire:הוצאה ראשונה', 'catalog.engagement.reopen:פתיחה ראשונה', 'catalog.engagement.retire:הוצאה שנייה', 'catalog.engagement.reopen:פתיחה שנייה'], 'nothing replaced anything: four events in order');
  assert.deepEqual([WHEN(log[1].detail.previous_retired_at), WHEN(log[3].detail.previous_retired_at)], [WHEN(first), WHEN(second)], 'each reopening records the retirement it found: the first one is still in the journal after the row was overwritten by the second');
  assert.deepEqual(log[3].detail.reset, { agreement_state: ['signed', 'draft'], contact_state: ['active', 'contacted'] });
  const c = (await card(w, 21, 11)).engagement; assert.deepEqual([c.activation, c.retired_at, c.last_retired_reason, WHEN(c.last_retired_at)], ['draft', null, 'הוצאה שנייה', WHEN(second)], 'the card names the last retirement, as history');
  assert.equal((await run(w, 21, 11, 'reopen', 'retired')).body.error, 'conflict', 'it is a draft now: a third reopening at once is refused'); await noActive(w);
  await w.pg.close();
});

test('the price link stays through a reopening (nothing is deleted) and is not a valid price by that fact: the activation still checks the approval of the price, on the server and again inside the UPDATE; a price that is no longer approved, was changed through the older screen, or was deleted stops the activation', async () => {
  const w = await world(); await w.open(); const link = async () => (await w.owner('SELECT pricing_id::text AS id, pricing_model AS model FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0];
  await put(w, 21, 11, "agreement_state = 'signed', contact_state = 'active'"); assert.equal((await act(w, 21, 11, 'retire', { expected_activation: 'pending', reason: 'הוצאה' })).status, 200);
  const linked = await link(); assert.deepEqual(linked, { id: '7', model: 'fixed' });
  assert.equal((await run(w, 21, 11, 'reopen', 'retired')).status, 200); assert.deepEqual(await link(), linked, 'the link and the model are still there');
  assert.equal((await card(w, 21, 11)).approved_price.id, 7);
  // the owners state both again and the engagement goes to pending; the activation switch is open for the rest of the test
  assert.equal((await w.call('PATCH', E(21, 11), YOSI, j({ changes: { agreement_state: 'signed', contact_state: 'active' }, expected: { agreement_state: 'draft', contact_state: 'contacted' } }))).status, 200);
  assert.equal((await act(w, 21, 11, 'submit', { expected_activation: 'draft' })).status, 200); await w.setSetting('private.catalog_activation_enabled', true);
  const tryActivate = async () => act(w, 21, 11, 'activate', { expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w, 21, 11) });
  assert.equal((await card(w, 21, 11)).checklist.can_activate, true, 'with the price approved and everything stated again it could be activated: the checks below are what stops it');
  // 1. the approval was withdrawn (as the older screen does when a price is edited)
  await w.owner('UPDATE pricing SET approved = false, approved_by = NULL, approved_at = NULL, public = false WHERE id = 7');
  let r = await tryActivate(); assert.deepEqual([r.status, r.body.error, r.body.missing], [422, 'transition_refused', ['price_approved']]); await noActive(w);
  // 2. the price was edited and approved again: that is a new approval and it is accepted as one
  await w.owner("UPDATE pricing SET price = 1500, approved = true, approved_by = 'yosi@example.test', approved_at = now() WHERE id = 7"); assert.equal((await card(w, 21, 11)).checklist.can_activate, true);
  // 3. the price row was deleted: the link is empty and the engagement says so
  await w.owner('DELETE FROM pricing WHERE id = 7'); r = await tryActivate(); assert.deepEqual([r.status, r.body.error, r.body.missing.includes('fixed_price_linked'), r.body.missing.includes('price_approved')], [422, 'transition_refused', true, true]); await noActive(w);
  await w.pg.close();
  // 4. the approval is withdrawn AFTER the owner read the page: the old view is the one the route sees, and the UPDATE itself refuses
  const w2 = await world(); await w2.open(); await w2.setSetting('private.catalog_activation_enabled', true); await put(w2, 21, 11, "agreement_state = 'signed', contact_state = 'active'");
  const stale = await store.loadEngagement(21, 11); await w2.owner('UPDATE pricing SET approved = false WHERE id = 7'); const real = store.loadEngagement; let once = true; store.loadEngagement = async (...a) => { if (once) { once = false; return stale; } return real(...a); };
  try { r = await act(w2, 21, 11, 'activate', { expected_activation: 'pending', confirm: 'activate', seen: stale.seen }); } finally { store.loadEngagement = real; }
  assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], 'the update refused it'); await noActive(w2); await w2.pg.close();
});

// ---- the price at the moment of the activation (the gap found in 5b-2b-1, now closed): the link stays when the older pricing screen moves or changes the price row, so the activation decides again ---------------------------
// an engagement that has everything the checklist asks for (pending, signed, an active collaboration, price 7 of service 11 and provider 21, service 11 cleared) with the activation switch OPEN, and then something done to the price row
const priceCase = async (sql) => { const w = await world(); await w.open(); await w.setSetting('private.catalog_activation_enabled', true); await put(w, 21, 11, "agreement_state = 'signed', contact_state = 'active'"); if (sql) await w.owner(sql); return w; };
const activate = async (w, who, extra) => act(w, 21, 11, 'activate', Object.assign({ expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w, 21, 11) }, extra || {}), who);
const PRICE_CASES = [   // [what happened to the price row, the SQL, may it still be the price of this engagement]
  ['nothing (the price as linked)', null, true],
  ['moved to ANOTHER SERVICE (still approved)', 'UPDATE pricing SET service_id = 12 WHERE id = 7', false],
  ['moved to ANOTHER PROVIDER (still approved)', 'UPDATE pricing SET professional_id = 22 WHERE id = 7', false],
  ['approved but WITHOUT AN AMOUNT', 'UPDATE pricing SET price = NULL WHERE id = 7', false],
  ['NO LONGER APPROVED', 'UPDATE pricing SET approved = false, approved_by = NULL, approved_at = NULL, public = false WHERE id = 7', false],
  ['a GENERAL price (no provider) of the same service', 'UPDATE pricing SET professional_id = NULL WHERE id = 7', true],
  ['a general price of ANOTHER service', 'UPDATE pricing SET professional_id = NULL, service_id = 12 WHERE id = 7', false],
];

test('ACTIVATION decides about the price again, by the rule of the linking route: a price moved to another service or provider, approved without an amount, or no longer approved stops it; a general price of the same service is accepted; the linking route and the activation agree on every case', async () => {
  for (const [name, sql, fits] of PRICE_CASES) {
    const w = await priceCase(sql);
    const link = await w.call('POST', E(21, 11) + '/link-price', YOSI, j({ pricing_id: 7, expected_pricing_id: 7 }));   // the same price, offered to the same engagement again, by the other route
    const c = await card(w, 21, 11), shown = c.checklist.items.find((i) => i.key === 'price_approved').ok, r = await activate(w, YOSI);
    assert.deepEqual([link.status === 200, shown, r.status === 200], [fits, fits, fits], name + ': the linking route, the checklist and the activation say the same');
    if (!fits) { assert.deepEqual([r.status, r.body.error, r.body.missing], [422, 'transition_refused', ['price_approved']], name); assert.equal(link.body.error, 'price_not_eligible', name); assert.equal((await rowOf(w, 21, 11)).activation, 'pending', name + ': nothing activated'); assert.equal(w.alerts.length, 0); }
    else { assert.equal((await rowOf(w, 21, 11)).activation, 'active', name); assert.equal(w.alerts.length, 1, 'the owners are told once'); assert.deepEqual((await w.audits("action = 'catalog.engagement.activate'"))[0].detail.checklist.filter((x) => /price/.test(x)), ['fixed_price_linked:ok', 'price_approved:ok']); }
    await w.pg.close();
  }
});

test('a change to the price after the card was opened and before the activation: the old view is refused; a read that was already out of date is refused by the UPDATE itself; the view moves with the price (its service, provider, amount and approval)', async () => {
  for (const [name, sql, fits] of PRICE_CASES.filter((x) => x[1] && !x[0].startsWith('a GENERAL'))) {
    const w = await priceCase(null), seen = await seenOf(w, 21, 11); await w.owner(sql); const fp = await w.fingerprint(DATA);
    assert.notEqual(await seenOf(w, 21, 11), seen, name + ': the view moved with the price');
    const r = await activate(w, YOSI, { seen }); assert.deepEqual([r.status, r.body.error], [409, 'seen_changed'], name + ': the old view'); assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing written'); assert.equal(fits, false); await w.pg.close();
    // the page was read when the price fitted; the price moved before the UPDATE; the route still sees the old read; the UPDATE compares the price row itself and refuses
    const w2 = await priceCase(null), stale = await store.loadEngagement(21, 11); assert.equal(stale.list.canActivate, true, 'at the time of the read everything was in order'); await w2.owner(sql);
    const real = store.loadEngagement; let once = true; store.loadEngagement = async (...a) => { if (once) { once = false; return stale; } return real(...a); }; let r2;
    try { r2 = await act(w2, 21, 11, 'activate', { expected_activation: 'pending', confirm: 'activate', seen: stale.seen }); } finally { store.loadEngagement = real; }
    assert.deepEqual([r2.status, r2.body.error], [409, 'seen_changed'], name + ': the update itself refused it'); assert.equal((await rowOf(w2, 21, 11)).activation, 'pending'); assert.equal((await w2.audits("action = 'catalog.engagement.activate'")).length, 0); assert.equal(w2.alerts.length, 0); await w2.pg.close();
  }
});

test('a failure in the middle of the activation leaves nothing behind; two owners who looked at the same card: the first activates, the second is told the state changed; a lost reply leaves one complete activation, and sending it again is refused by the data', async () => {
  const w = await priceCase(null), fp = await w.fingerprint(DATA), b = { expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w, 21, 11) };
  // statements: 0 and 1 are the two timeouts, 2 and 3 the counted update and its guard, 4 the journal row
  for (const at of [2, 3, 4, 'commit']) { w.failAt = at; const r = await act(w, 21, 11, 'activate', b); w.failAt = null; assert.ok([500, 502].includes(r.status), 'failure reported at ' + at + ': ' + r.status); assert.deepEqual(await w.fingerprint(DATA), fp, 'nothing left behind when it fails at ' + at); assert.equal(w.alerts.length, 0, 'no alert for an activation that did not happen'); }
  const first = await act(w, 21, 11, 'activate', b, YOSI), second = await act(w, 21, 11, 'activate', b, AVI);
  assert.deepEqual([first.status, second.status, second.body.error], [200, 409, 'conflict'], 'the same request after nothing was left behind works, and the second owner is too late');
  assert.deepEqual((await w.audits("action = 'catalog.engagement.activate'")).map((a) => a.actor), [YOSI], 'one activation, by the first owner'); assert.equal(w.alerts.length, 1); await w.pg.close();
  const w2 = await priceCase(null), b2 = { expected_activation: 'pending', confirm: 'activate', seen: await seenOf(w2, 21, 11) };
  w2.failAfterCommit = true; w2.failWith = { code: null, message: 'fetch failed' }; const lost = await act(w2, 21, 11, 'activate', b2); w2.failAfterCommit = false; w2.failWith = null;
  assert.deepEqual([lost.status, lost.body.error], [502, 'result_unknown']); assert.equal((await rowOf(w2, 21, 11)).activation, 'active'); assert.equal((await w2.audits("action = 'catalog.engagement.activate'")).length, 1, 'the change and its journal row are both there, once');
  assert.equal((await act(w2, 21, 11, 'activate', b2)).body.error, 'conflict', 'sent again: refused by the data, never doubled'); await w2.pg.close();
});

test('the closed activation switch cannot be bypassed, even with a price that fits and everything stated: every value but exactly JSON true keeps it closed; no action and no other route creates or changes the switch', async () => {
  const w = await priceCase(null), settings = async () => await w.fingerprint(['settings']);
  for (const v of [undefined, false, 'true', 'yes', 1, 0, null, [], {}, { on: true }]) {
    await w.setSetting('private.catalog_activation_enabled', v); const s0 = await settings();
    const r = await activate(w, YOSI); assert.deepEqual([r.status, r.body.error], [403, 'activation_disabled'], 'switch ' + JSON.stringify(v)); assert.equal((await rowOf(w, 21, 11)).activation, 'pending'); assert.deepEqual(await settings(), s0, 'the switch is not touched by the refusal');
  }
  await w.setSetting('private.catalog_activation_enabled', false); const s1 = await settings();
  // the other ways to try: the typed word, the old settings route, the creation, the tracking edit, and every state change that is not an activation
  assert.equal((await activate(w, YOSI, { confirm: 'yes' })).body.error, 'activation_disabled', 'the switch is looked at first');
  const old = await w.call('PUT', '/settings', YOSI, j({ key: 'private.catalog_activation_enabled', value: true })); assert.deepEqual([old.status, old.body.error], [400, 'use_catalog_switch']);
  assert.equal((await w.call('POST', '/catalog/engagements', YOSI, j({ provider_id: 24, service_id: 12, activation: 'active' }))).body.error, 'bad_activation');
  assert.equal((await w.call('PATCH', E(21, 11), YOSI, j({ changes: { activation: 'active' }, expected: { activation: 'pending' } }))).body.error, 'unknown_field');
  for (const [action, expected] of [['pause', 'pending'], ['return_to_review', 'paused'], ['reopen', 'retired'], ['resume', 'paused']]) {
    const r = await act(w, 21, 11, action, { expected_activation: expected, confirm: 'activate', seen: await seenOf(w, 21, 11), reason: 'x' }); assert.notEqual(r.status, 200, action);
  }
  assert.deepEqual(await settings(), s1, 'no action created or changed the switch'); await noActive(w);
  // it works only when exactly true: that is the one thing the other tests of this group rely on
  await w.setSetting('private.catalog_activation_enabled', true); assert.equal((await activate(w, YOSI)).status, 200);
  await w.pg.close();
});

// A RISK that is NOT closed here (the owner did not approve widening the fix to the older route; see PROVIDER-M1-OLD-PRICING-ROUTE-RISK.md): the older pricing screen (PATCH /pricing/:id) may change, move or un-approve a price that is
// linked to an engagement that is ALREADY ACTIVE. It answers 200, the price stops being approved and public, and the engagement stays active and linked to it. Before any activation in production an active engagement must not be left linked to a price that became invalid.
test.todo('an active engagement is not left linked to a price that the older pricing screen changed, moved or un-approved (decision needed before any activation in production)');
