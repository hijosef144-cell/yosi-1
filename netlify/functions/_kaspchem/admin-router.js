'use strict';
const { json, fail, HttpError, parseBody, logError } = require('./http');
const { cleanText, normalizePhone, cleanEmail } = require('./validate');
const content = require('./content');
const db = require('./db');
const { opsAlert } = require('./ops-alert');
const impact = require('./impact');
const engine = require('../../../kaspchem/assets/engine.js');
const catalog = require('./admin-catalog-router');
const catalogOwnedWrites = [['POST', /^\/services$/], ['PATCH', /^\/services\/\d+$/], ['POST', /^\/professionals$/], ['PATCH', /^\/professionals\/\d+$/]];   // the older routes that write what the catalog owns while it is open
const serviceGuard = require('./service-guard');
const priceGuard = require('./catalog-price-guard');

const STATUSES = ['new', 'contacted', 'in_progress', 'awaiting_client', 'done', 'closed', 'spam'];
const AGREEMENTS = ['none', 'in_talks', 'signed', 'ended'];
const num = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 1e9 ? Number(v) : undefined));
const idOf = (s) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'bad_id'); return n; };
const text = (v, max) => { const t = cleanText(v, 1, max); if (!t) throw new HttpError(400, 'bad_text'); return t; };
const optText = (v, max) => (v == null || v === '' ? null : text(v, max));

async function audit(actor, action, entity, entityId, detail) {
  await db.query('INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)', [actor, action, entity, String(entityId || ''), JSON.stringify(detail || {})]);
}

// ---- route table: [method, regex, handler(ctx)] ----------------------------------------------------------------
const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp('^' + pattern + '$'), fn]);

on('GET', '/me', async (c) => ({ email: c.me.email }));

on('GET', '/stats', async () => {
  const [byStatus, byTopic, money] = await Promise.all([
    db.query('SELECT status, count(*)::int AS n FROM treatment_requests GROUP BY status'),
    db.query('SELECT topic, count(*)::int AS n FROM treatment_requests GROUP BY topic ORDER BY n DESC'),
    db.query("SELECT coalesce(sum(amount),0) AS revenue, coalesce(sum(cost),0) AS cost, count(*)::int AS n FROM revenues WHERE status = 'approved'")
  ]);
  const m = money[0];
  return { byStatus, byTopic, approved: { revenue: Number(m.revenue), cost: Number(m.cost), profit: Number(m.revenue) - Number(m.cost), count: m.n } };
});

// Treatment requests --------------------------------------------------------------------------------------------
on('GET', '/requests', async (c) => {
  const q = c.query; const where = []; const p = [];
  if (q.status && STATUSES.includes(q.status)) { p.push(q.status); where.push('r.status = $' + p.length); }
  if (q.topic) { p.push(String(q.topic).slice(0, 40)); where.push('r.topic = $' + p.length); }
  if (q.q) { p.push('%' + String(q.q).slice(0, 60) + '%'); where.push('(a.name ILIKE $' + p.length + ' OR a.phone LIKE $' + p.length + ')'); }
  const rows = await db.query(
    `SELECT r.id, r.topic, r.status, r.assignee, r.outcome, r.created_at, r.consent_marketing, a.id AS applicant_id, a.name, a.phone, a.email,
            (SELECT count(*)::int FROM treatment_requests x WHERE x.applicant_id = a.id) AS applicant_requests
     FROM treatment_requests r JOIN applicants a ON a.id = r.applicant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC LIMIT 300`, p);
  await audit(c.me.email, 'request.list', 'request', '', { rows: rows.length, filtered: where.length > 0 }); // the list shows names and phones
  return { requests: rows };
});

