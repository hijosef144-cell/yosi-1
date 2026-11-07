'use strict';
// Catalog import, pure pricing logic. Synthetic wording and numbers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../netlify/functions/_kaspchem/catalog/pricing.js');

const cls = (price, mode, extra) => P.classifyPricing(Object.assign({ price, pricingMode: mode }, extra || {}));
const L = (r) => r.layer;

test('a fixed price: from the mixed column it is UNCLASSIFIED (never the client price), and only wording that says "market" makes it a market price; the amount is kept exactly', () => {
  let r = cls('₪12,000', 'מחיר קבוע'); assert.deepEqual(r.problems, []); assert.equal(L(r).kind, 'unclassified'); assert.equal(L(r).model, 'fixed'); assert.equal(L(r).amount, 12000); assert.equal(L(r).terms_text, 'מחיר קבוע'); assert.ok(r.flags.includes('price_unclassified'));
  r = cls('70', 'מחיר שוק קבוע'); assert.equal(L(r).kind, 'market'); assert.equal(L(r).amount, 70); assert.ok(!r.flags.includes('price_unclassified'));
  r = cls('1,400.50', 'מחיר קבוע'); assert.equal(L(r).amount, 1400.5);
  assert.equal(r.engagementModel, 'tbd', 'the engagement\'s own model stays "not set": the client price is unknown until the owner approves one');
  r = cls('500', ''); assert.equal(L(r).kind, 'unclassified'); assert.equal(L(r).model, 'fixed'); assert.ok(r.flags.includes('price_without_wording'));
  r = cls('', 'מחיר קבוע'); assert.equal(r.layer, null, 'a missing price stays missing'); assert.deepEqual(r.warnings, ['fixed_price_missing']); assert.deepEqual(r.problems, []);
  r = cls('', ''); assert.equal(r.layer, null); assert.equal(r.engagementModel, null); assert.deepEqual(r.problems, []);
});

test('percentage wordings: a single percentage, a range, a percentage with a minimum; the wording is kept verbatim; a missing base is marked, not invented', () => {
  let r = cls('', '8% מסכום ההחזר בפועל'); assert.deepEqual(r.problems, []); assert.equal(L(r).model, 'percent_of_result'); assert.equal(L(r).percent_low, 8); assert.equal(L(r).percent_high, null); assert.equal(L(r).amount, null); assert.equal(L(r).basis_missing, false); assert.equal(L(r).terms_text, '8% מסכום ההחזר בפועל'); assert.equal(r.engagementModel, 'percent_of_result');
  r = cls('', '10% ובסיס החיוב לא פורט'); assert.equal(L(r).percent_low, 10); assert.equal(L(r).basis_missing, true); assert.ok(r.flags.includes('basis_missing'));
  r = cls('', '10%'); assert.equal(L(r).basis_missing, true, 'a bare percentage names no base');
  r = cls('', '2%–2.5%'); assert.equal(L(r).model, 'percent_of_result'); assert.equal(L(r).percent_low, 2); assert.equal(L(r).percent_high, 2.5); r = cls('', '2% - 2,5% מההחזר'); assert.equal(L(r).percent_high, 2.5);
  r = cls('', '1% או 8,000 ₪ — הגבוה מביניהם'); assert.equal(L(r).model, 'percent_with_minimum'); assert.equal(L(r).percent_low, 1); assert.equal(L(r).minimum_amount, 8000); assert.equal(L(r).amount, null); assert.equal(L(r).terms_text, '1% או 8,000 ₪ — הגבוה מביניהם');
  r = cls('', '1% או 8000 ש"ח, הגבוה מביניהם'); assert.equal(L(r).minimum_amount, 8000);
  r = cls('', '5% או 3,000 ₪'); assert.equal(L(r).model, 'variable', 'without a word that says how the two combine, no rule is invented'); assert.equal(L(r).percent_low, null); assert.ok(r.flags.includes('unrecognized_pricing_text'));
  r = cls('', '5% ועוד 2% בהצלחה'); assert.equal(L(r).model, 'variable'); assert.equal(L(r).percent_low, null, 'two unrelated percentages: nothing is picked');
  r = cls('', '0% עמלה'); assert.ok(r.problems.some((p) => p.code === 'percent_out_of_range')); r = cls('', '120% מההחזר'); assert.ok(r.problems.some((p) => p.code === 'percent_out_of_range')); r = cls('', '3%-2%'); assert.ok(r.problems.some((p) => p.code === 'percent_range_reversed'));
});

