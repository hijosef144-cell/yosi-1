'use strict';
// Catalog import, pure text helpers. Synthetic values only; no database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../netlify/functions/_kaspchem/catalog/text.js');

test('text normalisation: invisible marks, no-break spaces and runs of spaces go; names compare equal across quote styles, points and punctuation', () => {
  assert.equal(T.normText('﻿  שלום‏  עולם ‫'), 'שלום עולם'); assert.equal(T.normText(null), ''); assert.equal(T.normText(undefined), ''); assert.equal(T.normText(12), '12');
  assert.equal(T.verbatim('  8% מסכום ההחזר‏  '), '8% מסכום ההחזר', 'the wording is kept as written, only the ends and invisible marks are cleaned');
  assert.equal(T.verbatim('a   b'), 'a   b', 'verbatim keeps inner spacing');
  for (const v of ['במו״מ', 'במו"מ', 'במו\'\'מ', 'במו”מ', 'במו״מ ']) assert.equal(T.valueKey(v), 'במומ', v);
  assert.equal(T.nameKey('ייעוץ  משכנתא — בדיקה'), T.nameKey('ייעוץ משכנתא - בדיקה')); assert.equal(T.nameKey('Tax-Refund (Basic)'), 'tax refund basic'); assert.equal(T.nameKey('שָׁלוֹם'), T.nameKey('שלום'));
  assert.notEqual(T.nameKey('ייעוץ משכנתא'), T.nameKey('ייעוץ ביטוח'));
  assert.equal(T.valueKey('מחיר ₪ (שוק / לקוח)'), 'מחיר שוק לקוח'.replace(/ /g, ''));
});

test('phones: formats are normalised; a lost leading zero is restored AND marked; anything else is a problem, nothing is guessed', () => {
  const ok = (raw, value, restored) => { const r = T.normalizePhone(raw); assert.equal(r.ok, true, raw); assert.equal(r.value, value, raw); assert.equal(r.restored, restored, raw + ' restored'); return r; };
  ok('0501234567', '0501234567', false); ok('050-123-4567', '0501234567', false); ok('050 1234567', '0501234567', false); ok('(050) 123.4567', '0501234567', false);
  ok('+972501234567', '0501234567', false); ok('+972-50-123-4567', '0501234567', false); ok('972501234567', '0501234567', false); ok('00972501234567', '0501234567', false);
  ok('021234567', '021234567', false); ok('03-1234567', '031234567', false); ok('+97231234567', '031234567', false);
  ok('501234567', '0501234567', true); ok('21234567', '021234567', true); ok('31234567', '031234567', true); ok('41234567', '041234567', true); ok('81234567', '081234567', true); ok('91234567', '091234567', true);
  assert.equal(T.normalizePhone('0501234567').display, '050-1234567'); assert.equal(T.normalizePhone('031234567').display, '03-1234567');
  assert.deepEqual(T.normalizePhone(''), { ok: true, empty: true, value: null, restored: false }); assert.equal(T.normalizePhone('   ').empty, true); assert.equal(T.normalizePhone(null).empty, true);
  const bad = { '12345': 'phone_unrecognized', '5012345678': 'phone_unrecognized', '151234567': 'phone_unrecognized', '0601234567': 'phone_unrecognized', '050-1234': 'phone_unrecognized', '+14155550123': 'phone_not_israeli', '0501234567x': 'phone_has_letters', 'טלפון': 'phone_has_letters', '050+1234567': 'phone_unrecognized', '71234567': 'phone_unrecognized', '601234567': 'phone_unrecognized' };
  for (const [raw, code] of Object.entries(bad)) { const r = T.normalizePhone(raw); assert.equal(r.ok, false, raw); assert.equal(r.problem, code, raw); }
});

test('e-mail: lower-cased and checked with the database\'s own shape; empty is fine, invalid is a problem', () => {
  assert.equal(T.normalizeEmail('  Office@Example.TEST ').value, 'office@example.test'); assert.equal(T.normalizeEmail('').empty, true); assert.equal(T.normalizeEmail(undefined).empty, true);
  for (const bad of ['office', 'a@b', 'a b@c.de', '<a@c.de>', '@c.de', 'a@c.d', 'a@@c.de', 'x'.repeat(201) + '@c.de']) assert.equal(T.normalizeEmail(bad).ok, false, bad);
});