on('GET', '/requests/(\\d+)', async (c, id) => {
  const rid = idOf(id);
  const [r] = await db.query(
    `SELECT r.*, a.name, a.phone, a.email FROM treatment_requests r JOIN applicants a ON a.id = r.applicant_id WHERE r.id = $1`, [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  const [notes, consents, revenues, topic, outcomeRows] = await Promise.all([
    db.query('SELECT id, author, body, created_at FROM request_notes WHERE request_id = $1 ORDER BY created_at', [rid]),
    db.query('SELECT kind, granted, text_version, created_at FROM consents WHERE request_id = $1 ORDER BY id', [rid]),
    db.query('SELECT * FROM revenues WHERE request_id = $1 ORDER BY created_at', [rid]),
    content.loadTopic(r.topic),
    db.query("SELECT id, amount::text AS amount, amount_basis FROM outcomes WHERE request_id = $1 AND source = 'system' AND voided_at IS NULL ORDER BY id", [rid])
  ]);
  // Show the answers with their original wording so staff don't need to decode ids.
  let readable, findings, findingDetails;
  if (topic && topic.kind === 'deep') {
    // The deep check: answers are profile + topic questions (qualified ids), findings are stored as "tier:ruleId" and shown grouped by tier.
    const deep = await content.loadDeepConfig({ ignoreRequires: true });
    const eff = deep ? engine.deepEffective(deep, r.answers) : { answers: {}, visible: {} };
    readable = deep ? deep.questions.filter((q) => eff.answers[q.id] != null).map((q) => ({
      question: q.text, answer: [].concat(r.answers[q.id]).map((id) => (q.options.find((o) => o.id === id) || {}).label || id).join(' · ')
    })) : [];
    const TIER = { high: 'סבירות גבוהה', missing: 'חסר מידע', low: 'סבירות נמוכה' };
    findingDetails = (r.findings || []).map((s) => {
      const m = /^(high|missing|low):(.+)$/.exec(String(s)) || [null, 'high', String(s)];
      const rule = (deep && deep.rules.find((x) => x.id === m[2])) || {};
      const sub = rule.subject && deep && deep.subjects && deep.subjects[rule.subject] ? deep.subjects[rule.subject].label : null;
      const unv = !!(deep && (deep.unverified || []).some((u) => u.id === (rule.baseId || rule.id)));
      return { id: m[2], tier: m[1], tierLabel: TIER[m[1]], title: (rule.finding || {}).title || m[2], subject: rule.subject || null, subjectLabel: sub, unverified: unv, refer: (rule.finding || {}).refer || null, serviceTag: rule.serviceTag || null };
    });
    findings = findingDetails.map((d) => d.tierLabel + ': ' + d.title + (d.subjectLabel ? ' (עבור: ' + d.subjectLabel + ')' : ''));
  } else {
    readable = topic ? engine.visibleQuestions(topic, r.answers).map((q) => ({
      question: q.text, answer: [].concat(r.answers[q.id]).map((id) => (q.options.find((o) => o.id === id) || {}).label || id).join(' · ')
    })) : [];
    // The quick check's findings point at other topics: show "topic: reason" so staff see which topics were recommended.
    const fTitle = (rule, fid) => { const f = (rule || {}).finding || {}; const t = f.title || fid; return topic && topic.kind === 'router' && f.groupTitle ? f.groupTitle + ': ' + t + (f.needsInfo ? ' (חסר מידע)' : '') : t; };
    findings = topic ? (r.findings || []).map((fid) => fTitle(topic.rules.find((x) => x.id === fid), fid)) : r.findings;
    findingDetails = topic ? (r.findings || []).map((fid) => { const rule = topic.rules.find((x) => x.id === fid) || {}; return { id: fid, title: fTitle(rule, fid), refer: (rule.finding || {}).refer || null, serviceTag: rule.serviceTag || null }; }) : [];
  }
  await audit(c.me.email, 'request.view', 'request', rid, {}); // who looked at personal details, not only who changed something
  return { request: Object.assign({}, r, { readable, findingTitles: findings, findingDetails }), notes, consents, revenues, outcome: (() => { const own = outcomeRows.filter((o) => o.amount_basis === 'documented' && Number(o.amount) > 0); return { any: outcomeRows.length, count: own.length, id: own.length === 1 ? Number(own[0].id) : null, amount: own.reduce((t, o) => t + Math.round(Number(o.amount) * 100), 0) / 100 }; })() };
});

on('PATCH', '/requests/(\\d+)', async (c, id) => {
  const rid = idOf(id); const b = c.body; const sets = []; const p = [];
  if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw new HttpError(400, 'bad_status'); p.push(b.status); sets.push('status = $' + p.length); }
  if (b.assignee !== undefined) { p.push(optText(b.assignee, 60)); sets.push('assignee = $' + p.length); }
  if (b.service_id !== undefined) { p.push(b.service_id ? idOf(b.service_id) : null); sets.push('service_id = $' + p.length); }
  if (b.professional_id !== undefined) { p.push(b.professional_id ? idOf(b.professional_id) : null); sets.push('professional_id = $' + p.length); }
  if (!sets.length) throw new HttpError(400, 'nothing_to_update');
  p.push(rid);
  const rows = await db.query('UPDATE treatment_requests SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $' + p.length + ' RETURNING id', p);
  if (!rows.length) throw new HttpError(404, 'not_found');
  await audit(c.me.email, 'request.update', 'request', rid, { fields: Object.keys(b) });
  return { ok: true };
});

on('POST', '/requests/(\\d+)/notes', async (c, id) => {
  const rid = idOf(id);
  await db.query('INSERT INTO request_notes (request_id, author, body) VALUES ($1,$2,$3)', [rid, c.me.email, text(c.body.body, 2000)]);
  await audit(c.me.email, 'note.create', 'request', rid, {}); // the note text itself is never copied into the log
  return { ok: true };
});

// Deleting applicants from the dashboard is disabled (owner decision, 2.11.2026): no admin can remove personal data or income records here.
// The route stays only so that an old page or a stale client gets a clear refusal; it changes no data. A legally required erasure is handled separately, outside the dashboard.
on('POST', '/applicants/(\\d+)/erase', async (c, id) => {
  await audit(c.me.email, 'applicant.erase.refused', 'applicant', idOf(id), {});
  throw new HttpError(410, 'erase_disabled');
});

// Access and correction requests (applicant rights). Which fields may be corrected and how long data is kept are legal decisions;
// this only provides the mechanics. Neither route echoes personal data into the audit log. ---------------------------------
on('GET', '/applicants/(\\d+)/export', async (c, id) => {
  const aid = idOf(id);
  const [a] = await db.query('SELECT id, name, phone, email, created_at FROM applicants WHERE id = $1', [aid]);
  if (!a) throw new HttpError(404, 'not_found');
  const [requests, consents, notes, revenues] = await Promise.all([
    db.query('SELECT id, topic, questionnaire_ver, answers, outcome, findings, status, consent_contact, consent_marketing, created_at FROM treatment_requests WHERE applicant_id = $1 ORDER BY id', [aid]),
    db.query('SELECT kind, granted, text_version, request_id, created_at FROM consents WHERE applicant_id = $1 ORDER BY id', [aid]),
    db.query('SELECT n.request_id, n.author, n.body, n.created_at FROM request_notes n JOIN treatment_requests r ON r.id = n.request_id WHERE r.applicant_id = $1 ORDER BY n.id', [aid]),
    db.query('SELECT v.request_id, v.amount, v.cost, v.status, v.created_at FROM revenues v JOIN treatment_requests r ON r.id = v.request_id WHERE r.applicant_id = $1 ORDER BY v.id', [aid])
  ]);
  await audit(c.me.email, 'applicant.export', 'applicant', aid, {});
  return { exportedAt: new Date().toISOString(), applicant: a, requests, consents, notes, revenues };
});
on('PATCH', '/applicants/(\\d+)', async (c, id) => {
  const aid = idOf(id); const b = c.body; const sets = []; const p = []; const fields = [];
  if (b.name !== undefined) { const v = cleanText(b.name, 2, 80); if (!v) throw new HttpError(400, 'bad_name'); p.push(v); sets.push('name = $' + p.length); fields.push('name'); }
  if (b.phone !== undefined) { const v = normalizePhone(b.phone); if (!v) throw new HttpError(400, 'bad_phone'); p.push(v); sets.push('phone = $' + p.length); fields.push('phone'); }
  if (b.email !== undefined) { const v = cleanEmail(b.email); if (v === null) throw new HttpError(400, 'bad_email'); p.push(v || null); sets.push('email = $' + p.length); fields.push('email'); }
  if (!sets.length) throw new HttpError(400, 'nothing_to_update');
  p.push(aid);
  let rows;
  try { rows = await db.query('UPDATE applicants SET ' + sets.join(', ') + ' WHERE id = $' + p.length + ' RETURNING id', p); }
  catch (e) { if (e && (e.code === '23505' || /duplicate key|unique/i.test(String(e.message)))) throw new HttpError(409, 'phone_exists'); throw e; }
  if (!rows.length) throw new HttpError(404, 'not_found');
  await audit(c.me.email, 'applicant.update', 'applicant', aid, { fields });
  return { ok: true };
});

// Services ------------------------------------------------------------------------------------------------------
on('GET', '/services', async () => ({ services: await db.query('SELECT * FROM services ORDER BY topic NULLS LAST, name') }));
on('POST', '/services', async (c) => {
  const b = c.body;
  const r = await db.query('INSERT INTO services (topic, name, description) SELECT $1::text, $2::text, $3::text WHERE ' + catalog.OLD_WRITE_CLOSED + ' RETURNING id', [optText(b.topic, 40), text(b.name, 120), optText(b.description, 600)]);
  if (!r.length) { await catalog.refuseOldWrite(); throw new HttpError(409, 'conflict'); }   // the catalog was opened while this write was on its way: nothing was written
  await audit(c.me.email, 'service.create', 'service', r[0].id, {});
  return { id: Number(r[0].id) };
});
on('PATCH', '/services/(\\d+)', async (c, id) => {
  const b = c.body;
  const v = [optText(b.topic, 40), text(b.name, 120), optText(b.description, 600), b.active !== false, idOf(id)];
  // Owner decision: the name and the topic of a service tied to a price the public site shows cannot change. The rule is part of the UPDATE itself (see service-guard.js).
  const done = await db.query('UPDATE services s SET topic=$1, name=$2, description=$3, active=$4 WHERE s.id = $5 AND ' + serviceGuard.allowsChange('$2::text', '$1::text') + ' AND ' + catalog.OLD_WRITE_CLOSED + ' RETURNING s.id', v);
  if (!done.length && await serviceGuard.isBlocked(db, v[4], v[1], v[0])) throw new HttpError(409, 'service_has_public_price', serviceGuard.MESSAGE);
  if (!done.length) await catalog.refuseOldWrite();   // the catalog was opened while this write was on its way: nothing was written (a service that does not exist still answers ok, as it always did)
  await audit(c.me.email, 'service.update', 'service', id, {});
  return { ok: true };
});

// Professionals -------------------------------------------------------------------------------------------------
on('GET', '/professionals', async () => ({ professionals: await db.query('SELECT * FROM professionals ORDER BY name') }));
function proFields(b) {
  if (!AGREEMENTS.includes(b.agreement_status || 'none')) throw new HttpError(400, 'bad_agreement');
  const topics = Array.isArray(b.topics) ? b.topics.map((t) => String(t).slice(0, 40)).slice(0, 12) : [];
  return [text(b.name, 120), optText(b.contact, 200), topics, b.agreement_status || 'none', optText(b.agreement_notes, 1000), b.routing_enabled === true];
}
on('POST', '/professionals', async (c) => {
  const r = await db.query('INSERT INTO professionals (name, contact, topics, agreement_status, agreement_notes, routing_enabled) SELECT $1::text, $2::text, $3::text[], $4::text, $5::text, $6::boolean WHERE ' + catalog.OLD_WRITE_CLOSED + ' RETURNING id', proFields(c.body));
  if (!r.length) { await catalog.refuseOldWrite(); throw new HttpError(409, 'conflict'); }   // the catalog was opened while this write was on its way: nothing was written
  await audit(c.me.email, 'professional.create', 'professional', r[0].id, {});
  return { id: Number(r[0].id) };
});
on('PATCH', '/professionals/(\\d+)', async (c, id) => {
  const done = await db.query('UPDATE professionals SET name=$1, contact=$2, topics=$3, agreement_status=$4, agreement_notes=$5, routing_enabled=$6 WHERE id=$7 AND ' + catalog.OLD_WRITE_CLOSED + ' RETURNING id', proFields(c.body).concat([idOf(id)]));
  if (!done.length) await catalog.refuseOldWrite();   // the catalog was opened while this write was on its way: nothing was written (a professional that does not exist still answers ok, as it always did)
  await audit(c.me.email, 'professional.update', 'professional', id, {});
  return { ok: true };
});

// Pricing: values are typed in by an admin only. Editing a row resets its approval; public requires approval. ----------
on('GET', '/pricing', async () => ({ pricing: await db.query('SELECT * FROM pricing ORDER BY id DESC') }));
function priceFields(b) {
  const price = num(b.price), cost = num(b.cost), commission = num(b.commission);
  if (price === undefined || cost === undefined || commission === undefined) throw new HttpError(400, 'bad_number');
  return [b.service_id ? idOf(b.service_id) : null, b.professional_id ? idOf(b.professional_id) : null, text(b.label, 160), price, cost, commission, optText(b.notes, 600)];
}
// Referral compensation is BLOCKED by default for every topic. It can be switched on per topic only through the setting
// `private.compensation_topics` (a list of topic ids) after written legal approval for that field of practice. A commission
// above zero is refused otherwise, so nobody can enter a referral fee by accident or by habit.
async function assertCompensationAllowed(b) {
  const commission = num(b.commission);
  if (!commission) return; // empty or zero: nothing to block
  const [s] = await db.query("SELECT value FROM settings WHERE key = 'private.compensation_topics'");
  const allowed = s && Array.isArray(s.value) ? s.value : [];
  let topic = null;
  if (b.service_id) { const [sv] = await db.query('SELECT topic FROM services WHERE id = $1', [idOf(b.service_id)]); topic = sv ? sv.topic : null; }
  if (!topic || !allowed.includes(topic)) throw new HttpError(422, 'compensation_blocked');
}
on('POST', '/pricing', async (c) => {
  await assertCompensationAllowed(c.body);
  const r = await db.query('INSERT INTO pricing (service_id, professional_id, label, price, cost, commission, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', priceFields(c.body));
  await audit(c.me.email, 'pricing.create', 'pricing', r[0].id, {});
  return { id: Number(r[0].id) };
});
// P1: a price that the provider catalog links to an engagement in its working state is not changed from here (catalog-price-guard.js says why). The check is part of the UPDATE itself, so there is no gap between looking and
// writing; what remains is a concurrent activation in the very same moment (documented, closed only by a database rule). Before the catalog tables exist this route is exactly what it was.
on('PATCH', '/pricing/(\\d+)', async (c, id) => {
  await assertCompensationAllowed(c.body);
  const guarded = await priceGuard.catalogTablesExist();
  let rows;
  try {
    rows = await db.query('UPDATE pricing SET service_id=$1, professional_id=$2, label=$3, price=$4, cost=$5, commission=$6, notes=$7, approved=false, approved_by=NULL, approved_at=NULL, public=false WHERE id=$8' + (guarded ? ' AND NOT ' + priceGuard.ACTIVE_LINK : '') + ' RETURNING id',
      priceFields(c.body).concat([idOf(id)]));
  } catch (e) {   // migration 003 (the price race guard): the database itself refused an edit that would leave an ACTIVE engagement with a price that is no longer valid, in the very moment the check above could not see
    if (e && e.code === 'P0001' && /price_linked_to_active_engagement/.test(String(e.message))) throw new HttpError(409, 'price_linked_to_active_engagement', priceGuard.LINKED_TO_ACTIVE);
    throw e;
  }
  if (guarded && !rows.length) {   // no row was changed: because of the guard, or because there is no such price (which has always answered "ok" and still does)
    const linked = await db.query('SELECT 1 AS x FROM pricing WHERE id = $1 AND ' + priceGuard.ACTIVE_LINK, [idOf(id)]);
    if (linked.length) throw new HttpError(409, 'price_linked_to_active_engagement', priceGuard.LINKED_TO_ACTIVE);
  }
  await audit(c.me.email, 'pricing.update', 'pricing', id, {});
  return { ok: true };
});
on('POST', '/pricing/(\\d+)/approve', async (c, id) => {
  const makePublic = c.body.public === true;
  const rows = await db.query('UPDATE pricing SET approved = true, approved_by = $1, approved_at = now(), public = $2 WHERE id = $3 AND price IS NOT NULL RETURNING id', [c.me.email, makePublic, idOf(id)]);
  if (!rows.length) throw new HttpError(400, 'price_required');
  await audit(c.me.email, 'pricing.approve', 'pricing', id, { public: makePublic });
  return { ok: true };
});
on('POST', '/pricing/(\\d+)/unpublish', async (c, id) => {
  await db.query('UPDATE pricing SET public = false WHERE id = $1', [idOf(id)]);
  await audit(c.me.email, 'pricing.unpublish', 'pricing', id, {});
  return { ok: true };
});

// Revenues: pending until a second action approves them; only approved rows count in business numbers. ---------------
on('POST', '/requests/(\\d+)/revenues', async (c, id) => {
  const amount = num(c.body.amount), cost = num(c.body.cost);
  if (amount == null || cost === undefined) throw new HttpError(400, 'bad_number');
  await db.query('INSERT INTO revenues (request_id, amount, cost, note, entered_by) VALUES ($1,$2,$3,$4,$5)', [idOf(id), amount, cost || 0, optText(c.body.note, 300), c.me.email]);
  await audit(c.me.email, 'revenue.create', 'request', id, {});
  return { ok: true };
});
on('POST', '/revenues/(\\d+)/decide', async (c, id) => {
  const s = c.body.status;
  if (s !== 'approved' && s !== 'rejected') throw new HttpError(400, 'bad_status');
  await db.query('UPDATE revenues SET status=$1, approved_by=$2, approved_at=now() WHERE id=$3', [s, c.me.email, idOf(id)]);
  await audit(c.me.email, 'revenue.' + s, 'revenue', id, {});
  return { ok: true };
});

// Questionnaires: draft → preview (client-side, same engine) → publish. Versions are immutable once published. ------
on('GET', '/questionnaires', async () => {
  const topics = await content.loadTopics();
  const rows = await db.query('SELECT id, topic, version, status, note, created_by, created_at, published_at FROM questionnaire_versions ORDER BY topic, version DESC');
  return { topics: topics.map((t) => ({ id: t.id, name: t.name, kind: t.kind || null, live: t.versionLabel, versions: rows.filter((r) => r.topic === t.id) })) };
});
on('GET', '/questionnaires/([a-z-]+)', async (c, topic) => {
  const live = await content.loadTopic(topic);
  if (!live || live.kind === 'deep') throw new HttpError(404, 'not_found'); // the deep route (profile, facts, gates) is edited in the content file, not in the questionnaire editor
  const draft = (await db.query("SELECT id, version, content, note FROM questionnaire_versions WHERE topic = $1 AND status = 'draft' ORDER BY version DESC LIMIT 1", [topic]))[0] || null;
  return { live, draft };
});
on('PUT', '/questionnaires/([a-z-]+)/draft', async (c, topic) => {
  const seedT = content.seedTopic(topic);
  if (!seedT || seedT.kind === 'deep') throw new HttpError(404, 'not_found');
  const cfg = c.body.content;
  if (!cfg || typeof cfg !== 'object' || JSON.stringify(cfg).length > 120000) throw new HttpError(400, 'bad_content');
  const errors = engine.lint(cfg);
  const existing = (await db.query("SELECT id FROM questionnaire_versions WHERE topic = $1 AND status = 'draft'", [topic]))[0];
  if (existing) {
    await db.query('UPDATE questionnaire_versions SET content = $1::jsonb, note = $2, created_by = $3 WHERE id = $4', [JSON.stringify(cfg), optText(c.body.note, 300), c.me.email, existing.id]);
  } else {
    const v = (await db.query('SELECT coalesce(max(version),0)+1 AS v FROM questionnaire_versions WHERE topic = $1', [topic]))[0].v;
    await db.query("INSERT INTO questionnaire_versions (topic, version, status, content, note, created_by) VALUES ($1,$2,'draft',$3::jsonb,$4,$5)", [topic, v, JSON.stringify(cfg), optText(c.body.note, 300), c.me.email]);
  }
  await audit(c.me.email, 'questionnaire.draft', 'topic', topic, {});
  return { ok: true, errors };
});
on('POST', '/questionnaires/([a-z-]+)/publish', async (c, topic) => {
  const d = (await db.query("SELECT id, version, content FROM questionnaire_versions WHERE topic = $1 AND status = 'draft'", [topic]))[0];
  if (!d) throw new HttpError(400, 'no_draft');
  const errors = engine.lint(d.content);
  if (errors.length) return { ok: false, errors };
  await db.query("UPDATE questionnaire_versions SET status = 'archived' WHERE topic = $1 AND status = 'published'", [topic]);
  await db.query("UPDATE questionnaire_versions SET status = 'published', published_at = now() WHERE id = $1", [d.id]);
  await audit(c.me.email, 'questionnaire.publish', 'topic', topic, { version: d.version });
  await opsAlert('פורסם שאלון', 'התחום ' + topic + ', גרסה ' + d.version + ', על ידי ' + c.me.email + '.');
  return { ok: true, version: d.version };
});
// Roll back = re-publish an archived version (production-safe undo for content).
on('POST', '/questionnaires/([a-z-]+)/rollback', async (c, topic) => {
  const target = (await db.query("SELECT id, version FROM questionnaire_versions WHERE topic = $1 AND id = $2 AND status = 'archived'", [topic, idOf(c.body.id)]))[0];
  if (!target) throw new HttpError(400, 'bad_version');
  await db.query("UPDATE questionnaire_versions SET status = 'archived' WHERE topic = $1 AND status = 'published'", [topic]);
  await db.query("UPDATE questionnaire_versions SET status = 'published', published_at = now() WHERE id = $1", [target.id]);
  await audit(c.me.email, 'questionnaire.rollback', 'topic', topic, { version: target.version });
  await opsAlert('שאלון הוחזר לגרסה קודמת', 'התחום ' + topic + ', גרסה ' + target.version + ', על ידי ' + c.me.email + '.');
  return { ok: true };
});
on('POST', '/questionnaires/([a-z-]+)/discard', async (c, topic) => {
  await db.query("DELETE FROM questionnaire_versions WHERE topic = $1 AND status = 'draft'", [topic]);
  await audit(c.me.email, 'questionnaire.discard', 'topic', topic, {});
  return { ok: true };
});

// Impact counter, simple model (the rules and the hidden logic live in ./impact.js). The dashboard shows only: families, shekels, an on/off switch and a preview.
// Every change is written to audit_log (figures only, never personal data). Reading (GET) never writes anything.
const isDup = (e) => e && (e.code === '23505' || /duplicate key|unique/i.test(String(e.message)));
const upsertSetting = (key, value, email) => db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [key, JSON.stringify(value), email]);

