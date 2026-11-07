'use strict';
// Catalog import, pure core: preview (differences before saving), the plan of safe operations, and rules R1-R11 of the M1 plan. Synthetic data only (tests/fixtures/catalog-demo.js).
// No database, no network, no clock: the importer produces plain data and these tests look at it.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../netlify/functions/_kaspchem/catalog/import.js');
const F = require('./fixtures/catalog-demo.js');
const SIM = require('./fixtures/catalog-sim.js');

const ROW = { fixed: 2, marketFixed: 3, percent: 4, range: 5, minimum: 6, quote: 7, noProvider: 8, signedAndActive: 9, commission: 10, placeholder: 11, blank: 12 };   // record numbers in F.FILE
// Invented names that are clearly different from one another (names that look alike are, correctly, flagged as questions).
const NAMES = { services: ['ייעוץ ירושה', 'הגשת ערר ארנונה', 'ליווי רכישת דירה', 'תכנון צוואה', 'בדיקת ביטוח רכב'], providers: ['אבי רוזן', 'מאיה גולן', 'שרון דוד', 'תומר ישראלי', 'ליאת בן דוד'] };
const preview = (csv, existing, extra) => I.buildPreview(Object.assign({ csv, existing: existing || F.EMPTY() }, extra || {}));
const rowOf = (p, n) => p.rows.find((r) => r.rowNumber === n);
// Approve every row the importer can apply, with everything it asks to be confirmed. o: { only: [rows], manual: bool, confirm: bool, decisions: { row: {...} } }
function approveAll(p, o) {
  const opt = o || {}, rows = {};
  for (const r of p.rows) {
    if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue;
    if (opt.only && !opt.only.includes(r.rowNumber)) continue;
    rows[r.rowNumber] = { apply: true, accept: r.changes.filter((c) => !c.manual).map((c) => c.id), acceptManual: opt.manual ? r.changes.filter((c) => c.manual).map((c) => c.id) : [], confirmed: opt.confirm === false ? [] : r.needsConfirmation, decisions: opt.decisions && opt.decisions[r.rowNumber] };
  }
  return { rows };
}
const opsOf = (plan, name) => plan.operations.filter((o) => o.op === name);
const plan = (p, a, existing, opts) => I.planApply(p, a, existing || F.EMPTY(), opts);
const csvOf = (rows, opts) => F.csv(rows.map((r) => F.row(r)), opts);

test('a clean file into an empty system: every row is "new", the preview shows it, and the plan creates drafts and pending entries only (R1, R3)', () => {
  const p = preview(F.FILE);
  assert.equal(p.ok, true); assert.deepEqual(p.summary, { rows_total: 11, new: 9, changed: 0, unchanged: 0, skipped: 2, problem: 0 }); assert.equal(p.decisionsNeeded, 0); assert.deepEqual(p.notInFile, []);
  assert.equal(p.rows.filter((r) => r.status === 'new').every((r) => r.problems.length === 0), true);
  const r = plan(p, approveAll(p)); assert.equal(r.ok, true);
  assert.deepEqual(r.summary, { create_service: 9, create_provider: 6, create_engagement: 8, create_layer: 8 });
  assert.ok(opsOf(r, 'create_service').every((o) => o.active === false), 'an imported service starts inactive');
  const eng = opsOf(r, 'create_engagement');
  assert.ok(eng.every((o) => ['draft', 'pending'].includes(o.set.activation)), 'R1: nothing is active');
  assert.ok(eng.every((o) => ['none', 'contacted', 'negotiating'].includes(o.set.contact_state) && ['not_discussed', 'draft'].includes(o.set.agreement_state)), 'R2: no signed agreement, no active collaboration');
  assert.ok(eng.every((o) => o.set.pricing_model !== 'fixed'), 'D15: the client price is the owner\'s, so no engagement is marked as having a fixed price');
  const by = (ref) => eng.find((o) => o.set.external_ref === ref).set;
  assert.deepEqual([by('TX-01').activation, by('TX-01').contact_state, by('TX-01').agreement_state, by('TX-01').terms_note], ['pending', 'contacted', 'not_discussed', 'שוחחנו בטלפון, ממתינה להצעה מסודרת']);
  assert.deepEqual([by('FA-01').activation, by('PN-01').activation, by('PN-02').activation], ['draft', 'pending', 'draft'], 'R1: "waiting" is pending, an empty or draft status is a draft');
  assert.deepEqual([by('RE-01').contact_state, by('RE-01').agreement_state], ['negotiating', 'draft']);
  assert.ok(opsOf(r, 'create_engagement').every((o) => o.updated_by.startsWith('import:')) && opsOf(r, 'create_layer').every((o) => o.recorded_by.startsWith('import:')), 'provenance: everything the import writes says so');
});

test('R3, R4, R5: prices word for word in separate layers; a percentage stays a percentage; nothing is invented; no pricing row and no approved price is ever created', () => {
  const p = preview(F.FILE), r = plan(p, approveAll(p)), layer = (ref) => { const eng = opsOf(r, 'create_engagement'); const k = eng.findIndex((o) => o.set.external_ref === ref); return r.operations.filter((o) => o.op === 'create_layer')[k].layer; };
  const fixed = layer('TX-01'); assert.deepEqual([fixed.kind, fixed.model, fixed.amount, fixed.status], ['unclassified', 'fixed', 1200, 'recorded'], 'the mixed "market / client" column is never promoted to a client price');
  const pct = layer('RE-01'); assert.deepEqual([pct.model, pct.percent_low, pct.percent_high, pct.amount, pct.terms_text], ['percent_of_result', 10, null, null, '10% מהחיסכון']);
  const range = layer('FA-01'); assert.deepEqual([range.model, range.percent_low, range.percent_high, range.amount], ['percent_of_result', 5, 8, null]); assert.equal(range.terms_text, 'בין 5-8% מהסכום שנחסך\nלפי היקף התיק', 'R4: the wording and the clarification, word for word');
  const min = layer('PN-01'); assert.deepEqual([min.model, min.percent_low, min.minimum_amount], ['percent_with_minimum', 3, 2000]);
  const quote = layer('PN-02'); assert.deepEqual([quote.model, quote.amount, quote.percent_low], ['quote', null, null]);
  const market = layer('TX-02'); assert.equal(market.source_note, 'אתר הספק'); assert.equal(market.source_date, '2026-10-20'); assert.equal(market.terms_text, 'מחיר קבוע\nמחיר שוק לפי אתר הספק');
  assert.equal(r.operations.some((o) => /pricing|offer/i.test(o.op)), false, 'no operation touches the approved-price table, and no provider offer is invented');
  assert.ok(opsOf(r, 'create_layer').every((o) => ['market', 'unclassified'].includes(o.layer.kind) && o.layer.status === 'recorded'));
  const marketRow = preview(csvOf([{ service: 'שירות בדיקה', provider: 'ספק בדיקה', price: '800', pricingMode: 'מחיר שוק קבוע', externalId: 'X-1' }])); const mp = plan(marketRow, approveAll(marketRow));
  assert.equal(opsOf(mp, 'create_layer')[0].layer.kind, 'market', 'a price the wording calls a market price is a market layer');
});

