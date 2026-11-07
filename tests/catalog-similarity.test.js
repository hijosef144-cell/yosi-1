'use strict';
// Catalog, pure similarity logic. Synthetic names only. The module only suggests: these tests also prove it never merges, renames or changes what it is given.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../netlify/functions/_kaspchem/catalog/similarity.js');

const pool = Object.freeze([
  Object.freeze({ id: 1, name: 'ייעוץ משכנתא' }), Object.freeze({ id: 2, name: 'בדיקת זכאות להחזר מס' }), Object.freeze({ id: 3, name: 'ליווי הליך גירושין' }), Object.freeze({ id: 4, name: 'ייעוץ מס' }), Object.freeze({ id: 5, name: 'ניהול תיק השקעות' }),
]);

test('the same service after normalisation (spacing, quotes, punctuation, points, case) is an EXACT match, not a suggestion', () => {
  for (const v of ['ייעוץ משכנתא', '  ייעוץ   משכנתא ', 'ייעוץ משכנתא.', 'ייעוץ-משכנתא', 'יִיעוּץ מִשְׁכַּנְתָּא', '"ייעוץ משכנתא"']) { const m = X.matchName(v, pool); assert.deepEqual(m.exact.map((i) => i.id), [1], v); assert.ok(!m.similar.some((s) => s.item.id === 1), 'an exact match is not also "similar"'); }
  assert.equal(X.similarity('Tax Refund', 'tax-refund'), 1);
});

test('near names are SUGGESTIONS with a score, highest first; different services are not suggested; a name sharing only a common word is not enough', () => {
  const plural = X.matchName('ייעוץ משכנתאות', pool); assert.deepEqual(plural.exact, []); assert.equal(plural.similar[0].item.id, 1); assert.ok(plural.similar[0].score >= X.SIMILAR_AT);
  const reorder = X.matchName('בדיקת החזר מס', pool); assert.equal(reorder.similar[0].item.id, 2, 'the same words with a Hebrew prefix and one word less'); assert.deepEqual(reorder.exact, []);
  const prefixed = X.matchName('בדיקת זכאות והחזר מס', pool); assert.equal(prefixed.similar[0].item.id, 2);
  assert.deepEqual(X.matchName('ליווי הליך גירושין ומזונות', pool).similar.map((s) => s.item.id), [3]);
  for (const unrelated of ['תכנון פנסיוני', 'הגשת ערר על ארנונה', 'ייעוץ ביטוח']) assert.deepEqual(X.matchName(unrelated, pool).similar, [], unrelated);
  assert.ok(!X.matchName('ייעוץ מס', pool).similar.some((s) => s.item.id === 1), '"ייעוץ מס" and "ייעוץ משכנתא" share only a common word');
  assert.ok(X.similarity('ייעוץ מס', 'ייעוץ משכנתא') < X.SIMILAR_AT);
  const many = X.matchName('בדיקת זכאות להחזר מסים', pool); assert.ok(many.similar.length >= 1 && many.similar.every((s, i, a) => i === 0 || a[i - 1].score >= s.score));
});

test('a service name against an empty pool, an empty name or odd input never throws and never matches', () => {
  assert.deepEqual(X.matchName('ייעוץ', []), { key: 'ייעוץ', exact: [], similar: [] }); assert.deepEqual(X.matchName('', pool).exact, []); assert.deepEqual(X.matchName('   ', pool).similar, []); assert.deepEqual(X.matchName('x', undefined).exact, []);
  assert.equal(X.similarity('', 'x'), 0); assert.equal(X.similarity(null, undefined), 0);
});

test('providers: the same name AND business is the provider; the same name with another business, or a near name, is a question', () => {
  const providers = Object.freeze([Object.freeze({ id: 1, name: 'דנה כהן', business_name: 'כהן ייעוץ' }), Object.freeze({ id: 2, name: 'משה לוי', business_name: null }), Object.freeze({ id: 3, name: 'רותם ברק', business_name: 'ברק פיננסים' })]);
  assert.deepEqual(X.matchProvider({ name: 'דנה כהן', business: 'כהן  ייעוץ' }, providers).exact.map((p) => p.id), [1]);
  const other = X.matchProvider({ name: 'דנה כהן', business: 'עסק אחר' }, providers); assert.deepEqual(other.exact, []); assert.deepEqual(other.sameNameOtherBusiness.map((p) => p.id), [1]);
  assert.deepEqual(X.matchProvider({ name: 'משה לוי', business: '' }, providers).exact.map((p) => p.id), [2], 'no business on either side is a match on the name');
  const near = X.matchProvider({ name: 'דנה כהנא', business: 'כהן ייעוץ' }, providers); assert.deepEqual(near.exact, []); assert.equal(near.similar[0].item.id, 1);
  assert.deepEqual(X.matchProvider({ name: 'שלמה אברמוביץ', business: 'משרד אחר' }, providers).similar, []);
});

test('pairs inside one list: equal names are reported as "same", near ones as "similar"; nothing is merged and the list is untouched', () => {
  const items = Object.freeze([Object.freeze({ id: 'a', name: 'ייעוץ משכנתא' }), Object.freeze({ id: 'b', name: 'ייעוץ  משכנתא' }), Object.freeze({ id: 'c', name: 'ייעוץ משכנתאות' }), Object.freeze({ id: 'd', name: 'ניהול תיק השקעות' })]);
  const r = X.suggestPairs(items); assert.deepEqual(r.same.map((p) => [p.a.id, p.b.id]), [['a', 'b']]); assert.deepEqual(r.similar.map((p) => [p.a.id, p.b.id]).sort(), [['a', 'c'], ['b', 'c']]);
  assert.equal(items.length, 4); assert.ok(Object.keys(r).every((k) => ['same', 'similar'].includes(k)), 'no "merged" or "result" field exists: the module has nothing to merge with');
  assert.equal(Object.keys(X).some((k) => /merge|link|rename/i.test(k)), false, 'the module exports no function that could merge, link or rename');
});