on('GET', '/impact', async () => {
  const now = new Date();
  const [rows, cfg, done] = await Promise.all([impact.loadRows(), impact.loadConfig(), impact.loadDoneRequests()]);
  const ev = impact.evaluate(rows, cfg, done);
  return {
    enabled: cfg.flag,
    start: { families: ev.start.families, amount: ev.start.amount, split: ev.start.rows > 1 }, // what the owners typed (the sum, read-only, if old data is split over several rows)
    auto: ev.auto,                                                                              // added automatically from completed treatments
    total: { families: ev.families, amount: ev.amount },                                        // exactly what the public counter shows when it is on
    shown: impact.visible(ev, cfg),
    as_of: now.toISOString()
  };
});

// The starting numbers. Saving them is the owners' explicit approval. It updates the one starting row (or creates it). The reference point (the cutoff) is
// FIXED: it is written only when it does not exist yet (the first save: today, plus the exact moment) and is never moved by a later save, so editing these
// numbers never changes what has been added automatically. More than one starting row is never merged silently.
on('PUT', '/impact', async (c) => {
  const families = impact.parseFamilies(c.body.families), amount = impact.parseAmount(c.body.amount, true);
  const [rows, cfg] = await Promise.all([impact.loadRows(), impact.loadConfig()]);
  const start = rows.filter((r) => r.source === 'baseline' && !r.voided);
  if (start.length > 1) throw new HttpError(409, 'split_baseline');
  const was = start.length ? { families: start[0].family_count, amount: Number(start[0].amount) } : null;
  if (start.length) {
    await db.query("UPDATE outcomes SET family_count = $1, amount = $2, amount_basis = 'documented', evidence_note = COALESCE(NULLIF(evidence_note, ''), $3), updated_at = now() WHERE id = $4", [families, amount, impact.START_NOTE, start[0].id]);
  } else {
    await db.query("INSERT INTO outcomes (source, kind, amount, amount_basis, family_count, evidence_note, entered_by) VALUES ('baseline', $1, $2, 'documented', $3, $4, $5)", [impact.AUTO_KIND, amount, families, impact.START_NOTE, c.me.email]);
  }
  let cutoff = cfg.cutoff, set = false;
  if (!cutoff) { // first ever save: fix the reference point
    cutoff = impact.todayIL(); set = true;
    await upsertSetting(impact.KEY.cutoff, cutoff, c.me.email);
    await upsertSetting(impact.KEY.reference, new Date().toISOString(), c.me.email);
  }
  await audit(c.me.email, 'impact.start.save', 'outcome', start.length ? start[0].id : '', { families, amount: Number(amount), from: was, cutoff, cutoff_set: set, created: !start.length });
  return { ok: true };
});

