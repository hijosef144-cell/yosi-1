'use strict';
// Catalog server, stage 4b, the CONTROLLED IMPORT through the API: preview writes nothing; apply saves in one transaction; the data moving in between is detected; any failure leaves nothing;
// nothing is ever activated, signed, published or priced by an import. In-memory Postgres (PGlite) with the real tables and grants, synthetic data, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, closeAll, YOSI, AVI } = require('./fixtures/catalog-world.js');
const F = require('./fixtures/catalog-demo.js');
const store = require('../netlify/functions/_kaspchem/catalog-store.js');
const W = require('../netlify/functions/_kaspchem/catalog-writes.js');
test.after(closeAll);

const j = (b) => ({ body: b });
const csvOf = (rows, opts) => F.csv(rows.map((r) => F.row(r)), opts);
const IMPORT = '/catalog/imports';
const preview = async (w, csv, extra, who) => { const r = await w.call('POST', IMPORT + '/preview', who || YOSI, j(Object.assign({ csv }, extra || {}))); assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200)); return r.body.preview; };
// the owner's approval: every row the screen would offer, with every change that is neither hand-made nor blocked, and the confirmations; o.manual adds the hand-made changes
function approvals(p, o) {
  const opt = o || {}, rows = {};
  for (const r of p.rows) {
    if (['skipped', 'problem', 'unchanged'].includes(r.status) || (opt.only && !opt.only.includes(r.rowNumber)) || ((r.decisions || []).length && !(opt.decisions && opt.decisions[r.rowNumber]))) continue;
    rows[r.rowNumber] = { apply: true, accept: r.changes.filter((c) => !c.manual && !c.blocked).map((c) => c.id), acceptManual: opt.manual ? r.changes.filter((c) => c.manual && !c.blocked).map((c) => c.id) : [], confirmed: opt.confirm === false ? [] : r.needsConfirmation, decisions: opt.decisions && opt.decisions[r.rowNumber] };
  }
  return { rows };
}
const apply = (w, csv, p, a, extra, who) => w.call('POST', IMPORT + '/apply', who || YOSI, j(Object.assign({ csv, previewId: p.previewId, approvals: a }, extra || {})));
const DATA = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'audit_log'];

test('PREVIEW writes nothing: only SELECTs in READ ONLY transactions, no audit row, no import log, no row changed; same input gives the same id; the answer carries no commission', async () => {
  const w = await world({ seed: false }); await w.open(); const before = await w.fingerprint(DATA); w.rec.length = 0; w.txs.length = 0;
  const r = await w.call('POST', IMPORT + '/preview', YOSI, j({ csv: F.FILE })); assert.equal(r.status, 200); const p = r.body.preview;
  assert.deepEqual([p.ok, p.summary], [true, { rows_total: 11, new: 9, changed: 0, unchanged: 0, skipped: 2, problem: 0 }]); assert.match(p.previewId, /^[0-9a-f]{64}$/); assert.equal(r.headers.get('cache-control'), 'no-store');
  const writes = w.rec.filter((x) => !/^\s*(select|with)\b/i.test(x.text) && !/FROM settings WHERE key = \$1/.test(x.text)); assert.deepEqual(writes, [], 'no statement of the preview writes anything');
  assert.ok(w.txs.length >= 1 && w.txs.every((t) => t.readOnly === true), 'the data is read in READ ONLY transactions'); assert.deepEqual(await w.fingerprint(DATA), before); assert.equal(await w.count('audit_log'), 0, 'not even an audit row'); assert.equal(await w.count('catalog_imports'), 0);
  assert.equal((await w.call('POST', IMPORT + '/preview', AVI, j({ csv: F.FILE }))).body.preview.previewId, p.previewId, 'the same file and data give the same id, whoever asks');
  assert.notEqual((await w.call('POST', IMPORT + '/preview', YOSI, j({ csv: F.FILE, mappings: { contact: { 'מילה': 'contacted' } } }))).body.preview.previewId, p.previewId);
  assert.equal(JSON.stringify(r.body).includes('הספק משלם לכספכם') || /"commission_percent"/.test(JSON.stringify(r.body)), false, 'the commission columns of the file are not in the answer'); await w.pg.close();
});

