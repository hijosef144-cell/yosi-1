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
    db.query("SELECT id, amount::text AS amount FROM outcomes WHERE request_id = $1 AND source = 'system' AND voided_at IS NULL ORDER BY id DESC LIMIT 1", [rid])
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
  return { request: Object.assign({}, r, { readable, findingTitles: findings, findingDetails }), notes, consents, revenues, outcome: outcomeRows.length ? { id: Number(outcomeRows[0].id), amount: Number(outcomeRows[0].amount) } : null };
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

// Impact counter, simple model (the rules and the hidden logic live in ./impact.js). The dashboard shows only: families, shekels, an on/off switch and a preview.
// Every change is written to audit_log (figures only, never personal data). Reading (GET) never writes anything.
const isDup = (e) => e && (e.code === '23505' || /duplicate key|unique/i.test(String(e.message)));
const upsertSetting = (key, value, email) => db.query('INSERT INTO settings (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()', [key, JSON.stringify(value), email]);

on('GET', '/impact', async () => {
  const now = new Date();
  const [rows, cfg] = await Promise.all([impact.loadRows(), impact.loadConfig()]);
  const ev = impact.evaluate(rows, cfg);
  return {
    enabled: cfg.flag,
    start: { families: ev.start.families, amount: ev.start.amount, split: ev.start.rows > 1 }, // what the owners typed (the sum, read-only, if old data is split over several rows)
    auto: ev.auto,                                                                              // added automatically from completed treatments
    total: { families: ev.families, amount: ev.amount },                                        // exactly what the public counter shows when it is on
    shown: impact.visible(ev, cfg),
    as_of: now.toISOString()
  };
});

// The starting numbers. Saving them is the owners' explicit approval: it updates the one starting row (or creates it) and moves the internal cutoff to today,
// because everything completed up to today is taken to be inside the numbers they typed. More than one starting row is never merged silently.
on('PUT', '/impact', async (c) => {
  const families = impact.parseFamilies(c.body.families), amount = impact.parseAmount(c.body.amount, true);
  const [rows, cfg] = await Promise.all([impact.loadRows(), impact.loadConfig()]);
  const start = rows.filter((r) => r.source === 'baseline' && !r.voided);
  if (start.length > 1) throw new HttpError(409, 'split_baseline');
  const today = impact.todayIL();
  const was = start.length ? { families: start[0].family_count, amount: Number(start[0].amount) } : null;
  if (start.length) {
    await db.query("UPDATE outcomes SET family_count = $1, amount = $2, amount_basis = 'documented', evidence_note = COALESCE(NULLIF(evidence_note, ''), $3), updated_at = now() WHERE id = $4", [families, amount, impact.START_NOTE, start[0].id]);
  } else {
    await db.query("INSERT INTO outcomes (source, kind, amount, amount_basis, family_count, evidence_note, entered_by) VALUES ('baseline', $1, $2, 'documented', $3, $4, $5)", [impact.AUTO_KIND, amount, families, impact.START_NOTE, c.me.email]);
  }
  await upsertSetting(impact.KEY.cutoff, today, c.me.email);
  await audit(c.me.email, 'impact.start.save', 'outcome', start.length ? start[0].id : '', { families, amount: Number(amount), from: was, cutoff: today, previous_cutoff: cfg.cutoff, created: !start.length });
  return { ok: true };
});

// The switch. Takes effect for the very next visitor (the public endpoint is never cached).
on('POST', '/impact/counter', async (c) => {
  if (typeof c.body.enabled !== 'boolean') throw new HttpError(400, 'bad_value');
  await upsertSetting(impact.KEY.flag, c.body.enabled, c.me.email);
  await audit(c.me.email, c.body.enabled ? 'impact.counter.enable' : 'impact.counter.disable', 'settings', impact.KEY.flag, {});
  return { ok: true, enabled: c.body.enabled };
});

// The amount saved or obtained in one completed treatment. One outcome per request: setting it again corrects the same one.
on('PUT', '/requests/(\\d+)/outcome', async (c, id) => {
  const rid = idOf(id), amount = impact.parseAmount(c.body.amount, false);
  const [r] = await db.query('SELECT status FROM treatment_requests WHERE id = $1', [rid]);
  if (!r) throw new HttpError(404, 'not_found');
  if (r.status !== 'done') throw new HttpError(409, 'request_not_done'); // only a completed treatment can carry an amount
  const [old] = await db.query("SELECT id, amount::text AS amount FROM outcomes WHERE request_id = $1 AND source = 'system' AND voided_at IS NULL ORDER BY id DESC LIMIT 1", [rid]);
  if (old) {
    await db.query("UPDATE outcomes SET amount = $1, amount_basis = 'documented', updated_at = now() WHERE id = $2", [amount, old.id]);
    await audit(c.me.email, 'impact.outcome.update', 'request', rid, { amount: Number(amount), from: Number(old.amount) });
  } else {
    try {
      await db.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, evidence_note, entered_by) VALUES ('system', $1, $2, 'documented', $3, $4, $5, $6)", [impact.AUTO_KIND, amount, rid, impact.todayIL(), impact.AUTO_NOTE, c.me.email]);
    } catch (e) { if (isDup(e)) throw new HttpError(409, 'outcome_exists'); throw e; }
    await audit(c.me.email, 'impact.outcome.create', 'request', rid, { amount: Number(amount) });
  }
  return { ok: true };
});
on('POST', '/requests/(\\d+)/outcome/remove', async (c, id) => {
  const rid = idOf(id);
  const rows = await db.query("UPDATE outcomes SET voided_at = now(), voided_by = $1, updated_at = now() WHERE request_id = $2 AND source = 'system' AND voided_at IS NULL RETURNING amount::text AS amount", [c.me.email, rid]);
  if (!rows.length) throw new HttpError(404, 'no_outcome');
  await audit(c.me.email, 'impact.outcome.remove', 'request', rid, { amount: Number(rows[0].amount) });
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