// The switch. Takes effect for the very next visitor (the public endpoint is never cached).
on('POST', '/impact/counter', async (c) => {
  if (typeof c.body.enabled !== 'boolean') throw new HttpError(400, 'bad_value');
  await upsertSetting(impact.KEY.flag, c.body.enabled, c.me.email);
  await audit(c.me.email, c.body.enabled ? 'impact.counter.enable' : 'impact.counter.disable', 'settings', impact.KEY.flag, {});
  return { ok: true, enabled: c.body.enabled };
});

// The amount saved or obtained in one completed treatment. Normally one outcome per request: setting it again corrects that one. Old data may hold several
// (one per kind): they are all summed, are never overwritten or dropped, and cannot be edited from here (only removed, all together).
const OWN_AMOUNTS = "request_id = $1 AND source = 'system' AND voided_at IS NULL AND amount_basis = 'documented' AND amount > 0";
on('PUT', '/requests/(\\d+)/outcome', async (c, id) => {
  const rid = idOf(id), amount = impact.parseAmount(c.body.amount, false);
  const [r] = await db.query('SELECT status FROM treatment_requests WHERE id = $1', [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  if (r.status !== 'done') throw new HttpError(409, 'request_not_done'); // only a completed treatment can carry an amount
  const old = await db.query('SELECT id, amount::text AS amount FROM outcomes WHERE ' + OWN_AMOUNTS + ' ORDER BY id', [rid]);
  if (old.length > 1) throw new HttpError(409, 'several_outcomes');
  if (old.length) {
    await db.query("UPDATE outcomes SET amount = $1, updated_at = now() WHERE id = $2", [amount, old[0].id]);
    await audit(c.me.email, 'impact.outcome.update', 'request', rid, { amount: Number(amount), from: Number(old[0].amount) });
  } else {
    try {
      await db.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, evidence_note, entered_by) VALUES ('system', $1, $2, 'documented', $3, $4, $5, $6)", [impact.AUTO_KIND, amount, rid, impact.todayIL(), impact.AUTO_NOTE, c.me.email]);
    } catch (e) { if (isDup(e)) throw new HttpError(409, 'outcome_exists'); throw e; }
    await audit(c.me.email, 'impact.outcome.create', 'request', rid, { amount: Number(amount) });
  }
  return { ok: true };
});
// Removing voids ALL of the treatment's amounts (one audit entry per row, figures only).
on('POST', '/requests/(\\d+)/outcome/remove', async (c, id) => {
  const rid = idOf(id);
  const rows = await db.query('UPDATE outcomes SET voided_at = now(), voided_by = $2, updated_at = now() WHERE ' + OWN_AMOUNTS + ' RETURNING amount::text AS amount', [rid, c.me.email]);
  if (!rows.length) throw new HttpError(404, 'no_outcome');
  for (const row of rows) await audit(c.me.email, 'impact.outcome.remove', 'request', rid, { amount: Number(row.amount) });
  return { ok: true };
});

// Settings & audit ----------------------------------------------------------------------------------------------
on('GET', '/settings', async () => {
  const rows = await db.query('SELECT key, value, updated_by, updated_at FROM settings ORDER BY key');
  return { settings: rows };
});
// The deep check's readiness panel (read only). The checklist is computed from the served content and the route; nothing is stored.
on('GET', '/deep/readiness', async () => content.deepReadiness());
on('PUT', '/settings', async (c) => {
  if (catalog.touchesSwitch(c.body)) throw new HttpError(400, 'use_catalog_switch', 'מתגי הקטלוג משתנים רק בהחלטה נפרדת של הבעלים, לא מכאן.');   // first of all, whatever else the request holds: nothing is saved
  const key = String(c.body.key || '');
  if (key === 'public.deep_enabled') { // OFF is always allowed and immediate; ON only when every readiness condition holds (409 with the unmet ones, nothing written)
    if (typeof c.body.value !== 'boolean') throw new HttpError(400, 'bad_value');
    if (c.body.value === true) {
      const rd = await content.deepReadiness();
      if (!rd.ready) throw new HttpError(409, 'deep_not_ready', 'הבדיקה המעמיקה אינה מוכנה להפעלה: ' + rd.items.filter((i) => !i.ok).map((i) => i.label).join('; '));
    }
  }
  if (!/^(public|private)\.[a-z_]{1,40}$/.test(key)) throw new HttpError(400, 'bad_key');
  if (impact.MANAGED_KEYS.includes(key)) throw new HttpError(400, 'use_impact_api'); // the impact counter, its cutoff and its approval change only through the validated, audited impact routes
  if (JSON.stringify(c.body.value).length > 4000) throw new HttpError(400, 'too_large');
  if (key === 'private.compensation_topics' && !(Array.isArray(c.body.value) && c.body.value.every((t) => typeof t === 'string' && /^[a-z-]{1,40}$/.test(t)))) throw new HttpError(400, 'bad_value');
  await db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [key, JSON.stringify(c.body.value), c.me.email]);
  await audit(c.me.email, 'settings.update', 'settings', key, {});
  if (key === 'public.legal_approved') await opsAlert(c.body.value === true ? 'שער קבלת הפניות נפתח' : 'שער קבלת הפניות נסגר', 'שונה על ידי ' + c.me.email + '.');
  else if (key === 'private.compensation_topics') await opsAlert('שונתה הפעלת תגמול על הפניות לתחומים', 'שונה על ידי ' + c.me.email + '. תחומים מופעלים כעת: ' + (Array.isArray(c.body.value) && c.body.value.length ? c.body.value.join(', ') : 'אין (הכול חסום)') + '.');
  return { ok: true };
});
on('GET', '/audit', async () => ({ audit: await db.query('SELECT actor, action, entity, entity_id, created_at FROM audit_log ORDER BY id DESC LIMIT 200') }));