test('SAVING: the whole import is one transaction with its audit row and its log row; nothing becomes active, signed, offered, published or priced; a second preview finds nothing to do; the same approval cannot be used twice', async () => {
  const w = await world({ seed: false }); await w.open(); const publicBefore = JSON.stringify(await w.publicPrices());
  const p = await preview(w, F.FILE); const a = approvals(p);
  const r = await apply(w, F.FILE, p, a, null, AVI); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.deepEqual(r.body.operations, { create_service: 9, create_provider: 6, create_engagement: 8, create_layer: 8 }); assert.equal(r.body.applied, true);
  const counts = { services: await w.count('services'), providers: await w.count('professionals'), engagements: await w.count('provider_services'), layers: await w.count('provider_service_prices') }; assert.deepEqual(counts, { services: 9, providers: 6, engagements: 8, layers: 8 });
  // the safety rules, in the database itself
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE activation NOT IN ('draft','pending') OR contact_state = 'active' OR agreement_state IN ('signed','ended') OR pricing_model = 'fixed' OR pricing_id IS NOT NULL"))[0].n, 0, 'nothing active, signed, in active collaboration or with a client price');
  assert.equal((await w.owner('SELECT count(*)::int AS n FROM services WHERE active'))[0].n, 0, 'imported services start switched off'); assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_service_prices WHERE kind = 'provider_offer' OR status <> 'recorded'"))[0].n, 0);
  assert.equal(await w.count('pricing'), 0, 'no price row'); assert.equal(await w.count('provider_service_compensation'), 0, 'no commission'); assert.equal((await w.owner("SELECT count(*)::int AS n FROM settings WHERE key NOT LIKE 'private.catalog%'"))[0].n, 0); assert.equal((await w.owner('SELECT count(*)::int AS n FROM service_settings'))[0].n, 0);
  assert.equal((await w.owner("SELECT count(*)::int AS n FROM provider_services WHERE updated_by NOT LIKE 'import:%'"))[0].n, 0, 'everything the import wrote says so'); assert.equal(JSON.stringify(await w.publicPrices()), publicBefore, 'the public site is untouched');
  const audit = await w.audits("action = 'catalog.import.apply'"); assert.equal(audit.length, 1); assert.deepEqual([audit[0].actor, audit[0].entity, audit[0].entity_id, audit[0].detail.rows_total, audit[0].detail.operations], [AVI, 'catalog_import', r.body.file_sha256.slice(0, 12), 11, r.body.operations]);
  const log = await w.owner('SELECT source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, imported_by FROM catalog_imports'); assert.deepEqual(log, [{ source: 'csv', file_sha256: r.body.file_sha256, rows_total: 11, rows_created: 9, rows_updated: 0, rows_skipped: 2, imported_by: AVI }]);
  assert.equal(w.alerts.length, 1); assert.match(w.alerts[0].text, /הוחלו 9 שורות/);
  // afterwards
  assert.equal((await apply(w, F.FILE, p, a)).body.error, 'preview_stale', 'the same approval, used again, is refused'); assert.equal(await w.count('provider_services'), 8);
  const again = await preview(w, F.FILE); assert.deepEqual(again.summary, { rows_total: 11, new: 0, changed: 0, unchanged: 9, skipped: 2, problem: 0 }); assert.equal(again.decisionsNeeded, 0);
  const nothing = await apply(w, F.FILE, again, approvals(again)); assert.deepEqual([nothing.status, nothing.body.applied, nothing.body.operations], [200, false, {}]); assert.equal(await w.count('audit_log'), 1, 'an import that changes nothing is not logged'); assert.equal(await w.count('catalog_imports'), 1);
  const hist = (await w.call('GET', '/catalog/history', YOSI)).body.history; assert.deepEqual(hist.map((h) => h.action), ['catalog.import.apply']); assert.equal((await w.call('GET', IMPORT, YOSI)).body.imports[0].file_sha256, r.body.file_sha256); await w.pg.close();
});

test('what the file says about "active", "signed" and "active collaboration" needs the owner\'s confirmation row by row, and even then only pending / draft / negotiating are saved', async () => {
  const w = await world({ seed: false }); await w.open(); const p = await preview(w, F.FILE), row = p.rows.find((x) => x.rowNumber === 9);
  assert.deepEqual(row.needsConfirmation.slice().sort(), ['file_says_active_needs_manual', 'file_says_collaboration_active_needs_manual', 'file_says_signed_needs_manual']);
  const refused = await apply(w, F.FILE, p, approvals(p, { confirm: false })); assert.deepEqual([refused.status, refused.body.error], [422, 'rows_refused']); assert.ok(refused.body.refused.some((x) => x.row === 9 && x.reason === 'confirmation_missing' && x.flags.length === 3)); assert.equal(await w.count('provider_services'), 0, 'nothing was saved');
  assert.equal((await apply(w, F.FILE, p, approvals(p))).status, 200); assert.deepEqual((await w.owner("SELECT activation, contact_state, agreement_state FROM provider_services WHERE external_ref = 'TX-03'"))[0], { activation: 'pending', contact_state: 'negotiating', agreement_state: 'draft' }); await w.pg.close();
});

