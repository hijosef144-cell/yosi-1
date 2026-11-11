'use strict';
// Catalog, pure engagement logic. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../netlify/functions/_kaspchem/catalog/states.js');

const NOW = '2026-11-08T10:00:00Z';
const ready = () => ({ professional_id: 1, service_id: 1, activation: 'pending', contact_state: 'active', agreement_state: 'signed', pricing_model: 'fixed', pricing_id: 7, paused_reason: null, retired_reason: null, retired_at: null });
const ctxOk = () => ({ service: { legal_cleared: true, finding_tags: ['t1'], topics: [] }, provider: { paused_until: null, archived_at: null }, pricing: { approved: true, fits: true }, now: NOW });

test('the transition table: exactly the allowed moves; a retired engagement can only go back to DRAFT (never to pending or active); nothing leads back to a state it should not', () => {
  const allowed = { draft: ['pending', 'retired'], pending: ['draft', 'active', 'paused', 'retired'], active: ['paused', 'retired'], paused: ['active', 'pending', 'retired'], retired: ['draft'] };
  for (const from of S.ACTIVATION) for (const to of S.ACTIVATION) assert.equal(S.canTransition(from, to), allowed[from].includes(to), from + ' -> ' + to);
  assert.equal(S.canTransition('retired', 'draft'), true); assert.equal(S.canTransition('retired', 'pending'), false); assert.equal(S.canTransition('retired', 'active'), false, 'a retired engagement never becomes active in one step');
  assert.equal(S.canTransition('draft', 'active'), false, 'no jump to active without passing "pending"'); assert.equal(S.canTransition('nonsense', 'draft'), false);
  assert.deepEqual(S.ACTIVATION.filter((to) => S.canTransition('paused', to)).sort(), ['active', 'pending', 'retired']);
});

test('the checklist: all six blocking items must hold; each one alone blocks; the later item never blocks; the missing list is stable and complete', () => {
  const full = S.checklist(ready(), ctxOk()); assert.equal(full.canActivate, true); assert.deepEqual(full.missing, []); assert.equal(full.items.length, 7); assert.equal(full.items.find((i) => i.key === 'delivery_ready').blocking, false);
  const breaks = {
    agreement_signed: (e) => { e.agreement_state = 'draft'; }, collaboration_active: (e) => { e.contact_state = 'negotiating'; }, fixed_price_linked: (e) => { e.pricing_id = null; },
    service_cleared: (e, c) => { c.service.legal_cleared = false; }, provider_available: (e, c) => { c.provider.archived_at = '2026-01-01T00:00:00Z'; }, price_approved: (e, c) => { c.pricing.approved = false; },
  };
  for (const [key, mutate] of Object.entries(breaks)) { const e = ready(), c = ctxOk(); mutate(e, c); const r = S.checklist(e, c); assert.deepEqual(r.missing, [key], key); assert.equal(r.canActivate, false); }
  const all = ready(); const c = ctxOk(); all.agreement_state = 'not_discussed'; all.contact_state = 'none'; all.pricing_id = null; c.service.legal_cleared = false; c.provider.paused_until = '2026-12-01T00:00:00Z'; c.pricing = null;
  assert.deepEqual(S.checklist(all, c).missing, ['agreement_signed', 'collaboration_active', 'fixed_price_linked', 'service_cleared', 'provider_available', 'price_approved'], 'every missing item, in a fixed order');
  const noMatch = ctxOk(); noMatch.service.finding_tags = []; noMatch.service.topics = []; assert.deepEqual(S.checklist(ready(), noMatch).missing, ['service_cleared'], 'cleared but matched to no finding or topic');
  const byTopic = ctxOk(); byTopic.service.finding_tags = []; byTopic.service.topics = ['lost-funds']; assert.equal(S.checklist(ready(), byTopic).canActivate, true);
});

test('the price counts only when it is approved AND fits the engagement (an amount, the engagement\'s service, general or the provider\'s own); a link alone is not a valid price, and a missing "fits" is a no', () => {
  const missing = (pricing) => { const c = ctxOk(); c.pricing = pricing; return S.checklist(ready(), c).missing; };
  assert.deepEqual(missing({ approved: true, fits: true }), []);
  for (const pricing of [{ approved: true, fits: false }, { approved: true }, { approved: true, fits: 'yes' }, { approved: false, fits: true }, { approved: 'true', fits: true }, { fits: true }, null]) assert.deepEqual(missing(pricing), ['price_approved'], JSON.stringify(pricing));
  assert.ok(S.ITEMS.find((i) => i.key === 'price_approved').label.includes('שייך לשירות'), 'the item says what it checks');
  assert.deepEqual(S.act(ready(), 'activate', {}, Object.assign(ctxOk(), { pricing: { approved: true, fits: false } })).missing, ['price_approved'], 'and the activation is refused for it');
});

