'use strict';
// The import against the STRUCTURE of the owners' real sheet (headers, title rows, placeholder rows with only a topic, phones as numbers without the zero, shekel and percent formats), with
// INVENTED data only (tests/fixtures/catalog-sheet-real-shape.csv). Plus three rules found by comparing the engine with that structure:
//   R12 a provider that is archived or paused gets no new engagement          R13 the topic of a service is the id of a topic of the system (a name the system lacks is not stored as text)
//   and a business column that holds a TYPE ("פרטי", "חברה") never makes two different providers look alike.
// Pure engine plus the database (in-memory Postgres, synthetic data). No network, nothing real.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../netlify/functions/_kaspchem/catalog/import.js');
const Sim = require('../netlify/functions/_kaspchem/catalog/similarity.js');
const F = require('./fixtures/catalog-demo.js');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
const store = require('../netlify/functions/_kaspchem/catalog-store.js');
const W = require('../netlify/functions/_kaspchem/catalog-writes.js');
test.after(closeAll);

const SHEET = fs.readFileSync(path.join(__dirname, 'fixtures', 'catalog-sheet-real-shape.csv'), 'utf8');
const { INTERNAL_TOPICS } = require('../netlify/functions/_kaspchem/catalog/internal-topics.js');
const TOPICS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8')).topics.map((t) => ({ id: t.id, name: t.name })).concat(INTERNAL_TOPICS.map((t) => ({ id: t.id, name: t.name })));   // what the import route hands the engine: the topics of the system and the two internal catalog domains
const preview = (csv, existing, extra) => I.buildPreview(Object.assign({ csv, existing: existing || F.EMPTY(), topics: TOPICS }, extra || {}));
const count = (p, k) => { const o = {}; p.rows.forEach((r) => (r[k] || []).forEach((x) => { const c = typeof x === 'string' ? x : x.code; o[c] = (o[c] || 0) + 1; })); return o; };
const rowOf = (p, n) => p.rows.find((r) => r.rowNumber === n);
const approveAll = (p, decisions) => { const rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: [], acceptManual: [], confirmed: r.needsConfirmation, decisions: decisions && decisions[r.rowNumber] }; } return { rows }; };
const NEW = { service: { use: 'new' } };

test('THE STRUCTURE OF THE OWNERS SHEET: title rows above the header, its own header names, placeholder rows with only a topic and a row without a provider are all read; nothing is a problem; what is similar is a question', () => {
  const p = preview(SHEET);
  assert.equal(p.ok, true); assert.deepEqual(p.fileProblems, []); assert.deepEqual(p.warnings, [], 'every column the importer expects was found under the header names of the sheet'); assert.equal(p.headerNumber, 4, 'the three rows above the header are ignored');
  assert.deepEqual(p.unknownColumns.map((u) => u.text), ['הערות תמחור'], 'the one column that is not read is named, not silently dropped');
  assert.deepEqual(p.summary, { rows_total: 22, new: 15, changed: 0, unchanged: 0, skipped: 7, problem: 0 });
  assert.deepEqual(p.rows.filter((r) => r.status === 'skipped').map((r) => r.reason), Array(7).fill('placeholder'), 'the seven rows that hold only a topic are placeholders');
  assert.equal(p.decisionsNeeded, 2, 'two services whose names are close (rent vs. exchange names) are questions, never merged'); assert.deepEqual(p.rows.filter((r) => (r.decisions || []).length).map((r) => r.decisions[0].type), ['similar_service', 'similar_service']);
  assert.equal(rowOf(p, 19).provider, null, 'a service without a provider is a service only'); assert.equal(rowOf(p, 19).engagement, null);
  const provs = p.rows.filter((r) => r.provider && r.provider.action === 'new'); assert.equal(provs.length, 3, 'three providers, although two of them have the same business word and every provider has several rows');
  assert.equal(p.rows.filter((r) => r.provider && r.provider.action === 'decision').length, 0, 'no provider is "similar" to another only because both write "פרטי" in the business column');
});

