'use strict';
// Stage 5c, the import screen (admin/kaspchem/catalog-import.js): the pure parts run in a sandbox without a browser, against the REAL import engine and the REAL routes (in-memory Postgres); the file is also read as text.
// The behaviour in a browser (the file box, the rows, the approvals, the dialogs, four widths) is covered by tests/e2e/catalog-import.spec.js. No network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Imp = require('../netlify/functions/_kaspchem/catalog/import.js');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').split('\r\n').join('\n');
const SRC = read('admin', 'kaspchem', 'catalog-import.js'), SERVER = (f) => read('netlify', 'functions', '_kaspchem', f), ENGINE = (f) => read('netlify', 'functions', '_kaspchem', 'catalog', f);
const sandbox = { window: {}, console }; vm.createContext(sandbox);
for (const f of ['catalog.js', 'catalog-edit.js', 'catalog-import.js']) vm.runInContext(read('admin', 'kaspchem', f), sandbox);
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const RAW = sandbox.window.KaspchemCatalogImport._t, E = sandbox.window.KaspchemCatalogEdit._t;
const T = new Proxy(RAW, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => plain(t[k](...a)) : t[k]) });
const HEBREW = /[֐-׿]/;
const DEMO = fs.readFileSync(path.join(__dirname, 'fixtures', 'catalog-sheet-demo.csv'), 'utf8');
const EXISTING = {
  services: [{ id: '1', name: '[דמו] בדיקת זכאות להחזר מס', topic: 'tax-refunds', description: 'x', updated_by: 'import:a' }, { id: '2', name: '[דמו] ייעוץ משכנתא', topic: 'mortgage' }, { id: '3', name: '[דמו] בדיקת תלוש שכר', topic: 'payslip-rights' }, { id: '6', name: '[דמו] ייעוץ משכנתאות', topic: 'mortgage' }],
  providers: [{ id: '11', name: '[דמו] נותן שירות א׳', business_name: '[דמו] משרד לדוגמה א׳', contact_phone: '050-0000001', contact_email: 'demo-a@example.test', updated_by: 'import:a' }, { id: '12', name: '[דמו] נותן שירות ב׳', business_name: null }],
  engagements: [{ professional_id: '11', service_id: '1', external_ref: 'DEMO-01', activation: 'pending', contact_state: 'negotiating', agreement_state: 'draft', pricing_model: 'fixed', pricing_id: '1', terms_note: null, updated_by: 'import:a', layers: [] }],
};
const preview = (csv, mappings, columnMap) => Imp.buildPreview({ csv, existing: EXISTING, mappings, columnMap });