test('a provider paused until a date blocks only until that date; no context at all blocks everything the server must check', () => {
  const c = ctxOk(); c.provider.paused_until = '2026-11-09T00:00:00Z'; assert.deepEqual(S.checklist(ready(), c).missing, ['provider_available']);
  c.provider.paused_until = '2026-11-07T00:00:00Z'; assert.equal(S.checklist(ready(), c).canActivate, true, 'the pause is over');
  const none = S.checklist(ready(), undefined); assert.deepEqual(none.missing, ['service_cleared', 'provider_available'.replace('provider_available', 'price_approved')], 'with no context: service not cleared and price not approved (the provider has no pause on record)');
});

test('decision D15: a percentage, per-case or open price can be documented but never activated, and the checklist says why', () => {
  for (const model of ['percent_of_result', 'percent_with_minimum', 'variable', 'quote']) {
    const e = ready(); e.pricing_model = model; const r = S.checklist(e, ctxOk()); assert.equal(r.canActivate, false, model); assert.ok(r.missing.includes('fixed_price_linked')); assert.equal(r.documentedOnly, true, model);
    assert.deepEqual(S.act(e, 'activate', {}, ctxOk()).errors, ['checklist_incomplete']);
  }
  const tbd = ready(); tbd.pricing_model = 'tbd'; assert.equal(S.checklist(tbd, ctxOk()).documentedOnly, false, '"not set" is not a documented model'); assert.equal(S.checklist(ready(), ctxOk()).documentedOnly, false);
});

test('the actions: submit, withdraw, activate, pause, resume, retire; reasons are mandatory; an engagement is activated only when the checklist is complete', () => {
  const draft = Object.assign(ready(), { activation: 'draft' });
  assert.equal(S.act(draft, 'submit').next.activation, 'pending'); assert.deepEqual(S.act(draft, 'activate', {}, ctxOk()).errors, ['activate_only_from_pending_or_paused']);
  assert.equal(S.act(ready(), 'withdraw').next.activation, 'draft'); assert.deepEqual(S.act(draft, 'withdraw').errors, ['not_allowed_from_draft']);
  const act = S.act(ready(), 'activate', {}, ctxOk()); assert.equal(act.ok, true); assert.equal(act.next.activation, 'active');
  const bad = ready(); bad.agreement_state = 'draft'; const refused = S.act(bad, 'activate', {}, ctxOk()); assert.equal(refused.ok, false); assert.deepEqual(refused.errors, ['checklist_incomplete']); assert.deepEqual(refused.missing, ['agreement_signed']);
  const active = act.next;
  assert.deepEqual(S.act(active, 'pause', {}, ctxOk()).errors, ['reason_required']); assert.deepEqual(S.act(active, 'pause', { reason: '   ' }, ctxOk()).errors, ['reason_required']);
  const paused = S.act(active, 'pause', { reason: ' ספק בחופשה ' }, ctxOk()); assert.equal(paused.next.activation, 'paused'); assert.equal(paused.next.paused_reason, 'ספק בחופשה');
  const resumed = S.act(paused.next, 'resume', {}, ctxOk()); assert.equal(resumed.ok, true); assert.equal(resumed.next.activation, 'active'); assert.equal(resumed.next.paused_reason, null);
  const lost = ctxOk(); lost.pricing.approved = false; assert.equal(S.act(paused.next, 'resume', {}, lost).ok, false, 'resuming needs the same checks as activating');
  assert.deepEqual(S.act(active, 'resume', {}, ctxOk()).errors, ['not_allowed_from_active']);
  assert.deepEqual(S.act(active, 'retire', {}, ctxOk()).errors, ['reason_required']);
  const retired = S.act(active, 'retire', { reason: 'הספק עזב', at: '2026-11-08T12:00:00Z' }, ctxOk()); assert.equal(retired.next.activation, 'retired'); assert.equal(retired.next.retired_reason, 'הספק עזב'); assert.equal(retired.next.retired_at, '2026-11-08T12:00:00.000Z');
  for (const a of ['submit', 'withdraw', 'activate', 'pause', 'resume', 'retire', 'return_to_review']) assert.equal(S.act(retired.next, a, { reason: 'x' }, ctxOk()).ok, false, 'a retired engagement refuses everything but "reopen": ' + a);
  assert.equal(S.act(ready(), 'retire', { reason: 'x' }).next.retired_at !== null, true, 'a retired engagement always carries its date');
  assert.deepEqual(S.act(ready(), 'explode').errors, ['unknown_action']); assert.deepEqual(S.act({ activation: 'weird' }, 'submit').errors, ['activation_unknown']);
});

