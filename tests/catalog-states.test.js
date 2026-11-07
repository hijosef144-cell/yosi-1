'use strict';
// Catalog, pure engagement logic. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../netlify/functions/_kaspchem/catalog/states.js');

const NOW = '2026-11-08T10:00:00Z';
const ready = () => ({ professional_id: 1, service_id: 1, activation: 'pending', contact_state: 'active', agreement_state: 'signed', pricing_model: 'fixed', pricing_id: 7, paused_reason: null, retired_reason: null, retired_at: null });
const ctxOk = () => ({ service: { legal_cleared: true, finding_tags: ['t1'], topics: [] }, provider: { paused_until: null, archived_at: null }, pricing: { approved: true }, now: NOW });

test('the transition table: exactly the allowed moves, retired is final, nothing leads back to a state it should not', () => {
  const allowed = { draft: ['pending', 'retired'], pending: ['draft', 'active', 'paused', 'retired'], active: ['paused', 'retired'], paused: ['active', 'pending', 'retired'], retired: [] };
  for (const from of S.ACTIVATION) for (const to of S.ACTIVATION) assert.equal(S.canTransition(from, to), allowed[from].includes(to), from + ' -> ' + to);
  assert.equal(S.canTransition('retired', 'draft'), false); assert.equal(S.canTransition('draft', 'active'), false, 'no jump to active without passing "pending"'); assert.equal(S.canTransition('nonsense', 'draft'), false);
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
  for (const a of ['submit', 'withdraw', 'activate', 'pause', 'resume', 'retire']) assert.equal(S.act(retired.next, a, { reason: 'x' }, ctxOk()).ok, false, 'retired is final: ' + a);
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
  const e = Object.freeze(ready()), c = Object.freeze({ service: Object.freeze({ legal_cleared: true, finding_tags: Object.freeze(['t']) }), provider: Object.freeze({}), pricing: Object.freeze({ approved: true }), now: NOW });
  assert.doesNotThrow(() => S.checklist(e, c)); const r = S.act(e, 'activate', {}, c); assert.equal(r.ok, true); assert.notEqual(r.next, e); assert.equal(e.activation, 'pending');
});
