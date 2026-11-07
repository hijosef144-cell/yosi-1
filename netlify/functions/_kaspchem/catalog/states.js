'use strict';
// Catalog, pure engagement logic: the life cycle of a provider-service engagement and the live checklist "what is missing to activate". No input/output, no clock of its own
// (the caller passes `now`), and the objects it is given are never changed: every function returns a new object.

const ACTIVATION = ['draft', 'pending', 'active', 'paused', 'retired'];
const CONTACT = ['none', 'contacted', 'negotiating', 'active', 'stopped'];
const AGREEMENT = ['not_discussed', 'draft', 'signed', 'ended'];
const PRICING_MODELS = ['fixed', 'percent_of_result', 'percent_with_minimum', 'variable', 'quote', 'tbd'];

// draft -> pending -> active <-> paused -> retired (retired is final; a retired engagement is replaced by a new one). Any live state can be retired.
const TRANSITIONS = {
  draft: ['pending', 'retired'],
  pending: ['draft', 'active', 'paused', 'retired'],
  active: ['paused', 'retired'],
  paused: ['active', 'pending', 'retired'],
  retired: [],
};
const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

// The checklist. `enforced` says where the rule is held: 'database' items cannot be bypassed by any code, 'server' items are checked by the server before it asks the database,
// 'later' items belong to a later stage and do not block yet.
const ITEMS = [
  { key: 'agreement_signed', enforced: 'database', blocking: true, label: 'הסכם חתום' },
  { key: 'collaboration_active', enforced: 'database', blocking: true, label: 'שיתוף פעולה פעיל' },
  { key: 'fixed_price_linked', enforced: 'database', blocking: true, label: 'מחיר קבוע עם שורת תמחור מקושרת' },
  { key: 'service_cleared', enforced: 'server', blocking: true, label: 'השירות מאושר משפטית ומתואם לממצא או לתחום' },
  { key: 'provider_available', enforced: 'server', blocking: true, label: 'הספק אינו מושהה ואינו מאורכב' },
  { key: 'price_approved', enforced: 'server', blocking: true, label: 'המחיר מאושר (בלשונית התמחור, לא ציבורי)' },
  { key: 'delivery_ready', enforced: 'later', blocking: false, label: 'משתמש פורטל פעיל או אופן העברה ידני (שלב M2)' },
];

// ctx: { service: { legal_cleared, finding_tags[], topics[] }, provider: { paused_until, archived_at }, pricing: { approved } | null, now: Date | ISO string }
function checklist(e, ctx) {
  const c = ctx || {}, service = c.service || {}, provider = c.provider || {}, pricing = c.pricing || null, now = new Date(c.now || Date.now());
  const matched = (Array.isArray(service.finding_tags) && service.finding_tags.length > 0) || (Array.isArray(service.topics) && service.topics.length > 0);
  const paused = provider.paused_until ? new Date(provider.paused_until) > now : false;
  const ok = {
    agreement_signed: e.agreement_state === 'signed',
    collaboration_active: e.contact_state === 'active',
    fixed_price_linked: e.pricing_model === 'fixed' && e.pricing_id !== null && e.pricing_id !== undefined,
    service_cleared: service.legal_cleared === true && matched,
    provider_available: !provider.archived_at && !paused,
    price_approved: !!(pricing && pricing.approved === true),
    delivery_ready: false,
  };
  const items = ITEMS.map((i) => Object.assign({}, i, { ok: ok[i.key] }));
  // a percentage, per-case or open price can be DOCUMENTED but never activated (decision D15): say so instead of only "no fixed price"
  const documentedOnly = e.pricing_model !== 'fixed' && PRICING_MODELS.includes(e.pricing_model) && e.pricing_model !== 'tbd';
  const missing = items.filter((i) => i.blocking && !i.ok).map((i) => i.key);
  return { items, missing, canActivate: missing.length === 0, documentedOnly };
}

// The rules the database itself holds on an engagement row (checks of the engagements table), in code. [] means the row is allowed.
function dbRuleViolations(e) {
  const p = [];
  if (!ACTIVATION.includes(e.activation)) p.push('activation_unknown');
  if (!CONTACT.includes(e.contact_state)) p.push('contact_state_unknown');
  if (!AGREEMENT.includes(e.agreement_state)) p.push('agreement_state_unknown');
  if (!PRICING_MODELS.includes(e.pricing_model)) p.push('pricing_model_unknown');
  if (e.activation === 'active' && !(e.agreement_state === 'signed' && e.contact_state === 'active' && e.pricing_model === 'fixed' && e.pricing_id !== null && e.pricing_id !== undefined)) p.push('active_needs_signed_active_and_fixed_price');
  if (e.activation === 'retired' && !e.retired_at) p.push('retired_needs_a_date');
  return p;
}

// Applies one action. actions: submit (draft -> pending), withdraw (pending -> draft), activate, pause (reason required), resume (paused -> active, same checks as activate),
// retire (reason required, final). Returns { ok: true, next } or { ok: false, errors: [codes], missing? }; never changes `e`.
function act(e, action, input, ctx) {
  const i = input || {}, reason = typeof i.reason === 'string' ? i.reason.trim() : '';
  const fail = (...errors) => ({ ok: false, errors });
  const plan = { submit: ['draft', 'pending'], withdraw: ['pending', 'draft'], activate: [null, 'active'], pause: [null, 'paused'], resume: ['paused', 'active'], retire: [null, 'retired'] }[action];
  if (!plan) return fail('unknown_action');
  if (!ACTIVATION.includes(e.activation)) return fail('activation_unknown');
  const to = plan[1];
  if (plan[0] && e.activation !== plan[0]) return fail('not_allowed_from_' + e.activation);
  if (action === 'activate' && e.activation !== 'pending' && e.activation !== 'paused') return fail('activate_only_from_pending_or_paused');
  if (!canTransition(e.activation, to)) return fail('transition_not_allowed:' + e.activation + '->' + to);
  if ((action === 'pause' || action === 'retire') && !reason) return fail('reason_required');
  if (to === 'active') {
    const list = checklist(e, ctx);
    if (!list.canActivate) return { ok: false, errors: ['checklist_incomplete'], missing: list.missing, documentedOnly: list.documentedOnly };
  }
  const next = Object.assign({}, e, { activation: to });
  if (action === 'pause') next.paused_reason = reason;
  if (action === 'resume' || action === 'activate') next.paused_reason = null;
  if (action === 'retire') { next.retired_reason = reason; next.retired_at = new Date(i.at || (ctx && ctx.now) || Date.now()).toISOString(); }
  const violations = dbRuleViolations(next);
  if (violations.length) return fail(...violations);   // the database would refuse it; so does the code
  return { ok: true, next };
}

module.exports = { ACTIVATION, CONTACT, AGREEMENT, PRICING_MODELS, TRANSITIONS, ITEMS, canTransition, checklist, dbRuleViolations, act };