test('the code and the database hold the same rule: every row act() produces is one the database rules accept, and the rules reject what the database rejects', () => {
  const okRows = [ready(), Object.assign(ready(), { activation: 'active' }), Object.assign(ready(), { activation: 'draft', agreement_state: 'not_discussed', contact_state: 'none', pricing_model: 'tbd', pricing_id: null }), Object.assign(ready(), { activation: 'retired', retired_at: '2026-11-01T00:00:00Z' })];
  okRows.forEach((r) => assert.deepEqual(S.dbRuleViolations(r), []));
  const bad = [Object.assign(ready(), { activation: 'active', agreement_state: 'draft' }), Object.assign(ready(), { activation: 'active', contact_state: 'contacted' }), Object.assign(ready(), { activation: 'active', pricing_model: 'quote' }), Object.assign(ready(), { activation: 'active', pricing_id: null }),
    Object.assign(ready(), { activation: 'retired' }), Object.assign(ready(), { activation: 'live' }), Object.assign(ready(), { contact_state: 'called' }), Object.assign(ready(), { agreement_state: 'verbal' }), Object.assign(ready(), { pricing_model: 'free' })];
  bad.forEach((r) => assert.ok(S.dbRuleViolations(r).length > 0, JSON.stringify(r)));
});

test('nothing is mutated: the engagement and the context come back untouched', () => {
  const e = Object.freeze(ready()), c = Object.freeze({ service: Object.freeze({ legal_cleared: true, finding_tags: Object.freeze(['t']) }), provider: Object.freeze({}), pricing: Object.freeze({ approved: true, fits: true }), now: NOW });
  assert.doesNotThrow(() => S.checklist(e, c)); const r = S.act(e, 'activate', {}, c); assert.equal(r.ok, true); assert.notEqual(r.next, e); assert.equal(e.activation, 'pending');
});

