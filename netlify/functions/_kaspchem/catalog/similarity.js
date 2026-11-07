'use strict';
// Catalog, pure similarity logic: which names look like the same service or the same provider. It only ever SUGGESTS. An exact match (the same name after normalisation) is the same
// thing; a near match is a question for a person. Nothing is merged, renamed or linked here, and the lists it is given are never changed.
const { nameKey } = require('./text.js');

const SIMILAR_AT = 0.7;                 // a score from 0 to 1; from here up a near match is shown to the owner as a question
const STOP = new Set(['של', 'את', 'עם', 'על', 'אל', 'או', 'גם', 'כל', 'לפי', 'מול', 'בין', 'ו', 'ה', 'the', 'of', 'and']);
const PREFIX = 'הולבכמש';              // one-letter Hebrew prefixes (the, and, in, to, like, from, that); a word starting with one of these letters may be a different word, so it is only a second chance

const tokens = (s) => nameKey(s).split(' ').filter((t) => t && !STOP.has(t));
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
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const edit = 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length);
  return Math.min(0.99, Math.max(dice(tokens(a), tokens(b)), edit));
}

// One name against a pool of { id, name, ... }: the pool items with the same normalised name, and the near ones (highest score first). Nothing is chosen for the caller.
function matchName(name, pool, opts) {
  const at = (opts && opts.at) || SIMILAR_AT, key = nameKey(name), exact = [], similar = [];
  for (const item of pool || []) {
    const s = similarity(name, item.name);
    if (s === 1 && nameKey(item.name) === key) exact.push(item);
    else if (s >= at) similar.push({ item, score: Math.round(s * 100) / 100 });
  }
  similar.sort((x, y) => y.score - x.score);
  return { key, exact, similar };
}

// A provider is known by name AND business. The same name with another business, or a near name, is a question for a person, never a match.
function matchProvider(p, pool, opts) {
  const at = (opts && opts.at) || SIMILAR_AT, nk = nameKey(p.name), bk = nameKey(p.business || '');
  const exact = [], sameNameOtherBusiness = [], similar = [];
  for (const item of pool || []) {
    const ink = nameKey(item.name), ibk = nameKey(item.business_name || item.business || '');
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