test('R5: a percentage without a stated basis is flagged, not completed', () => {
  const p = preview(csvOf([{ service: 'שירות א', provider: 'ספק א', pricingMode: '12%', externalId: 'B-1' }]));
  assert.ok(rowOf(p, 2).flags.includes('basis_missing')); assert.equal(rowOf(p, 2).record.layer.basis_missing, true); assert.equal(rowOf(p, 2).record.layer.percent_low, 12);
});

test('a price that is not a number, or that contradicts the wording, stops its row; the other rows go on; a stopped row cannot be applied (R3)', () => {
  const p = preview(csvOf([{ service: 'א', provider: 'ספק', price: 'בערך אלף', pricingMode: 'מחיר קבוע', externalId: 'P-1' }, { service: 'ב', provider: 'ספק', price: '500', pricingMode: '10% מהחיסכון', externalId: 'P-2' }, { service: 'ג', provider: 'ספק', price: '700', pricingMode: 'מחיר קבוע', externalId: 'P-3' }]));
  assert.deepEqual(rowOf(p, 2).problems.map((x) => x.code), ['price_not_numeric']); assert.deepEqual(rowOf(p, 3).problems.map((x) => x.code), ['price_conflicts_with_mode']); assert.equal(rowOf(p, 4).status, 'new');
  assert.equal(p.summary.problem, 2);
  const r = plan(p, { rows: { 2: { apply: true }, 4: { apply: true } } }); assert.equal(r.ok, false); assert.deepEqual(r.refused, [{ row: 2, reason: 'row_is_problem' }]); assert.deepEqual(r.operations, []);
});

test('placeholder and blank rows are skipped and cannot be applied; a service with no provider is a catalog entry only', () => {
  const p = preview(F.FILE);
  assert.deepEqual([rowOf(p, ROW.placeholder).status, rowOf(p, ROW.placeholder).reason, rowOf(p, ROW.blank).status, rowOf(p, ROW.blank).reason], ['skipped', 'placeholder', 'skipped', 'blank']);
  const r = plan(p, { rows: { [ROW.placeholder]: { apply: true } } }); assert.equal(r.ok, false); assert.equal(r.refused[0].reason, 'row_is_skipped');
  const only = plan(p, approveAll(p, { only: [ROW.noProvider] })); assert.deepEqual(only.summary, { create_service: 1 }); assert.equal(opsOf(only, 'create_service')[0].name, 'סקירת כיסויים ביטוחיים');
});

test('R6 (deferred to M1.1): the commission columns are ignored in any form, never block a row, never appear in the preview or in an operation', () => {
  const rows = ['10%', '0.1', '10', 'לא ידוע', ''].map((v, i) => ({ service: NAMES.services[i], provider: NAMES.providers[i], commissionModel: 'אחוז', commissionPercent: v, commissionFixed: i % 2 ? '500' : 'abc', commissionPayer: 'הספק משלם לכספכם', pricingMode: 'מחיר קבוע', price: '1000', externalId: 'C-' + i }));
  const p = preview(csvOf(rows)); assert.equal(p.summary.problem, 0);
  assert.ok(p.rows.slice(0, 4).every((r) => r.flags.includes('commission_not_imported') && r.problems.length === 0));
  const r = plan(p, approveAll(p)); assert.equal(r.ok, true);
  const text = JSON.stringify(r) + JSON.stringify(p); assert.equal(/commission_percent|הספק משלם לכספכם|compensation/i.test(text.replace(/commission_not_imported/g, '')), false);
  assert.equal(I.SHAPES.create_engagement.set.some((f) => /commission|compensation/i.test(f)), false);
});

test('R9: the same sheet id twice, or the same provider and service twice, are errors on every row involved; applying one of them is refused', () => {
  const p = preview(csvOf([{ service: 'א', provider: 'ספק א', externalId: 'D-1' }, { service: 'ב', provider: 'ספק ב', externalId: 'd-1' }, { service: 'ג', provider: 'ספק ג', externalId: 'D-3' }, { service: 'ג', provider: ' ספק  ג ', externalId: 'D-4' }]));
  assert.deepEqual(rowOf(p, 2).problems.map((x) => x.code), ['duplicate_external_ref']); assert.deepEqual(rowOf(p, 2).problems[0].rows, [2, 3]); assert.deepEqual(rowOf(p, 3).problems.map((x) => x.code), ['duplicate_external_ref']);
  assert.deepEqual(rowOf(p, 4).problems.map((x) => x.code), ['duplicate_engagement']); assert.deepEqual(rowOf(p, 5).problems.map((x) => x.code), ['duplicate_engagement']);
  assert.equal(p.summary.problem, 4);
  assert.equal(plan(p, approveAll(p)).operations.length, 0, 'nothing approvable');
});

