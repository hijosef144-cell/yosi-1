// One-off, idempotent patch: adds the Kaspchem nav links and homepage banner to index.html (additive only).
const fs = require('fs');
const f = require('path').join(__dirname, '..', 'index.html');
let h = fs.readFileSync(f, 'utf8');
if (h.includes('/kaspchem')) { console.log('already patched'); process.exit(0); }

const NL = String.fromCharCode(10);
const anchor = '    <!-- Services Preview -->';
if (h.split(anchor).length !== 2) throw new Error('anchors not found');
const lines = h.split(NL);
let linked = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('href="/knowledge/"') && lines[i].includes('</a>')) {
    const mobile = lines[i].includes('py-2');
    lines.splice(i + 1, 0, mobile
      ? '          <a href="/kaspchem" class="nav-link font-bold py-2 px-2 rounded-lg hover:bg-gray-50 transition" style="color:#17756c">כספכם – איתור כסף אבוד</a>'
      : '          <a href="/kaspchem" class="nav-link font-bold" style="color:#17756c">כספכם</a>');
    i++; linked++;
  }
}
if (linked !== 2) throw new Error('expected 2 nav links, got ' + linked);
h = lines.join(NL);

const banner = [
  '    <!-- כספכם – באנר קידום -->',
  '    <a href="/kaspchem" aria-label="כספכם – בדיקה קצרה לאיתור כסף אבוד" style="display:block;background:#0e3b41;color:#fff;text-decoration:none;border-top:4px solid #e3b04b">',
  '      <div class="section-container" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px 24px;padding-top:20px;padding-bottom:20px;text-align:center">',
  '        <span style="font-weight:800;font-size:1.35rem">כספכם <span style="color:#e3b04b">· מאתרים את הכסף האבוד שלכם</span></span>',
  '        <span style="opacity:.9">עשרה תחומים, כמה שאלות קצרות, תוצאה מיד.</span>',
  '        <span style="background:#e3b04b;color:#0a2a2f;font-weight:700;padding:8px 20px;border-radius:10px">לבדיקה</span>',
  '      </div>',
  '    </a>',
  '', ''].join(NL);
h = h.replace(anchor, banner + anchor);
fs.writeFileSync(f, h);
console.log('patched');
