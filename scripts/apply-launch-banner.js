#!/usr/bin/env node
/*
 * מוסיף (או בודק, או מסיר) את תגית הכרזה המשותפת בכל עמוד ציבורי באתר.
 *
 *   node scripts/apply-launch-banner.js            מוסיף לכל עמוד ציבורי שחסר בו
 *   node scripts/apply-launch-banner.js --check    רק מדווח (קוד יציאה 1 אם יש עמוד ציבורי בלי התגית או עמוד פנימי עם התגית)
 *   node scripts/apply-launch-banner.js --remove   מסיר את התגית מכל העמודים
 *
 * בטוח להרצה חוזרת. אחרי מיזוג ענף אחר שהוסיף עמודים או שינה את ה־<head>, אפשר פשוט להריץ שוב.
 * דפי ניהול ודפים פנימיים לא מקבלים את התגית (ראו EXCLUDED).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TAG = '<script src="/static/launch-banner.js" defer></script>';
const TAG_RE = /<script[^>]*src="\/static\/launch-banner\.js"[^>]*><\/script>[ \t]*(\r?\n)?/i;
// לא ציבורי / לא חלק מהאתר: ניהול, כספכם (כניסות מאובטחות), בדיקות, תיעוד, כלי עזר
const EXCLUDED = [/^admin\//, /^kaspchem\//, /^tests?\//, /^docs?\//, /^scripts\//, /^node_modules\//, /^test-results\//, /^db\//, /^netlify\//, /^static\/admin\//];

const root = path.resolve(__dirname, '..');
const mode = process.argv.includes('--remove') ? 'remove' : process.argv.includes('--check') ? 'check' : 'apply';

function files() {
  const out = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '*.html'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}
const isPublic = f => !EXCLUDED.some(re => re.test(f));

let changed = 0, missing = [], leaked = [];
for (const f of files()) {
  const abs = path.join(root, f);
  let src = fs.readFileSync(abs, 'utf8');
  const has = TAG_RE.test(src);
  const pub = isPublic(f);

  if (mode === 'remove') {
    if (has) { fs.writeFileSync(abs, src.replace(TAG_RE, ''), 'utf8'); changed++; console.log('removed  ', f); }
    continue;
  }
  if (!pub) { if (has) { leaked.push(f); if (mode === 'apply') { fs.writeFileSync(abs, src.replace(TAG_RE, ''), 'utf8'); changed++; console.log('removed (internal page)', f); } } continue; }
  if (has) continue;
  if (mode === 'check') { missing.push(f); continue; }

  // לפני סוף ה־head הראשון; מכבד את סוג שורת הסיום ואת ההזחה בקובץ
  const m = /(^|\n)([ \t]*)<\/head>/i.exec(src);
  let out;
  if (m) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const idx = m.index + m[1].length;
    out = src.slice(0, idx) + m[2] + TAG + eol + src.slice(idx);
  } else if (/<\/head>/i.test(src)) {
    out = src.replace(/<\/head>/i, TAG + '</head>');
  } else { console.error('NO </head>  ', f); process.exitCode = 1; continue; }
  fs.writeFileSync(abs, out, 'utf8');
  changed++; console.log('added    ', f);
}

if (mode === 'check') {
  if (missing.length) console.log('missing the banner tag:\n  ' + missing.join('\n  '));
  if (leaked.length) console.log('internal pages that have the tag:\n  ' + leaked.join('\n  '));
  console.log(missing.length || leaked.length ? 'CHECK FAILED' : 'OK: every public page has the tag, no internal page has it');
  if (missing.length || leaked.length) process.exitCode = 1;
} else {
  console.log(mode + ': ' + changed + ' file(s) changed');
}
