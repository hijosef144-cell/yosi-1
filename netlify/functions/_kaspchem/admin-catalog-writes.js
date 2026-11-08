'use strict';
// Catalog server, WRITE routes (stage 4b). Mounted by admin-catalog-router.js AFTER the owner role and the switch `private.catalog_enabled` have been checked, so none of these runs while the
// catalog is closed. Rules that hold for every route here:
//   * input is validated against a fixed list of fields (an unknown field is a 400, never ignored); nothing from the request becomes SQL text;
//   * an edit to something that exists carries `expected` (the values the caller saw): the UPDATE only matches if they still hold (compare-and-set), otherwise nothing is written (409);
//   * the change and its audit row are one transaction; the audit detail has field names and non-personal values, never a contact detail or a free text;
//   * nothing here writes the price table, the settings table or the commission table (the database layer would refuse it); there is no DELETE anywhere;
//   * nothing activates by itself: only the explicit `activate` / `resume` actions can, behind their own switch and checks (below).
const db = require('./db');
const { HttpError } = require('./http');
const { cleanText } = require('./validate');
const T = require('./catalog/text.js');
const P = require('./catalog/pricing.js');
const States = require('./catalog/states.js');
const Sim = require('./catalog/similarity.js');
const Imp = require('./catalog/import.js');
const W = require('./catalog-writes');
const store = require('./catalog-store');
const guards = require('./catalog-guards');
const serviceGuard = require('./service-guard');
const { opsAlert } = require('./ops-alert');

const MAX_IMPORT_ROWS = 300, MAX_IMPORT_BYTES = 1300000;

// ---- small helpers -------------------------------------------------------------------------------------------------------------------------------------------------------------
const bad = (code, message) => new HttpError(400, code, message);
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function refusal(status, code, extra, message) { const e = new HttpError(status, code, message); e.extra = extra; return e; }   // an answer with details (the router sends them)
function fields(c, allowed) {
  if (!isObj(c.body)) throw bad('bad_body');
  for (const k of Object.keys(c.body)) if (!allowed.includes(k)) throw bad('unknown_field');
  return c.body;
}
const req = (v, min, max, code) => { const t = cleanText(v, min, max); if (t === null) throw bad(code); return t; };
const opt = (v, max, code) => (v === null || v === undefined || v === '' ? null : req(v, 1, max, code));
const boolean = (v, code) => { if (typeof v !== 'boolean') throw bad(code); return v; };
const oneOf = (v, list, code) => { if (typeof v !== 'string' || !list.includes(v)) throw bad(code); return v; };
const intIn = (v, min, max, code) => { const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v; if (!Number.isInteger(n) || n < min || n > max) throw bad(code); return n; };
const idOf = (s) => { const n = Number(s); if (!Number.isSafeInteger(n) || n < 1) throw bad('bad_id'); return n; };
const idBody = (v, code) => { const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : v; if (!Number.isSafeInteger(n) || n < 1) throw bad(code); return n; };
const both = (c, extra) => { const b = fields(c, ['changes', 'expected'].concat(extra || [])); if (!isObj(b.changes) || !isObj(b.expected)) throw bad('bad_body'); return b; };
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));
const norm = (defs, changes) => Object.fromEntries(Object.keys(changes).map((k) => { if (!Object.prototype.hasOwnProperty.call(defs, k)) throw bad('unknown_field'); return [k, defs[k].v(changes[k])]; }));

// ---- the fields that can be edited, with their rules ---------------------------------------------------------------------------------------------------------------------------
const SERVICE = {
  name: { type: 'text', v: (x) => req(x, 1, 120, 'bad_name') }, topic: { type: 'text', v: (x) => opt(x, 40, 'bad_topic') },
  description: { type: 'text', v: (x) => opt(x, 600, 'bad_description') }, active: { type: 'boolean', v: (x) => boolean(x, 'bad_active') },
};
const SETTINGS = {
  finding_tags: { type: 'text[]', v: (x) => tags(x, 12, /^[a-z0-9-]{1,40}$/, 'bad_tags') }, topics: { type: 'text[]', v: (x) => tags(x, 12, /^[a-z-]{1,40}$/, 'bad_topics') },
};
function tags(x, max, re, code) { if (!Array.isArray(x) || x.length > max || x.some((t) => typeof t !== 'string' || !re.test(t))) throw bad(code); return Array.from(new Set(x)); }
const PROFILE = {
  business_name: { type: 'text', v: (x) => opt(x, 200, 'bad_business_name') },
  contact_phone: { type: 'text', v: (x) => { if (x === null || x === '') return null; const r = T.normalizePhone(x); if (!r.ok) throw bad('bad_phone'); return r.value; } },
  contact_email: { type: 'text', v: (x) => { if (x === null || x === '') return null; const r = T.normalizeEmail(x); if (!r.ok) throw bad('bad_email'); return r.value; } },
  internal_notes: { type: 'text', v: (x) => opt(x, 1000, 'bad_notes') }, capacity_open: { type: 'int', v: (x) => (x === null ? null : intIn(x, 0, 100000, 'bad_capacity')) },
  delivery_method: { type: 'text', v: (x) => oneOf(x, ['portal', 'manual'], 'bad_delivery_method') },
};
const PROVIDER_NAME = { name: { type: 'text', v: (x) => req(x, 1, 120, 'bad_name') } };
const ENGAGEMENT = {
  contact_state: { type: 'text', v: (x) => oneOf(x, States.CONTACT, 'bad_contact_state') }, agreement_state: { type: 'text', v: (x) => oneOf(x, States.AGREEMENT, 'bad_agreement_state') },
  terms_note: { type: 'text', v: (x) => opt(x, 1000, 'bad_terms_note') }, priority: { type: 'int', v: (x) => intIn(x, 0, 10000, 'bad_priority') }, external_ref: { type: 'text', v: (x) => opt(x, 80, 'bad_external_ref') },
};
const SAFE_DETAIL = ['name', 'topic', 'active', 'contact_state', 'agreement_state', 'priority', 'external_ref', 'delivery_method', 'capacity_open'];   // values that may be copied into the audit detail
const changeDetail = (changes, expected) => ({ fields: Object.keys(changes), from: pick(expected, SAFE_DETAIL), to: pick(changes, SAFE_DETAIL) });

