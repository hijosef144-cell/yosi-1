'use strict';
// Catalog import, pure helpers: text normalisation and the parsing of the values a spreadsheet export contains (phones, e-mail, percentages, money, dates).
// No input/output of any kind: no database, no network, no files. Every function returns a value and never changes its input.

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿­]/g;     // zero-width and bidi marks: invisible in a cell, but they break comparisons
const NIQQUD = /[֑-ׇ]/g;                                                // Hebrew points and cantillation
const QUOTES = /["'`׳״‘’‚‛“”„‟′″]/g;   // straight and curly quotes, geresh, gershayim

// Cell text as a person reads it: invisible marks removed, no-break spaces turned into spaces, runs of white space collapsed, ends trimmed.
function normText(s) {
  return String(s == null ? '' : s).replace(INVISIBLE, '').normalize('NFC').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Text kept word for word (the provider's own wording): only the invisible marks and the ends are cleaned.
function verbatim(s) { return String(s == null ? '' : s).replace(INVISIBLE, '').trim(); }

// A comparison key for names: no points, no quotes, no punctuation, one space between words, Latin letters in lower case. "במו״מ" and "במו"מ" give the same key.
function nameKey(s) {
  return normText(s).toLowerCase().replace(NIQQUD, '').replace(QUOTES, '').replace(/[\-–—־_/\\.,;:!?()[\]{}|*+=<>~^#@&%$₪]/g, ' ').replace(/\s+/g, ' ').trim();
}
// The same idea for a value from a closed list (header names, "מצב קשר" values): no spaces at all.
function valueKey(s) { return nameKey(s).replace(/ /g, ''); }

// ---- phones ---------------------------------------------------------------------------------------------------------------------------------------------------
// Israeli numbers. A spreadsheet that stores a phone as a NUMBER loses the leading zero, so a 9-digit mobile (starts with 5) or an 8-digit landline (starts with 2, 3, 4, 8 or 9)
// gets its zero back and is marked "restored" for the owner to confirm. Any other shape is a problem: nothing is guessed.
function normalizePhone(raw) {
  const text = normText(raw);
  if (!text) return { ok: true, empty: true, value: null, restored: false };
  if (/[A-Za-z֐-׿]/.test(text.replace(/^\+/, ''))) return { ok: false, problem: 'phone_has_letters' };
  let d = text.replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(d)) return { ok: false, problem: 'phone_unrecognized' };
  let restored = false;
  if (d.startsWith('+972')) d = '0' + d.slice(4);
  else if (d.startsWith('00972')) d = '0' + d.slice(5);
  else if (d.startsWith('972') && (d.length === 11 || d.length === 12)) d = '0' + d.slice(3);
  else if (d.startsWith('+')) return { ok: false, problem: 'phone_not_israeli' };
  if (!d.startsWith('0')) {
    if (d.length === 9 && d[0] === '5') { d = '0' + d; restored = true; }
    else if (d.length === 8 && /^[23489]/.test(d)) { d = '0' + d; restored = true; }
    else return { ok: false, problem: 'phone_unrecognized' };
  }
  const mobile = /^05\d{8}$/.test(d), landline = /^0[23489]\d{7}$/.test(d);
  if (!mobile && !landline) return { ok: false, problem: 'phone_unrecognized' };
  return { ok: true, value: d, restored, display: mobile ? d.slice(0, 3) + '-' + d.slice(3) : d.slice(0, 2) + '-' + d.slice(2) };
}

// ---- e-mail ---------------------------------------------------------------------------------------------------------------------------------------------------
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;   // the same shape the database check accepts
function normalizeEmail(raw) {
  const t = normText(raw).toLowerCase();
  if (!t) return { ok: true, empty: true, value: null };
  if (t.length > 200 || !EMAIL.test(t)) return { ok: false, problem: 'email_invalid' };
  return { ok: true, value: t };
}

// ---- percentages ----------------------------------------------------------------------------------------------------------------------------------------------
// "10%" and "10.0%" are percentages. A bare number up to 1 is read as a fraction (0.1 is 10%) and a bare number above 1 as a percentage (10 is 10%): both are marked for the
// owner to confirm, because a bare number is a guess. The result is in percent units.
function parsePercent(raw) {
  const t = normText(raw).replace(/٪/g, '%');
  if (!t) return { ok: true, empty: true, value: null };
  const m = /^(\d+(?:[.,]\d+)?)\s*(%)?$/.exec(t);
  if (!m) return { ok: false, problem: 'percent_not_numeric' };
  const n = Number(m[1].replace(',', '.'));
  if (m[2]) return n >= 0 && n <= 100 ? { ok: true, value: n, explicit: true } : { ok: false, problem: 'percent_out_of_range' };
  if (n <= 1) return { ok: true, value: Math.round(n * 1e6) / 1e4, explicit: false, flag: 'read_as_fraction' };
  return n <= 100 ? { ok: true, value: n, explicit: false, flag: 'read_as_percent' } : { ok: false, problem: 'percent_out_of_range' };
}

// ---- money ----------------------------------------------------------------------------------------------------------------------------------------------------
// "12000", "12,000", "₪12,000", "12,000 ₪", "12,000.50", "12000 ש״ח". A comma is a thousands separator only in groups of three; anything else that is not a plain number is a
// problem (a price is never guessed or rounded).
function parseMoney(raw) {
  let t = normText(raw);
  if (!t) return { ok: true, empty: true, value: null };
  t = t.replace(/₪|ש"?ח|ש״ח|שח|nis|ils/gi, ' ').trim();   // a currency sign may stand around the number, but a space INSIDE the number ("12 000") is not accepted
  if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(t)) return { ok: false, problem: 'price_not_numeric' };
  const n = Number(t.replace(/,/g, ''));
  if (!(n >= 0) || n > 9999999999.99) return { ok: false, problem: 'price_out_of_range' };
  return { ok: true, value: n };
}

// ---- dates ----------------------------------------------------------------------------------------------------------------------------------------------------
// Year-month-day only (2026-11-05, also with / or .). Day-first and month-first dates look alike, so they are a problem, never a guess.
function parseSourceDate(raw) {
  const t = normText(raw);
  if (!t) return { ok: true, empty: true, value: null };
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (!m) return { ok: false, problem: 'date_format' };
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false, problem: 'date_invalid' };
  return { ok: true, value: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0') };
}

module.exports = { normText, verbatim, nameKey, valueKey, normalizePhone, normalizeEmail, parsePercent, parseMoney, parseSourceDate, INVISIBLE };