test('reopen (retired -> DRAFT) and return_to_review (paused -> PENDING): the exact moves, a reason is mandatory, an unavailable or unknown provider blocks both, neither leads to active, nothing is signed or restored', () => {
  const retiredRow = (x) => Object.assign(ready(), { activation: 'retired', retired_at: '2026-11-01T00:00:00.000Z', retired_reason: 'הספק עזב', paused_reason: 'old' }, x || {});
  const pausedRow = (x) => Object.assign(ready(), { activation: 'paused', paused_reason: 'ספק בחופשה' }, x || {});
  // reopen: draft only; the retirement stays as history; the pause reason goes; the old signature does not count any more
  const r = S.act(retiredRow(), 'reopen', { reason: ' נפתח שוב ' }, ctxOk());
  assert.equal(r.ok, true); assert.equal(r.next.activation, 'draft'); assert.equal(r.next.retired_at, '2026-11-01T00:00:00.000Z', 'the date of the last retirement stays: it is history'); assert.equal(r.next.retired_reason, 'הספק עזב'); assert.equal(r.next.paused_reason, null);
  assert.equal(r.next.agreement_state, 'draft', 'a signature from before the retirement is not carried over'); assert.deepEqual([r.next.contact_state, r.next.pricing_model, r.next.pricing_id], ['contacted', 'fixed', 7], 'an "active" contact goes back to "contacted" (an existing value that does not say a collaboration is active); the price model and the price link stay');
  for (const [from, to] of [['active', 'contacted'], ['negotiating', 'negotiating'], ['contacted', 'contacted'], ['none', 'none'], ['stopped', 'stopped']]) assert.equal(S.act(retiredRow({ contact_state: from }), 'reopen', { reason: 'x' }, ctxOk()).next.contact_state, to, 'contact ' + from);
  assert.ok(S.CONTACT.includes('contacted'), 'the value it goes back to exists in the schema');
  for (const [from, to] of [['signed', 'draft'], ['ended', 'ended'], ['draft', 'draft'], ['not_discussed', 'not_discussed']]) assert.equal(S.act(retiredRow({ agreement_state: from }), 'reopen', { reason: 'x' }, ctxOk()).next.agreement_state, to, 'agreement ' + from);
  assert.equal(S.act(retiredRow({ agreement_state: 'ended' }), 'reopen', { reason: 'x' }, ctxOk()).next.agreement_state === 'signed', false, 'an ended agreement is never restored to signed');
  assert.deepEqual(S.dbRuleViolations(r.next), [], 'the reopened row is one the database accepts (a draft that still has a retirement date)');
  assert.deepEqual(S.checklist(r.next, ctxOk()).missing, ['agreement_signed', 'collaboration_active'], 'after the reopening the signature and the active collaboration are what is missing for an activation: both have to be stated again');
  assert.equal(S.checklist(r.next, ctxOk()).items.find((i) => i.key === 'fixed_price_linked').ok, true, 'the price link is still there (nothing is deleted); whether the price is valid is decided by the activation checks, not by the link');
  for (const bad of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: 5 }]) assert.deepEqual(S.act(retiredRow(), 'reopen', bad, ctxOk()).errors, ['reason_required']);
  for (const from of ['draft', 'pending', 'active', 'paused']) assert.deepEqual(S.act(retiredRow({ activation: from }), 'reopen', { reason: 'x' }, ctxOk()).errors, ['not_allowed_from_' + from], 'reopen only from retired: ' + from);
  // return_to_review: paused -> pending only; it is not an activation, so an incomplete checklist does not stop it, and a complete one does not make it active
  const q = S.act(pausedRow(), 'return_to_review', { reason: ' בדיקה מחדש ' }, ctxOk());
  assert.equal(q.ok, true); assert.equal(q.next.activation, 'pending'); assert.equal(q.next.paused_reason, null); assert.deepEqual([q.next.agreement_state, q.next.contact_state, q.next.pricing_model, q.next.pricing_id], ['signed', 'active', 'fixed', 7], 'only the state changes');
  assert.equal(S.act(pausedRow({ agreement_state: 'draft', contact_state: 'none', pricing_id: null }), 'return_to_review', { reason: 'x' }, ctxOk()).ok, true, 'an incomplete checklist does not matter: it is not an activation');
  for (const bad of [undefined, {}, { reason: '  ' }]) assert.deepEqual(S.act(pausedRow(), 'return_to_review', bad, ctxOk()).errors, ['reason_required']);
  for (const from of ['draft', 'pending', 'active', 'retired']) assert.deepEqual(S.act(pausedRow({ activation: from }), 'return_to_review', { reason: 'x' }, ctxOk()).errors, ['not_allowed_from_' + from], 'only from paused: ' + from);
  // both need an AVAILABLE provider, decided with what the caller knows; no context, or one without a provider, is a no
  for (const action of ['reopen', 'return_to_review']) {
    const row = action === 'reopen' ? retiredRow() : pausedRow(), arch = ctxOk(), paused = ctxOk(), ended = ctxOk();
    arch.provider.archived_at = '2026-10-01T00:00:00Z'; paused.provider.paused_until = '2026-11-09T00:00:00Z'; ended.provider.paused_until = '2026-11-07T00:00:00Z';
    assert.deepEqual(S.act(row, action, { reason: 'x' }, arch).errors, ['provider_archived'], action); assert.deepEqual(S.act(row, action, { reason: 'x' }, paused).errors, ['provider_paused'], action); assert.equal(S.act(row, action, { reason: 'x' }, ended).ok, true, 'a pause that is over does not block: ' + action);
    assert.deepEqual(S.act(row, action, { reason: 'x' }).errors, ['context_required'], action); assert.deepEqual(S.act(row, action, { reason: 'x' }, { service: {}, now: NOW }).errors, ['context_required'], action);
  }
  // pause is not blocked by an unavailable provider (it only reduces what is exposed), and stays an action that needs a reason
  const archived = ctxOk(); archived.provider.archived_at = '2026-10-01T00:00:00Z'; assert.equal(S.act(ready(), 'pause', { reason: 'x' }, archived).ok, true);
  // neither action can ever give an active engagement, whatever the checklist says
  assert.deepEqual([S.act(retiredRow(), 'reopen', { reason: 'x' }, ctxOk()).next.activation, S.act(pausedRow(), 'return_to_review', { reason: 'x' }, ctxOk()).next.activation], ['draft', 'pending'], 'with a complete checklist and an approved price, still not active');
  assert.deepEqual(S.act(r.next, 'activate', {}, ctxOk()).errors, ['activate_only_from_pending_or_paused'], 'a reopened draft goes through pending first, then the activation checks');
  assert.deepEqual(S.act(r.next, 'resume', {}, ctxOk()).errors, ['not_allowed_from_draft']);
  // nothing is mutated
  const frozen = Object.freeze(retiredRow()); const fc = Object.freeze({ provider: Object.freeze({}), now: NOW }); assert.equal(S.act(frozen, 'reopen', { reason: 'x' }, fc).ok, true); assert.equal(frozen.activation, 'retired'); assert.equal(frozen.agreement_state, 'signed');
});