test('WHAT THE SHEET SAYS BECOMES ONLY WHAT AN IMPORT MAY SET: contact and agreement words (with the typographic gershayim), pending activation, prices as separate layers, phones restored and confirmed, nothing active, no commission', () => {
  const p = preview(SHEET);
  const e = (n) => rowOf(p, n).record.engagement;
  assert.deepEqual([e(5).contact_state, e(5).agreement_state, e(5).activation, e(9).contact_state, e(9).agreement_state], ['negotiating', 'draft', 'pending', 'contacted', 'not_discussed'], 'the word with the gershayim and the others are mapped');
  const kinds = {}; p.rows.forEach((r) => { if (r.record && r.record.layer) kinds[r.record.layer.kind] = (kinds[r.record.layer.kind] || 0) + 1; }); assert.deepEqual(kinds, { unclassified: 11, market: 3 }, 'only a price whose wording says "market" is a market price; the rest is reported and unclassified');
  assert.deepEqual([rowOf(p, 6).record.layer.amount, rowOf(p, 8).record.layer.model, rowOf(p, 14).record.layer.model, rowOf(p, 14).record.layer.minimum_amount, rowOf(p, 18).record.layer.percent_low, rowOf(p, 18).record.layer.percent_high], [300, 'variable', 'percent_with_minimum', 8000, 2, 2.5], 'shekel formats, wording and ranges are read; nothing is invented');
  assert.equal(rowOf(p, 15).record.layer.kind, 'market'); assert.equal(rowOf(p, 15).record.layer.amount, 12000, '₪12,000');
  assert.deepEqual(count(p, 'flags'), { commission_not_imported: 15, questionnaire_mapping_not_imported: 14, price_unclassified: 5, phone_restored: 9, basis_missing: 1 });
  const restored = p.rows.filter((r) => r.flags.includes('phone_restored')); assert.equal(restored.length, 9, 'nine rows have a phone that lost its zero (stored as a number)'); restored.forEach((r) => assert.ok(r.needsConfirmation.includes('phone_restored'), 'each needs an explicit "I looked"'));
  assert.deepEqual([rowOf(p, 9).record.provider.phone, rowOf(p, 5).record.provider.phone], ['0500000022', '0500000011']);
  const plan = I.planApply(p, approveAll(p, { 15: NEW, 17: NEW }), F.EMPTY()); assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.deepEqual(plan.summary, { create_service: 15, create_provider: 3, create_engagement: 14, create_layer: 14 }, 'fifteen services, three providers, fourteen engagements, fourteen price layers');
  plan.operations.filter((o) => o.op === 'create_engagement').forEach((o) => { assert.notEqual(o.set.activation, 'active'); assert.ok(['draft', 'pending'].includes(o.set.activation)); assert.ok(['none', 'contacted', 'negotiating'].includes(o.set.contact_state)); assert.ok(['not_discussed', 'draft'].includes(o.set.agreement_state)); });
  plan.operations.filter((o) => o.op === 'create_service').forEach((o) => assert.equal(o.active, false)); assert.equal(JSON.stringify(plan).includes('commission'), false);
});

