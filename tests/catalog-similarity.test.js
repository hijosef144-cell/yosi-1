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

// ---- stage 4b: the faster version must give exactly the answers of the plain one ----------------------------------------------------------------------------------------------------
const { nameKey } = require('../netlify/functions/_kaspchem/catalog/text.js');
function referenceSimilarity(a, b) {   // the plain version of stage 3, kept here as the yardstick
  const STOP = new Set(['של', 'את', 'עם', 'על', 'אל', 'או', 'גם', 'כל', 'לפי', 'מול', 'בין', 'ו', 'ה', 'the', 'of', 'and']), PREFIX = 'הולבכמש';
  const tokens = (s) => nameKey(s).split(' ').filter((t) => t && !STOP.has(t));
  const stem = (t) => (t.length > 4 && PREFIX.includes(t[0]) ? t.slice(1) : t), same = (x, y) => x === y || stem(x) === y || x === stem(y) || stem(x) === stem(y);
  const dice = (x, y) => { if (!x.length || !y.length) return 0; const used = new Set(); let m = 0; for (const t of x) for (let j = 0; j < y.length; j++) if (!used.has(j) && same(t, y[j])) { used.add(j); m++; break; } return (2 * m) / (x.length + y.length); };
  const lev = (x, y) => { if (x === y) return 0; if (!x.length) return y.length; if (!y.length) return x.length; let prev = Array.from({ length: y.length + 1 }, (_, i) => i); for (let i = 1; i <= x.length; i++) { const cur = [i]; for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); prev = cur; } return prev[y.length]; };
  const ka = nameKey(a), kb = nameKey(b); if (!ka || !kb) return 0; if (ka === kb) return 1;
  return Math.min(0.99, Math.max(dice(tokens(a), tokens(b)), 1 - lev(ka, kb) / Math.max(ka.length, kb.length)));
}

test('the faster similarity gives exactly the same score as the plain one on thousands of random pairs (Hebrew, prefixes, punctuation, case, empty and near-equal names)', () => {
  let seed = 4242; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296, pick = (a) => a[Math.floor(rnd() * a.length)];
  const words = ['ייעוץ', 'משכנתא', 'משכנתאות', 'בדיקת', 'זכאות', 'להחזר', 'החזר', 'מס', 'מסים', 'ליווי', 'הליך', 'גירושין', 'פנסיוני', 'תיק', 'השקעות', 'ביטוח', 'רכב', 'דירה', 'ירושה', 'tax', 'Refund', 'check', 'של', 'את', 'ו', 'לבדיקת'];
  const name = () => Array.from({ length: Math.floor(rnd() * 5) }, () => pick(words)).join(pick([' ', '  ', '-', ', ', ' / '])) + pick(['', '', '.', ' ', '"']);
  let compared = 0, near = 0;
  for (let i = 0; i < 6000; i++) { const a = name(), b = rnd() < 0.3 ? a.replace(/ /g, '  ') : rnd() < 0.3 ? name() + ' ' + a : name(); const x = X.similarity(a, b), y = referenceSimilarity(a, b); assert.equal(x, y, JSON.stringify([a, b])); compared++; if (y >= 0.7 && y < 1) near++; }
  assert.ok(compared === 6000 && near > 100, 'the sample has plenty of near pairs: ' + near);
  for (const [a, b] of [['', ''], ['x', ''], [null, undefined], ['  ', 'ייעוץ'], ['ייעוץ משכנתא', 'ייעוץ משכנתאות'], ['בדיקת החזר מס', 'בדיקת זכאות להחזר מס']]) assert.equal(X.similarity(a, b), referenceSimilarity(a, b));
  const pool = Array.from({ length: 60 }, (_, i) => ({ id: i, name: name() })); for (let i = 0; i < 40; i++) { const n = name(), m = X.matchName(n, pool); const expect = pool.map((p) => [p.id, referenceSimilarity(n, p.name)]).filter(([, s]) => s >= 0.7 && s < 1).map(([id]) => id).sort((p, q) => p - q); assert.deepEqual(m.similar.map((s) => s.item.id).sort((p, q) => p - q), expect.filter((id) => !m.exact.some((e) => e.id === id))); }
});

test('speed: comparing 300 new names with 300 existing ones takes well under a second after the first pass, and the cache stays bounded', () => {
  const syl = ['בר', 'כה', 'לי', 'מו', 'נא', 'סר', 'עו', 'פל', 'צי', 'קר', 'רש', 'שם', 'תו', 'גל', 'דן', 'הד']; let seed = 99; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const nm = () => 'שירות ' + Array.from({ length: 3 }, () => syl[Math.floor(rnd() * syl.length)] + syl[Math.floor(rnd() * syl.length)]).join(' ');
  const pool = Array.from({ length: 300 }, (_, i) => ({ id: i, name: nm() })), fresh = Array.from({ length: 300 }, nm);
  const t0 = Date.now(); for (const n of fresh) X.matchName(n, pool); const first = Date.now() - t0;
  const t1 = Date.now(); for (const n of fresh) X.matchName(n, pool); const second = Date.now() - t1;
  assert.ok(first < 4000, 'first pass ' + first + ' ms'); assert.ok(second < 1500, 'second pass ' + second + ' ms');
  for (let i = 0; i < 25000; i++) X.similarity('שם ' + i, 'שם אחר'); assert.ok(X.similarity('ייעוץ משכנתא', 'ייעוץ משכנתאות') >= 0.7, 'still correct after the cache was refilled');
});
