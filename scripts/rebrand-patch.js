// One-off: Kaspchem is a charity organization (ארגון חסד) working in partnership with מצפן כלכלי, its professional body.
// Not assumed: that it is a registered nonprofit, or who legally receives payments. Legal-entity details are a placeholder/setting.
const fs = require('fs');
const path = require('path');
const R = (f) => path.join(__dirname, '..', f);
function sub(file, from, to) {
  let s = fs.readFileSync(R(file), 'utf8');
  if (!s.includes(from)) throw new Error(file + ': not found: ' + from.slice(0, 60));
  fs.writeFileSync(R(file), s.replace(from, to));
}

// --- landing ---
sub('kaspchem/index.html',
  '<p><strong>כספכם הוא מיזם מסחרי</strong> לאיתור הזדמנויות כלכליות. הוא פועל <span id="charity">בשיתוף ארגון חסד</span>, ובגיבוי המקצועי של <a href="/">מצפן כלכלי</a>.</p>',
  '<p><strong>כספכם הוא ארגון חסד</strong> שמסייע לאתר הזדמנויות כלכליות. הוא פועל בשיתוף <a href="/">מצפן כלכלי</a>, הגוף המקצועי שמלווה אותו.</p>\n        <p id="org-details" hidden></p>');
sub('kaspchem/index.html',
  '<p>הבדיקה הראשונית באתר אינה כרוכה בתשלום. אם יוצע לכם שירות בתשלום, המחיר והתנאים יוצגו לכם לפני כל התחייבות.</p>',
  '<p><strong>הבדיקה הראשונית חינמית.</strong> שירותי המשך עשויים להיות בתשלום, בהתאם למחיר ולתנאים שיוצגו לכם לפני כל התחייבות.</p>');
sub('kaspchem/index.html',
  '<p>כספכם הוא מיזם מסחרי הפועל בגיבוי מקצועי של מצפן כלכלי. התוכן באתר כללי ואינו מהווה ייעוץ.</p>',
  '<p>כספכם הוא ארגון חסד הפועל בשיתוף מצפן כלכלי, הגוף המקצועי. התוכן באתר כללי ואינו מהווה ייעוץ.</p>\n    <p id="org-details-foot" hidden></p>');
sub('kaspchem/index.html',
  '<details><summary>האם חייבים להשאיר פרטים?</summary>',
  '<details><summary>האם זה עולה כסף?</summary><p>הבדיקה הראשונית חינמית. שירותי המשך עשויים להיות בתשלום, ואם יוצע לכם כזה, המחיר והתנאים יוצגו לכם מראש, לפני כל התחייבות.</p></details>\n      <details><summary>האם חייבים להשאיר פרטים?</summary>');

sub('kaspchem/assets/landing.js',
  "      var el = document.getElementById('charity');\n      if (c.settings && c.settings.charity_name) el.textContent = 'בשיתוף ' + c.settings.charity_name;",
  "      // Legal-entity details are shown only if an admin entered them (nothing is assumed about registration or who receives payments).\n      var d = c.settings && c.settings.org_details;\n      if (d) ['org-details', 'org-details-foot'].forEach(function (id) { var el = document.getElementById(id); if (el) { el.textContent = d; el.hidden = false; } });");

// --- legal drafts ---
sub('kaspchem/terms.html',
  '<p>כספכם הוא מיזם מסחרי לאיתור הזדמנויות כלכליות, הפועל בשיתוף ארגון חסד ובגיבוי מקצועי של מצפן כלכלי. הבדיקה הראשונית באתר היא כללית ומבוססת על כללים פשוטים ועל תשובותיכם בלבד.</p>',
  '<p>כספכם הוא ארגון חסד שמסייע לאתר הזדמנויות כלכליות, ופועל בשיתוף מצפן כלכלי, הגוף המקצועי שמלווה אותו. [פרטי הגוף המשפטי המפעיל: יושלמו לאחר קביעתם.] הבדיקה הראשונית באתר היא כללית ומבוססת על כללים פשוטים ועל תשובותיכם בלבד.</p>');
sub('kaspchem/terms.html',
  '<p>הבדיקה הראשונית אינה כרוכה בתשלום. טיפול בפנייה עשוי להיות כרוך בתמורה. המחיר והתנאים יוצגו לכם לפני כל התחייבות. [הסדרי תמורה, עמלות ושיתופי פעולה יפורטו כאן לאחר שיקבעו.]</p>',
  '<p>הבדיקה הראשונית חינמית. שירותי המשך עשויים להיות בתשלום, בהתאם למחיר ולתנאים שיוצגו לכם לפני כל התחייבות. [הגוף המקבל את התמורה, הסדרי התשלום והמסים החלים: ייקבעו בהתאם לדין ויפורטו כאן.]</p>');
sub('kaspchem/privacy.html',
  '<p>כספכם הוא מיזם מסחרי הפועל בגיבוי מקצועי של מצפן כלכלי. [פרטי בעל מסד הנתונים והאחראי על הגנת הפרטיות: יושלמו על ידי בעלי המיזם.]</p>',
  '<p>כספכם הוא ארגון חסד הפועל בשיתוף מצפן כלכלי, הגוף המקצועי. [פרטי הגוף המשפטי שהוא בעל מאגר המידע והאחראי על הגנת הפרטיות: יושלמו לאחר קביעתם.]</p>');
sub('kaspchem/privacy.html', 'המידע זמין למנהלי המיזם בלבד.', 'המידע זמין למנהלי כספכם בלבד.');
sub('kaspchem/privacy.html', '[תקופת שמירה: תוגדר על ידי בעלי המיזם.]', '[תקופת שמירה: תוגדר על ידי כספכם.]');

// --- docs ---
sub('docs/KASPCHEM.md',
  '5. Settings → charity name (only with the organization\'s approval).',
  '5. Settings → legal-entity details (optional free text, shown on the public page only if filled; enter only after the legal structure and who receives payments are confirmed).\n\nBranding: Kaspchem is a charity organization (ארגון חסד) working in partnership with מצפן כלכלי, its professional body. Do not describe it as a commercial venture or as a registered nonprofit until that is confirmed. Pricing/revenue tooling stays: a charity may charge for follow-up services.');
console.log('rebrand applied');