// ---- entry: caller (kaspchem-admin.mjs) has already authenticated and authorized `me` --------------------------------
async function handle(event, me) {
  try {
    const path = (event.path || '').replace(/^.*\/api\/kaspchem\/admin/, '') || '/';
    const method = event.httpMethod;
    if (catalog.isCatalogPath(path)) return await catalog.handle(event, me, path);   // the catalog (stage 4a, read only) answers for /catalog/*; every other path is handled below, exactly as before
    if (catalogOwnedWrites.some(([om, ore]) => om === method && ore.test(path.replace(/\/$/, '') || '/'))) await catalog.refuseOldWrite();   // closed for writing while the catalog switch is open (checked after who is asking, before anything is read or written)
    for (const [m, re, fn] of routes) {
      if (m !== method) continue;
      const hit = re.exec(path.replace(/\/$/, '') || '/');
      if (!hit) continue;
      const body = method === 'GET' ? {} : parseBody(event, 150000);
      const out = await fn({ me, body, query: event.queryStringParameters || {} }, ...hit.slice(1));
      return json(200, Object.assign({ ok: true }, out));
    }
    return fail(404, 'not_found');
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.code, e.userMessage);
    logError('admin', e);
    return fail(500, 'server_error');
  }
}

module.exports = { handle };
