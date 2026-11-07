'use strict';
// Catalog import, pure CSV reading. Synthetic text only; no files, no database, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../netlify/functions/_kaspchem/catalog/csv.js');

test('the reader handles quotes, doubled quotes, commas and line breaks inside quotes, every line end, a BOM and empty fields', () => {
  const r = C.parseCsv('a,b,c\r\n"x, y","say ""hi""",\r\n"two\nlines",,z\r\n');
  assert.deepEqual(r.problems, []); assert.deepEqual(r.rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', ''], ['two\nlines', '', 'z']]);
  assert.deepEqual(C.parseCsv('a,b\nc,d').rows, [['a', 'b'], ['c', 'd']]); assert.deepEqual(C.parseCsv('a,b\rc,d\r').rows, [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(C.parseCsv('﻿שם,עיר\nדנה,חיפה').rows, [['שם', 'עיר'], ['דנה', 'חיפה']], 'a BOM is dropped'); assert.deepEqual(C.parseCsv('a,b,\n,,\n').rows, [['a', 'b', ''], ['', '', '']]);
  assert.deepEqual(C.parseCsv('').rows, []); assert.deepEqual(C.parseCsv(null).rows, []); assert.deepEqual(C.parseCsv('\n').rows, [['']]); assert.deepEqual(C.parseCsv('x').rows, [['x']]);
  assert.deepEqual(C.parseCsv('"a"""\n').rows, [['a"']]); assert.deepEqual(C.parseCsv('"",x\n').rows, [['', 'x']]); assert.deepEqual(C.parseCsv(Buffer.from('a,ב\n')).rows, [['a', 'ב']], 'a Buffer is read as UTF-8');
  assert.deepEqual(C.parseCsv('a;b\n1;2', { delimiter: ';' }).rows, [['a', 'b'], ['1', '2']]);
});

test('a malformed file is reported with its row number and is never repaired; a file that is too big, too long or not UTF-8 is refused outright', () => {
  const u = C.parseCsv('a,b\n"open,never closed\nmore'); assert.deepEqual(u.problems, [{ code: 'unterminated_quote', row: 2 }]);
  const s = C.parseCsv('a,b\n"x"y,2\n'); assert.deepEqual(s.problems, [{ code: 'stray_text_after_quote', row: 2 }]); assert.equal(s.rows[1][0], 'xy');
  assert.equal(C.parseCsv('a,b\nx"y,2').problems.length, 0, 'a quote inside an unquoted field is just text');
  assert.deepEqual(C.parseCsv('a'.repeat(40), { maxBytes: 10 }).problems.map((p) => p.code), ['file_too_large']); assert.deepEqual(C.parseCsv('a'.repeat(40), { maxBytes: 10 }).rows, []);
  assert.equal(C.parseCsv('א'.repeat(600000)).problems[0].code, 'file_too_large', 'the limit counts BYTES (Hebrew letters take two)');
  assert.deepEqual(C.parseCsv('a\nb\nc\nd', { maxRecords: 3 }).problems.map((p) => p.code), ['too_many_rows']);
  assert.deepEqual(C.parseCsv('a,�,b').problems, [{ code: 'bad_encoding' }]);
});

const HEADER = ['תחום', 'השירות המדויק', 'שם הספק', 'מזהה שירות', 'מצב קשר', 'מצב הסכם', 'סטטוס הפעלה באתר', 'מחיר ₪ (שוק / לקוח)', 'אופן התמחור'];
test('the header row is found by name, whatever sits above it, in whatever quote style; unknown columns are listed; absent ones are reported', () => {
  const rows = [['טבלת ניסיון', '', ''], [''], HEADER, ['משכנתאות', 'ייעוץ', 'ספק א', 'AAA-1', '', '', '', '', '']];
  const h = C.detectHeader(rows); assert.equal(h.headerIndex, 2); assert.equal(h.headerNumber, 3); assert.deepEqual(h.problems, []); assert.deepEqual(h.warnings, []); assert.equal(h.columns.domain, 0); assert.equal(h.columns.price, 7); assert.equal(h.columns.pricingMode, 8);
  const odd = C.detectHeader([['‏תחום ', ' השירות  המדויק', 'שם הספק', 'מזהה שירות', 'מצב קשר', 'מצב הסכם', 'סטטוס הפעלה באתר', 'מחיר ₪ (שוק/לקוח)', 'אופן התמחור', 'עמודה חדשה']]);
  assert.equal(odd.headerIndex, 0); assert.equal(odd.columns.service, 1); assert.equal(odd.columns.price, 7, 'spacing around the slash does not matter'); assert.deepEqual(odd.unknown, [{ index: 9, text: 'עמודה חדשה' }]);
  assert.equal(C.detectHeader([['תחום', 'שירות', 'שם הספק']]).columns.service, 0 + 1, '"שירות" alone is accepted for the service column');
  const missingOptional = C.detectHeader([['תחום', 'השירות המדויק']]); assert.deepEqual(missingOptional.problems, []); assert.deepEqual(missingOptional.warnings.map((w) => w.column), ['provider', 'externalId', 'contact', 'agreement', 'activation', 'price', 'pricingMode']);
  assert.deepEqual(C.detectHeader([['תחום', 'שם הספק']]).problems.length, 1, 'no service column at all: the header is not even recognised'); assert.equal(C.detectHeader([['תחום', 'שם הספק']]).headerIndex, -1);
  assert.deepEqual(C.detectHeader([['a', 'b'], ['c', 'd']]).problems, [{ code: 'header_not_found' }]); assert.deepEqual(C.detectHeader([]).problems, [{ code: 'header_not_found' }]);
  const dup = C.detectHeader([['תחום', 'השירות המדויק', 'מצב קשר', 'מצב קשר']]); assert.deepEqual(dup.problems, [{ code: 'duplicate_column', column: 'contact', indexes: [2, 3] }]);
  const mapped = C.detectHeader([['תחום', 'השירות המדויק', 'שלב ההתקשרות']], { columnMap: { 'שלב ההתקשרות': 'contact' } }); assert.equal(mapped.columns.contact, 2, 'the owner can map a header the importer does not know');
  const farDown = Array.from({ length: 60 }, () => ['x']).concat([HEADER]); assert.equal(C.detectHeader(farDown).headerIndex, -1, 'only the first 50 rows are searched');
});

test('row objects: numbered by position, short rows padded, extra cells noticed, blank rows marked, and a column the file does not have is ABSENT (not empty)', () => {
  const rows = [HEADER, ['משכנתאות', 'ייעוץ', 'ספק א', 'A-1'], ['', '', '', '', '', '', '', '', ''], ['x', 'y', 'z', 'w', 'q', 'r', 's', 't', 'u', 'EXTRA']];
  const h = C.detectHeader(rows); const objs = C.rowObjects(rows, h);
  assert.equal(objs.length, 3); assert.deepEqual(objs.map((o) => o.rowNumber), [2, 3, 4]); assert.equal(objs[0].cells.provider, 'ספק א'); assert.equal(objs[0].cells.price, '', 'a short row is padded with empty cells'); assert.equal(objs[0].blank, false);
  assert.equal(objs[1].blank, true); assert.equal(objs[2].extra, true); assert.equal(objs[0].extra, false);
  const noPrice = C.detectHeader([['תחום', 'השירות המדויק']]); const o2 = C.rowObjects([['תחום', 'השירות המדויק'], ['a', 'b']], noPrice); assert.equal('price' in o2[0].cells, false); assert.equal(o2[0].cells.service, 'b');
  assert.deepEqual(C.rowObjects(rows, { headerIndex: -1 }), []); assert.deepEqual(C.rowObjects(rows, null), []);
});

test('a realistic export: CRLF, quoted fields with commas and shekel signs, empty trailing cells, Hebrew', () => {
  const csv = ['תחום,השירות המדויק,שם הספק,מזהה שירות,מחיר ₪ (שוק / לקוח),אופן התמחור', 'משכנתאות,"ייעוץ, בדיקה ובניית תיק",ספק א,AAA-1,"₪12,000",מחיר שוק קבוע', ',,,,,'].join('\r\n') + '\r\n';
  const r = C.parseCsv(csv); assert.deepEqual(r.problems, []); const h = C.detectHeader(r.rows); const objs = C.rowObjects(r.rows, h);
  assert.equal(objs[0].cells.service, 'ייעוץ, בדיקה ובניית תיק'); assert.equal(objs[0].cells.price, '₪12,000'); assert.equal(objs[1].blank, true);
});