test('wordings with no numbers: complexity, per-case quote, not set, and anything not understood; none of them takes the price cell\'s number', () => {
  for (const [mode, model] of [['לפי מורכבות התיק', 'variable'], ['משתנה', 'variable'], ['הצעת מחיר לפי מקרה', 'quote'], ['לפי מקרה', 'quote'], ['מחיר טרם נקבע', 'tbd'], ['לא נקבע', 'tbd'], ['נוסח חדש שלא הכרנו', 'variable']]) {
    const r = cls('', mode); assert.deepEqual(r.problems, [], mode); assert.equal(L(r).model, model, mode); assert.equal(L(r).amount, null); assert.equal(L(r).percent_low, null); assert.equal(L(r).terms_text, mode); assert.equal(L(r).kind, 'unclassified');
    const withPrice = cls('900', mode); assert.ok(withPrice.problems.some((p) => p.code === 'price_conflicts_with_mode'), mode + ' with a price'); assert.equal(withPrice.layer, null);
  }
  assert.ok(cls('', 'נוסח חדש שלא הכרנו').flags.includes('unrecognized_pricing_text'));
  assert.equal(cls('', 'מחיר שוק לפי מורכבות').layer.kind, 'market', '"market" wording makes any model a market layer');
  assert.ok(cls('300', '8% מההחזר').problems.some((p) => p.code === 'price_conflicts_with_mode'), 'a percentage wording and a price cell disagree: the owner decides');
});

test('problems block the row and are never repaired: a price that is not a number, a date in the wrong shape, text longer than the limit (not cut)', () => {
  for (const bad of ['abc', '12 000', '1,20', 'חינם', '10-20']) assert.ok(cls(bad, 'מחיר קבוע').problems.some((p) => p.code === 'price_not_numeric'), bad);
  assert.ok(cls('100', 'מחיר קבוע', { priceDate: '05/11/2026' }).problems.some((p) => p.code === 'date_format')); assert.ok(cls('100', 'מחיר קבוע', { priceDate: '2026-02-31' }).problems.some((p) => p.code === 'date_invalid'));
  const long = 'נ'.repeat(601); const r = cls('', long); assert.ok(r.problems.some((p) => p.code === 'text_too_long' && p.field === 'terms_text')); assert.equal(r.layer, null);
  assert.ok(cls('', 'ב', { priceTerms: 'ג'.repeat(600) }).problems.some((p) => p.code === 'text_too_long'), 'the wording and the clarifications together count');
  assert.ok(cls('100', 'מחיר קבוע', { priceSource: 'מ'.repeat(601) }).problems.some((p) => p.field === 'source_note'));
  const ok600 = cls('100', 'מחיר קבוע', { priceSource: 'מ'.repeat(600), priceTerms: 'ת'.repeat(100) }); assert.deepEqual(ok600.problems, []); assert.equal(L(ok600).source_note.length, 600);
});

test('source and clarifications are copied word for word: only the ends are cleaned; the date is normalised to year-month-day', () => {
  const r = cls('100', 'מחיר קבוע', { priceTerms: '  כולל מע"מ,  לא כולל חניה  ', priceSource: 'מייל מ-3.11, "אושר בטלפון"', priceDate: '2026/11/3' });
  assert.deepEqual(r.problems, []); assert.equal(L(r).terms_text, 'מחיר קבוע\nכולל מע"מ,  לא כולל חניה'); assert.equal(L(r).source_note, 'מייל מ-3.11, "אושר בטלפון"'); assert.equal(L(r).source_date, '2026-11-03');
  const absent = P.classifyPricing({ price: '100', pricingMode: 'מחיר קבוע' }); assert.equal(L(absent).source_note, null); assert.equal(L(absent).source_date, null);
});

test('the importer only ever makes market or unclassified layers, "recorded", never an offer; the layers it makes always satisfy the database checks', () => {
  const samples = [['₪12,000', 'מחיר קבוע'], ['70', 'מחיר שוק קבוע'], ['', '8% מסכום ההחזר'], ['', '2%–2.5%'], ['', '1% או 8,000 ₪ — הגבוה מביניהם'], ['', 'לפי מורכבות'], ['', 'הצעת מחיר'], ['', 'מחיר טרם נקבע'], ['', 'משהו אחר'], ['300', ''], ['', '10% ובסיס לא פורט']];
  for (const [price, mode] of samples) { const r = cls(price, mode); assert.deepEqual(r.problems, [], mode); if (r.layer) { assert.ok(['market', 'unclassified'].includes(r.layer.kind)); assert.equal(r.layer.status, 'recorded'); assert.deepEqual(P.validateLayer(r.layer), [], mode); } }
});