test('R9: a sheet id that belongs to another provider or another service is a problem, not a guess; a missing sheet id is a warning', () => {
  const ex = F.existing();
  const p = preview(csvOf([{ domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'אדם אחר', externalId: 'TX-01' }, { domain: 'מיסים', service: 'שירות שונה לגמרי', provider: 'רועי שמש', externalId: 'RE-01' }, { domain: 'מיסים', service: 'שירות חדש', provider: 'ספק חדש', externalId: '' }]), ex);
  assert.deepEqual(rowOf(p, 2).problems.map((x) => x.code), ['external_ref_belongs_to_another_engagement']); assert.deepEqual(rowOf(p, 3).problems.map((x) => x.code), ['external_ref_belongs_to_another_engagement']);
  assert.ok(rowOf(p, 4).warnings.includes('external_ref_missing') || rowOf(p, 4).status === 'new');
});

test('R10: an unknown contact word blocks its row until it is mapped; mapping only allows safe values; the mapping is part of the preview id', () => {
  const file = csvOf([{ service: 'א', provider: 'ספק א', contact: 'מחכה לתשובה', externalId: 'U-1' }, { service: 'ב', provider: 'ספק ב', contact: 'יצרתי קשר', externalId: 'U-2' }]);
  const p = preview(file); assert.equal(rowOf(p, 2).status, 'problem'); assert.deepEqual(rowOf(p, 2).problems[0], { code: 'unknown_value', field: 'contact_state', value: 'מחכה לתשובה' }); assert.equal(rowOf(p, 3).status, 'new');
  const mapped = preview(file, F.EMPTY(), { mappings: { contact: { 'מחכה  לתשובה': 'contacted' } } }); assert.equal(rowOf(mapped, 2).status, 'new'); assert.equal(rowOf(mapped, 2).record.engagement.contact_state, 'contacted'); assert.notEqual(mapped.previewId, p.previewId);
  for (const target of ['active', 'stopped', 'banana']) { const bad = preview(file, F.EMPTY(), { mappings: { contact: { 'מחכה לתשובה': target } } }); assert.equal(rowOf(bad, 2).problems[0].code, 'mapping_not_allowed', target); }
  const agr = preview(csvOf([{ service: 'א', provider: 'ספק', agreement: 'בוטל' }]), F.EMPTY(), { mappings: { agreement: { 'בוטל': 'signed' } } }); assert.equal(rowOf(agr, 2).problems[0].code, 'mapping_not_allowed', 'a mapping cannot make an agreement signed');
  const act = preview(csvOf([{ service: 'א', provider: 'ספק', activation: 'מושהה' }])); assert.equal(rowOf(act, 2).problems[0].code, 'unknown_value'); assert.equal(rowOf(act, 2).problems[0].field, 'activation');
  const dir = preview(csvOf([{ service: 'א', provider: 'ספק', direction: 'הספק מפנה לכספכם' }])); assert.equal(rowOf(dir, 2).problems[0].code, 'unsupported_direction');
});

test('missing columns: optional ones are warnings and the import goes on without them; a missing required column or header stops the whole file', () => {
  const some = F.csv([F.ROWS.fixed, F.ROWS.noProvider], { omit: ['provider', 'externalId', 'contact', 'agreement', 'activation', 'price', 'pricingMode'] });
  const p = preview(some); assert.equal(p.ok, true); assert.equal(p.warnings.filter((w) => w.code === 'missing_column').length, 7);
  assert.ok(p.rows.every((r) => r.status === 'new' && !r.engagement)); assert.equal(plan(p, approveAll(p)).summary.create_service, 2);
  const noService = preview(F.csv([F.ROWS.fixed], { omit: ['service'] })); assert.equal(noService.ok, false); assert.ok(noService.fileProblems.some((x) => x.code === 'header_not_found'), 'the header row is the one with both the domain and the service column'); assert.deepEqual(noService.rows, []);
  const noHeader = preview('"a","b"\r\n"1","2"\r\n'); assert.equal(noHeader.ok, false); assert.ok(noHeader.fileProblems.some((x) => x.code === 'header_not_found'));
  assert.equal(plan(noHeader, { rows: {} }, F.EMPTY()).reason, 'preview_not_usable');
});

test('the same data in every shape the export can take gives the same rows: BOM, CRLF or LF, a title above the header, a Buffer, quotes, commas and line breaks inside fields', () => {
  const base = [F.ROWS.fixed, F.ROWS.percent, Object.assign({}, F.ROWS.range, { description: 'שורה ראשונה, עם פסיק\nשורה שנייה "מצוטטת"' })];
  const shapes = [F.csv(base), F.csv(base, { bom: true }), F.csv(base, { lf: true }), F.csv(base, { title: 'כותרת הגיליון' }), Buffer.from(F.csv(base), 'utf8')];
  const records = shapes.filter((x, i) => i !== 3).map((s) => JSON.stringify(preview(s).rows.map((r) => r.record)));
  assert.equal(new Set(records).size, 1, 'one set of records for every shape');
  assert.deepEqual(preview(shapes[3]).rows.map((r) => r.rowNumber), [3, 4, 5], 'a title row above the header moves every row number by one: numbers are positions in the file');
  const p = preview(shapes[0]); assert.equal(rowOf(p, 4).record.service.description, 'שורה ראשונה, עם פסיק\nשורה שנייה "מצוטטת"', 'R4: verbatim, inside quotes');
  assert.equal(preview(shapes[3]).headerNumber, 2); assert.equal(rowOf(preview(shapes[3]), 3).record.provider.name, 'דנה לבני', 'row numbers are the position in the file, title row included');
  assert.notEqual(preview(shapes[0]).fileSha256, preview(shapes[1]).fileSha256, 'the hash is of the file as it is');
});

test('a file that is too big, has too many rows, is not UTF-8, or has a quote that never closes is refused as a whole, with a clear code (R11 limits)', () => {
  const big = preview('"תחום","השירות המדויק"\r\n' + '"x","' + 'ש'.repeat(600 * 1024) + '"\r\n'); assert.equal(big.ok, false); assert.equal(big.fileProblems[0].code, 'file_too_large'); assert.deepEqual(big.rows, []);
  const many = preview(F.csv(Array.from({ length: 5001 }, (_, i) => ({ domain: 'א', service: 'שירות ' + i })), { omit: F.ORDER.filter((k) => !['domain', 'service'].includes(k)) })); assert.equal(many.ok, false); assert.equal(many.fileProblems.pop().code, 'too_many_rows');
  const win1255 = Buffer.concat([Buffer.from('"תחום","השירות המדויק"\r\n"', 'utf8'), Buffer.from([0xE0, 0xE1, 0xE2]), Buffer.from('","x"\r\n', 'utf8')]); assert.equal(preview(win1255).fileProblems[0].code, 'bad_encoding');
  const open = preview('"תחום","השירות המדויק"\r\n"a","b'); assert.equal(open.ok, false); assert.equal(open.fileProblems[0].code, 'unterminated_quote');
  for (const p of [big, many, open]) assert.equal(plan(p, { rows: {} }).reason, 'preview_not_usable');
});