test('DATA MOVED between preview and save: refused with "preview_stale" and nothing is written (by the server\'s own comparison, and, if that were skipped, by the guard inside the transaction itself)', async () => {
  const w = await world({ seed: false }); await w.open(); const p = await preview(w, F.FILE), a = approvals(p), before = await w.fingerprint(DATA);
  await w.owner("INSERT INTO services (name) VALUES ('שירות שנוסף בינתיים')"); const moved = await w.fingerprint(DATA);
  let r = await apply(w, F.FILE, p, a); assert.deepEqual([r.status, r.body.error], [409, 'preview_stale']); assert.deepEqual(await w.fingerprint(DATA), moved, 'the import added nothing');
  await w.owner('DELETE FROM services'); const p2 = await preview(w, F.FILE), a2 = approvals(p2);
  await w.owner("UPDATE professionals SET agreement_notes = 'x' WHERE false"); await w.setSetting('private.something_else', 1);   // things the import does not read do not make a preview stale
  assert.equal((await apply(w, F.FILE, p2, a2)).status, 200, 'unrelated changes do not block the save'); await w.pg.close();
  // the guard INSIDE the transaction, on its own: the server is made to work from an old reading of the data, so its own comparison passes; the database still says no
  const x = await world({ seed: false }); await x.open(); const old = await store.readSnapshot(); await x.owner("INSERT INTO services (name) VALUES ('נוסף אחרי הקריאה')");
  const real = store.readSnapshot; store.readSnapshot = async () => old;
  try { const pv = await preview(x, F.FILE); const out = await apply(x, F.FILE, pv, approvals(pv)); assert.deepEqual([out.status, out.body.error], [409, 'preview_stale'], 'refused by the transaction\'s own check'); } finally { store.readSnapshot = real; }
  assert.equal(await x.count('provider_services'), 0); assert.equal(await x.count('audit_log'), 0); assert.equal(await x.count('catalog_imports'), 0); await x.pg.close();
});

test('FAILURE AT ANY STATEMENT of an import leaves NOTHING (no row, no audit row, no log row); a failure just before COMMIT too; a reply lost after COMMIT leaves it saved once and the retry is refused', async () => {
  const csv = csvOf([F.ROWS.fixed, F.ROWS.percent, F.ROWS.noProvider]);
  const w = await world({ seed: false }); await w.open(); const p = await preview(w, csv), a = approvals(p), before = await w.fingerprint(DATA); let k = 0, tried = 0;
  for (; ; k++) {
    w.failAt = k; const r = await apply(w, csv, p, a); w.failAt = null;
    if (r.status === 200) break;
    assert.equal(r.status, 500, 'position ' + k + ' ' + JSON.stringify(r.body)); assert.deepEqual(await w.fingerprint(DATA), before, 'a failure at statement ' + k + ' left something behind'); tried++; assert.ok(k < 80, 'runaway');
  }
  assert.ok(tried >= 15, 'positions tried: ' + tried); assert.equal(await w.count('provider_services'), 2); assert.equal(await w.count('catalog_imports'), 1); assert.equal(await w.count('audit_log'), 1, 'and the run that went through left exactly one of each');
  await w.pg.close();
  const y = await world({ seed: false }); await y.open(); const q = await preview(y, csv), b = approvals(q), clean = await y.fingerprint(DATA);
  y.failAt = 'commit'; assert.equal((await apply(y, csv, q, b)).status, 500); y.failAt = null; assert.deepEqual(await y.fingerprint(DATA), clean, 'a failure just before COMMIT');
  y.failAfterCommit = true; assert.equal((await apply(y, csv, q, b)).status, 500); y.failAfterCommit = false;   // the transaction was committed, the reply was lost
  assert.deepEqual([await y.count('provider_services'), await y.count('catalog_imports'), await y.count('audit_log')], [2, 1, 1], 'saved once');
  assert.equal((await apply(y, csv, q, b)).body.error, 'preview_stale', 'the retry is refused'); const after = await preview(y, csv); assert.deepEqual(after.rows.filter((r) => r.status !== 'skipped').map((r) => r.status), ['unchanged', 'unchanged', 'unchanged'], 'and a new preview says: nothing left to do');
  assert.deepEqual([await y.count('provider_services'), await y.count('catalog_imports')], [2, 1]); await y.pg.close();
});

