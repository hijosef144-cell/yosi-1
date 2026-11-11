'use strict';
// The dry run of the sheet import (scripts/catalog-dry-run.js): the owner's own computer, one csv file, no database, no network, no file written, and no contact detail in what it prints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const D = require('../scripts/catalog-dry-run.js');
const ROOT = path.join(__dirname, '..'), TWIN = path.join(__dirname, 'fixtures', 'catalog-sheet-structure-twin.csv'), SHAPE = path.join(__dirname, 'fixtures', 'catalog-sheet-real-shape.csv');
const text = (r) => r.lines.join('\n');

test('THE TWIN: the numbers the owner will see: 3 providers, 22 services, 21 engagements, 21 reported prices; 15 phones to confirm (the rows), one question, one row without a provider, 3 market prices and 18 to classify, the commission not read', () => {
  const r = D.main([TWIN]), t = text(r); assert.equal(r.code, 0);
  assert.match(t, /27 שורות עם תוכן: 22 חדשות, 5 דולגו \(שורות ממלאות\), 0 בעיות/); assert.match(t, /3 נותני שירות, 22 שירותים, 21 התקשרויות, 21 מחירים מדווחים \(18 לא מסווג \(מדווח בלבד\), 3 מחיר שוק\)/);
  assert.match(t, /אישור טלפון \(15 שורות\): 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21, 22, 23, 24\./); assert.match(t, /שורות 10\)/); assert.match(t, /שורות של שירות בלי נותן שירות \(ייווצר שירות בלבד\): 26/);
  assert.match(t, /3 נקראו כמחיר שוק[\s\S]*18 נשארים "לא מסווג/); assert.match(t, /עמלה: 22 שורות כוללות נתוני עמלה\. הם אינם נקלטים/);
  assert.match(t, /2 עסקים \(פנימי\)/); assert.match(t, /3 חיסכון והשקעות \(פנימי\)/);
  assert.match(t, /כל שירות ייווצר כבוי, כל התקשרות ממתינה לאישור \(אף אחת לא פעילה או חתומה\)/);
});

test('NO CONTACT DETAIL is ever printed: no provider name, business, phone, e-mail or sheet id, with or without the price worksheet; the worksheet names the services and the wording of the prices, which are not contact details', () => {
  for (const file of [TWIN, SHAPE]) for (const args of [[], ['--prices']]) {
    const t = text(D.main([file].concat(args)));
    for (const secret of ['אביגיל רוזנטל', 'בנימין שחר', 'גילי מרום', 'מורשה ראשון', 'יועצת', 'משרד שלישי', '500000101', '0500000101', '0500000202', '500000303', '0500000011', '0500000022', 'twin-a@', 'twin-b@', 'twin-c@', 'demo-dm-', '@example', 'TW-0', 'DM-0', 'https://example.test']) assert.equal(t.includes(secret), false, path.basename(file) + ' ' + args.join(' ') + ' printed ' + secret);
  }
  const t = text(D.main([TWIN, '--prices'])); assert.match(t, /גיליון עבודה למחירים/); assert.match(t, /\[דמו\] מחזור משכנתא פנימי/); assert.match(t, /1% או 8,000/);
  assert.ok(!/גיליון עבודה למחירים/.test(text(D.main([TWIN]))), 'the worksheet only with --prices');
});

test('THE STRUCTURE OF THE REAL SHEET (invented data): the same kinds of answers, no write, and the safety sentence', () => {
  const r = D.main([SHAPE]), t = text(r); assert.equal(r.code, 0); assert.match(t, /15 חדשות, 7 דולגו/); assert.match(t, /אישור טלפון \(9 שורות\)/); assert.match(t, /לא נכתב דבר, לא נפתח חיבור לשום מסד נתונים/); assert.match(t, /זו בדיקה בלבד/);
});

test('BAD INPUT is answered in plain words and never crashes: no file, two files, an unknown option, an empty file, a file that is not the sheet', () => {
  assert.equal(D.main([]).code, 2); assert.equal(D.main([TWIN, SHAPE]).code, 2); assert.equal(D.main([TWIN, '--write']).code, 2); assert.equal(D.main([path.join(os.tmpdir(), 'no-such-file-' + Date.now() + '.csv')]).code, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-')), empty = path.join(dir, 'empty.csv'), other = path.join(dir, 'other.csv'); fs.writeFileSync(empty, ''); fs.writeFileSync(other, 'a,b,c\n1,2,3\n');
  for (const f of [empty, other]) { const r = D.main([f]); assert.equal(r.code, 1); assert.match(text(r), /הקובץ אינו שמיש/); assert.match(text(r), /UTF-8/); }
});

test('IT TOUCHES NOTHING: the tool loads no database module and no driver, writes no file, and the file it reads is left byte for byte as it was', () => {
  const r = spawnSync(process.execPath, ['-e', "const D = require('./scripts/catalog-dry-run.js'); D.main(['tests/fixtures/catalog-sheet-structure-twin.csv']); console.log(JSON.stringify(Object.keys(require.cache).filter((k) => /[\\/]db\.js$|neondatabase|pglite|nodemailer|ops-alert|admin-/.test(k))))"], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim().split('\n').pop(), '[]', 'no database, driver, mail or admin module was loaded');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'catalog-dry-run.js'), 'utf8'); assert.ok(!/writeFile|appendFile|createWriteStream|unlink|rmSync|child_process|fetch\(|https?\.request|net\.|process\.env/.test(src), 'the source writes nothing, starts nothing, sends nothing and reads no environment');
  const before = fs.readFileSync(TWIN); D.main([TWIN, '--prices']); assert.ok(before.equals(fs.readFileSync(TWIN)));
});