test('percentages: a % sign is explicit; a bare number is a guess (fraction up to 1, percentage above) and is marked; nothing outside 0-100 passes', () => {
  assert.deepEqual(T.parsePercent('10%'), { ok: true, value: 10, explicit: true }); assert.equal(T.parsePercent('10.0%').value, 10); assert.equal(T.parsePercent(' 2,5 % ').value, 2.5); assert.equal(T.parsePercent('100%').value, 100); assert.equal(T.parsePercent('0%').value, 0);
  const frac = T.parsePercent('0.1'); assert.equal(frac.value, 10); assert.equal(frac.flag, 'read_as_fraction'); assert.equal(frac.explicit, false);
  assert.equal(T.parsePercent('0.125').value, 12.5); assert.equal(T.parsePercent('1').flag, 'read_as_fraction'); assert.equal(T.parsePercent('1').value, 100);
  const big = T.parsePercent('10'); assert.equal(big.value, 10); assert.equal(big.flag, 'read_as_percent'); assert.equal(T.parsePercent('2.5').value, 2.5);
  assert.equal(T.parsePercent('').empty, true);
  for (const [raw, code] of [['abc', 'percent_not_numeric'], ['10 אחוז', 'percent_not_numeric'], ['101%', 'percent_out_of_range'], ['150', 'percent_out_of_range'], ['-5%', 'percent_not_numeric'], ['1e2', 'percent_not_numeric'], ['10%%', 'percent_not_numeric']]) assert.equal(T.parsePercent(raw).problem, code, raw);
});

test('money: shekel signs and thousands commas are understood; a price that is not a plain number is a problem and is never rounded', () => {
  for (const [raw, n] of [['12000', 12000], ['12,000', 12000], ['₪12,000', 12000], ['12,000 ₪', 12000], ['₪ 12,000', 12000], ['12,000.50', 12000.5], ['70', 70], ['70.5', 70.5], ['12000 ש״ח', 12000], ['12,000 שח', 12000], ['NIS 1,200', 1200], ['0', 0], ['1,234,567', 1234567]]) assert.equal(T.parseMoney(raw).value, n, raw);
  assert.equal(T.parseMoney('').empty, true);
  for (const bad of ['abc', '12,00', '1,2345', '70,5', '12.345', '12 000', '-5', '1e3', '₪', 'כ-500', '12,000,', '5%', '10-20']) assert.equal(T.parseMoney(bad).ok, false, bad);
  assert.equal(T.parseMoney('12.345').problem, 'price_not_numeric');
});

test('dates: year-month-day only; any other shape or an impossible date is a problem', () => {
  assert.equal(T.parseSourceDate('2026-11-05').value, '2026-11-05'); assert.equal(T.parseSourceDate('2026/11/5').value, '2026-11-05'); assert.equal(T.parseSourceDate('2026.1.9').value, '2026-01-09'); assert.equal(T.parseSourceDate('').empty, true);
  for (const [raw, code] of [['05/11/2026', 'date_format'], ['11-05-2026', 'date_format'], ['5 בנובמבר', 'date_format'], ['2026-13-01', 'date_invalid'], ['2026-02-30', 'date_invalid'], ['2026-00-10', 'date_invalid'], ['26-11-05', 'date_format'], ['2026-11', 'date_format']]) assert.equal(T.parseSourceDate(raw).problem, code, raw);
});

test('the helpers never change their input', () => {
  const o = Object.freeze({ toString() { return ' 050-1234567 '; } });
  assert.equal(T.normalizePhone(o).value, '0501234567');
  const s = ' x '; T.normText(s); T.nameKey(s); assert.equal(s, ' x ');
});

test('control characters (a NUL cannot be stored in a text column) are removed from cells; tab, line feed and carriage return are kept where they are meaningful', () => {
  const T = require('../netlify/functions/_kaspchem/catalog/text.js');
  assert.equal(T.normText('ש\u0000ר\u0007ות\u007F'), 'שרות'); assert.equal(T.verbatim('שורה\u0000 ראשונה\nשורה\u001f שנייה'), 'שורה ראשונה\nשורה שנייה'); assert.equal(T.nameKey('שי\u0000רות'), 'שירות');
  assert.equal(T.verbatim('א\tב\r\nג'), 'א\tב\r\nג', 'tab and line ends survive in verbatim text'); assert.equal(T.normText('א\tב'), 'א ב');
});