test('R13 TOPICS: the topic NAME of the sheet becomes the ID of the system topic or of an internal catalog domain; a name nobody has is never stored as text (no topic, said on the row); without a list of topics the older behaviour stays', () => {
  const p = preview(SHEET); const topic = (n) => rowOf(p, n).record.service.topic;
  assert.deepEqual([topic(5), topic(9), topic(13), topic(14), topic(19)], ['tax-refunds', 'national-insurance', 'insurance-pension', 'mortgage', 'housing']);
  assert.deepEqual([topic(6), topic(7), topic(11)], ['business', 'business', 'savings-investments'], 'the two sheet domains that are not topics of the public check are internal catalog domains (owner decision 2026-11-11): the service keeps its domain');
  assert.deepEqual([rowOf(p, 6).record.service.topic_in_file, rowOf(p, 11).record.service.topic_in_file], [undefined, undefined]); assert.equal(count(p, 'warnings').topic_not_in_system, undefined, 'nothing to warn about: every domain of this sheet is known');
  assert.deepEqual(INTERNAL_TOPICS.map((t) => t.id), ['business', 'savings-investments']); const ids = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8')).topics.map((t) => t.id)); INTERNAL_TOPICS.forEach((t) => assert.equal(ids.has(t.id), false, t.id + ' is NOT a topic of the public check, so no questionnaire, route or page has it'));
  const odd = SHEET.split('"עסקים"').join('"תחום שאינו קיים"'), po = preview(odd);   // a domain nobody has: no topic, said on the row, never stored as text
  assert.deepEqual([rowOf(po, 6).record.service.topic, rowOf(po, 6).record.service.topic_in_file], [null, 'תחום שאינו קיים']); assert.equal(count(po, 'warnings').topic_not_in_system, 2);
  const plan = I.planApply(po, approveAll(po, { 15: NEW, 17: NEW }), F.EMPTY()); const svc = plan.operations.filter((o) => o.op === 'create_service'); assert.equal(svc.filter((o) => o.topic === null).length, 2); assert.equal(svc.some((o) => /[א-ת]/.test(o.topic || '')), false, 'no Hebrew text is ever stored as a topic');
  const plan0 = I.planApply(p, approveAll(p, { 15: NEW, 17: NEW }), F.EMPTY()); assert.deepEqual(plan0.operations.filter((o) => o.op === 'create_service' && ['business', 'savings-investments'].includes(o.topic)).length, 3, 'three services keep an internal domain'); assert.equal(JSON.stringify(plan0).includes('pricing_id'), false, 'and nothing is priced or made public by it');
  assert.equal(I.buildPreview({ csv: SHEET, existing: F.EMPTY() }).rows[0].record.service.topic, 'מסים והחזרים', 'no list of topics given: the text of the file, as before');
  // an existing service whose topic is already the right id: no change is proposed; the sheet's name for the same topic is not a "change"
  const ex = F.EMPTY(); ex.services.push({ id: 5, name: '[דמו] בדיקה והגשת החזר מס לשכירים', topic: 'tax-refunds', description: null, updated_by: 'import:x' });
  assert.equal(rowOf(preview(SHEET, ex), 5).changes.filter((c) => c.field === 'topic').length, 0);
  ex.services[0].topic = 'mortgage'; const ch = rowOf(preview(SHEET, ex), 5).changes.find((c) => c.field === 'topic'); assert.deepEqual([ch.old, ch.new], ['mortgage', 'tax-refunds']);
});

test('A BUSINESS COLUMN THAT HOLDS A TYPE never makes two providers look alike; a real business name still does; the exact match and "same name, other business" are unchanged', () => {
  assert.equal(Sim.isGenericBusiness('פרטי'), true); assert.equal(Sim.isGenericBusiness('חברה בע"מ'), true); assert.equal(Sim.isGenericBusiness('לבני מס'), false);
  const a = { name: 'אבי רוזן', business: 'פרטי' }, pool = [{ id: 1, name: 'מאיה גולן', business_name: 'פרטי' }];
  assert.deepEqual(Sim.matchProvider(a, pool), { exact: [], sameNameOtherBusiness: [], similar: [] }, 'two different people, both "פרטי"');
  assert.equal(Sim.matchProvider({ name: 'דנה לבני', business: 'לבני מס ושות' }, [{ id: 2, name: 'שרה כהן', business_name: 'לבני מס ושות' }]).similar.length, 1, 'the same real business under another name is still a question');
  assert.equal(Sim.matchProvider({ name: 'אבי רוזן', business: 'פרטי' }, [{ id: 3, name: 'אבי רוזן', business_name: 'חברה' }]).sameNameOtherBusiness.length, 1);
  assert.equal(Sim.matchProvider({ name: 'אבי רוזן', business: 'פרטי' }, [{ id: 3, name: 'אבי רוזן', business_name: 'פרטי' }]).exact.length, 1);
  const p = preview(SHEET); assert.equal(count(p, 'warnings').business_is_a_label, 14, 'the row says so: the value is kept as written and used for nothing');
});

