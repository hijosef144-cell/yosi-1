'use strict';
const { json, fail, HttpError, parseBody, logError } = require('./http');
const { cleanText } = require('./validate');
const content = require('./content');
const db = require('./db');
const engine = require('../../../kaspchem/assets/engine.js');

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
  return { requests: rows };
});

on('GET', '/requests/(\\d+)', async (c, id) => {
  const rid = idOf(id);
  const [r] = await db.query(
    `SELECT r.*, a.name, a.phone, a.email FROM treatment_requests r JOIN applicants a ON a.id = r.applicant_id WHERE r.id = $1`, [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  const [notes, consents, revenues, topic] = await Promise.all([
    db.query('SELECT id, author, body, created_at FROM request_notes WHERE request_id = $1 ORDER BY created_at', [rid]),
    db.query('SELECT kind, granted, text_version, created_at FROM consents WHERE request_id = $1 ORDER BY id', [rid]),
    db.query('SELECT * FROM revenues WHERE request_id = $1 ORDER BY created_at', [rid]),
    content.loadTopic(r.topic)
  ]);
  // Show the answers with their original wording so staff don't need to decode ids.
  const readable = topic ? engine.visibleQuestions(topic, r.answers).map((q) => ({
    question: q.text, answer: [].concat(r.answers[q.id]).map((id) => (q.options.find((o) => o.id === id) || {}).label || id).join(' · ')
  })) : [];
  const findings = topic ? (r.findings || []).map((fid) => (topic.rules.find((x) => x.id === fid) || { finding: { title: fid } }).finding.title) : r.findings;
  const findingDetails = topic ? (r.findings || []).map((fid) => { const rule = topic.rules.find((x) => x.id === fid) || {}; return { id: fid, title: (rule.finding || {}).title || fid, refer: (rule.finding || {}).refer || null, serviceTag: rule.serviceTag || null }; }) : [];
  return { request: Object.assign({}, r, { readable, findingTitles: findings, findingDetails }), notes, consents, revenues };
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
  return { ok: true };
});

// Privacy erasure: removes the person and (via ON DELETE) their notes and consents; revenue rows go with the request.
on('POST', '/applicants/(\\d+)/erase', async (c, id) => {
  const aid = idOf(id);
  if (c.body.confirm !== 'ERASE') throw new HttpError(400, 'confirmation_required');
  await db.query('DELETE FROM revenues WHERE request_id IN (SELECT id FROM treatment_requests WHERE applicant_id = $1)', [aid]);
  await db.query('DELETE FROM treatment_requests WHERE applicant_id = $1', [aid]);
  await db.query('DELETE FROM applicants WHERE id = $1', [aid]);
  await audit(c.me.email, 'applicant.erase', 'applicant', aid, {});
  return { ok: true };
});

// Services ------------------------------------------------------------------------------------------------------
on('GET', '/services', async () => ({ services: await db.query('SELECT * FROM services ORDER BY topic NULLS LAST, name') }));
on('POST', '/services', async (c) => {
  const b = c.body;
  const r = await db.query('INSERT INTO services (topic, name, description) VALUES ($1,$2,$3) RETURNING id', [optText(b.topic, 40), text(b.name, 120), optText(b.description, 600)]);
  await audit(c.me.email, 'service.create', 'service', r[0].id, {});
  return { id: Number(r[0].id) };
});
on('PATCH', '/services/(\\d+)', async (c, id) => {
  const b = c.body;
  await db.query('UPDATE services SET topic=$1, name=$2, description=$3, active=$4 WHERE id=$5', [optText(b.topic, 40), text(b.name, 120), optText(b.description, 600), b.active !== false, idOf(id)]);
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
  const r = await db.query('INSERT INTO professionals (name, contact, topics, agreement_status, agreement_notes, routing_enabled) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', proFields(c.body));
  await audit(c.me.email, 'professional.create', 'professional', r[0].id, {});
  return { id: Number(r[0].id) };
});
on('PATCH', '/professionals/(\\d+)', async (c, id) => {
  await db.query('UPDATE professionals SET name=$1, contact=$2, topics=$3, agreement_status=$4, agreement_notes=$5, routing_enabled=$6 WHERE id=$7', proFields(c.body).concat([idOf(id)]));
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
on('POST', '/pricing', async (c) => {
  const r = await db.query('INSERT INTO pricing (service_id, professional_id, label, price, cost, commission, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', priceFields(c.body));
  await audit(c.me.email, 'pricing.create', 'pricing', r[0].id, {});
  return { id: Number(r[0].id) };
});
on('PATCH', '/pricing/(\\d+)', async (c, id) => {
  await db.query('UPDATE pricing SET service_id=$1, professional_id=$2, label=$3, price=$4, cost=$5, commission=$6, notes=$7, approved=false, approved_by=NULL, approved_at=NULL, public=false WHERE id=$8',
    priceFields(c.body).concat([idOf(id)]));
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
  return { topics: topics.map((t) => ({ id: t.id, name: t.name, live: t.versionLabel, versions: rows.filter((r) => r.topic === t.id) })) };
});
on('GET', '/questionnaires/([a-z-]+)', async (c, topic) => {
  const live = await content.loadTopic(topic);
  if (!live) throw new HttpError(404, 'not_found');
  const draft = (await db.query("SELECT id, version, content, note FROM questionnaire_versions WHERE topic = $1 AND status = 'draft' ORDER BY version DESC LIMIT 1", [topic]))[0] || null;
  return { live, draft };
});
on('PUT', '/questionnaires/([a-z-]+)/draft', async (c, topic) => {
  const seedT = content.seedTopic(topic);
  if (!seedT) throw new HttpError(404, 'not_found');
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
  return { ok: true, version: d.version };
});
// Roll back = re-publish an archived version (production-safe undo for content).
on('POST', '/questionnaires/([a-z-]+)/rollback', async (c, topic) => {
  const target = (await db.query("SELECT id, version FROM questionnaire_versions WHERE topic = $1 AND id = $2 AND status = 'archived'", [topic, idOf(c.body.id)]))[0];
  if (!target) throw new HttpError(400, 'bad_version');
  await db.query("UPDATE questionnaire_versions SET status = 'archived' WHERE topic = $1 AND status = 'published'", [topic]);
  await db.query("UPDATE questionnaire_versions SET status = 'published', published_at = now() WHERE id = $1", [target.id]);
  await audit(c.me.email, 'questionnaire.rollback', 'topic', topic, { version: target.version });
  return { ok: true };
});
on('POST', '/questionnaires/([a-z-]+)/discard', async (c, topic) => {
  await db.query("DELETE FROM questionnaire_versions WHERE topic = $1 AND status = 'draft'", [topic]);
  return { ok: true };
});

// Settings & audit ----------------------------------------------------------------------------------------------
on('GET', '/settings', async () => {
  const rows = await db.query('SELECT key, value, updated_by, updated_at FROM settings ORDER BY key');
  return { settings: rows };
});
on('PUT', '/settings', async (c) => {
  const key = String(c.body.key || '');
  if (!/^(public|private)\.[a-z_]{1,40}$/.test(key)) throw new HttpError(400, 'bad_key');
  if (JSON.stringify(c.body.value).length > 4000) throw new HttpError(400, 'too_large');
  await db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [key, JSON.stringify(c.body.value), c.me.email]);
  await audit(c.me.email, 'settings.update', 'settings', key, {});
  return { ok: true };
});
on('GET', '/audit', async () => ({ audit: await db.query('SELECT actor, action, entity, entity_id, created_at FROM audit_log ORDER BY id DESC LIMIT 200') }));

// ---- entry: caller (kaspchem-admin.mjs) has already authenticated and authorized `me` --------------------------------
async function handle(event, me) {
  try {
    const path = (event.path || '').replace(/^.*\/api\/kaspchem\/admin/, '') || '/';
    const method = event.httpMethod;
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