test('validateLayer mirrors every check of the layers table', () => {
  const base = { kind: 'market', status: 'recorded' };
  const bad = (l) => P.validateLayer(Object.assign({}, base, l));
  assert.deepEqual(bad({ model: 'fixed', amount: 5 }), []); assert.deepEqual(bad({ model: 'percent_of_result', percent_low: 5 }), []); assert.deepEqual(bad({ model: 'percent_of_result', percent_low: 5, percent_high: 8 }), []); assert.deepEqual(bad({ model: 'percent_with_minimum', percent_low: 5, minimum_amount: 100 }), []);
  for (const m of ['variable', 'quote', 'tbd']) assert.deepEqual(bad({ model: m }), []);
  assert.ok(bad({ model: 'fixed' }).length); assert.ok(bad({ model: 'fixed', amount: 5, percent_low: 1 }).length); assert.ok(bad({ model: 'fixed', amount: -1 }).length); assert.ok(bad({ model: 'percent_of_result' }).length); assert.ok(bad({ model: 'percent_of_result', percent_low: 5, amount: 5 }).length);
  assert.ok(bad({ model: 'percent_with_minimum', percent_low: 5 }).length); assert.ok(bad({ model: 'percent_of_result', percent_low: 0 }).length); assert.ok(bad({ model: 'percent_of_result', percent_low: 101 }).length); assert.ok(bad({ model: 'percent_of_result', percent_low: 8, percent_high: 5 }).length);
  for (const m of ['variable', 'quote', 'tbd']) { assert.ok(bad({ model: m, amount: 1 }).length); assert.ok(bad({ model: m, percent_low: 1 }).length); assert.ok(bad({ model: m, minimum_amount: 1 }).length); }
  assert.ok(bad({ model: 'fixed', amount: 5, status: 'awaiting_response' }).length, 'only an offer can wait'); assert.deepEqual(P.validateLayer({ kind: 'provider_offer', status: 'awaiting_response', model: 'tbd' }), []);
  assert.ok(bad({ model: 'barter' }).length); assert.ok(P.validateLayer({ kind: 'approved', model: 'fixed', amount: 1 }).length); assert.ok(bad({ model: 'tbd', terms_text: 'x'.repeat(601) }).length); assert.ok(bad({ model: 'tbd', source_note: 'x'.repeat(601) }).length);
});

test('the classifier does not change its input', () => {
  const cells = Object.freeze({ price: '₪12,000', pricingMode: 'מחיר שוק קבוע', priceTerms: 'x', priceSource: 'y', priceDate: '2026-11-03' });
  const a = P.classifyPricing(cells), b = P.classifyPricing(cells); assert.deepEqual(a, b);
});

test('everyday wordings: a range with the percent sign only on the second number, and a percent with a few words before the minimum', () => {
  const range = P.classifyPricing({ pricingMode: 'בין 5-8% מהסכום שנחסך', priceTerms: 'לפי היקף התיק' });
  assert.equal(range.layer.model, 'percent_of_result'); assert.equal(range.layer.percent_low, 5); assert.equal(range.layer.percent_high, 8); assert.equal(range.layer.amount, null); assert.equal(range.layer.basis_missing, false);
  assert.equal(range.layer.terms_text, 'בין 5-8% מהסכום שנחסך\nלפי היקף התיק', 'the wording is kept as written');
  const min = P.classifyPricing({ pricingMode: '3% מהסכום או לפחות 2,000 ₪' });
  assert.equal(min.layer.model, 'percent_with_minimum'); assert.equal(min.layer.percent_low, 3); assert.equal(min.layer.minimum_amount, 2000); assert.equal(min.layer.amount, null);
  assert.equal(P.classifyPricing({ pricingMode: '3% מהסכום או 2,000 ₪' }).layer.model, 'variable', 'no word for "minimum" or "at least": the wording is not guessed');
  assert.equal(P.classifyPricing({ pricingMode: '3% מהסכום או לפחות 2,000 ₪ ועוד 500 ₪ דמי פתיחה' }).layer.model, 'variable', 'a number the pattern does not account for: nothing is picked out of the wording');
});