async function writeOrDiagnose(statements, diagnose) {
  try { return await W.run(statements); } catch (e) { if (e && e.noRows && diagnose) throw (await diagnose()) || e; throw e; }
}
const dup = (what, rows) => new HttpError(409, what, 'כבר קיימת רשומה דומה: ' + rows.slice(0, 3).map((r) => r.name + ' (מספר ' + r.id + ')').join(', ') + '. כדי ליצור בכל זאת יש לשלוח allow_duplicate.');

// ---- the route table ------------------------------------------------------------------------------------------------------------------------------------------------------------
// `sample`: a real path and a valid body, used by the tests to drive every route with every kind of caller.
const ROUTES = [];
const route = (method, re, name, sample, run, maxBytes) => ROUTES.push({ method, re, name, sample, run, maxBytes: maxBytes || 65536 });

// ===== services ==================================================================================================================================================================
route('POST', /^\/catalog\/services$/, 'services.create', { path: '/catalog/services', body: { name: 'שירות חדש לדוגמה' } }, async (c) => {
  const b = fields(c, ['name', 'topic', 'description', 'allow_duplicate']);
  const name = SERVICE.name.v(b.name), topic = SERVICE.topic.v(b.topic), description = SERVICE.description.v(b.description);
  if (b.allow_duplicate !== true) {
    const pool = (await db.query('SELECT id::text AS id, name FROM services ORDER BY id')).map((x) => ({ id: Number(x.id), name: x.name })), m = Sim.matchName(name, pool);
    if (m.exact.length || m.similar.length) throw dup('similar_service_exists', m.exact.concat(m.similar.map((s) => s.item)));
  }
  const [id] = await W.reserve('service', 1);   // a new service starts switched off
  await W.run([{ text: 'INSERT INTO services (id, name, topic, description, active) VALUES ($1::bigint, $2, $3, $4, false)', params: [id, name, topic, description] }, W.audit(c.me.email, 'catalog.service.create', 'service', id, { name, topic })]);
  return { id: Number(id) };
});
route('PATCH', /^\/catalog\/services\/(\d+)$/, 'services.update', { path: '/catalog/services/1', body: { changes: { description: 'חדש' }, expected: { description: null } } }, async (c, sid) => {
  const id = idOf(sid), b = both(c), changes = norm(SERVICE, b.changes);
  // the owner decision: a service tied to a price the public site shows keeps its name and its topic (inside the UPDATE, see service-guard.js)
  const u = W.casUpdate({ table: 'services', alias: 's', defs: SERVICE, key: { id }, changes: b.changes, expected: b.expected, extra: ({ ph }) => [serviceGuard.allowsChange(ph.name, ph.topic)] });
  await writeOrDiagnose([...W.counted(u.text, u.params), W.audit(c.me.email, 'catalog.service.update', 'service', id, changeDetail(changes, b.expected))], async () => {
    if (!(await db.query('SELECT 1 FROM services WHERE id = $1::bigint', [String(id)])).length) return new HttpError(404, 'not_found');
    if (await serviceGuard.isBlocked(db, String(id), changes.name, changes.topic)) return new HttpError(409, 'service_has_public_price', serviceGuard.MESSAGE);
    return null;
  });
  return { ok: true };
});
route('PUT', /^\/catalog\/services\/(\d+)\/settings$/, 'services.settings', { path: '/catalog/services/1/settings', body: { code: 'sample-code', finding_tags: [], topics: [] } }, async (c, sid) => {
  const id = idOf(sid), b = fields(c, ['code', 'finding_tags', 'topics', 'expected']), statements = [];
  if (b.expected === undefined) {   // create: the settings of this service do not exist yet
    const code = typeof b.code === 'string' && /^[a-z0-9-]{2,40}$/.test(b.code) ? b.code : (() => { throw bad('bad_code'); })();
    const tagsV = b.finding_tags === undefined ? [] : SETTINGS.finding_tags.v(b.finding_tags), topicsV = b.topics === undefined ? [] : SETTINGS.topics.v(b.topics);
    statements.push(...W.counted('INSERT INTO service_settings (service_id, code, finding_tags, topics) SELECT $1::bigint, $2, $3::text[], $4::text[] WHERE EXISTS (SELECT 1 FROM services WHERE id = $1::bigint) ON CONFLICT (service_id) DO NOTHING', [String(id), code, tagsV, topicsV]),
      W.audit(c.me.email, 'catalog.service.settings.create', 'service', id, { code, finding_tags: tagsV.length, topics: topicsV.length }));
    try { await W.run(statements); } catch (e) {
      if (e.noRows) throw (await db.query('SELECT 1 FROM services WHERE id = $1::bigint', [String(id)])).length ? new HttpError(409, 'settings_exist') : new HttpError(404, 'not_found');
      if (e.constraint && /code/.test(e.constraint)) throw new HttpError(409, 'code_in_use'); throw e;
    }
    return { ok: true };
  }
  if (b.code !== undefined || !isObj(b.expected)) throw bad('bad_body');   // the code is fixed once it is set
  const changes = norm(SETTINGS, pick(b, ['finding_tags', 'topics'])), u = W.casUpdate({ table: 'service_settings', defs: SETTINGS, key: { service_id: id }, changes: pick(b, ['finding_tags', 'topics']), expected: b.expected, extraSets: ['updated_at = now()'] });
  await writeOrDiagnose([...W.counted(u.text, u.params), W.audit(c.me.email, 'catalog.service.settings.update', 'service', id, { fields: Object.keys(changes) })], async () => ((await db.query('SELECT 1 FROM service_settings WHERE service_id = $1::bigint', [String(id)])).length ? null : new HttpError(404, 'not_found')));
  return { ok: true };
});
route('POST', /^\/catalog\/services\/(\d+)\/clearance$/, 'services.clearance', { path: '/catalog/services/1/clearance', body: { cleared: true, expected_cleared: false } }, async (c, sid) => {
  const id = idOf(sid), b = fields(c, ['cleared', 'expected_cleared', 'note']), cleared = boolean(b.cleared, 'bad_cleared'), was = boolean(b.expected_cleared, 'expected_required'), note = opt(b.note, 600, 'bad_note');
  // recorded with the signed-in owner, never a name from the request; withdrawing a clearance is refused while an engagement of the service is active
  const dml = 'UPDATE service_settings SET legal_cleared = $1::boolean, legal_cleared_by = CASE WHEN $1::boolean THEN $2::text ELSE NULL END, legal_cleared_at = CASE WHEN $1::boolean THEN now() ELSE NULL END, legal_note = $3::text, updated_at = now() ' +
    "WHERE service_id = $4::bigint AND legal_cleared = $5::boolean AND ($1::boolean OR NOT EXISTS (SELECT 1 FROM provider_services x WHERE x.service_id = $4::bigint AND x.activation = 'active'))";
  await writeOrDiagnose([...W.counted(dml, [cleared, c.me.email, note, String(id), was]), W.audit(c.me.email, 'catalog.service.clearance', 'service', id, { cleared })], async () => {
    const r = await db.query("SELECT legal_cleared, (SELECT count(*)::int FROM provider_services x WHERE x.service_id = $1::bigint AND x.activation = 'active') AS active FROM service_settings WHERE service_id = $1::bigint", [String(id)]);
    if (!r.length) return new HttpError(409, 'settings_required'); if (r[0].legal_cleared !== was) return new HttpError(409, 'conflict'); if (!cleared && r[0].active > 0) return new HttpError(409, 'active_engagements_exist'); return null;
  });
  return { ok: true };
});

