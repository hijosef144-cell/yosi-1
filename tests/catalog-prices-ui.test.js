'use strict';
// Stage 5b-3, the screens of the prices (admin/kaspchem/catalog-prices.js): the pure parts run in a sandbox without a browser, fed with what the real server answers; the file is also read as text. The behaviour in a
// browser (dialogs, double clicks, conflicts, four widths) is covered by tests/e2e/catalog-prices.spec.js. No network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../netlify/functions/_kaspchem/catalog/pricing.js');
const { world, closeAll, YOSI } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').split('\r\n').join('\n');
const SRC = read('admin', 'kaspchem', 'catalog-prices.js'), EDIT = read('admin', 'kaspchem', 'catalog-edit.js');
const sandbox = { window: {}, console }; vm.createContext(sandbox);
for (const f of ['catalog.js', 'catalog-edit.js', 'catalog-prices.js']) vm.runInContext(read('admin', 'kaspchem', f), sandbox);
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const RAW = sandbox.window.KaspchemCatalogPrices._t, C = sandbox.window.KaspchemCatalog._t, E = sandbox.window.KaspchemCatalogEdit._t;
const T = new Proxy(RAW, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => plain(t[k](...a)) : t[k]) });
const HEBREW = /[֐-׿]/;
const h = { ils: (n) => Number(n).toLocaleString('he-IL') + ' ₪' };

test('the rule of a layer on the screen is the rule of the server and of the database, on every combination of kind, model, state and number', () => {
  const nums = [null, 0, 10, 100, 101, -1], texts = [null, 'x', 'x'.repeat(601)];
  let n = 0;
  for (const kind of ['market', 'provider_offer', 'unclassified', 'other']) for (const model of [...P.MODELS, 'nope']) for (const status of [undefined, 'recorded', 'awaiting_response', 'received', 'declined', 'nope']) for (const amount of [null, 0, 1200, -1]) for (const low of nums) for (const high of [null, 5, 50]) for (const min of [null, 0, 600, -5]) for (const text of texts) {
    const l = { kind, model, status, amount, percent_low: low, percent_high: high, minimum_amount: min, terms_text: text, source_note: text === null ? null : 'x' };
    assert.deepEqual(T.layerProblems(l).slice().sort(), P.validateLayer(l).slice().sort(), JSON.stringify(l)); n++;
  }
  assert.ok(n > 20000, 'a large matrix was compared: ' + n);
  // every code the rule can give has words, and the box it belongs to
  const seen = new Set(); for (const model of P.MODELS) for (const amount of [null, 5, -1]) for (const low of [null, 5, 101]) for (const high of [null, 3]) for (const min of [null, -2]) for (const kind of ['market', 'provider_offer']) for (const status of ['recorded', 'awaiting_response']) P.validateLayer({ kind, model, status, amount, percent_low: low, percent_high: high, minimum_amount: min }).forEach((c) => seen.add(c));
  for (const c of ['model_unknown', 'status_unknown', 'kind_unknown', 'terms_text_too_long', 'source_note_too_long']) seen.add(c);
  for (const code of seen) { assert.ok(T.LAYER_CODE[code], 'words for ' + code); assert.match(T.LAYER_CODE[code][1], HEBREW, code); }
});