test('DUPLICATES: a sheet id twice in the file, the same provider and service twice, a second administrator using the same preview, and a record created by hand in between are all refused or flagged, never doubled', async () => {
  const w = await world({ seed: false }); await w.open();
  const dupFile = csvOf([{ service: 'ייעוץ ירושה', provider: 'אבי רוזן', externalId: 'D-1' }, { service: 'הגשת ערר ארנונה', provider: 'מאיה גולן', externalId: 'd-1' }, { service: 'ליווי רכישת דירה', provider: 'שרון דוד', externalId: 'D-3' }, { service: 'ליווי רכישת דירה', provider: ' שרון  דוד ', externalId: 'D-4' }]);
  const pd = await preview(w, dupFile); assert.deepEqual(pd.rows.map((r) => r.status), ['problem', 'problem', 'problem', 'problem']); assert.deepEqual(pd.rows.map((r) => r.problems[0].code), ['duplicate_external_ref', 'duplicate_external_ref', 'duplicate_engagement', 'duplicate_engagement']);
  const refused = await apply(w, dupFile, pd, { rows: { 2: { apply: true }, 4: { apply: true } } }); assert.deepEqual([refused.status, refused.body.error], [422, 'rows_refused']); assert.deepEqual(refused.body.refused.map((x) => x.reason), ['row_is_problem', 'row_is_problem']); assert.equal(await w.count('provider_services'), 0);
  const file = csvOf([F.ROWS.fixed, F.ROWS.percent]); const p = await preview(w, file), a = approvals(p);
  assert.equal((await apply(w, file, p, a, null, YOSI)).status, 200); const second = await apply(w, file, p, a, null, AVI); assert.deepEqual([second.status, second.body.error], [409, 'preview_stale'], 'the second administrator with the same preview'); assert.equal(await w.count('provider_services'), 2); assert.equal(await w.count('services'), 2);
  const w2 = await world({ seed: false }); await w2.open(); const p2 = await preview(w2, file), a2 = approvals(p2);
  assert.equal((await w2.call('POST', '/catalog/services', AVI, j({ name: 'בדיקת זכאות להחזר מס' }))).status, 200);   // someone creates one of the services by hand while the preview is on screen
  assert.equal((await apply(w2, file, p2, a2)).body.error, 'preview_stale'); assert.equal(await w2.count('provider_services'), 0); assert.equal(await w2.count('services'), 1, 'one service, not two'); await w.pg.close(); await w2.pg.close();
});

test('SIMILAR names are a question, through the API too: without an answer nothing is saved; "use the existing one" links to it; "new one" creates it; nothing is merged or renamed', async () => {
  const w = await world(); await w.open(); const file = csvOf([{ domain: 'נדל"ן', service: 'ייעוץ משכנתאות', provider: 'מיכל פז', externalId: 'M-1' }]);
  const p = await preview(w, file); assert.equal(p.decisionsNeeded, 1); assert.equal(String(p.rows[0].decisions[0].candidates[0].id), '12');
  const none = await apply(w, file, p, { rows: { 2: { apply: true } } }); assert.deepEqual([none.status, none.body.error, none.body.refused], [422, 'rows_refused', [{ row: 2, reason: 'decision_missing', entity: 'service' }]]);
  const merge = await apply(w, file, p, { rows: { 2: { apply: true, decisions: { service: { use: 'merge', id: 12 } } } } }); assert.equal(merge.status, 422);
  const before = await w.fingerprint(['services']); const ok = await apply(w, file, p, { rows: { 2: { apply: true, decisions: { service: { use: 'existing', id: 12 }, provider: undefined } } } }); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(await w.fingerprint(['services']), before, 'no service was created, renamed or changed'); assert.deepEqual((await w.owner("SELECT service_id::int AS service_id FROM provider_services WHERE external_ref = 'M-1'")), [{ service_id: 12 }]); await w.pg.close();
  const x = await world(); await x.open(); const p2 = await preview(x, file); assert.equal((await apply(x, file, p2, { rows: { 2: { apply: true, decisions: { service: { use: 'new' } } } } })).status, 200);
  assert.deepEqual((await x.owner("SELECT name, active FROM services WHERE name LIKE 'ייעוץ משכנתא%' ORDER BY id")), [{ name: 'ייעוץ משכנתא', active: true }, { name: 'ייעוץ משכנתאות', active: false }]); await x.pg.close();
});

