// Rewrites the admin settings() view: structure panel (read-only), launch gate, optional legal-entity details.
const fs = require('fs');
const f = require('path').join(__dirname, '..', 'admin', 'kaspchem', 'admin.js');
let s = fs.readFileSync(f, 'utf8');
const NL = s.includes('\r\n') ? '\r\n' : '\n';
const a = s.indexOf('  function settings() {');
const b = s.indexOf('  function audit() {');
if (a < 0 || b < 0) throw new Error('markers');
const fn = [
"  function settings() {",
"    api('GET', '/settings').then(function (r) {",
"      var cur = {}; r.settings.forEach(function (s) { cur[s.key] = s.value; });",
"      view.innerHTML = H('הגדרות') +",
"        '<div class=\"panel\"><h2 style=\"margin-bottom:.6rem\">מיתוג ומבנה</h2><p><strong>כספכם</strong> מוצג לציבור כארגון חסד, בשיתוף <strong>מצפן כלכלי</strong> כגוף המקצועי. הבדיקה הראשונית חינמית, ושירותי המשך עשויים להיות בתשלום לפי מחיר ותנאים שמוצגים מראש. לא נקבע באתר אם כספכם עמותה רשומה ומי הגוף שמקבל את התשלום, ולכן אין לציין זאת עד שיוכרע.</p></div>' +",
"        '<div class=\"panel\"><h2 style=\"margin-bottom:.6rem\">פתיחה לציבור</h2><p class=\"warn\">כל עוד זה כבוי, האתר מציג שאלונים ותוצאות אך אינו מקבל פניות. הפעילו רק לאחר שעורך דין אישר את מדיניות הפרטיות, תנאי השימוש ונוסח ההסכמות, והחלפתם את הטיוטות בדפים.</p><label style=\"display:flex;gap:.6rem;font-weight:700\"><input type=\"checkbox\" id=\"la\"' + (cur['public.legal_approved'] === true ? ' checked' : '') + '> הנוסחים המשפטיים אושרו, אפשר לקבל פניות</label></div>' +",
"        '<div class=\"panel\"><h2 style=\"margin-bottom:.6rem\">פרטי הגוף המשפטי (רשות)</h2><p>טקסט חופשי שיוצג בעמוד הציבורי ובתחתיתו, למשל שם הגוף ומספר רישום. מלאו רק לאחר שהמבנה המשפטי אושר. ריק = לא מוצג דבר.</p><div class=\"row\"><div><label for=\"od\">פרטים להצגה</label><textarea id=\"od\" maxlength=\"300\">' + esc(cur['public.org_details'] || '') + '</textarea></div><div><button class=\"btn\" id=\"ods\">שמירה</button></div></div></div>';",
"      document.getElementById('la').onchange = function (e) { if (e.target.checked && !confirm('לאשר שהנוסחים המשפטיים אושרו ולפתוח לקבלת פניות?')) { e.target.checked = false; return; } api('PUT', '/settings', { key: 'public.legal_approved', value: e.target.checked }).then(function () { toast(e.target.checked ? 'האתר מקבל פניות' : 'קבלת פניות כבויה'); }).catch(fail); };",
"      document.getElementById('ods').onclick = function () { api('PUT', '/settings', { key: 'public.org_details', value: od.value.trim() }).then(function () { toast('נשמר'); }).catch(fail); };",
"    }).catch(fail);",
"  }",
"",
""].join(NL);
s = s.slice(0, a) + fn + s.slice(b);
fs.writeFileSync(f, s);
console.log('admin settings rewritten');