test('R7: what the file does not mention is reported as "not in file" and never touched; the plan has no delete, no retire, no pause', () => {
  const ex = F.existing(), file = csvOf([F.ROWS.fixed]);
  const p = preview(file, ex); assert.deepEqual(p.notInFile.map((x) => x.external_ref), ['RE-01']);
  const r = plan(p, approveAll(p, { manual: true }), ex); assert.equal(r.ok, true);
  assert.equal(r.operations.some((o) => /delete|remove|retire|pause|archive/i.test(o.op) || /retired|paused|archived/.test(JSON.stringify(o.set || {}))), false);
  assert.deepEqual(SIM.applyOps(ex, r.operations).engagements.find((e) => e.external_ref === 'RE-01'), ex.engagements[1], 'the engagement missing from the file is exactly as it was');
  assert.equal(preview(F.FILE, F.EMPTY()).notInFile.length, 0);
  const manualOnly = F.existing(); manualOnly.engagements.push({ professional_id: 21, service_id: 12, external_ref: null, activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, terms_note: null, updated_by: 'owner@example.test', layers: [] });
  assert.equal(preview(file, manualOnly).notInFile.length, 1, 'an engagement made by hand in the system (no sheet id) is not a sheet row, so it is never reported as missing');
});

test('R8: a value changed by hand is shown as such and is not overwritten unless that one change is separately approved', () => {
  const ex = F.existing(); ex.engagements[1].updated_by = 'owner@example.test'; ex.providers[1].updated_by = undefined; ex.engagements[0].layers[0].recorded_by = 'owner@example.test'; ex.engagements[0].layers[0].amount = 1000;
  const p = preview(F.FILE, ex);
  const r4 = rowOf(p, ROW.percent), act = r4.changes.find((c) => c.id === 'engagement.activation'); assert.deepEqual([act.old, act.new, act.manual], ['draft', 'pending', true]);
  assert.equal(r4.changes.find((c) => c.id === 'provider.contact_phone').manual, true, 'no provenance on record counts as hand-made');
  const r2 = rowOf(p, ROW.fixed), lay = r2.changes.find((c) => c.id === 'layer.unclassified.replace'); assert.equal(lay.manual, true); assert.equal(lay.sensitive, true); assert.equal(lay.old.amount, 1000); assert.equal(lay.new.amount, 1200);
  const normal = plan(p, approveAll(p), ex); assert.equal(normal.ok, true);
  assert.equal(normal.operations.some((o) => o.op === 'update_engagement' || o.op === 'update_layer' || o.op === 'update_provider'), false, 'ordinary approval does not reach hand-edited values');
  const knowing = plan(p, approveAll(p, { manual: true }), ex);
  assert.deepEqual(opsOf(knowing, 'update_engagement').map((o) => o.set), [{ activation: 'pending' }]); assert.equal(opsOf(knowing, 'update_layer')[0].set.amount, 1200); assert.equal(opsOf(knowing, 'update_provider')[0].set.contact_phone, '0521112233');
  assert.ok(opsOf(knowing, 'update_engagement')[0].updated_by.startsWith('import:'));
  const one = approveAll(p, { manual: true }); one.rows[ROW.percent].acceptManual = ['engagement.activation']; const partial = plan(p, one, ex);
  assert.equal(opsOf(partial, 'update_provider').length, 0, 'only the one approved hand-edited change is applied');
});

test('nothing existing changes without approval: an approved row with no accepted changes writes nothing; a change is applied only if listed; values the sheet leaves empty never blank anything', () => {
  const ex = F.existing(), p = preview(F.FILE, ex);
  assert.deepEqual(rowOf(p, ROW.fixed).changes, [], 'identical to what exists');
  assert.equal(rowOf(p, ROW.fixed).status, 'unchanged');
  const bare = { rows: { [ROW.percent]: { apply: true, confirmed: ['phone_restored'] } } };
  assert.deepEqual(plan(p, bare, ex).operations.filter((o) => /^update_/.test(o.op)), [], 'listing the row is not listing its changes');
  const listed = { rows: { [ROW.percent]: { apply: true, confirmed: ['phone_restored'], accept: ['provider.contact_phone'] } } };
  assert.deepEqual(opsOf(plan(p, listed, ex), 'update_provider').map((o) => o.set), [{ contact_phone: '0521112233' }]);
  const emptied = preview(csvOf([{ domain: '', service: 'בדיקת זכאות להחזר מס', description: '', provider: 'דנה לבני', business: 'לבני מס', phone: '', email: '', contact: '', agreement: '', notes: '', activation: '', externalId: 'TX-01' }]), ex);
  assert.deepEqual(rowOf(emptied, 2).changes.map((c) => c.id), ['engagement.activation'], 'empty cells blank nothing; only the empty status (a draft) is a statement, and it is a change to approve');
});