test('every code the engine can give for a file, a row, a warning or a flag has words on the screen, and the words carry what is needed to find the problem', () => {
  const grab = (files, res) => { const out = new Set(); for (const f of files) for (const re of res) for (const m of ENGINE(f).matchAll(re)) out.add(m[1]); return out; };
  const rowCodes = grab(['import.js', 'pricing.js', 'text.js'], [/\bcode: '([a-z_]+)'/g, /\bbad\('([a-z_]+)'/g, /\bproblem: '([a-z_]+)'/g, /problems\.push\('([a-z_]+)'/g]);
  rowCodes.delete('too_many_rows');   // a problem of the file, not of a row
  assert.ok(rowCodes.size > 25, 'the scan found the row problems: ' + rowCodes.size);
  assert.deepEqual([...rowCodes].filter((c) => !T.ROW_PROBLEM[c] && c !== 'layer_invalid'), [], 'row problems without words');
  const fileCodes = grab(['csv.js', 'import.js'], [/\bcode: '([a-z_]+)'/g]); fileCodes.delete('missing_column'); for (const c of ['duplicate_engagement', 'duplicate_external_ref', 'external_ref_belongs_to_another_engagement']) fileCodes.delete(c);
  assert.deepEqual([...fileCodes].filter((c) => !T.FILE_PROBLEM[c] && !T.ROW_PROBLEM[c]), [], 'file problems without words'); for (const c of ['header_not_found', 'duplicate_column', 'missing_required_column', 'file_too_large', 'bad_encoding', 'too_many_rows', 'unterminated_quote', 'stray_text_after_quote']) assert.ok(T.FILE_PROBLEM[c], c);
  const flags = grab(['import.js', 'pricing.js', 'text.js'], [/flags\.push\('([a-z_]+)'\)/g, /\bflag: '([a-z_]+)'/g]); for (const m of /MANUAL_FLAG = \{([^}]*)\}/.exec(ENGINE('import.js'))[1].matchAll(/'(file_says_[a-z_]+)'/g)) flags.add(m[1]);
  assert.ok(flags.size > 12, 'the scan found the flags: ' + flags.size); assert.deepEqual([...flags].filter((c) => !T.FLAG[c]), [], 'flags without words');
  const warnings = grab(['import.js', 'pricing.js'], [/warnings\.push\('([a-z_]+)'\)/g]); warnings.add('missing_column'); assert.ok(warnings.size >= 5); assert.deepEqual([...warnings].filter((c) => !T.WARNING[c]), [], 'warnings without words');
  const reasons = grab(['import.js'], [/\bno\('([a-z_]+)'/g]); reasons.delete('row_is_'); reasons.add('row_is_problem'); reasons.add('row_is_skipped'); assert.deepEqual([...reasons].filter((c) => !T.REFUSED[c]), [], 'refusals of the save without words');
  for (const m of [T.ROW_PROBLEM, T.FILE_PROBLEM, T.WARNING, T.FLAG, T.REFUSED]) for (const [code, text] of Object.entries(plain(m))) { assert.match(text, HEBREW, code); assert.doesNotMatch(text, /[a-z]_[a-z]|undefined|null\b/, code + ': ' + text); }
  assert.match(T.problemText({ code: 'unknown_value', field: 'contact_state', value: 'בדרך' }, 'row'), /מצב קשר: ״בדרך״/); assert.match(T.problemText({ code: 'duplicate_engagement', field: 'provider', rows: [9, 10] }, 'row'), /בשורות 9, 10/);
  assert.match(T.problemText({ code: 'missing_required_column', column: 'service' }, 'file'), /השירות המדויק/); assert.match(T.problemText({ code: 'stray_text_after_quote', row: 7 }, 'file'), /בשורה 7/);
  assert.match(T.problemText({ code: 'date_format', field: 'source_date' }, 'row'), /2026-10-25/, 'the date format that is needed is said');
  assert.match(T.problemText({ code: 'layer_invalid:fixed_needs_an_amount_and_nothing_else' }, 'row'), HEBREW); assert.match(T.problemText({ code: 'something_new' }, 'row'), HEBREW);
});

test('the engine, on the demo sheet, gives what the screen is built for: new rows, a change, problems of every kind, a decision, rows to confirm, a blank row; and the screen can show each of them in words', () => {
  const p = preview(DEMO); assert.equal(p.ok, true); assert.deepEqual(plain(p.summary), { rows_total: 12, new: 5, changed: 1, unchanged: 0, skipped: 1, problem: 5 }); assert.equal(p.decisionsNeeded, 1);
  const codes = new Set(p.rows.flatMap((r) => (r.problems || []).map((x) => x.code))); for (const c of ['unknown_value', 'phone_has_letters', 'duplicate_engagement', 'price_without_provider']) assert.ok(codes.has(c), c);
  const flags = new Set(p.rows.flatMap((r) => r.flags || [])); for (const f of ['file_says_signed_needs_manual', 'file_says_collaboration_active_needs_manual', 'file_says_active_needs_manual', 'commission_not_imported', 'price_unclassified']) assert.ok(flags.has(f), f);
  for (const r of p.rows) { const html = RAW.rowHtml(r, { rows: {} }); assert.match(html, /שורה \d+/); assert.doesNotMatch(html, /undefined|\bnull\b|NaN|\[object/); }
  const r4 = p.rows.find((r) => r.rowNumber === 4), h4 = RAW.rowHtml(r4, { rows: {} }); assert.match(h4, /שינויים לעומת מה שקיים/); assert.match(h4, /מצב קשר:[^]*במשא ומתן[^]*נוצר קשר/); assert.match(h4, /החלפה עלולה לנתק את השירות מהתחום\. מומלץ לא לאשר/, 'a change of the topic of an existing service is warned about'); assert.match(h4, /data-cipapply="4"/);
  const r5 = p.rows.find((r) => r.rowNumber === 5), h5 = RAW.rowHtml(r5, { rows: {} }); assert.match(h5, /קיים שירות בשם דומה/); assert.match(h5, /שום דבר לא ימוזג אוטומטית/); assert.match(h5, /ליצור שירות חדש/); assert.match(h5, /\[דמו\] ייעוץ משכנתא/);
  const r7 = p.rows.find((r) => r.rowNumber === 7), h7 = RAW.rowHtml(r7, { rows: {} }); assert.match(h7, /דורש אישור מפורש/); assert.match(h7, /הייבוא רושם ״טיוטה״ בלבד/); assert.match(h7, /ראיתי והבנתי/);
  const r2 = p.rows.find((r) => r.rowNumber === 2), h2 = RAW.rowHtml(r2, { rows: {} }); assert.match(h2, /מחיר \(מדווח בלבד\)[^]*ערך שטרם סווג[^]*לא מחיר מאושר ולא הצעת ספק/); assert.match(h2, /לא פעילה/);
  const r3 = p.rows.find((r) => r.rowNumber === 3), h3 = RAW.rowHtml(r3, { rows: {} }); assert.match(h3, /מחיר שוק/); assert.doesNotMatch(RAW.rowHtml(p.rows.find((r) => r.rowNumber === 13), { rows: {} }), /data-cipapply/); assert.match(RAW.rowHtml(p.rows.find((r) => r.rowNumber === 13), { rows: {} }), /שורה ריקה/);
  const r6 = p.rows.find((r) => r.rowNumber === 6); assert.match(RAW.rowHtml(r6, { rows: {} }), /ערך שאינו מוכר/); assert.deepEqual(plain(T.unknownValues(p)), [{ field: 'contact_state', value: 'בדרך', rows: [6] }]);
  assert.equal(RAW.rowHtml(p.rows.find((r) => r.rowNumber === 11), { rows: {} }).includes('data-cipapply'), false, 'a row with a problem cannot be approved');
});

test('what the screen says will be saved is what the engine plans, for every combination of approvals: the counts of the summary equal the engine\'s own summary', () => {
  const p = preview(DEMO), rows = p.rows.filter((r) => r.status === 'new' || r.status === 'changed');
  const decide = (r, how) => { const out = {}; for (const d of r.decisions || []) out[d.entity] = how === 'existing' && d.candidates.length ? { use: 'existing', id: d.candidates[0].id } : { use: 'new' }; return out; };
  let compared = 0, seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 400; i++) {
    const approvals = { rows: {} };
    for (const r of rows) {
      if (rnd() < 0.6) continue; const a = T.startApproval(r);
      if (rnd() < 0.5) a.accept = a.accept.filter(() => rnd() < 0.7); if (rnd() < 0.3) for (const c of r.changes || []) if (c.manual) a.acceptManual.push(c.id);
      a.decisions = rnd() < 0.5 ? decide(r, 'new') : decide(r, 'existing'); a.confirmed = (r.needsConfirmation || []).filter(() => rnd() < 0.8); approvals.rows[r.rowNumber] = a;
    }
    const plan = Imp.planApply(p, approvals, EXISTING, { actor: 'a', previewId: p.previewId });
    const ready = Object.keys(approvals.rows).every((n) => RAW.rowReady(rows.find((r) => String(r.rowNumber) === n), approvals.rows[n]));
    assert.equal(ready, plan.ok || !plan.refused.some((x) => ['decision_missing', 'confirmation_missing'].includes(x.reason)), 'the screen\'s "this approval is complete" is the engine\'s: ' + JSON.stringify(plan.refused));
    if (!plan.ok) continue; compared++;
    assert.deepEqual(plain(T.summarize(p, approvals)), plain(plan.summary), 'summary ' + i);
  }
  assert.ok(compared > 100, 'many plans were compared: ' + compared);
  assert.deepEqual(plain(T.summarize(p, { rows: {} })), {}, 'nothing approved, nothing to save');
});

test('the work done is kept through a new preview exactly for the rows that did not change: a fixed mapping, a corrected cell elsewhere; what changed loses its approval and is named', () => {
  const p1 = preview(DEMO), a = { rows: {} }, sigs = {};
  for (const r of p1.rows.filter((x) => x.status === 'new')) { a.rows[r.rowNumber] = T.startApproval(r); sigs[r.rowNumber] = RAW.signature(r); }
  // the owner maps the unknown word: only row 6 moves; every approved row is kept
  const p2 = preview(DEMO, { contact: { 'בדרך': 'contacted' } }); assert.equal(p2.rows.find((r) => r.rowNumber === 6).status, 'new'); assert.notEqual(p2.previewId, p1.previewId);
  const k2 = T.reconcile(a, sigs, p2); assert.deepEqual(k2.dropped, []); assert.deepEqual(Object.keys(k2.approvals.rows).sort(), Object.keys(a.rows).sort());
  // a cell of one approved row is corrected in the text: that row loses its approval, the others keep theirs
  const edited = DEMO.replace('"[דמו] גולן כהן","[דמו] גולן ייעוץ","050-0000101"', '"[דמו] גולן כהן","[דמו] גולן ייעוץ","050-0000199"'); assert.notEqual(edited, DEMO);
  const k3 = T.reconcile(a, sigs, preview(edited)); assert.deepEqual(k3.dropped, [2]); assert.ok(!k3.approvals.rows[2] && k3.approvals.rows[3]);
  // a row that stopped being applicable (an edit made it a problem) is dropped; an approval of a row that is not there any more is dropped
  const broken = DEMO.replace('"[דמו] ייעוץ משכנתא","ליווי בבחירת משכנתא ובמחזור (נתוני דמה)","[דמו] מיכל לוי"', '"","ליווי בבחירת משכנתא ובמחזור (נתוני דמה)","[דמו] מיכל לוי"'); assert.ok(T.reconcile(a, sigs, preview(broken)).dropped.includes(3));
  assert.deepEqual(T.reconcile(a, sigs, preview(DEMO.split('\n').slice(0, 3).join('\n') + '\n')).dropped.filter((n) => n > 3).length > 0, true);
  // the signature moves with what the approval depends on (the decisions and the changes), not with a different row
  const r5 = p1.rows.find((r) => r.rowNumber === 5); assert.equal(RAW.signature(r5), RAW.signature(JSON.parse(JSON.stringify(r5)))); const moved = JSON.parse(JSON.stringify(r5)); moved.decisions[0].candidates.pop(); assert.notEqual(RAW.signature(r5), RAW.signature(moved));
});

test('the mappings the owner may choose are exactly what the engine allows an import to set, and they travel in the shape the engine reads', () => {
  const safe = Imp.SAFE_TARGETS; assert.deepEqual(plain(T.TARGETS), { contact_state: safe.contact, agreement_state: safe.agreement, activation: safe.activation });
  assert.deepEqual(plain(T.mappingsFrom({ 'contact_state|בדרך': 'contacted', 'agreement_state|בכתיבה': 'draft', 'activation|x': '', 'nonsense|y': 'z' })), { contact: { 'בדרך': 'contacted' }, agreement: { 'בכתיבה': 'draft' } });
  const p = preview(DEMO, T.mappingsFrom({ 'contact_state|בדרך': 'contacted' })); assert.equal(p.rows.find((r) => r.rowNumber === 6).problems.length, 0);
  for (const bad of ['active', 'signed', 'stopped']) assert.equal(preview(DEMO, { contact: { 'בדרך': bad } }).rows.find((r) => r.rowNumber === 6).problems[0].code, 'mapping_not_allowed', bad + ' is never set by an import');
  for (const v of ['שיתוף פעולה פעיל', 'חתום', 'פעיל']) assert.match(SRC, new RegExp(v), 'the screen says ' + v + ' is set by a person only');
  const unknown = Imp.buildPreview({ csv: '"תחום","השירות המדויק","מי","עוד"\r\n"מיסים","[דמו] שירות","[דמו] ספק","y"\r\n', existing: EXISTING }); assert.deepEqual(plain(unknown.unknownColumns).map((u) => u.text), ['מי', 'עוד'], 'the engine names the columns it did not know, which the screen offers to map');
  assert.ok(T.COLUMN.service && T.COLUMN.domain && T.COLUMN.externalId);
  const mapped = Imp.buildPreview({ csv: '"תחום","השירות המדויק","מי"\r\n"מיסים","[דמו] שירות","[דמו] ספק"\r\n', existing: EXISTING, columnMap: { 'מי': 'provider' } }); assert.equal(mapped.rows[0].record.provider.name, '[דמו] ספק', 'a column mapped by the owner is read');
  assert.ok(Object.keys(plain(T.COLUMN)).every((k) => /^[a-zA-Z]+$/.test(k)) && Object.keys(plain(T.COLUMN)).length === 23);
});

test('the screen sends only the two routes of the import, with exactly the fields the server reads; the save needs a typed word and an acknowledgement; nothing is stored in the browser; no timer but the search box; text from the file is escaped', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|\beval\(|new Function|document\.write|ctx\.api\(/); assert.doesNotMatch(code, /insertAdjacentHTML|outerHTML/);
  assert.equal((code.match(/setTimeout\(/g) || []).length, 2, 'the search box, and the release of the link of the template file; nothing else'); assert.doesNotMatch(code, /setInterval|requestAnimationFrame|autosave|retry\(/);
  assert.deepEqual([...code.matchAll(/K\.send\(h\.ctx, '(\w+)', '([^']+)'/g)].map((m) => m[1] + ' ' + m[2]), ['POST /catalog/imports/preview']); assert.deepEqual([...code.matchAll(/K\.write\(h, ctl, '(\w+)', '([^']+)'/g)].map((m) => m[1] + ' ' + m[2]), ['POST /catalog/imports/apply']);
  for (const p of ['/catalog/imports/preview', '/catalog/imports/apply']) assert.equal(E.allowed('POST', p), true);
  const fields = /fields\(c, \['csv', 'mappings', 'columnMap'\]\.concat\(extra \|\| \[\]\)\)/.test(SERVER('admin-catalog-writes.js')); assert.ok(fields, 'the server reads csv, mappings, columnMap and, for the save, previewId and approvals');
  assert.ok(code.includes('{ csv: W.csv, previewId: p.previewId, approvals: approvals }') && code.includes('var body = { csv: W.csv };'), 'the bodies of the two requests');
  assert.ok(code.includes("String(v.confirmbox || '').trim() === 'import'") && code.includes("'כדי לאשר יש להקליד בדיוק: import'") && code.includes("if (!v.ack) return { field: 'ack'"), 'the explicit approval of the save');
  assert.ok(code.includes('var approvals = JSON.parse(JSON.stringify(W.approvals))') || code.includes('approvals = JSON.parse(JSON.stringify(W.approvals))'), 'the approvals that are sent are the ones that were shown in the summary');
  assert.match(code, /f\.size > MAX_BYTES/); assert.equal(RAW.MAX_BYTES, 1024 * 1024); assert.match(SERVER('admin-catalog-writes.js'), /MAX_IMPORT_BYTES/);
  // nothing leaves the page before a click: the file box only reads the file; the preview and the save are behind buttons and a dialog
  assert.doesNotMatch(code, /addEventListener\('(blur|focusout|keyup|keydown)'/); assert.ok(/function readFile\(api, f\) \{[^]*?readAsText/.test(code) && !/readFile[^]*?runPreview\(api/.test(code.slice(code.indexOf('function readFile'), code.indexOf('function template'))), 'reading the file does not send it');
  // the answers of the save, in words: a stale preview and refused rows keep the work and send nothing again
  const E1 = (message, status, details) => ({ message, status, details });
  assert.equal(plain(RAW.applyRefine(E1('preview_stale', 409), E.describe(E1('preview_stale', 409)))).kind, 'stale');
  const refused = plain(RAW.applyRefine(E1('rows_refused', 422, { codes: ['r5:decision_missing:service', 'r7:confirmation_missing', 'r9:change_blocked:service_has_public_price', 'not a code <img>'] }), E.describe(E1('rows_refused', 422))));
  assert.equal(refused.kind, 'blocked'); assert.match(refused.list.join(' '), /שורה 5: חסרה החלטה על שם דומה/); assert.match(refused.list.join(' '), /שורה 7: חסר אישור/); assert.match(refused.list.join(' '), /שורה 9: שינוי חסום אושר[^]*מחיר שמוצג באתר/); assert.doesNotMatch(JSON.stringify(refused), /decision_missing|_/);
  assert.equal(plain(RAW.applyRefine(E1('file_not_usable', 422), {})).kind, 'blocked'); assert.equal(plain(RAW.applyRefine(E1('conflict_retry', 409), E.describe(E1('conflict_retry', 409)))).kind, 'busy'); assert.equal(plain(RAW.applyRefine(E1('result_unknown', 502), E.describe(E1('result_unknown', 502)))).kind, 'unknown');
  assert.match(plain(RAW.refusedText({ row: 3, reason: 'brand_new_reason' })), HEBREW);
});

test('SAFE TEXT, every field of a row: whatever the file holds is shown as text, never as a tag', () => {
  const P = '"><img src=x onerror=window.__x=1><script>window.__x=2</script>\'', A = '\'><svg onload=window.__x=3></svg>';
  const row = { rowNumber: 4, status: 'changed', record: { service: { name: P, key: 'k', topic: A }, provider: { name: A, business: P, key: 'k|k' }, engagement: { activation: 'pending' }, layer: { kind: 'market', model: 'fixed', amount: 100, terms_text: P } },
    problems: [{ code: 'unknown_value', field: 'contact_state', value: P }], warnings: [], flags: ['phone_restored'], needsConfirmation: ['phone_restored'], service: { action: 'existing', id: P }, provider: { action: 'existing', id: A }, engagement: { action: 'existing' },
    changes: [{ id: 'service.topic', entity: 'service', field: 'topic', old: P, new: A, manual: true }, { id: 'layer.market.replace', entity: 'layer', field: 'replace', kind: 'market', old: { model: 'fixed', amount: 1, terms_text: P }, new: { model: 'fixed', amount: 2, terms_text: A } }],
    decisions: [{ entity: 'service', type: 'similar_service', candidates: [{ id: P, name: A, score: 0.9 }] }, { entity: 'provider', type: 'same_name_other_business', candidates: [{ id: A, name: P, business: A }] }] };
  const html = RAW.rowHtml(row, { rows: { 4: { apply: true, decisions: {}, accept: [], acceptManual: [], confirmed: [] } } });
  assert.doesNotMatch(html, /<(img|script|svg)\b/i); assert.match(html, /&lt;img src=x/); assert.doesNotMatch(html, /"><img|'><svg/);
  const approved = RAW.rowHtml(row, { rows: { 4: { apply: true, decisions: { service: { use: 'existing', id: P } }, accept: ['service.topic'], acceptManual: ['service.topic'], confirmed: ['phone_restored'] } } }); assert.doesNotMatch(approved, /<(img|script|svg)\b/i); assert.doesNotMatch(approved, /"><img|'><svg/);
});

// ---------- the screen fed with what the real routes answer ----------
const post = (w, p, body) => w.call('POST', '/catalog' + p, YOSI, { body });
const SHEET = '"תחום","השירות המדויק","שם הספק","עסק / ארגון","טלפון","מצב קשר","מצב הסכם","סטטוס הפעלה באתר","מחיר ₪ (שוק / לקוח)","אופן התמחור","מקור מחיר / התכתבות","תאריך מקור","מזהה שירות"\r\n' +
  '"מיסים","שירות חדש א","ספק חדש א","","0501110001","יצרתי קשר","טיוטה","ממתין לאישור להפניה","500","מחיר שוק קבוע","אתר הספק","2026-10-20","SH-1"\r\n' +
  '"מיסים","בדיקת זכאות להחזר מס","דנה לבני","לבני מס","","יצרתי קשר","טיוטה","ממתין לאישור להפניה","","","","","TX-01"\r\n' +
  '"משכנתאות","ייעוץ משכנתה","גבריאל כרמלי","","","יצרתי קשר","טרם נדון","ממתין לאישור להפניה","","הצעת מחיר לכל מקרה","","","SH-3"\r\n';

test('INTEGRATION server <-> screen: the preview of the real route is drawn by the screen; the approvals the screen builds are accepted by the real save; the summary on the screen equals what the server says it saved; nothing is activated, no price is approved, nothing is deleted', async () => {
  const w = await world(); await w.open();
  const before = { prices: await w.fingerprint(['pricing']), active: await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active'"), engagements: await w.count('provider_services') };
  const pv = await post(w, '/imports/preview', { csv: SHEET }); assert.equal(pv.status, 200); const p = pv.body.preview;
  assert.equal(p.ok, true); assert.deepEqual(plain(p.summary).rows_total, 3); const row = (n) => p.rows.find((r) => r.rowNumber === n);
  assert.deepEqual([row(2).status, row(3).status, row(4).status], ['new', 'changed', 'new']); assert.equal(row(4).decisions.length, 1, 'a similar name is a question');
  const html = p.rows.map((r) => RAW.rowHtml(r, { rows: {} })).join(''); assert.match(html, /שירות חדש א/); assert.match(html, /דנה לבני/); assert.match(html, /קיים שירות בשם דומה/); assert.doesNotMatch(html, /undefined|\[object/);
  // the approvals the screen builds: the new row, the changed row with its changes ticked, the decision answered by the person
  const a = { rows: {} }; a.rows[2] = T.startApproval(row(2)); a.rows[3] = T.startApproval(row(3)); a.rows[4] = T.startApproval(row(4)); a.rows[4].decisions = { service: { use: 'new' } };
  for (const n of [2, 3, 4]) assert.equal(RAW.rowReady(row(n), a.rows[n]), true, 'row ' + n);
  const bad = JSON.parse(JSON.stringify(a)); bad.rows[4].decisions = {}; assert.equal(RAW.rowReady(row(4), bad.rows[4]), false); const refused = await post(w, '/imports/apply', { csv: SHEET, previewId: p.previewId, approvals: bad });
  assert.deepEqual([refused.status, refused.body.error], [422, 'rows_refused']); assert.match(T.applyRefine({ message: 'rows_refused', status: 422, details: refused.body }, {}).list.join(' '), /שורה 4: חסרה החלטה על שם דומה/); assert.deepEqual(await w.fingerprint(['pricing']), before.prices, 'refused: nothing was written');
  const sum = T.summarize(p, a), out = await post(w, '/imports/apply', { csv: SHEET, previewId: p.previewId, approvals: a }); assert.equal(out.status, 200, JSON.stringify(out.body)); assert.equal(out.body.applied, true);
  assert.deepEqual(plain(sum), plain(out.body.operations), 'the screen said what the server then did');
  // what exists now
  const act = (await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active'"))[0].n; assert.equal(act, before.active[0].n, 'nothing became active');
  assert.deepEqual((await w.owner("SELECT name, active FROM services WHERE name IN ('שירות חדש א', 'ייעוץ משכנתה') ORDER BY name")).map((r) => [r.name, r.active]), [['ייעוץ משכנתה', false], ['שירות חדש א', false]], 'imported services start switched off');
  assert.deepEqual(await w.fingerprint(['pricing']), before.prices, 'no price of the older table was touched'); assert.equal(await w.count('provider_services'), before.engagements + 2);
  const layers = await w.owner("SELECT kind, model, amount::float8 AS amount, status, recorded_by FROM provider_service_prices WHERE recorded_by LIKE 'import:%' ORDER BY kind, model"); assert.ok(layers.length >= 2); assert.ok(layers.every((l) => l.status === 'recorded' && l.recorded_by.startsWith('import:') && ['market', 'unclassified'].includes(l.kind)), 'prices only as reported layers');
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_service_prices WHERE kind = 'provider_offer' AND recorded_by LIKE 'import:%'"))[0].n, 0, 'an import never writes the provider offer');
  assert.equal((await w.owner('SELECT count(*)::int AS n FROM catalog_imports'))[0].n, 1); assert.equal((await post(w, '/imports/apply', { csv: SHEET, previewId: p.previewId, approvals: a })).status, 409, 'the same save again is refused (the data moved since the preview)');
  // and the preview of the same file now says that nothing is left to do for those rows
  const again = (await post(w, '/imports/preview', { csv: SHEET })).body.preview; assert.deepEqual(again.rows.map((r) => r.status), ['unchanged', 'unchanged', 'unchanged'], 'the way to check the state after an unknown result');
  assert.equal(T.summarize(again, { rows: {} }) && Object.keys(plain(T.summarize(again, { rows: {} }))).length, 0);
});
