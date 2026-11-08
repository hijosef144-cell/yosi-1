'use strict';
// Catalog server, READ side (stage 4a). Everything here only reads from the database. The one exception is the audit row written when a provider's contact details are viewed
// (AUDIT_VIEW, fixed text, no personal detail in it). There is no write to the catalog tables, to `pricing` or to `settings` anywhere in this file (the tests scan for it).
//   * Every statement is a SELECT with $n parameters; user input never becomes SQL text. No `SELECT *`: each response lists its columns, so a column added to a table later is not
//     exposed by accident. The confidential commission table, `pricing.cost` and `pricing.commission` are never selected.
//   * Ids are cast to text in SQL and returned as numbers; numbers and dates are cast in SQL so the Neon HTTP driver and the test database give the same values.
const db = require('./db');
const { HttpError } = require('./http');
const States = require('./catalog/states.js');
const Sim = require('./catalog/similarity.js');
const Imp = require('./catalog/import.js');

let clock = () => new Date();
const setClock = (fn) => { clock = fn || (() => new Date()); };

// A read goes through here: anything that is not a SELECT is refused before it is sent.
const rd = (text, params) => { if (!/^\s*(select|with)\b/i.test(text)) throw new Error('read_only_statements_only'); return db.query(text, params || []); };
// Several reads as one consistent snapshot: one READ ONLY transaction (the database refuses any write in it).
const rdTx = (statements, opts) => db.transaction(statements, Object.assign({ readOnly: true, isolationLevel: 'RepeatableRead' }, opts || {}));
const num = (v) => (v === null || v === undefined ? null : Number(v));
const like = (s) => (s ? '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null);   // the user's text is a literal, never a pattern
const page = (q) => [q.limit, q.offset];
const MAX_COMPARE = 400;   // the similar-services review compares every pair: beyond this many services it is refused rather than slow

const STATE_CASE = "CASE WHEN pp.archived_at IS NOT NULL THEN 'archived' WHEN pp.paused_until IS NOT NULL AND pp.paused_until > now() THEN 'paused' ELSE 'available' END";

// ---- overview -----------------------------------------------------------------------------------------------------------------------------------------------------------
async function overview() {
  const [svc, prov, byAct, byModel, last, uncleared] = await rdTx([
    { text: 'SELECT count(*)::int AS total, (count(*) FILTER (WHERE active))::int AS active FROM services' },
    { text: 'SELECT count(*)::int AS total, (count(*) FILTER (WHERE pp.archived_at IS NOT NULL))::int AS archived, (count(*) FILTER (WHERE pp.archived_at IS NULL AND pp.paused_until > now()))::int AS paused FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id' },
    { text: 'SELECT activation AS k, count(*)::int AS n FROM provider_services GROUP BY activation ORDER BY activation' },
    { text: 'SELECT pricing_model AS k, count(*)::int AS n FROM provider_services GROUP BY pricing_model ORDER BY pricing_model' },
    { text: 'SELECT id::text AS id, source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, jsonb_array_length(problems)::int AS problems, imported_by, created_at FROM catalog_imports ORDER BY id DESC LIMIT 1' },
    { text: 'SELECT count(*)::int AS n FROM services s LEFT JOIN service_settings ss ON ss.service_id = s.id WHERE coalesce(ss.legal_cleared, false) = false' },
  ]);
  const group = (rows) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
  return {
    services: { total: svc[0].total, active: svc[0].active, not_cleared: uncleared[0].n },
    providers: { total: prov[0].total, paused: prov[0].paused, archived: prov[0].archived },
    engagements: { total: byAct.reduce((a, r) => a + r.n, 0), by_activation: group(byAct), by_pricing_model: group(byModel) },
    last_import: last[0] ? Object.assign({}, last[0], { id: num(last[0].id) }) : null,
  };
}

// ---- services -----------------------------------------------------------------------------------------------------------------------------------------------------------
const SERVICE_LIST = 'SELECT s.id::text AS id, s.name, s.topic, s.description, s.active, ss.code, coalesce(ss.legal_cleared, false) AS legal_cleared, coalesce(ss.offered, false) AS offered, ' +
  '(SELECT count(*)::int FROM provider_services x WHERE x.service_id = s.id) AS engagements, ' +
  "(SELECT count(*)::int FROM provider_services x WHERE x.service_id = s.id AND x.activation = 'active') AS engagements_active, (count(*) OVER ())::int AS total " +
  'FROM services s LEFT JOIN service_settings ss ON ss.service_id = s.id ' +
  'WHERE ($1::text IS NULL OR s.name ILIKE $1) AND ($2::text IS NULL OR s.topic = $2) AND ($3::boolean IS NULL OR s.active = $3) ' +
  'ORDER BY s.topic NULLS LAST, s.name, s.id LIMIT $4 OFFSET $5';
async function listServices(q) {
  const rows = await rd(SERVICE_LIST, [like(q.q), q.topic || null, q.active === undefined ? null : q.active, ...page(q)]);
  return { services: rows.map((r) => ({ id: num(r.id), name: r.name, topic: r.topic, description: r.description, active: r.active, code: r.code, legal_cleared: r.legal_cleared, offered: r.offered, engagements: r.engagements, engagements_active: r.engagements_active })), total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset };
}
async function getService(id) {
  const [svc, engs, names] = await rdTx([
    { text: 'SELECT s.id::text AS id, s.name, s.topic, s.description, s.active, s.created_at, ss.code, ss.finding_tags, ss.topics AS settings_topics, ss.share_questions, coalesce(ss.legal_cleared, false) AS legal_cleared, ss.legal_cleared_by, ss.legal_cleared_at, ss.legal_note, coalesce(ss.offered, false) AS offered FROM services s LEFT JOIN service_settings ss ON ss.service_id = s.id WHERE s.id = $1::bigint', params: [id] },
    { text: 'SELECT ps.professional_id::text AS provider_id, p.name AS provider_name, ps.activation, ps.contact_state, ps.agreement_state, ps.pricing_model, ps.external_ref FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id WHERE ps.service_id = $1::bigint ORDER BY p.name, ps.professional_id', params: [id] },
    { text: 'SELECT id::text AS id, name FROM services ORDER BY id' },
  ]);
  if (!svc.length) throw new HttpError(404, 'not_found');
  const s = svc[0];
  // Other services with the same name (after normalisation) come first with score 1, then the near ones: duplicates are the most important thing to show. The service itself is never listed.
  const match = names.length > MAX_COMPARE ? null : Sim.matchName(s.name, names.filter((x) => String(x.id) !== String(s.id)).map((x) => ({ id: num(x.id), name: x.name })));
  const similar = match && match.exact.map((i) => ({ id: i.id, name: i.name, score: 1 })).concat(match.similar.map((m) => ({ id: m.item.id, name: m.item.name, score: m.score }))).slice(0, 10);
  return {
    service: { id: num(s.id), name: s.name, topic: s.topic, description: s.description, active: s.active, created_at: s.created_at },
    settings: { code: s.code, finding_tags: s.finding_tags || [], topics: s.settings_topics || [], share_questions: s.share_questions || [], legal_cleared: s.legal_cleared, legal_cleared_by: s.legal_cleared_by, legal_cleared_at: s.legal_cleared_at, legal_note: s.legal_note, offered: s.offered },
    engagements: engs.map((e) => ({ provider_id: num(e.provider_id), provider_name: e.provider_name, activation: e.activation, contact_state: e.contact_state, agreement_state: e.agreement_state, pricing_model: e.pricing_model, external_ref: e.external_ref })),
    similar_services: similar,
  };
}

// ---- providers ----------------------------------------------------------------------------------------------------------------------------------------------------------
// The LIST carries no contact detail at all. The CARD does, and every view of a card is recorded in the audit log (who and which provider, never the contact detail itself).
const PROVIDER_LIST = 'SELECT p.id::text AS id, p.name, pp.business_name, coalesce(pp.delivery_method, \'portal\') AS delivery_method, pp.paused_until, pp.archived_at, ' + STATE_CASE + ' AS state, ' +
  '(SELECT count(*)::int FROM provider_services x WHERE x.professional_id = p.id) AS engagements, ' +
  "(SELECT count(*)::int FROM provider_services x WHERE x.professional_id = p.id AND x.activation = 'active') AS engagements_active, (count(*) OVER ())::int AS total " +
  'FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id ' +
  'WHERE ($1::text IS NULL OR p.name ILIKE $1 OR pp.business_name ILIKE $1) AND ($2::text IS NULL OR ' + STATE_CASE + ' = $2) ' +
  'ORDER BY p.name, p.id LIMIT $3 OFFSET $4';
async function listProviders(q) {
  const rows = await rd(PROVIDER_LIST, [like(q.q), q.state || null, ...page(q)]);
  return { providers: rows.map((r) => ({ id: num(r.id), name: r.name, business_name: r.business_name, delivery_method: r.delivery_method, state: r.state, paused_until: r.paused_until, archived_at: r.archived_at, engagements: r.engagements, engagements_active: r.engagements_active })), total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset };
}
const AUDIT_VIEW = 'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)';
async function getProvider(id, actor) {
  const [prov, engs] = await rdTx([
    { text: 'SELECT p.id::text AS id, p.name, pp.business_name, pp.contact_phone, pp.contact_email, coalesce(pp.delivery_method, \'portal\') AS delivery_method, pp.paused_until, pp.archived_at, pp.capacity_open, pp.internal_notes, ' + STATE_CASE + ' AS state FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id WHERE p.id = $1::bigint', params: [id] },
    { text: 'SELECT ps.service_id::text AS service_id, s.name AS service_name, ps.activation, ps.contact_state, ps.agreement_state, ps.pricing_model, ps.external_ref FROM provider_services ps JOIN services s ON s.id = ps.service_id WHERE ps.professional_id = $1::bigint ORDER BY s.name, ps.service_id', params: [id] },
  ]);
  if (!prov.length) throw new HttpError(404, 'not_found');
  await db.query(AUDIT_VIEW, [actor, 'catalog.provider.view', 'provider', String(id), '{}']);   // before the data leaves: if the record cannot be written, nothing is shown
  const p = prov[0];
  return {
    provider: { id: num(p.id), name: p.name, business_name: p.business_name, contact_phone: p.contact_phone, contact_email: p.contact_email, delivery_method: p.delivery_method, state: p.state, paused_until: p.paused_until, archived_at: p.archived_at, capacity_open: p.capacity_open, internal_notes: p.internal_notes },
    engagements: engs.map((e) => ({ service_id: num(e.service_id), service_name: e.service_name, activation: e.activation, contact_state: e.contact_state, agreement_state: e.agreement_state, pricing_model: e.pricing_model, external_ref: e.external_ref })),
  };
}

// ---- engagements --------------------------------------------------------------------------------------------------------------------------------------------------------
const ENGAGEMENT_LIST = 'SELECT ps.professional_id::text AS provider_id, p.name AS provider_name, ps.service_id::text AS service_id, s.name AS service_name, s.topic AS service_topic, ps.activation, ps.contact_state, ps.agreement_state, ps.pricing_model, ps.pricing_id IS NOT NULL AS price_linked, ps.external_ref, ' +
  '(SELECT array_agg(l.kind ORDER BY l.kind) FROM provider_service_prices l WHERE l.professional_id = ps.professional_id AND l.service_id = ps.service_id) AS price_kinds, (count(*) OVER ())::int AS total ' +
  'FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id JOIN services s ON s.id = ps.service_id ' +
  'WHERE ($1::bigint IS NULL OR ps.professional_id = $1) AND ($2::bigint IS NULL OR ps.service_id = $2) AND ($3::text IS NULL OR ps.activation = $3) AND ($4::text IS NULL OR ps.pricing_model = $4) ' +
  'ORDER BY p.name, s.name, ps.professional_id, ps.service_id LIMIT $5 OFFSET $6';
async function listEngagements(q) {
  const rows = await rd(ENGAGEMENT_LIST, [q.provider_id === undefined ? null : q.provider_id, q.service_id === undefined ? null : q.service_id, q.activation || null, q.pricing_model || null, ...page(q)]);
  return { engagements: rows.map((r) => ({ provider_id: num(r.provider_id), provider_name: r.provider_name, service_id: num(r.service_id), service_name: r.service_name, service_topic: r.service_topic, activation: r.activation, contact_state: r.contact_state, agreement_state: r.agreement_state, pricing_model: r.pricing_model, price_linked: r.price_linked, external_ref: r.external_ref, price_layers: r.price_kinds || [] })), total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset };
}
// One engagement: its state, its THREE price layers kept apart (market, the provider's offer to Kaspchem, not yet classified), the approved client price that is linked to it (read
// from the existing pricing table: only its id, label, price and flags; never its cost or commission), and the live "what is missing before it can be active" list.
const ENGAGEMENT_ONE = 'SELECT ps.professional_id::text AS provider_id, p.name AS provider_name, ps.service_id::text AS service_id, s.name AS service_name, s.topic AS service_topic, ' +
  'ps.activation, ps.contact_state, ps.agreement_state, ps.pricing_model, ps.pricing_id::text AS pricing_id, ps.external_ref, ps.priority, ps.terms_note, ps.paused_reason, ps.retired_reason, ps.retired_at, ps.updated_by, ps.updated_at, ' +
  "coalesce(ss.legal_cleared, false) AS service_legal_cleared, coalesce(ss.finding_tags, '{}'::text[]) AS service_finding_tags, coalesce(ss.topics, '{}'::text[]) AS service_topics, pp.paused_until AS provider_paused_until, pp.archived_at AS provider_archived_at, " +
  'pr.id::text AS price_id, pr.label AS price_label, pr.price::float8 AS price_value, pr.approved AS price_approved, pr.public AS price_public ' +
  'FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id JOIN services s ON s.id = ps.service_id LEFT JOIN service_settings ss ON ss.service_id = ps.service_id ' +
  'LEFT JOIN provider_profiles pp ON pp.professional_id = ps.professional_id LEFT JOIN pricing pr ON pr.id = ps.pricing_id WHERE ps.professional_id = $1::bigint AND ps.service_id = $2::bigint';
const LAYERS_ONE = 'SELECT kind, model, amount::float8 AS amount, percent_low::float8 AS percent_low, percent_high::float8 AS percent_high, minimum_amount::float8 AS minimum_amount, terms_text, status, basis_missing, source_note, source_date::text AS source_date, recorded_by, updated_at ' +
  'FROM provider_service_prices WHERE professional_id = $1::bigint AND service_id = $2::bigint ORDER BY kind';
async function getEngagement(providerId, serviceId) {
  const [eng, layers] = await rdTx([{ text: ENGAGEMENT_ONE, params: [providerId, serviceId] }, { text: LAYERS_ONE, params: [providerId, serviceId] }]);
  if (!eng.length) throw new HttpError(404, 'not_found');
  const r = eng[0], pricingId = num(r.pricing_id);
  const list = States.checklist({ agreement_state: r.agreement_state, contact_state: r.contact_state, pricing_model: r.pricing_model, pricing_id: pricingId },
    { service: { legal_cleared: r.service_legal_cleared, finding_tags: r.service_finding_tags, topics: r.service_topics }, provider: { paused_until: r.provider_paused_until, archived_at: r.provider_archived_at },
      pricing: r.price_id === null ? null : { approved: r.price_approved === true }, now: clock() });
  const byKind = { market: null, provider_offer: null, unclassified: null };
  for (const l of layers) byKind[l.kind] = { model: l.model, amount: l.amount, percent_low: l.percent_low, percent_high: l.percent_high, minimum_amount: l.minimum_amount, terms_text: l.terms_text, status: l.status, basis_missing: l.basis_missing, source_note: l.source_note, source_date: l.source_date, recorded_by: l.recorded_by, updated_at: l.updated_at };
  return {
    engagement: { provider_id: num(r.provider_id), provider_name: r.provider_name, service_id: num(r.service_id), service_name: r.service_name, service_topic: r.service_topic, activation: r.activation, contact_state: r.contact_state, agreement_state: r.agreement_state, pricing_model: r.pricing_model, external_ref: r.external_ref, priority: r.priority, terms_note: r.terms_note, paused_reason: r.paused_reason, retired_reason: r.retired_reason, retired_at: r.retired_at, updated_by: r.updated_by, updated_at: r.updated_at },
    price_layers: byKind,
    approved_price: r.price_id === null ? null : { id: num(r.price_id), label: r.price_label, price: r.price_value, approved: r.price_approved === true, public: r.price_public === true },
    checklist: { items: list.items.map((i) => ({ key: i.key, label: i.label, ok: i.ok, blocking: i.blocking, enforced: i.enforced })), missing: list.missing, can_activate: list.canActivate, documented_only: list.documentedOnly },
  };
}

// ---- import log and similar services ---------------------------------------------------------------------------------------------------------------------------------
async function listImports(q) {
  const rows = await rd('SELECT id::text AS id, source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, problems, imported_by, created_at, (count(*) OVER ())::int AS total FROM catalog_imports ORDER BY id DESC LIMIT $1 OFFSET $2', page(q));
  return { imports: rows.map((r) => ({ id: num(r.id), source: r.source, file_sha256: r.file_sha256, rows_total: r.rows_total, rows_created: r.rows_created, rows_updated: r.rows_updated, rows_skipped: r.rows_skipped, problems: r.problems, imported_by: r.imported_by, created_at: r.created_at })), total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset };
}
async function similarServices() {
  const rows = await rd('SELECT id::text AS id, name FROM services ORDER BY id');
  if (rows.length > MAX_COMPARE) throw new HttpError(422, 'too_many_services_to_compare');
  const r = Sim.suggestPairs(rows.map((x) => ({ id: num(x.id), name: x.name })));
  const side = (x) => ({ id: x.id, name: x.name });
  return { same: r.same.slice(0, 100).map((p) => ({ a: side(p.a), b: side(p.b) })), similar: r.similar.slice(0, 100).map((p) => ({ a: side(p.a), b: side(p.b), score: p.score })), services_compared: rows.length };
}

// ---- change detection (used by the import apply of stage 4b; no route in 4a exposes it) ---------------------------------------------------------------------
// What the import reads, read in ONE consistent snapshot, plus two fingerprints of exactly those columns: a SQL one (the very same text can be run INSIDE the write transaction and compared
// there) and a JavaScript one. If anything the import reads changes between the preview and the save, both change.
const SNAP = {
  services: 'SELECT id::text AS id, name, topic, description FROM services ORDER BY id',
  providers: 'SELECT p.id::text AS id, p.name, pp.business_name, pp.contact_phone, pp.contact_email FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id ORDER BY p.id',
  engagements: 'SELECT professional_id::text AS professional_id, service_id::text AS service_id, external_ref, activation, contact_state, agreement_state, pricing_model, pricing_id::text AS pricing_id, terms_note, updated_by FROM provider_services ORDER BY professional_id, service_id',
  layers: 'SELECT professional_id::text AS professional_id, service_id::text AS service_id, kind, model, amount::float8 AS amount, percent_low::float8 AS percent_low, percent_high::float8 AS percent_high, minimum_amount::float8 AS minimum_amount, terms_text, status, basis_missing, source_note, source_date::text AS source_date, recorded_by FROM provider_service_prices ORDER BY professional_id, service_id, kind',
};
const FINGERPRINT_EXPR = "md5(coalesce((SELECT string_agg(ROW(id, name, topic, description)::text, '|' ORDER BY id) FROM services), '') || '#' || " +
  "coalesce((SELECT string_agg(ROW(p.id, p.name, pp.business_name, pp.contact_phone, pp.contact_email)::text, '|' ORDER BY p.id) FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id), '') || '#' || " +
  "coalesce((SELECT string_agg(ROW(professional_id, service_id, external_ref, activation, contact_state, agreement_state, pricing_model, pricing_id, terms_note, updated_by)::text, '|' ORDER BY professional_id, service_id) FROM provider_services), '') || '#' || " +
  "coalesce((SELECT string_agg(ROW(professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, basis_missing, source_note, source_date, status, recorded_by)::text, '|' ORDER BY professional_id, service_id, kind) FROM provider_service_prices), ''))";
const FINGERPRINT_SQL = 'SELECT ' + FINGERPRINT_EXPR + ' AS fingerprint';
async function readSnapshot() {
  const [services, providers, engagements, layers, fp] = await rdTx([{ text: SNAP.services }, { text: SNAP.providers }, { text: SNAP.engagements }, { text: SNAP.layers }, { text: FINGERPRINT_SQL }]);
  engagements.forEach((e) => { e.layers = layers.filter((l) => l.professional_id === e.professional_id && l.service_id === e.service_id); });
  const snapshot = { services, providers, engagements };
  return { snapshot, fingerprint: fp[0].fingerprint, digest: Imp.snapshotDigest(snapshot) };
}

module.exports = { overview, listServices, getService, listProviders, getProvider, listEngagements, getEngagement, listImports, similarServices, readSnapshot, setClock, FINGERPRINT_SQL, FINGERPRINT_EXPR, SNAP, AUDIT_VIEW, MAX_COMPARE };
