'use strict';
// Catalog, pure similarity logic: which names look like the same service or the same provider. It only ever SUGGESTS. An exact match (the same name after normalisation) is the
// same thing; a near match is a question for a person. Nothing is merged, renamed or linked here, and the lists it is given are never changed.
// Speed (stage 4b): the comparison key and the word list of a name are remembered (a bounded cache), and the edit distance is only computed when it could change the answer. The scores
// are exactly the ones the plain version gives (a property test compares them on thousands of random pairs).
const { nameKey } = require('./text.js');

const SIMILAR_AT = 0.7;                 // a score from 0 to 1; from here up a near match is shown to the owner as a question
const STOP = new Set(['של', 'את', 'עם', 'על', 'אל', 'או', 'גם', 'כל', 'לפי', 'מול', 'בין', 'ו', 'ה', 'the', 'of', 'and']);
const PREFIX = 'הולבכמש';              // one-letter Hebrew prefixes (the, and, in, to, like, from, that); a word starting with one of these letters may be a different word, so it is only a second chance

const CACHE = new Map(), CACHE_MAX = 20000;
function info(s) {
  const raw = String(s == null ? '' : s);
  let v = CACHE.get(raw);
  if (v === undefined) {
    const key = nameKey(raw);
    v = { key, tokens: key.split(' ').filter((t) => t && !STOP.has(t)) };
    if (CACHE.size >= CACHE_MAX) CACHE.clear();
    CACHE.set(raw, v);
  }
  return v;
}
const stem = (t) => (t.length > 4 && PREFIX.includes(t[0]) ? t.slice(1) : t);
const sameToken = (a, b) => a === b || stem(a) === b || a === stem(b) || stem(a) === stem(b);

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const used = new Set(); let m = 0;
  for (const x of a) for (let j = 0; j < b.length; j++) if (!used.has(j) && sameToken(x, b[j])) { used.add(j); m++; break; }
  return (2 * m) / (a.length + b.length);
}
function levenshtein(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
// 0..1. 1 only for names whose keys are equal.
function similarity(a, b) {
  const A = info(a), B = info(b);
  if (!A.key || !B.key) return 0;
  if (A.key === B.key) return 1;
  const d = dice(A.tokens, B.tokens), longest = Math.max(A.key.length, B.key.length);
  // the edit ratio can never be higher than 1 - |length difference| / longest; when even that cannot beat the word score, the edit distance cannot change the result
  const edit = 1 - Math.abs(A.key.length - B.key.length) / longest > d ? 1 - levenshtein(A.key, B.key) / longest : 0;
  return Math.min(0.99, Math.max(d, edit));
}

// One name against a pool of { id, name, ... }: the pool items with the same normalised name, and the near ones (highest score first). Nothing is chosen for the caller.
function matchName(name, pool, opts) {
  const at = (opts && opts.at) || SIMILAR_AT, key = info(name).key, exact = [], similar = [];
  for (const item of pool || []) {
    const s = similarity(name, item.name);
    if (s === 1 && info(item.name).key === key) exact.push(item);
    else if (s >= at) similar.push({ item, score: Math.round(s * 100) / 100 });
  }
  similar.sort((x, y) => y.score - x.score);
  return { key, exact, similar };
}

// A provider is known by name AND business. The same name with another business, or a near name, is a question for a person, never a match.
function matchProvider(p, pool, opts) {
  const at = (opts && opts.at) || SIMILAR_AT, nk = info(p.name).key, bk = info(p.business || '').key;
  const exact = [], sameNameOtherBusiness = [], similar = [];
  for (const item of pool || []) {
    const ink = info(item.name).key, ibk = info(item.business_name || item.business || '').key;
    if (ink === nk && ibk === bk) exact.push(item);
    else if (ink === nk) sameNameOtherBusiness.push(item);
    else { const s = Math.max(similarity(p.name, item.name), bk && ibk ? similarity(p.business, item.business_name || item.business) : 0); if (s >= at) similar.push({ item, score: Math.round(s * 100) / 100 }); }
  }
  similar.sort((x, y) => y.score - x.score);
  return { exact, sameNameOtherBusiness, similar };
}

// All near pairs inside one list (for a review screen). Pairs whose names are equal after normalisation are reported as `same`, near ones as `similar`.
function suggestPairs(items, opts) {
  const at = (opts && opts.at) || SIMILAR_AT, same = [], similar = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const s = similarity(items[i].name, items[j].name);
    if (s === 1) same.push({ a: items[i], b: items[j] });
    else if (s >= at) similar.push({ a: items[i], b: items[j], score: Math.round(s * 100) / 100 });
  }
  similar.sort((x, y) => y.score - x.score);
  return { same, similar };
}

module.exports = { similarity, matchName, matchProvider, suggestPairs, SIMILAR_AT };