test('R1 and R2: a file that says "active", "signed" or "active collaboration" activates nothing: the row is imported as pending / draft / negotiating, flagged, and needs the owner\'s confirmation first', () => {
  const p = preview(F.FILE), r9 = rowOf(p, ROW.signedAndActive);
  assert.deepEqual(r9.needsConfirmation.slice().sort(), ['file_says_active_needs_manual', 'file_says_collaboration_active_needs_manual', 'file_says_signed_needs_manual']);
  assert.deepEqual([r9.record.engagement.activation, r9.record.engagement.contact_state, r9.record.engagement.agreement_state], ['pending', 'negotiating', 'draft']);
  const refused = plan(p, approveAll(p, { confirm: false })); assert.equal(refused.ok, false); assert.ok(refused.refused.some((x) => x.row === ROW.signedAndActive && x.reason === 'confirmation_missing' && x.flags.length === 3)); assert.deepEqual(refused.operations, []);
  const r = plan(p, approveAll(p)); assert.equal(r.ok, true);
  const after = SIM.applyOps(F.EMPTY(), r.operations);
  assert.equal(after.engagements.some((e) => e.activation === 'active' || e.agreement_state === 'signed' || e.contact_state === 'active'), false);
  const known = preview(csvOf([{ service: 'א', provider: 'ספק', contact: 'שיתוף פעולה פעיל', agreement: 'הסכם חתום', activation: 'פעיל באתר', externalId: 'S-1' }]));
  assert.equal(known.rows[0].needsConfirmation.length, 3);
  const ex = F.existing(); ex.engagements[0] = Object.assign(ex.engagements[0], { activation: 'active', contact_state: 'active', agreement_state: 'signed', pricing_model: 'fixed', pricing_id: 7 });
  const back = preview(F.FILE, ex), r2 = rowOf(back, ROW.fixed);
  assert.deepEqual(r2.flags.filter((f) => /managed_in_system/.test(f)).sort(), ['activation_managed_in_system', 'agreement_state_managed_in_system', 'contact_state_managed_in_system', 'pricing_model_managed_in_system'], 'what the owner already moved in the system is not moved back by the file');
  assert.equal(r2.changes.some((c) => /contact_state|agreement_state|activation|pricing_model/.test(c.field)), false);
});

test('R9: a near-identical service name is a QUESTION: it needs an answer, and the answer is "use the existing one" or "create a new one"; nothing is merged or renamed', () => {
  const ex = F.existing(), file = csvOf([{ domain: 'נדל"ן', service: 'ייעוץ משכנתאות', provider: 'מיכל פז', business: 'פז ייעוץ', externalId: 'M-1' }]);
  const p = preview(file, ex), row = rowOf(p, 2);
  assert.equal(p.decisionsNeeded, 1); assert.equal(row.decisions[0].type, 'similar_service'); assert.equal(row.decisions[0].candidates[0].id, 12); assert.ok(row.decisions[0].candidates[0].score >= 0.7); assert.equal(row.status, 'new');
  const noAnswer = plan(p, { rows: { 2: { apply: true } } }, ex); assert.equal(noAnswer.ok, false); assert.deepEqual(noAnswer.refused, [{ row: 2, reason: 'decision_missing', entity: 'service' }]);
  const bad = plan(p, { rows: { 2: { apply: true, decisions: { service: { use: 'existing', id: 999 } } } } }, ex); assert.equal(bad.refused[0].reason, 'decision_unknown_id');
  const merge = plan(p, { rows: { 2: { apply: true, decisions: { service: { use: 'merge', id: 12 } } } } }, ex); assert.equal(merge.refused[0].reason, 'decision_missing', 'there is no "merge" answer');
  const existing = plan(p, { rows: { 2: { apply: true, decisions: { service: { use: 'existing', id: 12 } } } } }, ex); assert.equal(existing.ok, true);
  assert.deepEqual(opsOf(existing, 'create_service'), []); assert.deepEqual(opsOf(existing, 'create_engagement')[0].service, { id: 12 });
  const fresh = plan(p, { rows: { 2: { apply: true, decisions: { service: { use: 'new' } } } } }, ex); assert.equal(fresh.ok, true);
  assert.equal(opsOf(fresh, 'create_service')[0].name, 'ייעוץ משכנתאות'); assert.equal(fresh.operations.some((o) => o.op === 'update_service'), false, 'the existing service is left exactly as it was');
  for (const r of [existing, fresh]) assert.equal(r.operations.some((o) => o.set && 'name' in o.set), false, 'no operation can rename anything');
  const after = SIM.applyOps(ex, fresh.operations); assert.equal(after.services.length, 3); assert.equal(after.services.find((s) => s.id === 12).name, 'ייעוץ משכנתא');
});

test('R9: the same provider name with another business, or a near provider name, is a question too; and an exact provider (name and business) is matched without asking', () => {
  const ex = F.existing();
  const p = preview(csvOf([{ service: NAMES.services[0], provider: 'דנה לבני', business: 'עסק אחר', externalId: 'Q-1' }, { service: NAMES.services[1], provider: 'דנה לבנה', business: 'לבני מס', externalId: 'Q-2' }, { service: NAMES.services[2], provider: 'דנה  לבני', business: 'לבני מס', externalId: 'Q-3' }]), ex);
  assert.equal(rowOf(p, 2).decisions[0].type, 'same_name_other_business'); assert.equal(rowOf(p, 3).decisions[0].type, 'similar_provider'); assert.equal(rowOf(p, 4).decisions.length, 0); assert.deepEqual(rowOf(p, 4).provider, { action: 'existing', id: 21 });
  const none = plan(p, approveAll(p, { only: [2] }), ex); assert.equal(none.ok, false); assert.equal(none.refused[0].entity, 'provider');
  const sameProvider = plan(p, approveAll(p, { only: [2], decisions: { 2: { provider: { use: 'existing', id: 21 } } } }), ex); assert.deepEqual(opsOf(sameProvider, 'create_engagement')[0].provider, { id: 21 }); assert.equal(opsOf(sameProvider, 'create_provider').length, 0);
  const newProvider = plan(p, approveAll(p, { only: [2], decisions: { 2: { provider: { use: 'new' } } } }), ex); assert.equal(opsOf(newProvider, 'create_provider')[0].business_name, 'עסק אחר');
});

