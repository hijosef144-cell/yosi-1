'use strict';
const { json, fail, HttpError, parseBody, logError } = require('./http');
const { cleanText, normalizePhone, cleanEmail } = require('./validate');
const content = require('./content');
const db = require('./db');
const { opsAlert } = require('./ops-alert');
const impact = require('./impact');
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
    db.query("SELECT id, kind, amount::text AS amount, amount_basis, evidence_note, to_char(completed_on,'YYYY-MM-DD') AS completed_on, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, to_char(last_verified_at,'YYYY-MM-DD') AS last_verified_at, voided_at IS NOT NULL AS voided FROM outcomes WHERE request_id = $1 ORDER BY id", [rid])
  ]);
  // Show the answers with their original wording so staff don't need to decode ids.
  const readable = topic ? engine.visibleQuestions(topic, r.answers).map((q) => ({
    question: q.text, answer: [].concat(r.answers[q.id]).map((id) => (q.options.find((o) => o.id === id) || {}).label || id).join(' · ')
  })) : [];
  // The quick check's findings point at other topics: show "topic: reason" so staff see which topics were recommended.
  const fTitle = (rule, fid) => { const f = (rule || {}).finding || {}; const t = f.title || fid; return topic && topic.kind === 'router' && f.groupTitle ? f.groupTitle + ': ' + t + (f.needsInfo ? ' (חסר מידע)' : '') : t; };
  const findings = topic ? (r.findings || []).map((fid) => fTitle(topic.rules.find((x) => x.id === fid), fid)) : r.findings;
  const findingDetails = topic ? (r.findings || []).map((fid) => { const rule = topic.rules.find((x) => x.id === fid) || {}; return { id: fid, title: fTitle(rule, fid), refer: (rule.finding || {}).refer || null, serviceTag: rule.serviceTag || null }; }) : [];
  await audit(c.me.email, 'request.view', 'request', rid, {}); // who looked at personal details, not only who changed something
  return { request: Object.assign({}, r, { readable, findingTitles: findings, findingDetails }), notes, consents, revenues, outcomes: outcomeRows.map((o) => Object.assign({}, o, { amount: Number(o.amount) })) };
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
on('PATCH', '/pricing/(\\d+)', async (c, id) => {
  await assertCompensationAllowed(c.body);
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

// Impact outcomes (stage 3): what the public counter is computed from. The rules live in ./impact.js; this is only the dashboard's way in.
// Every create, edit, void, approval and switch is written to audit_log (ids, kinds and amounts only: never the internal evidence text, never names).
const isDup = (e) => e && (e.code === '23505' || /duplicate key|unique/i.test(String(e.message)));
const OUTCOME_COLS = 'source, kind, amount, amount_basis, request_id, family_count, completed_on, starts_on, ends_on, last_verified_at, evidence_note, entered_by';
const OUTCOME_FIELDS = ['kind', 'amount', 'amount_basis', 'evidence_note', 'completed_on', 'starts_on', 'ends_on', 'last_verified_at', 'family_count'];
async function insertOutcome(v, requestId, email) {
  const r = await db.query(`INSERT INTO outcomes (${OUTCOME_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [v.source, v.kind, v.amount, v.amount_basis, requestId, v.family_count, v.completed_on, v.starts_on, v.ends_on, v.last_verified_at, v.evidence_note, email]);
  return Number(r[0].id);
}
const MISSING_AMOUNT_SQL = `SELECT r.id, r.topic, to_char(r.updated_at AT TIME ZONE 'Asia/Jerusalem', 'YYYY-MM-DD') AS updated_on
  FROM treatment_requests r
  WHERE r.status = 'done'
    AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.request_id = r.id AND o.voided_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action = 'outcome.none' AND a.entity = 'request' AND a.entity_id = r.id::text)
  ORDER BY r.updated_at DESC LIMIT 200`;

on('GET', '/impact', async () => {
  const now = new Date(), today = impact.todayIL(now);
  const [rows, cfg, missing] = await Promise.all([impact.loadRows(true), impact.loadConfig(), db.query(MISSING_AMOUNT_SQL)]);
  const ev = impact.evaluate(rows, cfg, today, false);
  const draft = impact.evaluate(rows, cfg, today, true); // the opening data as it would count once approved
  const real = {}; ev.detail.forEach((d) => { real[d.id] = d; });
  const dr = {}; draft.detail.forEach((d) => { dr[d.id] = d; });
  const shape = (r) => Object.assign({}, r, { applicant_id: undefined, amount: Number(r.amount), counted: real[r.id].counted, reason: real[r.id].reason, active: real[r.id].active, inactive_reason: real[r.id].inactive_reason });
  const warn = impact.addMonths(today, -impact.WARN_MONTHS), expire = impact.addMonths(today, -impact.VERIFY_MONTHS);
  const expiring = rows.filter((r) => dr[r.id].counted && r.kind === 'ongoing_saving' && !['ended', 'not_started'].includes(dr[r.id].inactive_reason) && r.last_verified_at && r.last_verified_at <= warn)
    .map((r) => ({ id: r.id, source: r.source, request_id: r.request_id, topic: r.topic || null, amount: Number(r.amount), family_count: r.family_count, last_verified_at: r.last_verified_at, expires_on: impact.addMonths(r.last_verified_at, impact.VERIFY_MONTHS), expired: r.last_verified_at < expire }));
  const decision = impact.publicDecision(ev, cfg), ifOn = impact.publicDecision(ev, Object.assign({}, cfg, { flag: true }));
  return {
    today,
    config: { counter_enabled: cfg.flag, cutoff: cfg.cutoff, approval: cfg.approval ? { at: cfg.approval.at, by: cfg.approval.by, rows: cfg.approval.rows } : null, approval_valid: ev.approvalValid, baseline_exists: ev.baselineExists },
    blocked_reason: ifOn, // why the public would see nothing even with the switch on (null = it would be shown)
    baseline: rows.filter((r) => r.source === 'baseline').map(shape),
    outcomes: rows.filter((r) => r.source === 'system').map(shape),
    missing_amount: missing, expiring,
    preview: { public_now: decision ? { enabled: false, reason: decision } : Object.assign({ enabled: true }, impact.aggregate(ev, now)), draft: impact.aggregate(draft, now) }
  };
});

on('POST', '/requests/(\\d+)/outcomes', async (c, id) => {
  const rid = idOf(id);
  const [r] = await db.query('SELECT id, status FROM treatment_requests WHERE id = $1', [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  if (r.status !== 'done') throw new HttpError(409, 'request_not_done'); // only a completed treatment can have a counted outcome
  const v = impact.normalize('system', c.body, impact.todayIL());
  let oid;
  try { oid = await insertOutcome(v, rid, c.me.email); } catch (e) { if (isDup(e)) throw new HttpError(409, 'outcome_exists'); throw e; }
  await audit(c.me.email, 'impact.outcome.create', 'outcome', oid, { request_id: rid, kind: v.kind, amount: Number(v.amount), basis: v.amount_basis });
  return { id: oid };
});
// "Completed, but nothing to count": a deliberate decision, so the request stops being listed as "completed without an amount".
on('POST', '/requests/(\\d+)/outcome-none', async (c, id) => {
  const rid = idOf(id);
  const [r] = await db.query('SELECT status FROM treatment_requests WHERE id = $1', [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  if (r.status !== 'done') throw new HttpError(409, 'request_not_done');
  await audit(c.me.email, 'outcome.none', 'request', rid, {});
  return { ok: true };
});

on('POST', '/impact/baseline', async (c) => {
  const v = impact.normalize('baseline', c.body, impact.todayIL());
  const oid = await insertOutcome(v, null, c.me.email);
  await audit(c.me.email, 'impact.baseline.create', 'outcome', oid, { kind: v.kind, amount: Number(v.amount), family_count: v.family_count, basis: v.amount_basis });
  return { id: oid };
});
on('PATCH', '/impact/outcomes/(\\d+)', async (c, id) => {
  const oid = idOf(id);
  const [old] = await db.query(`SELECT source, kind, amount::text AS amount, amount_basis, family_count, evidence_note, voided_at IS NOT NULL AS voided,
      to_char(completed_on,'YYYY-MM-DD') AS completed_on, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, to_char(last_verified_at,'YYYY-MM-DD') AS last_verified_at
    FROM outcomes WHERE id = $1`, [oid]);
  if (!old) throw new HttpError(404, 'not_found');
  if (old.voided) throw new HttpError(409, 'voided');
  const given = OUTCOME_FIELDS.filter((f) => c.body[f] !== undefined);
  if (!given.length) throw new HttpError(400, 'nothing_to_update');
  const merged = Object.assign({}, old); given.forEach((f) => { merged[f] = c.body[f]; });
  const v = impact.normalize(old.source, merged, impact.todayIL());
  try {
    await db.query('UPDATE outcomes SET kind=$1, amount=$2, amount_basis=$3, family_count=$4, completed_on=$5, starts_on=$6, ends_on=$7, last_verified_at=$8, evidence_note=$9, updated_at=now() WHERE id=$10',
      [v.kind, v.amount, v.amount_basis, v.family_count, v.completed_on, v.starts_on, v.ends_on, v.last_verified_at, v.evidence_note, oid]);
  } catch (e) { if (isDup(e)) throw new HttpError(409, 'outcome_exists'); throw e; }
  await audit(c.me.email, old.source === 'baseline' ? 'impact.baseline.update' : 'impact.outcome.update', 'outcome', oid,
    { fields: given, before: { kind: old.kind, amount: Number(old.amount), basis: old.amount_basis, family_count: old.family_count }, after: { kind: v.kind, amount: Number(v.amount), basis: v.amount_basis, family_count: v.family_count } });
  return { ok: true };
});
on('POST', '/impact/outcomes/(\\d+)/void', async (c, id) => {
  const oid = idOf(id);
  const reason = c.body.reason == null || c.body.reason === '' ? null : text(c.body.reason, 200);
  const rows = await db.query('UPDATE outcomes SET voided_at = now(), voided_by = $1, void_reason = $2, updated_at = now() WHERE id = $3 AND voided_at IS NULL RETURNING source, kind, amount::text AS amount', [c.me.email, reason, oid]);
  if (!rows.length) { const [x] = await db.query('SELECT id FROM outcomes WHERE id = $1', [oid]); throw new HttpError(x ? 409 : 404, x ? 'voided' : 'not_found'); }
  await audit(c.me.email, rows[0].source === 'baseline' ? 'impact.baseline.void' : 'impact.outcome.void', 'outcome', oid, { kind: rows[0].kind, amount: Number(rows[0].amount) });
  return { ok: true };
});

// The baseline cutoff: system outcomes count only when the treatment was completed AFTER this date, so history is never counted twice.
on('PUT', '/impact/baseline-cutoff', async (c) => {
  const d = c.body.date;
  if (d !== null && !(impact.isDate(d) && d <= impact.todayIL())) throw new HttpError(400, 'bad_date');
  const cfg = await impact.loadConfig();
  if (d === null) await db.query('DELETE FROM settings WHERE key = $1', [impact.KEY.cutoff]);
  else await db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [impact.KEY.cutoff, JSON.stringify(d), c.me.email]);
  await audit(c.me.email, 'impact.baseline.cutoff', 'settings', impact.KEY.cutoff, { from: cfg.cutoff, to: d });
  return { ok: true };
});
// The single explicit "approve publishing opening data" action. It approves the opening rows exactly as they are now; changing any of them later
// (or the cutoff) makes the approval stale, and the opening data stays out of the public numbers until it is approved again.
on('POST', '/impact/approve-baseline', async (c) => {
  if (c.body.confirm !== true) throw new HttpError(400, 'confirm_required');
  const [rows, cfg] = await Promise.all([impact.loadRows(false), impact.loadConfig()]);
  const base = rows.filter((r) => r.source === 'baseline' && !r.voided);
  if (!base.length) throw new HttpError(400, 'no_baseline');
  if (!cfg.cutoff) throw new HttpError(400, 'cutoff_required');
  const fp = impact.fingerprint(rows, cfg.cutoff);
  if (cfg.approval && cfg.approval.fp === fp) throw new HttpError(409, 'already_approved');
  const value = { fp, at: new Date().toISOString(), by: c.me.email, rows: base.length };
  await db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [impact.KEY.approval, JSON.stringify(value), c.me.email]);
  await audit(c.me.email, 'impact.baseline.approve', 'settings', impact.KEY.approval, { rows: base.length, cutoff: cfg.cutoff, figures: base.map((r) => ({ kind: r.kind, amount: Number(r.amount), family_count: r.family_count, basis: r.amount_basis })) });
  return { ok: true };
});
// The public switch for the counter (default off). Turning it on with unapproved opening data is allowed but shows nothing publicly until approved.
on('POST', '/impact/counter', async (c) => {
  if (typeof c.body.enabled !== 'boolean') throw new HttpError(400, 'bad_value');
  await db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [impact.KEY.flag, JSON.stringify(c.body.enabled), c.me.email]);
  await audit(c.me.email, c.body.enabled ? 'impact.counter.enable' : 'impact.counter.disable', 'settings', impact.KEY.flag, {});
  const [rows, cfg] = await Promise.all([impact.loadRows(false), impact.loadConfig()]);
  return { ok: true, blocked_reason: impact.publicDecision(impact.evaluate(rows, cfg, impact.todayIL(), false), cfg) };
});

// Settings & audit ----------------------------------------------------------------------------------------------
on('GET', '/settings', async () => {
  const rows = await db.query('SELECT key, value, updated_by, updated_at FROM settings ORDER BY key');
  return { settings: rows };
});
on('PUT', '/settings', async (c) => {
  const key = String(c.body.key || '');
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