test('HAND-MADE values are protected through the API: the import shows the change as hand-made and does not apply it with the ordinary approval; only the separate approval does', async () => {
  const w = await world(); await w.open(); const row = (notes) => csvOf([{ domain: 'מיסים', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבני', business: 'לבני מס', phone: '0501234567', email: 'dana@example.test', contact: 'במו"מ', agreement: 'טיוטה', activation: 'ממתין לאישור להפניה', externalId: 'TX-01', notes }]);
  const file = row('הערה חדשה מהקובץ'); let p = await preview(w, file); assert.deepEqual(p.rows[0].changes.map((c) => [c.id, c.manual]), [['engagement.terms_note', false]], 'seeded by an earlier import: not hand-made');
  assert.equal((await w.call('PATCH', '/catalog/engagements/21/11', YOSI, j({ changes: { terms_note: 'ערכתי ידנית' }, expected: { terms_note: 'שוחחנו בטלפון' } }))).status, 200);   // the owner edits the note by hand
  p = await preview(w, file); assert.deepEqual(p.rows[0].changes.map((c) => [c.id, c.manual, c.old, c.new]), [['engagement.terms_note', true, 'ערכתי ידנית', 'הערה חדשה מהקובץ']]);
  const ordinary = await apply(w, file, p, { rows: { 2: { apply: true, accept: ['engagement.terms_note'] } } }); assert.deepEqual([ordinary.status, ordinary.body.applied], [200, false], 'a hand-made value is not touched by the ordinary approval'); assert.equal((await w.owner('SELECT terms_note FROM provider_services WHERE professional_id = 21'))[0].terms_note, 'ערכתי ידנית');
  const knowing = await apply(w, file, p, { rows: { 2: { apply: true, acceptManual: ['engagement.terms_note'] } } }, null, AVI); assert.equal(knowing.status, 200); assert.deepEqual((await w.owner('SELECT terms_note, updated_by FROM provider_services WHERE professional_id = 21'))[0], { terms_note: 'הערה חדשה מהקובץ', updated_by: 'import:' + AVI }); await w.pg.close();
});

test('A SERVICE TIED TO A PUBLIC PRICE keeps its topic through the import: the change is shown as blocked, approving it refuses the whole save, and even the SQL of the save would stop it', async () => {
  const w = await world(); await w.open(); await w.owner('UPDATE pricing SET public = true WHERE id = 7');
  const file = csvOf([{ domain: 'פנסיה', service: 'בדיקת זכאות להחזר מס', provider: 'דנה לבני', business: 'לבני מס', phone: '0501234567', email: 'dana@example.test', contact: 'במו"מ', agreement: 'טיוטה', activation: 'ממתין לאישור להפניה', externalId: 'TX-01', notes: 'שוחחנו בטלפון' }]);
  const p = await preview(w, file); const ch = p.rows[0].changes.find((c) => c.id === 'service.topic'); assert.deepEqual([ch.old, ch.new, ch.blocked], ['מיסים', 'פנסיה', 'service_has_public_price']);
  const before = await w.fingerprint(DATA); assert.equal(ch.manual, true, 'a service has no record of who edited it, so a change to it counts as hand-made');
  const plain = await apply(w, file, p, { rows: { 2: { apply: true, accept: ['service.topic'] } } }); assert.deepEqual([plain.status, plain.body.applied], [200, false], 'the ordinary approval does not reach it');
  const r = await apply(w, file, p, { rows: { 2: { apply: true, acceptManual: ['service.topic'] } } }); assert.deepEqual([r.status, r.body.error, r.body.refused[0].reason, r.body.refused[0].why], [422, 'rows_refused', 'change_blocked', 'service_has_public_price'], 'the separate approval meets the block'); assert.deepEqual(await w.fingerprint(DATA), before);
  const left = await apply(w, file, p, approvals(p)); assert.deepEqual([left.status, left.body.applied], [200, false], 'leaving the blocked change out is fine (nothing else to do here)');
  await assert.rejects(() => W.run(W.opStatements({ op: 'update_service', id: '11', set: { topic: 'פנסיה' } }, new Map())), (e) => e.status === 409 && e.noRows === true, 'the SQL of the save refuses it on its own'); assert.equal((await w.owner('SELECT topic FROM services WHERE id = 11'))[0].topic, 'מיסים');
  await w.owner('UPDATE pricing SET public = false WHERE id = 7'); const p2 = await preview(w, file); assert.equal(p2.rows[0].changes.find((c) => c.id === 'service.topic').blocked, undefined); assert.equal((await apply(w, file, p2, approvals(p2, { manual: true }))).body.applied, true); assert.equal((await w.owner('SELECT topic FROM services WHERE id = 11'))[0].topic, 'פנסיה'); await w.pg.close();
});

test('PRIVACY: neither the audit log nor the import log holds a name, phone, e-mail, sheet id, price or wording of the file; only the hash, counts and codes', async () => {
  const w = await world({ seed: false }); await w.open(); const p = await preview(w, F.FILE); assert.equal((await apply(w, F.FILE, p, approvals(p))).status, 200);
  const text = JSON.stringify(await w.audits()) + JSON.stringify(await w.owner('SELECT * FROM catalog_imports'));
  for (const secret of ['דנה', 'לבני', 'רועי', 'שמש', '0501234567', '0521112233', 'dana@example', 'TX-0', 'RE-01', '1,200', '1200', 'שוחחנו', 'מהחיסכון', 'הספק משלם', 'ייעוץ משכנתא']) assert.equal(text.includes(secret), false, secret);
  const bad = await preview(w, csvOf([{ service: 'שירות פרטי', provider: 'ספק פרטי', price: 'בערך אלף', externalId: 'Z-9' }, { service: 'עבודה אחרת לגמרי', provider: 'איש אחר', externalId: 'Z-8' }])); assert.equal(bad.rows[0].problems[0].code, 'price_not_numeric');
  const ok = await apply(w, 'x', bad, { rows: {} }); assert.deepEqual([ok.status, ok.body.error], [422, 'file_not_usable'], 'a file that is not a sheet is refused before anything else');
  const partial = await apply(w, csvOf([{ service: 'שירות פרטי', provider: 'ספק פרטי', price: 'בערך אלף', externalId: 'Z-9' }, { service: 'עבודה אחרת לגמרי', provider: 'איש אחר', externalId: 'Z-8' }]), bad, approvals(bad)); assert.equal(partial.status, 200); const log = JSON.stringify(await w.owner('SELECT problems FROM catalog_imports ORDER BY id DESC LIMIT 1')); assert.deepEqual(JSON.parse(log)[0].problems, [{ row: 2, code: 'price_not_numeric' }], 'the log keeps a row number and a code for a problem, nothing else');
  await w.pg.close();
});

test('FILES THAT ARE NOT WHAT THEY SHOULD BE: empty, binary-looking, broken quotes, wrong header, duplicate columns, huge cells, too many rows, too big: each answered clearly, never a server error, never a write', async () => {
  const w = await world(); await w.open(); const before = await w.fingerprint(DATA); const H = '"תחום","השירות המדויק","שם הספק"\r\n';
  const cases = [
    ['empty', '', 400, 'bad_csv'], ['spaces and breaks', '  \r\n  \n', 200, 'header_not_found'], ['only a BOM', '﻿', 200, 'header_not_found'], ['only blank lines', '\r\n\r\n\r\n', 200, 'header_not_found'], ['not a sheet', 'a,b\n1,2', 200, 'header_not_found'],
    ['unterminated quote', H + '"x","y', 200, 'unterminated_quote'], ['replacement character (not UTF-8)', H + '"x","�","z"\r\n', 200, 'bad_encoding'], ['duplicate columns', '"תחום","תחום","השירות המדויק"\r\n', 200, 'duplicate_column'], ['service column missing', '"תחום","שם הספק"\r\n"x","y"\r\n', 200, 'header_not_found'],
    ['too many rows (301)', F.csv(Array.from({ length: 301 }, (_, i) => ({ domain: 'א', service: 'שירות ' + i })), { omit: F.ORDER.filter((k) => !['domain', 'service'].includes(k)) }), 200, 'too_many_rows'],
    ['file over 1 MB', '"תחום","השירות המדויק"\r\n"x","' + 'ש'.repeat(600 * 1024) + '"\r\n', 200, 'file_too_large'], ['body over the limit', 'x'.repeat(1400000), 413, 'too_large'],
    ['header only', H, 200, null], ['NUL and control characters', H + '"מיסים","שי\u0000רות\u0007","ספק\u001f"\r\n', 200, null], ['formula-like cells', H + '"=1+1","=HYPERLINK(""http://x"",""y"")","+cmd|calc"\r\n', 200, null],
    ['one huge cell', H + '"מיסים","' + 'ש'.repeat(100000) + '","ספק"\r\n', 200, null], ['ten thousand extra cells', H + '"מיסים","שירות","ספק"' + ',"x"'.repeat(10000) + '\r\n', 200, null], ['bare CR line ends', H.replace(/\r\n/, '\r') + '"מיסים","שירות","ספק"\r', 200, null],
    ['emoji and marks', H + '"מיסים","שירות 😀 ‏‮","ספק ́"\r\n', 200, null], ['quote inside a field', H + '"מיסים","שי"רות","ספק"\r\n', 200, null],
  ];
  for (const [name, csv, status, code] of cases) {
    const r = await w.call('POST', IMPORT + '/preview', YOSI, j({ csv }));
    assert.equal(r.status, status, name + ' -> ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120)); assert.notEqual(r.status, 500, name);
    if (status === 200 && code) { assert.equal(r.body.preview.ok, false, name); assert.equal(r.body.preview.fileProblems[0].code, code, name); } else if (status === 200) assert.equal(r.body.preview.ok, true, name); else assert.equal(r.body.error, code, name);
  }
  const nul = (await w.call('POST', IMPORT + '/preview', YOSI, j({ csv: H + '"מיסים","שי\u0000רות\u0007","ספק\u001f"\r\n' }))).body.preview.rows[0]; assert.equal(nul.record.service.name, 'שירות', 'junk characters are removed, the rest is kept');
  const formula = (await w.call('POST', IMPORT + '/preview', YOSI, j({ csv: H + '"=1+1","=HYPERLINK(""http://x"",""y"")","+cmd|calc"\r\n' }))).body.preview.rows[0]; assert.equal(formula.record.service.name, '=HYPERLINK("http://x","y")', 'text is text: kept as written, never evaluated');
  assert.equal((await w.call('POST', IMPORT + '/preview', YOSI, j({ csv: H + '"מיסים","' + 'ש'.repeat(100000) + '","ספק"\r\n' }))).body.preview.rows[0].problems[0].code, 'name_too_long');
  for (const [raw, status, code] of [['not json', 400, 'bad_json'], ['[]', 400, 'bad_body'], ['{"csv":123}', 400, 'bad_csv'], ['{}', 400, 'bad_csv'], ['{"csv":"x","extra":1}', 400, 'unknown_field'], ['{"csv":"x","mappings":[]}', 400, 'bad_mappings'], ['{"csv":"x","columnMap":"y"}', 400, 'bad_column_map']]) { const r = await w.call('POST', IMPORT + '/preview', YOSI, { raw }); assert.deepEqual([r.status, r.body.error], [status, code], raw); }
  assert.deepEqual(await w.fingerprint(DATA), before, 'not one file changed anything'); await w.pg.close();
});

test('the approval is checked before anything else: wrong shapes, someone else\'s preview id, a different file, and absurd sizes are refused; the id must belong to exactly this file and this data', async () => {
  const w = await world({ seed: false }); await w.open(); const p = await preview(w, F.FILE), a = approvals(p), before = await w.fingerprint(DATA);
  const send = (body) => w.call('POST', IMPORT + '/apply', YOSI, { raw: JSON.stringify(body) });
  for (const [body, status, code] of [[{ csv: F.FILE, previewId: p.previewId }, 400, 'bad_approvals'], [{ csv: F.FILE, previewId: 'x', approvals: a }, 400, 'bad_approvals'], [{ csv: F.FILE, previewId: p.previewId, approvals: [] }, 400, 'bad_approvals'], [{ csv: F.FILE, previewId: p.previewId, approvals: { rows: [] } }, 400, 'bad_approvals'],
    [{ csv: F.FILE, previewId: p.previewId, approvals: { rows: Object.fromEntries(Array.from({ length: 401 }, (_, i) => [String(i + 2), { apply: true }])) } }, 400, 'bad_approvals'], [{ csv: F.FILE + '\r\n"x","y"', previewId: p.previewId, approvals: a }, 409, 'preview_stale'], [{ csv: F.FILE, previewId: '0'.repeat(64), approvals: a }, 409, 'preview_stale'],
    [{ csv: F.FILE, previewId: p.previewId, approvals: a, note: 'x' }, 400, 'unknown_field'], [{ csv: F.FILE, previewId: p.previewId, approvals: { rows: { 99: { apply: true } } } }, 422, 'rows_refused'], [{ csv: F.FILE, previewId: p.previewId, approvals: { rows: { 2: { apply: 'yes' } } } }, 200, undefined]]) {
    const r = await send(body); assert.equal(r.status, status, JSON.stringify(r.body).slice(0, 150)); if (code) assert.equal(r.body.error, code); }
  const none = await send({ csv: F.FILE, previewId: p.previewId, approvals: { rows: { 2: { apply: 'yes' } } } }); assert.equal(none.body.applied, false, '"apply" must be exactly true');
  assert.deepEqual(await w.fingerprint(DATA), before); const hostile = JSON.parse('{"csv":' + JSON.stringify(F.FILE) + ',"previewId":"' + p.previewId + '","approvals":{"rows":{"__proto__":{"apply":true},"constructor":{"apply":true},"2":{"apply":true,"accept":["x"],"decisions":{"__proto__":{"use":"new"}}}}}}');
  const r = await send(hostile); assert.ok([200, 422].includes(r.status), String(r.status)); assert.equal(({}).apply, undefined, 'the prototype is untouched'); await w.pg.close();
});

test('SIZE: a file at the 300-row limit against 300 existing services is previewed in a few seconds and saved in one transaction; a fresh preview then finds the saved rows unchanged', async () => {
  const w = await world({ seed: false }); await w.open();
  await w.owner("INSERT INTO services (name, topic) SELECT 'שירות קיים מספר ' || g || ' ' || md5(g::text), 'מיסים' FROM generate_series(1, 300) g");
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const word = (n) => Array.from({ length: n }, () => String.fromCharCode(0x5d0 + Math.floor(rnd() * 27))).join('');   // invented words: the names really differ from one another
  const rows = Array.from({ length: 300 }, (_, i) => ({ domain: 'מיסים', service: word(6) + ' ' + word(5) + ' ' + word(4), provider: word(5) + ' ' + word(6), business: word(7), contact: 'יצרתי קשר', agreement: 'טרם נדון', price: String(500 + (i % 40) * 25), pricingMode: 'מחיר קבוע', activation: 'ממתין', externalId: 'BIG-' + i }));
  const csv = csvOf(rows); const t0 = Date.now(); const p = await preview(w, csv); const previewMs = Date.now() - t0;
  assert.equal(p.summary.rows_total, 300); assert.ok(previewMs < 8000, 'preview took ' + previewMs + ' ms');
  const a = approvals(p), n = Object.keys(a.rows).length; assert.ok(n >= 250, 'rows without a question: ' + n);
  const t1 = Date.now(); const r = await apply(w, csv, p, a); const applyMs = Date.now() - t1; assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200)); assert.ok(applyMs < 15000, 'apply took ' + applyMs + ' ms');
  assert.equal(await w.count('provider_services'), n); assert.equal(await w.count('catalog_imports'), 1); assert.equal(w.txs.filter((t) => !t.readOnly).length, 1, 'one write transaction for the whole file');
  const q = await preview(w, csv); assert.equal(q.rows.filter((x) => x.status === 'new' && !(x.decisions || []).length && x.engagement && x.engagement.action === 'new').length, 0, 'saved rows are not offered again'); await w.pg.close();
});

test('the SHAPE of an import\'s one transaction: lock timeout, table lock, the fingerprint of what the preview read, the guard, the changes, the audit row, the log row; READ COMMITTED (so the check under the lock sees the latest data); exactly one write transaction', async () => {
  const w = await world({ seed: false }); await w.open(); const csv = csvOf([F.ROWS.fixed, F.ROWS.percent]); const p = await preview(w, csv); const fp0 = (await store.readSnapshot()).fingerprint; w.rec.length = 0; w.txs.length = 0;
  assert.equal((await apply(w, csv, p, approvals(p))).status, 200);
  const writes = w.txs.filter((t) => !t.readOnly); assert.equal(writes.length, 1, 'one write transaction'); assert.equal(writes[0].iso, 'ReadCommitted');
  const stmts = w.rec.filter((r) => r.kind === 'tx' && !r.readOnly);
  assert.equal(stmts[0].text, "SET LOCAL lock_timeout = '4000ms'"); assert.equal(stmts[1].text, 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN SHARE ROW EXCLUSIVE MODE');
  assert.match(stmts[2].text, /^SELECT set_config\('kaspchem\.expect', \$1, true\)$/); assert.equal(stmts[2].params[0], fp0, 'the fingerprint travels as a parameter and is the one of the data the preview was made from'); assert.match(stmts[3].text, /^DO \$guard\$ BEGIN IF \(SELECT md5\(/);
  assert.match(stmts[stmts.length - 2].text, /^INSERT INTO audit_log/); assert.match(stmts[stmts.length - 1].text, /^INSERT INTO catalog_imports/); assert.ok(stmts.length > 10);
  assert.ok(w.txs.filter((t) => t.readOnly).every((t) => t.iso === 'RepeatableRead'), 'the reads stay on one consistent snapshot'); await w.pg.close();
});