test('numbers are typed, never guessed: a decimal point, thousands in groups of three, nothing else; the boxes of the model decide what is sent; an offer alone has a state', () => {
  const ok = { '1150': 1150, '1,150': 1150, '1,150.5': 1150.5, '7.5': 7.5, ' 900 ': 900, '0': 0, '': null, '  ': null };
  for (const [s, v] of Object.entries(ok)) assert.equal(T.toNumber(s), v, JSON.stringify(s));
  for (const bad of ['1,5', '1,50', '12,34', '1.150,5', '-3', 'abc', '1e3', '₪100', '1 150', '1,,150', '.5', '5.', '٣']) assert.ok(Number.isNaN(RAW.toNumber(bad)), 'refused: ' + bad);
  const F = (kind, v) => T.layerFromForm(kind, v);
  assert.deepEqual(F('market', { model: 'fixed', amount: '1,100', percent_low: '9', percent_high: '10', minimum_amount: '5', terms_text: '  תנאים  ', status: 'received', basis_missing: true, source_note: ' אתר ', source_date: '2026-10-20' }),
    { kind: 'market', model: 'fixed', amount: 1100, percent_low: null, percent_high: null, minimum_amount: null, terms_text: 'תנאים', status: 'recorded', basis_missing: false, source_note: 'אתר', source_date: '2026-10-20' }, 'a fixed price sends the amount only; a market price has no state; no basis flag');
  const off = F('provider_offer', { model: 'percent_with_minimum', amount: '5', percent_low: '5', percent_high: '', minimum_amount: '600', status: 'awaiting_response', basis_missing: true });
  assert.deepEqual([off.amount, off.percent_low, off.percent_high, off.minimum_amount, off.status, off.basis_missing], [null, 5, null, 600, 'awaiting_response', true], 'a percentage with a minimum: no fixed amount even if one was typed; an offer keeps its state');
  for (const model of ['variable', 'quote', 'tbd']) assert.deepEqual(plain(['amount', 'percent_low', 'percent_high', 'minimum_amount'].map((k) => F('unclassified', { model, amount: '3', percent_low: '3', percent_high: '4', minimum_amount: '5', terms_text: 'לפי מקרה' })[k])), [null, null, null, null], model + ' has no numbers');
  assert.deepEqual(Object.keys(T.bodyOf(F('market', { model: 'tbd' }))), ['model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'terms_text', 'status', 'basis_missing', 'source_note', 'source_date'], 'exactly the keys the server accepts');
  const known = /const known = \[([^\]]*)\]/.exec(read('netlify', 'functions', '_kaspchem', 'admin-catalog-writes.js'))[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(Object.keys(T.bodyOf(F('market', { model: 'tbd' }))), known, 'the same keys, in the same order, as the server');
  // a form that describes the layer as it is already: no change, nothing to send
  const cur = { model: 'fixed', amount: 1200, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, status: 'recorded', basis_missing: false, source_note: null, source_date: '2026-10-20', updated_at: 'x', recorded_by: 'a' };
  assert.equal(T.sameLayer(F('market', { model: 'fixed', amount: '1200', source_date: '2026-10-20' }), cur), true); assert.equal(T.sameLayer(F('market', { model: 'fixed', amount: '1200.5', source_date: '2026-10-20' }), cur), false); assert.equal(T.sameLayer(F('market', { model: 'fixed', amount: '1200' }), cur), false, 'a date taken away is a change');
});

test('the answers of the server about a layer and about a price link are said in words, with the box they belong to; the server\'s own words never reach the screen', () => {
  const E1 = (message, status, details, userMessage) => ({ message, status, details, userMessage });
  const d = (e) => RAW.layerRefine(e, E.describe(e));
  const bad = plain(d(E1('layer_invalid', 422, { codes: ['fixed_needs_an_amount_and_nothing_else', 'minimum_needed'] }, 'SELECT secret'))); assert.deepEqual([bad.kind, bad.field], ['validation', 'amount']); assert.match(bad.message, /מחיר קבוע דורש סכום בלבד/); assert.match(bad.message, /דורש סכום מינימום/); assert.doesNotMatch(bad.message, /SELECT|_/);
  assert.deepEqual(plain(d(E1('bad_amount', 400))).field, 'amount'); assert.equal(plain(d(E1('date_format', 400))).field, 'source_date'); assert.equal(plain(d(E1('bad_source_note', 400))).field, 'source_note'); assert.equal(plain(d(E1('bad_status', 400))).field, 'status');
  assert.equal(plain(d(E1('layer_exists', 409))).kind, 'stale'); assert.equal(plain(d(E1('conflict', 409))).kind, 'conflict'); assert.equal(plain(d(E1('only_unclassified_can_be_classified', 400))).kind, 'stale');
  const pr = (e) => plain(RAW.priceRefine(e, E.describe(e)));
  assert.match(pr(E1('engagement_active', 409)).message, /ההתקשרות פעילה[^]*להשהות אותה[^]*לא נשמר דבר/); assert.match(pr(E1('price_not_eligible', 422)).message, /אינה מאושרת[^]*לא נשמר דבר/);
  for (const c of ['unknown', 'result_unknown', 'busy_retry']) assert.match(E.describe(E1(c, c === 'unknown' ? 400 : 409)).message || 'הפעולה', HEBREW);
  assert.equal(E.describe(E1('result_unknown', 502)).kind, 'unknown');
});

test('the tools of the engagement card: what each state offers, the separation of the kinds of price in words, the agreement as the owners reported it, and never an approval, a publication or a way round the working state', () => {
  const eng = (over) => Object.assign({ provider_id: 21, service_id: 11, provider_name: 'דנה', service_name: 'בדיקה', activation: 'pending', agreement_state: 'draft', terms_note: null }, over);
  const layer = { model: 'fixed', amount: 100, status: 'recorded', updated_at: '2026-11-01T00:00:00.000Z' };
  const t0 = T.toolsHtml({ engagement: eng(), price_layers: {}, approved_price: null });
  for (const text of ['רישום מחיר שוק', 'רישום הצעת הספק', 'רישום ערך שטרם סווג', 'קישור מחיר מאושר']) assert.ok(t0.includes('>' + text + '<'), text);
  for (const gone of ['סיווג הערך', 'ניתוק המחיר', 'החלפת המחיר']) assert.ok(!t0.includes(gone), 'not offered: ' + gone);
  const t1 = T.toolsHtml({ engagement: eng(), price_layers: { market: layer, provider_offer: layer, unclassified: layer }, approved_price: { id: 7, label: 'x', price: 1, approved: true, public: false } });
  for (const text of ['עריכת מחיר שוק', 'עריכת הצעת הספק', 'עריכת ערך שטרם סווג', 'סיווג הערך שטרם סווג', 'החלפת המחיר המקושר', 'ניתוק המחיר המקושר']) assert.ok(t1.includes('>' + text + '<'), text);
  const working = T.toolsHtml({ engagement: eng({ activation: 'active' }), price_layers: {}, approved_price: { id: 7, label: 'x', price: 1, approved: true, public: false } });
  assert.ok(!/data-cp="(link|unlink)"/.test(working)); assert.match(working, /ההתקשרות פעילה: כדי להחליף או לנתק את המחיר המקושר יש להשהות אותה/);
  assert.doesNotMatch(t0 + t1 + working, /data-cp="(approve|publish|unpublish|activate|delete)"|אישור ופרסום|לפרסם|להפעיל/, 'no approval, publication or activation');
  assert.match(t1, /מדווחים/); assert.match(t1, /מוצעת[^]*ואינה הסכמה/); assert.match(t1, /מאושר<\/strong> הוא רק המחיר המקושר מהלשונית ״תמחור״ שאושר שם/); assert.match(t1, /אין שדה של מחיר מוסכם נפרד/);
  const agreed = T.toolsHtml({ engagement: eng({ agreement_state: 'signed', terms_note: 'שוחחנו <b>בטלפון</b>' }), price_layers: {}, approved_price: null }); assert.match(agreed, /מצב ההסכם: חתום/); assert.match(agreed, /הערת התנאים: שוחחנו &lt;b&gt;בטלפון&lt;\/b&gt;/); assert.doesNotMatch(agreed, /<b>/);
  assert.match(agreed, /דיווח של הבעלים, לא אימות/);
});

test('every request of the module goes through the dialog kit and its allow-list; it has no way of its own to the network, no storage, no approval or publication of a price, and no automatic send', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|\beval\(|new Function|document\.write|ctx\.api\(/);
  assert.doesNotMatch(code, /\/approve|\/unpublish|\/pricing\b(?!-rows)|'DELETE'|'PATCH'|setInterval|requestAnimationFrame|autosave/i, 'it never touches the older pricing routes');
  assert.equal((code.match(/setTimeout\(/g) || []).length, 1, 'one timer: the delay of the search box');
  assert.deepEqual([...code.matchAll(/K\.write\(h, ctl, '(\w+)'/g)].map((m) => m[1]).sort(), ['POST', 'POST', 'POST', 'PUT'], 'four writes: the layer, the classification, the link, the removal of the link');
  for (const [m, p] of [['PUT', '/catalog/engagements/1/2/prices/market'], ['PUT', '/catalog/engagements/1/2/prices/provider_offer'], ['PUT', '/catalog/engagements/1/2/prices/unclassified'], ['POST', '/catalog/engagements/1/2/prices/unclassified/classify'], ['POST', '/catalog/engagements/1/2/link-price'], ['POST', '/catalog/engagements/1/2/unlink-price']]) assert.equal(E.allowed(m, p), true, m + ' ' + p);
  assert.ok(code.includes("var path = '/catalog/engagements/' + e.provider_id + '/' + e.service_id + '/prices/' + kind") || /'\/prices\/' \+ kind/.test(code), 'the layer path is built from the kind of the layer'); assert.ok(code.includes("'/link-price'") && code.includes("'/unlink-price'"));
  assert.ok(code.includes('h.get(\'/catalog/pricing-rows?service_id=') && code.includes("'/catalog/prices'"), 'the reads are the two read routes of the prices');
  // the dialog sends the version it saw (compare-and-set), and a form that changes nothing sends nothing
  assert.ok(code.includes('if (cur) body.expected_updated_at = cur.updated_at;') && code.includes('if (cur && sameLayer(l, cur))'));
  assert.ok(code.includes('expected_pricing_id: ap ? ap.id : null') && code.includes('{ expected_pricing_id: ap.id }'));
  assert.match(EDIT, /\['PUT', \/\^\\\/catalog\\\/engagements\\\/\\d\+\\\/\\d\+\\\/prices\\\/\(market\|provider_offer\|unclassified\)\$\/\]/);
  assert.ok(SRC.startsWith('/* Catalog prices, stage 5b-3'));
});

test('INTEGRATION server -> screen: the prices of the real read routes drawn by the screens, kept apart, with the approval and the fit of the linked price, and without anything confidential', async () => {
  const w = await world(); await w.open();
  await w.owner("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, status, source_note, recorded_by) VALUES (21, 11, 'provider_offer', 'percent_of_result', NULL, 8, 10, 'awaiting_response', 'שיחה <b>טלפונית</b>', 'avi@example.test'), (22, 12, 'market', 'fixed', 900, NULL, NULL, 'recorded', NULL, 'avi@example.test')");
  const list = (await w.call('GET', '/catalog/prices', YOSI)).body, rows = (await w.call('GET', '/catalog/pricing-rows', YOSI)).body;
  const by = T.byTable(list, h), rt = T.rowsTable(rows, h), text = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(by), /דנה לבני ← בדיקת זכאות להחזר מס/); assert.match(text(by), /8–10% מהתוצאה/); assert.match(text(by), /ממתין לתשובה/); assert.match(text(by), /900/); assert.match(text(by), /בדיקת החזר[^]*מאושר/); assert.doesNotMatch(by, /אינו מתאים להתקשרות/, 'a price that fits is not flagged');
  assert.match(text(rt), /בדיקת החזר/); assert.match(text(rt), /מאושר, פנימי/); assert.match(text(rt), /ממתין לאישור/); assert.match(text(rt), /כללי/); assert.match(text(rt), /1 התקשרויות/);
  assert.doesNotMatch(by + rt, /NOTE-SECRET|PAYER-SECRET|31337|41414|77\.77|commission|<b>/i);
  // the price moved by the older pricing screen: the line says it does not fit; a working engagement is counted in the rows
  await w.owner('UPDATE pricing SET service_id = 12 WHERE id = 7'); await w.owner("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11");
  const moved = T.byTable((await w.call('GET', '/catalog/prices', YOSI)).body, h); assert.match(text(moved), /אינו מתאים להתקשרות/);
  assert.match(text(T.rowsTable((await w.call('GET', '/catalog/pricing-rows', YOSI)).body, h)), /1 התקשרויות \(1 פעילות\)/);
  assert.match(T.byTable({ prices: [], total: 0, limit: 50, offset: 0 }, h) + '', /אין התקשרויות לתצוגה/); assert.match(T.rowsTable({ pricing_rows: [], total: 0 }, h), /אין שורות תמחור/);
  // the reasons a row cannot be linked
  assert.deepEqual(plain(T.whyNot({ approved: false, price: null, provider_id: 5, service_id: 12 }, { provider_id: 21, service_id: 11 })), ['לא מאושר (אישור נעשה בלשונית ״תמחור״)', 'אין בו סכום', 'של נותן שירות אחר', 'של שירות אחר']);
  assert.deepEqual(plain(T.whyNot({ approved: true, price: 3, provider_id: null, service_id: 11 }, { provider_id: 21, service_id: 11 })), []);
  assert.deepEqual([T.rowState({ public: true, approved: true }), T.rowState({ public: false, approved: true }), T.rowState({ public: false, approved: false })], ['מוצג לציבור', 'מאושר, פנימי', 'ממתין לאישור']);
});