test('two providers offering the same service share ONE service record and each get their own engagement; a service named twice is one service', () => {
  const p = preview(csvOf([{ service: 'ייעוץ פיננסי', provider: 'ספק ראשון', externalId: 'S-1' }, { service: ' ייעוץ  פיננסי ', provider: 'ספק שני', externalId: 'S-2' }, { service: 'ייעוץ פיננסי', provider: 'ספק שלישי', externalId: 'S-3' }]));
  assert.deepEqual(p.rows.map((r) => r.service.action), ['new', 'same_as_row', 'same_as_row']);
  const r = plan(p, approveAll(p)); assert.equal(opsOf(r, 'create_service').length, 1); const ref = opsOf(r, 'create_service')[0].ref;
  assert.deepEqual(opsOf(r, 'create_engagement').map((o) => o.service.ref), [ref, ref, ref]); assert.equal(opsOf(r, 'create_provider').length, 3);
  const later = plan(p, approveAll(p, { only: [3, 4] }));
  assert.equal(opsOf(later, 'create_service').length, 1, 'if the first row is not approved the next one still has its service');
  const after = SIM.applyOps(F.EMPTY(), r.operations); assert.equal(after.services.length, 1); assert.equal(after.engagements.length, 3);
});

test('re-importing the same file after it was applied finds nothing to do; a changed price shows up as one price change; the plan is deterministic', () => {
  const p1 = preview(F.FILE), r1 = plan(p1, approveAll(p1)); const state = SIM.applyOps(F.EMPTY(), r1.operations);
  const p2 = preview(F.FILE, state);
  assert.deepEqual(p2.rows.filter((r) => r.status !== 'skipped').map((r) => [r.rowNumber, r.status]), p2.rows.filter((r) => r.status !== 'skipped').map((r) => [r.rowNumber, 'unchanged']), 'every row is unchanged the second time');
  assert.equal(p2.decisionsNeeded, 0); assert.equal(p2.notInFile.length, 0);
  assert.equal(plan(p2, approveAll(p2), state).operations.length, 0);
  const edited = F.FILE.replace('"1,200"', '"1,350"'); const p3 = preview(edited, state);
  assert.deepEqual(p3.rows.filter((r) => r.status === 'changed').map((r) => [r.rowNumber, r.changes.map((c) => c.id)]), [[ROW.fixed, ['layer.unclassified.replace']]]);
  const c = rowOf(p3, ROW.fixed).changes[0]; assert.deepEqual([c.old.amount, c.new.amount], [1200, 1350]);
  assert.equal(I.digest(plan(p1, approveAll(p1)).operations), I.digest(r1.operations), 'the same input gives the same plan');
});

test('a price already classified by the owner is not re-created or duplicated as "unclassified" by the next import', () => {
  const ex = F.existing(); ex.engagements[0].layers = [F.layer({ kind: 'market', amount: 1200, terms_text: 'מחיר שוק' })];
  const p = preview(F.FILE, ex); assert.deepEqual(rowOf(p, ROW.fixed).changes, []); assert.equal(rowOf(p, ROW.fixed).status, 'unchanged');
});

test('preview and apply must agree: if the data changed after the preview, or the approval is for another preview, NOTHING is applied', () => {
  const ex = F.existing(), p = preview(F.FILE, ex), a = approveAll(p);
  assert.equal(plan(p, a, ex, { previewId: p.previewId }).ok, true);
  const moved = F.existing(); moved.services.push({ id: 13, name: 'שירות שנוסף בינתיים', topic: null, description: null });
  const stale = plan(p, a, moved); assert.deepEqual([stale.ok, stale.reason, stale.operations], [false, 'snapshot_changed', []]);
  const edited = F.existing(); edited.engagements[0].terms_note = 'נערך בינתיים'; assert.equal(plan(p, a, edited).reason, 'snapshot_changed');
  assert.equal(plan(p, a, ex, { previewId: 'f'.repeat(64) }).reason, 'preview_mismatch');
  const reordered = { engagements: ex.engagements.slice().reverse(), providers: ex.providers.slice().reverse(), services: ex.services.slice().reverse() }; assert.equal(plan(p, a, reordered).ok, true, 'the order of the lists does not matter');
  assert.notEqual(preview(F.FILE, ex).previewId, preview(F.FILE.replace('TX-04', 'TX-09'), ex).previewId); assert.equal(preview(F.FILE, ex).previewId, preview(F.FILE, F.existing()).previewId);
  assert.equal(plan(null, a, ex).reason, 'preview_not_usable');
});

test('all or nothing: if any approved row cannot be applied, NOT ONE operation is returned (the plan is meant to run in one transaction)', () => {
  const p = preview(csvOf([{ service: NAMES.services[0], provider: NAMES.providers[0], externalId: 'A-1' }, { service: NAMES.services[1], provider: NAMES.providers[1], contact: 'מילה לא מוכרת', externalId: 'A-2' }, { service: NAMES.services[2], provider: NAMES.providers[2], externalId: 'A-3' }]));
  const mixed = plan(p, { rows: { 2: { apply: true }, 3: { apply: true }, 4: { apply: true }, 99: { apply: true } } });
  assert.deepEqual([mixed.ok, mixed.reason, mixed.operations.length], [false, 'rows_refused', 0]);
  assert.ok(mixed.refused.some((x) => x.row === 3 && x.reason === 'row_is_problem') && mixed.refused.some((x) => x.row === 99 && x.reason === 'no_such_row'));
  assert.equal(plan(p, { rows: { 2: { apply: true }, 4: { apply: true } } }).ok, true, 'without the bad row the rest goes through');
  assert.equal(plan(p, { rows: { 2: { apply: false } } }).operations.length, 0, 'a row is applied only with apply: true');
  assert.equal(plan(p, {}).operations.length, 0); assert.equal(plan(p, undefined).ok, true);
});