// ===== providers =================================================================================================================================================================
route('POST', /^\/catalog\/providers$/, 'providers.create', { path: '/catalog/providers', body: { name: 'ספק לדוגמה', business_name: 'עסק לדוגמה' } }, async (c) => {
  const b = fields(c, ['name', 'allow_duplicate'].concat(Object.keys(PROFILE))), name = PROVIDER_NAME.name.v(b.name);
  const prof = Object.fromEntries(Object.keys(PROFILE).map((k) => [k, b[k] === undefined ? (k === 'delivery_method' ? 'portal' : null) : PROFILE[k].v(b[k])]));
  if (b.allow_duplicate !== true) {
    const pool = (await db.query('SELECT p.id::text AS id, p.name, pp.business_name FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id ORDER BY p.id')).map((x) => ({ id: Number(x.id), name: x.name, business_name: x.business_name }));
    const m = Sim.matchProvider({ name, business: prof.business_name || '' }, pool), found = m.exact.concat(m.sameNameOtherBusiness, m.similar.map((s) => s.item));
    if (found.length) throw dup('similar_provider_exists', found);
  }
  const [id] = await W.reserve('provider', 1);
  await W.run([{ text: 'INSERT INTO professionals (id, name) VALUES ($1::bigint, $2)', params: [id, name] },
    { text: 'INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email, internal_notes, capacity_open, delivery_method) VALUES ($1::bigint, $2, $3, $4, $5, $6::int, $7)', params: [id, prof.business_name, prof.contact_phone, prof.contact_email, prof.internal_notes, prof.capacity_open, prof.delivery_method] },
    W.audit(c.me.email, 'catalog.provider.create', 'provider', id, { fields: ['name'].concat(Object.keys(prof).filter((k) => prof[k] !== null && k !== 'delivery_method')) })]);
  return { id: Number(id) };
});
const ENSURE_PROFILE = 'INSERT INTO provider_profiles (professional_id) SELECT $1::bigint WHERE EXISTS (SELECT 1 FROM professionals WHERE id = $1::bigint) ON CONFLICT (professional_id) DO NOTHING';
route('PATCH', /^\/catalog\/providers\/(\d+)$/, 'providers.update', { path: '/catalog/providers/1', body: { changes: { internal_notes: 'הערה' }, expected: { internal_notes: null } } }, async (c, pid) => {
  const id = idOf(pid), b = both(c), names = Object.keys(b.changes);
  const nameKeys = names.filter((k) => k === 'name'), profileKeys = names.filter((k) => k !== 'name');
  if (names.some((k) => k !== 'name' && !Object.prototype.hasOwnProperty.call(PROFILE, k))) throw bad('unknown_field');
  const merged = Object.assign({}, norm(PROVIDER_NAME, pick(b.changes, nameKeys)), norm(PROFILE, pick(b.changes, profileKeys)));
  const statements = [{ text: ENSURE_PROFILE, params: [String(id)] }];
  if (nameKeys.length) { const u = W.casUpdate({ table: 'professionals', defs: PROVIDER_NAME, key: { id }, changes: pick(b.changes, nameKeys), expected: b.expected }); statements.push(...W.counted(u.text, u.params)); }
  if (profileKeys.length) { const u = W.casUpdate({ table: 'provider_profiles', defs: PROFILE, key: { professional_id: id }, changes: pick(b.changes, profileKeys), expected: b.expected, extraSets: ['updated_at = now()'] }); statements.push(...W.counted(u.text, u.params)); }
  statements.push(W.audit(c.me.email, 'catalog.provider.update', 'provider', id, { fields: names, to: pick(merged, ['delivery_method', 'capacity_open']) }));   // contact details and notes: field names only
  await writeOrDiagnose(statements, async () => ((await db.query('SELECT 1 FROM professionals WHERE id = $1::bigint', [String(id)])).length ? null : new HttpError(404, 'not_found')));
  return { ok: true };
});
const PROVIDER_ACTIONS = {
  pause: { sql: 'UPDATE provider_profiles SET paused_until = $2::timestamptz, updated_at = now() WHERE professional_id = $1::bigint AND archived_at IS NULL', need: ['until', 'reason'] },
  resume: { sql: 'UPDATE provider_profiles SET paused_until = NULL, updated_at = now() WHERE professional_id = $1::bigint AND paused_until IS NOT NULL', need: [] },
  archive: { sql: "UPDATE provider_profiles SET archived_at = now(), updated_at = now() WHERE professional_id = $1::bigint AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM provider_services x WHERE x.professional_id = $1::bigint AND x.activation = 'active')", need: ['reason'] },
  unarchive: { sql: 'UPDATE provider_profiles SET archived_at = NULL, updated_at = now() WHERE professional_id = $1::bigint AND archived_at IS NOT NULL', need: [] },
};
route('POST', /^\/catalog\/providers\/(\d+)\/(pause|resume|archive|unarchive)$/, 'providers.state', { path: '/catalog/providers/1/archive', body: { reason: 'סיבה' } }, async (c, pid, action) => {
  const id = idOf(pid), def = PROVIDER_ACTIONS[action], b = fields(c, ['until', 'reason']), params = [String(id)], detail = {};
  if (def.need.includes('reason')) detail.reason = req(b.reason, 1, 300, 'reason_required');
  if (def.need.includes('until')) {
    const t = typeof b.until === 'string' ? new Date(b.until) : null, now = Date.now();
    if (!t || Number.isNaN(t.getTime()) || t.getTime() <= now || t.getTime() > now + 366 * 86400000) throw bad('bad_until');
    params.push(t.toISOString()); detail.until = t.toISOString();
  }
  await writeOrDiagnose([{ text: ENSURE_PROFILE, params: [String(id)] }, ...W.counted(def.sql, params), W.audit(c.me.email, 'catalog.provider.' + action, 'provider', id, detail)], async () => {
    const r = await db.query("SELECT pp.archived_at, pp.paused_until, (SELECT count(*)::int FROM provider_services x WHERE x.professional_id = $1::bigint AND x.activation = 'active') AS active FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id WHERE p.id = $1::bigint", [String(id)]);
    if (!r.length) return new HttpError(404, 'not_found');
    if (action === 'archive' && r[0].archived_at) return new HttpError(409, 'already_archived'); if (action === 'archive' && r[0].active > 0) return new HttpError(409, 'active_engagements_exist');
    if (action === 'pause' && r[0].archived_at) return new HttpError(409, 'provider_archived'); if (action === 'resume') return new HttpError(409, 'not_paused'); if (action === 'unarchive') return new HttpError(409, 'not_archived'); return null;
  });
  return { ok: true };
});