test('THE WORDS IN THE DROPDOWNS OF THE SHEET: the ones an import may set are mapped; "approved for referral" is imported as pending and must be confirmed; the ones it may not set stay questions for the owner', () => {
  const row = (n, over) => F.row(Object.assign({ domain: 'משכנתאות', service: ['בדיקת קרן השתלמות', 'ליווי הגשת ערר ארנונה', 'ייעוץ ירושה וצוואות', 'תכנון מס לעצמאים', 'הגשת תביעה לביטוח לאומי', 'בדיקת תלוש שכר'][n], provider: ['אבי רוזן', 'מאיה גולן', 'יעל מורג', 'איתן גל', 'נועה אדלר', 'אורי כץ'][n], externalId: 'W-' + n, contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין לאישור להפניה' }, over));
  const p = preview(F.csv([row(0, { contact: 'לא פניתי' }), row(1, { contact: 'שיחה נקבעה' }), row(2, { activation: 'לא להפניה' }), row(3, { activation: 'מאושר להפניה' }), row(4, { contact: 'מושהה' }), row(5, { agreement: 'לא רלוונטי' })]));
  const e = (n) => rowOf(p, n).record.engagement;
  assert.deepEqual([e(2).contact_state, e(3).contact_state, e(4).activation], ['none', 'contacted', 'draft']);
  assert.deepEqual([e(5).activation, rowOf(p, 5).needsConfirmation], ['pending', ['file_says_active_needs_manual']], 'approved for referral: only a person approves; the row says so and needs an explicit look');
  assert.deepEqual([rowOf(p, 6).status, rowOf(p, 6).problems[0].code, rowOf(p, 6).problems[0].value], ['problem', 'unknown_value', 'מושהה'], 'a paused contact is not something an import can set: a question');
  assert.deepEqual([rowOf(p, 7).status, rowOf(p, 7).problems[0].code, rowOf(p, 7).problems[0].value], ['problem', 'unknown_value', 'לא רלוונטי']);
  const plan = I.planApply(p, approveAll(p), F.EMPTY()); assert.equal(plan.ok, true, JSON.stringify(plan)); plan.operations.filter((o) => o.op === 'create_engagement').forEach((o) => assert.notEqual(o.set.activation, 'active'));
});

test('R12 AN ARCHIVED OR PAUSED PROVIDER gets no new engagement from an import: the row is a problem, nothing of it can be approved, and an engagement that already exists is still updated', () => {
  const file = F.csv([F.row({ domain: 'ביטוחים ופנסיה', service: 'שירות חדש לבדיקה', provider: 'דנה לבני', business: 'לבני מס', externalId: 'NEW-1', contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין לאישור להפניה' })]);
  const ex = F.existing();
  const ok = preview(file, ex); assert.equal(rowOf(ok, 2).status, 'new', 'an available provider: the row is fine');
  for (const why of ['archived', 'paused']) {
    const e = F.clone(ex); e.providers.find((x) => x.id === 21).unavailable = why;
    const p = preview(file, e); const r = rowOf(p, 2); assert.equal(r.status, 'problem'); assert.deepEqual([r.problems[0].code, r.problems[0].field, r.problems[0].value], ['provider_unavailable', 'provider', why]); assert.equal(r.engagement, null);
    const plan = I.planApply(p, { rows: { 2: { apply: true } } }, e); assert.deepEqual([plan.ok, plan.reason, plan.refused[0].reason, plan.operations], [false, 'rows_refused', 'row_is_problem', []]);
  }
  // an engagement that exists already is not "new": editing it is allowed (only a NEW engagement needs an available provider)
  const e2 = F.clone(ex); e2.providers.find((x) => x.id === 21).unavailable = 'paused';
  const upd = F.csv([F.row({ domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבני', business: 'לבני מס', externalId: 'TX-01', contact: 'במו"מ', agreement: 'טרם נדון', activation: 'ממתין לאישור להפניה' })]);
  assert.notEqual(rowOf(preview(upd, e2), 2).status, 'problem'); assert.equal(rowOf(preview(upd, e2), 2).problems.length, 0);
  // the owner answered a similarity question with "use this existing provider": the plan still refuses an unavailable one
  const near = F.csv([F.row({ domain: 'ביטוחים ופנסיה', service: 'שירות חדש לבדיקה', provider: 'דנה לבנין', business: 'לבני מס', externalId: 'NEW-2', contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין לאישור להפניה' })]);
  const e3 = F.clone(ex); e3.providers.find((x) => x.id === 21).unavailable = 'archived'; const pn = preview(near, e3); assert.equal(rowOf(pn, 2).decisions[0].entity, 'provider', 'a near name is a question');
  const refused = I.planApply(pn, { rows: { 2: { apply: true, decisions: { provider: { use: 'existing', id: 21 } } } } }, e3); assert.deepEqual([refused.ok, refused.refused[0].reason, refused.operations], [false, 'provider_unavailable', []]);
  const fine = I.planApply(pn, { rows: { 2: { apply: true, decisions: { provider: { use: 'new' } } } } }, e3); assert.equal(fine.ok, true, 'a NEW provider (the owner said it is someone else) is fine');
});

// ---- the database: the snapshot knows who is unavailable, the fingerprint moves with it, and the INSERT of the save re-checks on its own --------------------------------------------------
const j = (b) => ({ body: b });
const IMPORT = '/catalog/imports';
const DATA = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'audit_log'];
const prev = async (w, csv) => { const r = await w.call('POST', IMPORT + '/preview', YOSI, j({ csv })); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.preview; };
const applyTo = (w, csv, p, a) => w.call('POST', IMPORT + '/apply', YOSI, j({ csv, previewId: p.previewId, approvals: a }));
const NEWENG = F.csv([F.row({ domain: 'ביטוחים ופנסיה', service: 'שירות חדש לבדיקה', provider: 'דנה לבני', business: 'לבני מס', externalId: 'NEW-1', contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין לאישור להפניה' })]);
const OWNER_ROW = { rows: { 2: { apply: true, accept: [], acceptManual: [], confirmed: [] } } };

test('R12 IN THE DATABASE: archived or paused (a pause that has not ended) is a problem in the preview, a provider that became unavailable after the preview makes it stale, and a pause that ended is available again', async () => {
  const w = await world(); await w.open();
  for (const how of ['archived_at = now()', "paused_until = now() + interval '3 days'"]) {
    await w.owner('UPDATE provider_profiles SET archived_at = NULL, paused_until = NULL WHERE professional_id = 21');
    const ok = await prev(w, NEWENG); assert.equal(ok.rows[0].status, 'new', 'available: a new engagement for a new service');
    await w.owner('UPDATE provider_profiles SET ' + how + ' WHERE professional_id = 21');
    const stale = await applyTo(w, NEWENG, ok, OWNER_ROW); const before = await w.fingerprint(DATA);
    assert.deepEqual([stale.status, stale.body.error], [409, 'preview_stale'], 'the provider became unavailable after the preview: the data is not what was approved'); assert.deepEqual(await w.fingerprint(DATA), before);
    const p = await prev(w, NEWENG); assert.deepEqual([p.rows[0].status, p.rows[0].problems[0].code], ['problem', 'provider_unavailable']);
    const r = await applyTo(w, NEWENG, p, OWNER_ROW); assert.deepEqual([r.status, r.body.error, r.body.refused[0].reason], [422, 'rows_refused', 'row_is_problem']); assert.deepEqual(await w.fingerprint(DATA), before, 'not one row, audit or log line was written');
  }
  await w.owner("UPDATE provider_profiles SET archived_at = NULL, paused_until = now() - interval '1 day' WHERE professional_id = 21");
  const over = await prev(w, NEWENG); assert.equal(over.rows[0].status, 'new', 'a pause that has ended does not block');
  assert.equal((await applyTo(w, NEWENG, over, OWNER_ROW)).status, 200); assert.equal((await w.owner('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 21'))[0].n, 2);
  await w.pg.close();
});

test('R12 THE SQL OF THE SAVE stops it on its own: even when the snapshot guard is satisfied, an INSERT of an engagement for an unavailable provider gives no row and the whole batch fails, writing nothing', async () => {
  const w = await world(); await w.open();
  const op = { op: 'create_engagement', provider: { id: '21' }, service: { id: '12' }, set: { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', external_ref: null, terms_note: null }, updated_by: 'import:test@example.test', source_row: 2 };
  const ctx = (snap) => ({ expect: snap.fingerprint, actor: 'test@example.test', fileSha256: 'a'.repeat(64), summary: { create_engagement: 1 }, rowsApplied: [2], log: { source: 'csv', file_sha256: 'a'.repeat(64), rows_total: 1, rows_created: 1, rows_updated: 0, rows_skipped: 0, problems: [], imported_by: 'test@example.test' } });
  for (const how of ['archived_at = now()', "paused_until = now() + interval '2 days'"]) {
    await w.owner('UPDATE provider_profiles SET archived_at = NULL, paused_until = NULL WHERE professional_id = 21'); await w.owner('UPDATE provider_profiles SET ' + how + ' WHERE professional_id = 21');
    const snap = await store.readSnapshot(), before = await w.fingerprint(DATA);   // the fingerprint is the CURRENT one, so only the INSERT's own check can refuse
    await assert.rejects(() => W.run(W.importBatch([op], new Map(), ctx(snap)), 'import'), (e) => e.status === 409 && e.noRows === true, how);
    assert.deepEqual(await w.fingerprint(DATA), before, 'nothing was written, not even the audit row or the log row');
  }
  await w.owner('UPDATE provider_profiles SET archived_at = NULL, paused_until = NULL WHERE professional_id = 21');
  const snap = await store.readSnapshot(); await W.run(W.importBatch([op], new Map(), ctx(snap)), 'import');
  assert.equal((await w.owner('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 21 AND service_id = 12'))[0].n, 1, 'the same batch works when the provider is available: the guard is the only difference');
  await w.pg.close();
});

test('THE SHEET SHAPE END TO END ON THE DATABASE: saving it creates topics as ids (system topics and the two internal domains, none as text), phones with their zero, 15 services, 3 providers, 14 engagements, 14 layers; nothing active; no commission row', async () => {
  const w = await world({ seed: false }); await w.open();
  const p = await prev(w, SHEET); assert.deepEqual(p.summary, { rows_total: 22, new: 15, changed: 0, unchanged: 0, skipped: 7, problem: 0 });
  const rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: [], acceptManual: [], confirmed: r.needsConfirmation, decisions: (r.decisions || []).length ? NEW : undefined }; }
  const res = await applyTo(w, SHEET, p, { rows }); assert.equal(res.status, 200, JSON.stringify(res.body)); assert.equal(res.body.applied, true);
  const n = async (sql) => (await w.owner(sql))[0].n;
  assert.deepEqual([await n('SELECT count(*)::int AS n FROM services'), await n('SELECT count(*)::int AS n FROM professionals'), await n('SELECT count(*)::int AS n FROM provider_services'), await n('SELECT count(*)::int AS n FROM provider_service_prices')], [15, 3, 14, 14]);
  assert.equal(await n("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active' OR agreement_state IN ('signed', 'ended') OR contact_state IN ('active', 'stopped')"), 0, 'nothing active, nothing signed');
  assert.equal(await n('SELECT count(*)::int AS n FROM services WHERE active'), 0, 'every imported service is off');
  assert.equal(await n('SELECT count(*)::int AS n FROM provider_service_compensation'), 0, 'no commission'); assert.equal(await n('SELECT count(*)::int AS n FROM pricing'), 0, 'no approved or client price row is created');
  const topics = (await w.owner('SELECT topic, count(*)::int AS n FROM services GROUP BY topic ORDER BY topic')).map((r) => [r.topic, r.n]);
  assert.deepEqual(topics, [['business', 2], ['housing', 1], ['insurance-pension', 1], ['mortgage', 5], ['national-insurance', 2], ['savings-investments', 1], ['tax-refunds', 3]], 'the two internal domains are stored as their ids; none is stored as text or left empty');
  assert.deepEqual((await w.owner("SELECT contact_phone FROM provider_profiles WHERE contact_phone IS NOT NULL ORDER BY contact_phone")).map((r) => r.contact_phone), ['0500000011', '0500000022', '0500000033']);
  await w.pg.close();
});