test('an answer that would point at a pair that already has an engagement, or a sheet id already in use, is refused (the database would refuse it too)', () => {
  const ex = F.existing(), p = preview(csvOf([{ domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבנה', business: 'לבני מס', externalId: 'Z-1' }]), ex);
  assert.equal(rowOf(p, 2).decisions[0].type, 'similar_provider');
  const r = plan(p, { rows: { 2: { apply: true, decisions: { provider: { use: 'existing', id: 21 } } } } }, ex); assert.equal(r.ok, false); assert.equal(r.refused[0].reason, 'engagement_already_exists');
  const dup = preview(csvOf([{ service: 'ייעוץ משכנתאות', provider: 'מיכל פז', externalId: 'M-1' }, { service: 'ייעוץ  משכנתאות ', provider: 'מיכל פז', externalId: 'M-2' }]), ex);
  assert.equal(rowOf(dup, 2).problems[0].code, 'duplicate_engagement');
});

test('assertSafe: the operation list is checked against R1, R2, R3, R6, R7 and D15 on its own; every unsafe shape is refused', () => {
  const p = preview(F.FILE), good = plan(p, approveAll(p)).operations; assert.equal(I.assertSafe(good), true);
  const clone = SIM.clone;
  const eng = () => clone(good.find((o) => o.op === 'create_engagement')), lay = () => clone(good.find((o) => o.op === 'create_layer')), svc = () => clone(good.find((o) => o.op === 'create_service'));
  const bad = {
    'a delete': { op: 'delete_engagement', key: { professional_id: 1, service_id: 1 } }, 'a pricing row': { op: 'create_pricing', price: 100 }, 'a commission row': { op: 'create_compensation', model: 'percent' }, 'an unknown op': { op: 'truncate' },
    'active': Object.assign(eng(), { set: Object.assign(eng().set, { activation: 'active' }) }), 'paused': Object.assign(eng(), { set: Object.assign(eng().set, { activation: 'paused' }) }), 'retired': Object.assign(eng(), { set: Object.assign(eng().set, { activation: 'retired' }) }),
    'active collaboration': Object.assign(eng(), { set: Object.assign(eng().set, { contact_state: 'active' }) }), 'stopped contact': Object.assign(eng(), { set: Object.assign(eng().set, { contact_state: 'stopped' }) }),
    'signed agreement': Object.assign(eng(), { set: Object.assign(eng().set, { agreement_state: 'signed' }) }), 'ended agreement': Object.assign(eng(), { set: Object.assign(eng().set, { agreement_state: 'ended' }) }),
    'a fixed engagement price': Object.assign(eng(), { set: Object.assign(eng().set, { pricing_model: 'fixed' }) }), 'a pricing link': Object.assign(eng(), { set: Object.assign(eng().set, { pricing_id: 5 }) }),
    'a commission field': Object.assign(eng(), { set: Object.assign(eng().set, { commission_percent: 10 }) }), 'an unlisted field': Object.assign(eng(), { set: Object.assign(eng().set, { priority: 1 }) }), 'an extra key': Object.assign(eng(), { delete: true }),
    'no import actor': Object.assign(eng(), { updated_by: 'owner@example.test' }), 'an offer layer': Object.assign(lay(), { layer: Object.assign(lay().layer, { kind: 'provider_offer' }) }),
    'an offer waiting for an answer': Object.assign(lay(), { layer: Object.assign(lay().layer, { status: 'awaiting_response' }) }), 'a layer the database would refuse': Object.assign(lay(), { layer: Object.assign(lay().layer, { model: 'fixed', amount: null }) }),
    'a layer with no import actor': Object.assign(lay(), { recorded_by: 'x' }), 'an active service': Object.assign(svc(), { active: true }), 'a service rename': { op: 'update_service', id: 1, set: { name: 'x' }, source_row: 2 },
    'an update with a state': { op: 'update_engagement', key: { professional_id: 1, service_id: 1 }, set: { agreement_state: 'signed' }, updated_by: 'import:x', source_row: 2 },
    'a layer update of an offer': { op: 'update_layer', engagement: { professional_id: 1, service_id: 1 }, kind: 'provider_offer', set: { model: 'tbd', amount: null, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, basis_missing: false }, recorded_by: 'import:x', source_row: 2 },
    'a layer update that breaks the checks': { op: 'update_layer', engagement: { professional_id: 1, service_id: 1 }, kind: 'market', set: { model: 'variable', amount: 5 }, recorded_by: 'import:x', source_row: 2 },
  };
  for (const [name, op] of Object.entries(bad)) assert.throws(() => I.assertSafe([op]), /unsafe import operation/, name);
  assert.throws(() => I.assertSafe(good.concat([bad.active])), /unsafe/, 'one bad operation among good ones');
  assert.throws(() => I.assertSafe('nope'), /unsafe/);
  assert.equal(I.assertSafe([]), true);
});

test('the input is never changed: frozen snapshot, frozen approvals, and the preview is the same after the plan', () => {
  const ex = F.deepFreeze(F.existing()), digestBefore = I.digest(ex);
  const p = preview(F.FILE, ex), a = F.deepFreeze(approveAll(p, { manual: true })), pBefore = JSON.stringify(p);
  assert.doesNotThrow(() => plan(p, a, ex)); assert.equal(JSON.stringify(p), pBefore, 'the preview is untouched by planning'); assert.equal(I.digest(ex), digestBefore);
  const r = plan(p, a, ex); r.operations[0].name = 'x'; assert.equal(JSON.stringify(p), pBefore, 'an operation is a copy, not a view into the preview');
});

test('R11: the import log holds the hash, counts and problem codes only, with the same columns as the catalog_imports table; no name, phone, e-mail, price or wording of the file', () => {
  const file = F.FILE.replace('"1,500"', '"בערך אלף"'), ex = F.existing(), p = preview(file, ex), r = plan(p, approveAll(p), ex);
  const log = I.importLog(p, r, 'owner@example.test');
  assert.deepEqual(Object.keys(log).sort(), ['file_sha256', 'imported_by', 'problems', 'rows_created', 'rows_skipped', 'rows_total', 'rows_updated', 'source']);
  assert.match(log.file_sha256, /^[0-9a-f]{64}$/); assert.equal(log.source, 'csv'); assert.equal(log.rows_total, 11);
  assert.equal(log.rows_created + log.rows_updated + log.rows_skipped, log.rows_total); assert.ok(log.rows_created > 0 && log.rows_updated > 0 && log.rows_skipped > 0);
  assert.deepEqual(log.problems, [{ row: ROW.commission, code: 'price_not_numeric' }]);
  const text = JSON.stringify(log); for (const secret of ['דנה', 'לבני', '0501234567', 'dana@example', '1,200', '900', 'TX-0', 'שוחחנו', 'מהחיסכון', 'בערך אלף', 'הספק משלם']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(I.importLog({ fileSha256: 'a'.repeat(64), fileProblems: [{ code: 'unterminated_quote', row: 7 }], rows: [], summary: { rows_total: 0 } }, null, 'x').problems, [{ row: 7, code: 'unterminated_quote' }]);
});

test('the importer module has no input/output, no clock and no network: it requires only its sibling pure modules and crypto', () => {
  const src = require('fs').readFileSync(require.resolve('../netlify/functions/_kaspchem/catalog/import.js'), 'utf8');
  const required = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort(); assert.deepEqual(required, ['./csv.js', './pricing.js', './similarity.js', './text.js', 'crypto']);
  for (const word of ['fetch(', 'process.env', 'Date.now', 'new Date', 'Math.random', 'setTimeout', 'require(\'fs\')', 'http', 'neon', 'pg']) assert.equal(new RegExp(word.replace(/[()]/g, '\\$&').replace('.', '\\.')).test(src.replace(/\/\/.*$/gm, '')), false, word);
});

// ---- added after the first mutation round: each of these closes a gap a deliberately broken copy of the importer got through ---------------------------------------------------------------
const PR = require('../netlify/functions/_kaspchem/catalog/pricing.js');

test('R8 (strict): a hand-edited change that is listed under the ordinary approval is NOT applied; only the separate hand-edit approval applies it', () => {
  const ex = F.existing(); ex.engagements[1].updated_by = 'owner@example.test';
  const p = preview(F.FILE, ex), r4 = rowOf(p, ROW.percent);
  assert.ok(r4.changes.some((c) => c.manual && c.id === 'engagement.activation') && r4.changes.some((c) => !c.manual && c.id === 'provider.contact_phone'));
  const sneaky = { rows: { [ROW.percent]: { apply: true, confirmed: ['phone_restored'], accept: r4.changes.map((c) => c.id) } } };   // every id, hand-edited one included, under the ordinary list
  const r = plan(p, sneaky, ex); assert.equal(r.ok, true);
  assert.equal(opsOf(r, 'update_engagement').length, 0, 'the hand-edited activation was not touched'); assert.equal(opsOf(r, 'update_provider').length, 1, 'the ordinary change was applied');
});

test('an existing engagement is found by provider and service even when the file row has no sheet id; a different sheet id is then a change to approve, not a second engagement', () => {
  const ex = F.existing(), row = { domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבני', business: 'לבני מס', contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין' };
  const none = preview(csvOf([Object.assign({ externalId: '' }, row)]), ex);
  assert.deepEqual([rowOf(none, 2).status, rowOf(none, 2).engagement.action], ['unchanged', 'existing']); assert.ok(rowOf(none, 2).warnings.includes('external_ref_missing'));
  const other = preview(csvOf([Object.assign({ externalId: 'TX-77' }, row)]), ex);
  assert.equal(rowOf(other, 2).engagement.action, 'existing'); assert.deepEqual(rowOf(other, 2).changes.map((c) => [c.id, c.old, c.new]), [['engagement.external_ref', 'TX-01', 'TX-77']]);
});

test('a phone number whose leading zero was restored needs the owner\'s confirmation before its row is applied', () => {
  const ex = F.existing(), p = preview(F.FILE, ex);
  assert.deepEqual(rowOf(p, ROW.percent).needsConfirmation, ['phone_restored']);
  const r = plan(p, approveAll(p, { only: [ROW.percent], confirm: false }), ex); assert.equal(r.ok, false); assert.deepEqual(r.refused, [{ row: ROW.percent, reason: 'confirmation_missing', flags: ['phone_restored'] }]);
  assert.equal(plan(p, approveAll(p, { only: [ROW.percent] }), ex).ok, true);
});

test('two rows that end up as the same provider and service after the owner\'s answers cannot both create an engagement', () => {
  const ex = F.existing(), base = { domain: 'נדל"ן', service: 'ייעוץ משכנתא', business: 'לבני מס' };
  const p = preview(csvOf([Object.assign({ provider: 'דנה לבנה', externalId: 'W-1' }, base), Object.assign({ provider: 'דנה לבני', externalId: 'W-2' }, base)]), ex);
  assert.equal(rowOf(p, 2).decisions[0].type, 'similar_provider'); assert.equal(rowOf(p, 3).decisions.length, 0); assert.deepEqual(rowOf(p, 3).provider, { action: 'existing', id: 21 });
  const one = plan(p, { rows: { 2: { apply: true, decisions: { provider: { use: 'existing', id: 21 } } } } }, ex); assert.equal(one.ok, true);
  const both = plan(p, { rows: { 2: { apply: true, decisions: { provider: { use: 'existing', id: 21 } } }, 3: { apply: true } } }, ex);
  assert.equal(both.ok, false); assert.deepEqual(both.refused, [{ row: 3, reason: 'engagement_twice_in_plan' }]); assert.deepEqual(both.operations, []);
});

test('a changed price is one whole statement: the replacement carries every price field (empty ones as null), so applying it never leaves an old number behind', () => {
  const ex = F.existing();   // TX-01 holds a fixed price of 1200
  const p = preview(csvOf([{ domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבני', business: 'לבני מס', contact: 'יצרתי קשר', agreement: 'טרם נדון', activation: 'ממתין', price: '', pricingMode: 'לפי מורכבות התיק', notes: 'שוחחנו בטלפון, ממתינה להצעה מסודרת', externalId: 'TX-01' }]), ex);
  const ch = rowOf(p, 2).changes.find((c) => c.id === 'layer.unclassified.replace');
  assert.ok(ch); assert.deepEqual(['model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'terms_text', 'basis_missing'].filter((f) => !(f in ch.new)), [], 'all price fields are present'); assert.equal(ch.new.amount, null); assert.equal(ch.old.amount, 1200);
  const r = plan(p, approveAll(p), ex); assert.equal(r.ok, true);
  const layer = SIM.applyOps(ex, r.operations).engagements[0].layers[0];
  assert.deepEqual([layer.model, layer.amount], ['variable', null]); assert.deepEqual(PR.validateLayer(layer), [], 'the result satisfies the database rules');
  assert.equal(opsOf(r, 'update_engagement').filter((o) => 'pricing_model' in o.set).length, 1, 'the descriptive model on the engagement follows (tbd -> variable) as its own listed change');
});