// ===== engagements ===============================================================================================================================================================
route('POST', /^\/catalog\/engagements$/, 'engagements.create', { path: '/catalog/engagements', body: { provider_id: 1, service_id: 1 } }, async (c) => {
  const b = fields(c, ['provider_id', 'service_id', 'external_ref']), p = idBody(b.provider_id, 'bad_provider_id'), s = idBody(b.service_id, 'bad_service_id'), ref = ENGAGEMENT.external_ref.v(b.external_ref);
  // a new engagement is a draft, nothing agreed, no price model (the table's own defaults)
  try { await W.run([{ text: 'INSERT INTO provider_services (professional_id, service_id, external_ref, updated_by) VALUES ($1::bigint, $2::bigint, $3, $4)', params: [String(p), String(s), ref, c.me.email] }, W.audit(c.me.email, 'catalog.engagement.create', 'engagement', p + '/' + s, {})]); }
  catch (e) {
    if (e.code === 'duplicate') throw new HttpError(409, /external_ref/.test(e.constraint || '') ? 'external_ref_in_use' : 'engagement_exists'); if (e.code === 'bad_reference') throw new HttpError(404, 'provider_or_service_not_found'); throw e;
  }
  return { provider_id: p, service_id: s };
});
route('PATCH', /^\/catalog\/engagements\/(\d+)\/(\d+)$/, 'engagements.update', { path: '/catalog/engagements/1/1', body: { changes: { terms_note: 'הערה' }, expected: { terms_note: null } } }, async (c, pid, sid) => {
  const p = idOf(pid), s = idOf(sid), b = both(c), changes = norm(ENGAGEMENT, b.changes);   // the owner may state a contact or agreement state by hand; activation, prices and links have their own routes
  const u = W.casUpdate({ table: 'provider_services', defs: ENGAGEMENT, key: { professional_id: p, service_id: s }, changes: b.changes, expected: b.expected, extraSets: [(q) => 'updated_by = ' + q(c.me.email, 'text'), 'updated_at = now()'] });
  await writeOrDiagnose([...W.counted(u.text, u.params), W.audit(c.me.email, 'catalog.engagement.update', 'engagement', p + '/' + s, changeDetail(changes, b.expected))], async () => ((await db.query('SELECT 1 FROM provider_services WHERE professional_id = $1::bigint AND service_id = $2::bigint', [String(p), String(s)])).length ? null : new HttpError(404, 'not_found')));
  return { ok: true };
});

// The lifecycle. submit / withdraw / pause / retire only ever reduce what is exposed. `activate` and `resume` (which returns to active) are the only ways to become active and need ALL of:
//   the switch `private.catalog_activation_enabled` (closed by default), the typed confirmation `confirm: "activate"`, `seen` (the fingerprint of what the owner looked at; if anything the checklist
//   depends on moved since, it is refused), a complete checklist, and the server-side items (service cleared, provider available, price approved) re-checked INSIDE the UPDATE. The database's own
//   rule (signed agreement, active collaboration, fixed price with a linked price row) is the last fence. Nothing about the public site changes: no price is published, no service offered.
const REACTIVATING = ['activate', 'resume'];
const ACTIVATION_CHECKS = ' AND EXISTS (SELECT 1 FROM service_settings ss WHERE ss.service_id = provider_services.service_id AND ss.legal_cleared AND (cardinality(ss.finding_tags) > 0 OR cardinality(ss.topics) > 0))' +
  ' AND NOT EXISTS (SELECT 1 FROM provider_profiles pp WHERE pp.professional_id = provider_services.professional_id AND (pp.archived_at IS NOT NULL OR (pp.paused_until IS NOT NULL AND pp.paused_until > now())))' +
  ' AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.id = provider_services.pricing_id AND pr.approved)' +
  " AND EXISTS (SELECT 1 FROM settings st WHERE st.key = 'private.catalog_activation_enabled' AND st.value = 'true'::jsonb)";
route('POST', /^\/catalog\/engagements\/(\d+)\/(\d+)\/actions\/(submit|withdraw|activate|pause|resume|retire)$/, 'engagements.action', { path: '/catalog/engagements/1/1/actions/submit', body: { expected_activation: 'draft' } }, async (c, pid, sid, action) => {
  const p = idOf(pid), s = idOf(sid), b = fields(c, ['expected_activation', 'reason', 'confirm', 'seen']);
  if (!States.ACTIVATION.includes(b.expected_activation)) throw bad('expected_required');
  const reactivates = REACTIVATING.includes(action), loaded = await store.loadEngagement(p, s);
  if (!loaded) throw new HttpError(404, 'not_found');
  if (loaded.r.activation !== b.expected_activation) throw new HttpError(409, 'conflict');
  if (reactivates) {
    if (!(await guards.activationOpen())) throw new HttpError(403, 'activation_disabled', 'הפעלת התקשרויות כבויה (private.catalog_activation_enabled).');
    if (b.confirm !== 'activate') throw bad('confirmation_required');
    if (b.seen !== loaded.seen) throw new HttpError(409, 'seen_changed', 'המצב השתנה מאז שצפיתם בו. יש לרענן ולאשר שוב.');
  }
  const reason = b.reason === undefined ? undefined : req(b.reason, 1, 300, 'bad_reason');
  const res = States.act(Object.assign({}, loaded.e, { retired_at: loaded.r.retired_at }), action, { reason }, loaded.ctx);
  if (!res.ok) throw refusal(422, 'transition_refused', { errors: res.errors, missing: res.missing || [], documented_only: !!res.documentedOnly });
  const e = loaded.e, params = [], q = (v, cast) => { params.push(v); return '$' + params.length + '::' + cast; };
  const sets = ['activation = ' + q(res.next.activation, 'text'), 'updated_by = ' + q(c.me.email, 'text'), 'updated_at = now()'];
  if (action === 'pause') sets.push('paused_reason = ' + q(reason, 'text')); if (reactivates) sets.push('paused_reason = NULL');
  if (action === 'retire') sets.push('retired_reason = ' + q(reason, 'text'), 'retired_at = now()');
  let where = 'professional_id = ' + q(String(p), 'bigint') + ' AND service_id = ' + q(String(s), 'bigint') + ' AND activation = ' + q(b.expected_activation, 'text');
  if (reactivates) where += ' AND agreement_state = ' + q(e.agreement_state, 'text') + ' AND contact_state = ' + q(e.contact_state, 'text') + ' AND pricing_model = ' + q(e.pricing_model, 'text') + ' AND pricing_id IS NOT DISTINCT FROM ' + q(e.pricing_id === null ? null : String(e.pricing_id), 'bigint') + ACTIVATION_CHECKS;
  const detail = { from: b.expected_activation, to: res.next.activation }; if (reason) detail.reason = reason; if (reactivates) detail.checklist = loaded.list.items.filter((i) => i.blocking).map((i) => i.key + ':' + (i.ok ? 'ok' : 'missing'));
  await writeOrDiagnose([...W.counted('UPDATE provider_services SET ' + sets.join(', ') + ' WHERE ' + where, params), W.audit(c.me.email, 'catalog.engagement.' + action, 'engagement', p + '/' + s, detail)], async () => {
    const again = await store.loadEngagement(p, s);
    if (!again) return new HttpError(404, 'not_found'); if (again.r.activation !== b.expected_activation) return new HttpError(409, 'conflict');
    if (reactivates && !(await guards.activationOpen())) return new HttpError(403, 'activation_disabled'); return new HttpError(409, 'seen_changed', 'המצב השתנה מאז שצפיתם בו. יש לרענן ולאשר שוב.');
  });
  if (reactivates) await opsAlert('הפעלת התקשרות שונתה', 'התקשרות ' + p + '/' + s + ' הועברה למצב פעיל על ידי ' + c.me.email + '.');   // no personal detail; a failure to send never breaks the request
  else if (action === 'retire') await opsAlert('התקשרות הוצאה משימוש', 'התקשרות ' + p + '/' + s + ' הוצאה משימוש על ידי ' + c.me.email + '.');
  return { activation: res.next.activation };
});

// ===== price layers and the link to an approved price ===========================================================================================================================
// Three layers are kept apart: market, the provider's offer to Kaspchem, and "unclassified". The price APPROVED for clients is a row in the older pricing table: this API only LINKS an
// existing approved one. It never creates, edits, approves or publishes a price (the database layer refuses any write to that table).
const money = (v, code) => { if (v === null || v === undefined || v === '') return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 9999999999.99) throw bad(code); return v; };
const percent = (v, code) => { if (v === null || v === undefined || v === '') return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(code); return v; };
const verbatimText = (v, code) => { if (v === null || v === undefined || v === '') return null; if (typeof v !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw bad(code); const t = T.verbatim(v); return t === '' ? null : t; };
function layerFrom(kind, raw) {
  if (!isObj(raw)) throw bad('bad_body');
  const known = ['model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'terms_text', 'status', 'basis_missing', 'source_note', 'source_date'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw bad('unknown_field');
  const date = raw.source_date === null || raw.source_date === undefined || raw.source_date === '' ? null : T.parseSourceDate(raw.source_date);
  if (date && !date.ok) throw bad(date.problem);
  const l = { kind, model: oneOf(raw.model, P.MODELS, 'bad_model'), amount: money(raw.amount, 'bad_amount'), percent_low: percent(raw.percent_low, 'bad_percent'), percent_high: percent(raw.percent_high, 'bad_percent'), minimum_amount: money(raw.minimum_amount, 'bad_minimum'),
    terms_text: verbatimText(raw.terms_text, 'bad_terms_text'), status: raw.status === undefined ? 'recorded' : oneOf(raw.status, P.STATUSES, 'bad_status'), basis_missing: raw.basis_missing === undefined ? false : boolean(raw.basis_missing, 'bad_basis_missing'),
    source_note: verbatimText(raw.source_note, 'bad_source_note'), source_date: date ? date.value : null };
  const codes = P.validateLayer(l);   // the database's own checks, in code
  if (codes.length) throw refusal(422, 'layer_invalid', { codes }, 'שכבת המחיר אינה תקינה.');
  return l;
}
const LAYER_COLS = '(professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, status, basis_missing, source_note, source_date, recorded_by)';
route('PUT', /^\/catalog\/engagements\/(\d+)\/(\d+)\/prices\/(market|provider_offer|unclassified)$/, 'prices.put', { path: '/catalog/engagements/1/1/prices/market', body: { layer: { model: 'fixed', amount: 1000 } } }, async (c, pid, sid, kind) => {
  const p = idOf(pid), s = idOf(sid), b = fields(c, ['layer', 'expected_updated_at']), l = layerFrom(kind, b.layer), exists = async () => (await db.query('SELECT 1 FROM provider_services WHERE professional_id = $1::bigint AND service_id = $2::bigint', [String(p), String(s)])).length > 0;
  const detail = { kind, model: l.model, status: l.status, created: b.expected_updated_at === undefined };   // amounts are business figures, not personal: they are in the layer itself, the log only says what kind of change
  let dml, params;
  if (b.expected_updated_at === undefined) {   // create: only if this layer does not exist yet
    dml = 'INSERT INTO provider_service_prices ' + LAYER_COLS + ' SELECT $1::bigint, $2::bigint, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11::boolean, $12, $13::date, $14 WHERE EXISTS (SELECT 1 FROM provider_services WHERE professional_id = $1::bigint AND service_id = $2::bigint) ON CONFLICT (professional_id, service_id, kind) DO NOTHING';
    params = [String(p), String(s), kind, l.model, l.amount, l.percent_low, l.percent_high, l.minimum_amount, l.terms_text, l.status, l.basis_missing, l.source_note, l.source_date, c.me.email];
  } else {            // update: only if nobody changed it since the caller read it
    const at = typeof b.expected_updated_at === 'string' && !Number.isNaN(new Date(b.expected_updated_at).getTime()) ? new Date(b.expected_updated_at).toISOString() : (() => { throw bad('bad_expected_updated_at'); })();
    dml = 'UPDATE provider_service_prices SET model = $1, amount = $2::numeric, percent_low = $3::numeric, percent_high = $4::numeric, minimum_amount = $5::numeric, terms_text = $6, status = $7, basis_missing = $8::boolean, source_note = $9, source_date = $10::date, recorded_by = $11, updated_at = now() ' +
      "WHERE professional_id = $12::bigint AND service_id = $13::bigint AND kind = $14 AND date_trunc('milliseconds', updated_at) = $15::timestamptz";
    params = [l.model, l.amount, l.percent_low, l.percent_high, l.minimum_amount, l.terms_text, l.status, l.basis_missing, l.source_note, l.source_date, c.me.email, String(p), String(s), kind, at];
  }
  await writeOrDiagnose([...W.counted(dml, params), W.audit(c.me.email, 'catalog.price.' + (detail.created ? 'create' : 'update'), 'engagement', p + '/' + s, detail)], async () => (!(await exists()) ? new HttpError(404, 'not_found') : new HttpError(409, detail.created ? 'layer_exists' : 'conflict')));
  return { ok: true };
});
route('POST', /^\/catalog\/engagements\/(\d+)\/(\d+)\/prices\/(market|provider_offer|unclassified)\/classify$/, 'prices.classify', { path: '/catalog/engagements/1/1/prices/unclassified/classify', body: { to: 'market' } }, async (c, pid, sid, kind) => {
  const p = idOf(pid), s = idOf(sid), b = fields(c, ['to']), to = oneOf(b.to, ['market', 'provider_offer'], 'bad_target');
  if (kind !== 'unclassified') throw bad('only_unclassified_can_be_classified');
  const dml = "UPDATE provider_service_prices SET kind = $1, status = 'recorded', recorded_by = $2, updated_at = now() WHERE professional_id = $3::bigint AND service_id = $4::bigint AND kind = 'unclassified'";
  try { await W.run([...W.counted(dml, [to, c.me.email, String(p), String(s)]), W.audit(c.me.email, 'catalog.price.classify', 'engagement', p + '/' + s, { from: 'unclassified', to })]); }
  catch (e) { if (e.noRows) throw new HttpError(404, 'not_found'); if (e.code === 'duplicate') throw new HttpError(409, 'layer_exists'); throw e; }
  return { ok: true };
});
route('POST', /^\/catalog\/engagements\/(\d+)\/(\d+)\/link-price$/, 'prices.link', { path: '/catalog/engagements/1/1/link-price', body: { pricing_id: 1, expected_pricing_id: null } }, async (c, pid, sid) => {
  const p = idOf(pid), s = idOf(sid), b = fields(c, ['pricing_id', 'expected_pricing_id']), pricingId = idBody(b.pricing_id, 'bad_pricing_id');
  if (b.expected_pricing_id === undefined) throw bad('expected_required'); const was = b.expected_pricing_id === null ? null : String(idBody(b.expected_pricing_id, 'bad_expected'));
  // only a price that EXISTS, is APPROVED, has a price, belongs to this service (and is general or this provider's); read here, never written. Not while the engagement is active.
  const dml = "UPDATE provider_services SET pricing_id = $1::bigint, pricing_model = 'fixed', updated_by = $2, updated_at = now() WHERE professional_id = $3::bigint AND service_id = $4::bigint AND pricing_id IS NOT DISTINCT FROM $5::bigint AND activation <> 'active' " +
    'AND EXISTS (SELECT 1 FROM pricing pr WHERE pr.id = $1::bigint AND pr.approved AND pr.price IS NOT NULL AND pr.service_id = provider_services.service_id AND (pr.professional_id IS NULL OR pr.professional_id = provider_services.professional_id))';
  await writeOrDiagnose([...W.counted(dml, [String(pricingId), c.me.email, String(p), String(s), was]), W.audit(c.me.email, 'catalog.price.link', 'engagement', p + '/' + s, { pricing_id: pricingId })], async () => {
    const r = await db.query('SELECT activation, pricing_id::text AS pricing_id FROM provider_services WHERE professional_id = $1::bigint AND service_id = $2::bigint', [String(p), String(s)]);
    if (!r.length) return new HttpError(404, 'not_found'); if (r[0].activation === 'active') return new HttpError(409, 'engagement_active', 'יש להשהות את ההתקשרות לפני החלפת המחיר המקושר.');
    if (r[0].pricing_id !== was) return new HttpError(409, 'conflict'); return new HttpError(422, 'price_not_eligible', 'השורה אינה קיימת, אינה מאושרת, אין בה מחיר, או שאינה שייכת לשירות ולספק של ההתקשרות.');
  });
  return { ok: true };
});
route('POST', /^\/catalog\/engagements\/(\d+)\/(\d+)\/unlink-price$/, 'prices.unlink', { path: '/catalog/engagements/1/1/unlink-price', body: { expected_pricing_id: 1 } }, async (c, pid, sid) => {
  const p = idOf(pid), s = idOf(sid), b = fields(c, ['expected_pricing_id']), was = String(idBody(b.expected_pricing_id, 'expected_required'));
  const dml = "UPDATE provider_services SET pricing_id = NULL, pricing_model = 'tbd', updated_by = $1, updated_at = now() WHERE professional_id = $2::bigint AND service_id = $3::bigint AND pricing_id = $4::bigint AND activation <> 'active'";
  await writeOrDiagnose([...W.counted(dml, [c.me.email, String(p), String(s), was]), W.audit(c.me.email, 'catalog.price.unlink', 'engagement', p + '/' + s, {})], async () => {
    const r = await db.query('SELECT activation FROM provider_services WHERE professional_id = $1::bigint AND service_id = $2::bigint', [String(p), String(s)]);
    if (!r.length) return new HttpError(404, 'not_found'); return r[0].activation === 'active' ? new HttpError(409, 'engagement_active') : new HttpError(409, 'conflict');
  });
  return { ok: true };
});

// ===== the controlled import: two steps, nothing stored between them ============================================================================================================
// Step 1 (preview) reads and compares; it writes NOTHING, not even an audit row. Step 2 (apply) is sent the same file again with the id of the preview and the owner's approvals (row numbers and
// change ids, never operations): the server reads the data again, builds the preview again, and refuses if it is not the preview that was approved; it plans the operations itself, checks them
// against the safety rules, and saves them in ONE transaction that also re-checks, under a table lock, that the data is still what the preview was made from.
const mapping = (v, code) => { if (v === undefined) return undefined; if (!isObj(v) || Object.keys(v).length > 200) throw bad(code); for (const [k, x] of Object.entries(v)) if (typeof k !== 'string' || k.length > 100 || (typeof x !== 'string' && !isObj(x))) throw bad(code); return v; };
async function importInputs(c, extra) {
  const b = fields(c, ['csv', 'mappings', 'columnMap'].concat(extra || []));
  if (typeof b.csv !== 'string' || !b.csv.length) throw bad('bad_csv');
  const mappings = mapping(b.mappings, 'bad_mappings'), columnMap = mapping(b.columnMap, 'bad_column_map');
  const snap = await store.readSnapshot();
  const preview = Imp.buildPreview({ csv: b.csv, existing: snap.snapshot, mappings, columnMap, maxRows: MAX_IMPORT_ROWS });
  return { b, snap, preview };
}
route('POST', /^\/catalog\/imports\/preview$/, 'imports.preview', { path: '/catalog/imports/preview', body: { csv: '"תחום","השירות המדויק"\r\n' } }, async (c) => {
  const { preview } = await importInputs(c);
  return { preview };
}, MAX_IMPORT_BYTES);
route('POST', /^\/catalog\/imports\/apply$/, 'imports.apply', { path: '/catalog/imports/apply', body: { csv: '"תחום","השירות המדויק"\r\n', previewId: 'x', approvals: { rows: {} } } }, async (c) => {
  const { b, snap, preview } = await importInputs(c, ['previewId', 'approvals']);
  if (typeof b.previewId !== 'string' || !/^[0-9a-f]{64}$/.test(b.previewId) || !isObj(b.approvals) || !isObj(b.approvals.rows) || Object.keys(b.approvals.rows).length > 400) throw bad('bad_approvals');
  if (!preview.ok) throw refusal(422, 'file_not_usable', { problems: preview.fileProblems }, 'הקובץ אינו תקין ולכן לא נשמר דבר.');
  if (preview.previewId !== b.previewId) throw new HttpError(409, 'preview_stale', 'התצוגה המקדימה כבר אינה תואמת לקובץ או לנתונים. יש להפיק תצוגה חדשה.');
  const plan = Imp.planApply(preview, b.approvals, snap.snapshot, { actor: c.me.email, previewId: b.previewId });
  if (!plan.ok) { if (plan.reason === 'rows_refused') throw refusal(422, 'rows_refused', { refused: plan.refused }, 'חלק מהשורות שאושרו אינן ניתנות לשמירה, ולכן לא נשמר דבר.'); throw new HttpError(409, plan.reason === 'snapshot_changed' ? 'preview_stale' : plan.reason); }
  if (!plan.operations.length) return { applied: false, operations: {} };   // nothing approved changes anything: nothing is written, not even a log row
  Imp.assertSafe(plan.operations);   // the safety rules again, on the operations themselves, right before they are turned into SQL
  const ids = await W.reserveIds(plan.operations), log = Imp.importLog(preview, plan, c.me.email);
  const rowsApplied = Array.from(new Set(plan.operations.map((o) => o.source_row))).sort((x, y) => x - y);
  await W.run(W.importBatch(plan.operations, ids, { expect: snap.fingerprint, actor: c.me.email, fileSha256: preview.fileSha256, summary: plan.summary, rowsApplied, log }), 'import');
  await opsAlert('ייבוא קטלוג הוחל', 'הוחלו ' + rowsApplied.length + ' שורות מקובץ הייבוא על ידי ' + c.me.email + '.');
  return { applied: true, operations: plan.summary, rows_applied: rowsApplied, file_sha256: preview.fileSha256 };
}, MAX_IMPORT_BYTES);

module.exports = { ROUTES, MAX_IMPORT_ROWS, SERVICE, PROFILE, ENGAGEMENT, SETTINGS, layerFrom };
