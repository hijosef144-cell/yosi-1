// Builds docs/research/scenarios-v6 from scenarios-v5: migrates the tax-refunds answers to the v6 question ids (work grant per tax year),
// adjusts the five life-insurance-duplicate scenarios to the owner's decision (duplicate check = health insurance only),
// and adds the dedicated work-grant tests for tax years 2024 and 2025 (regression item 7) plus copy guards for decisions 3, 4, 6.
// Usage: node scripts/make-scenarios-v6.js   (requires drafts-v6 built by patch-v6.js + assemble-v6.js)
const fs = require('fs'); const path = require('path');
const E = require('../kaspchem/assets/engine.js');
const root = path.join(__dirname, '..', 'docs', 'research');
const src = path.join(root, 'scenarios-v5'); const dst = path.join(root, 'scenarios-v6');
fs.mkdirSync(dst, { recursive: true });
const all = JSON.parse(fs.readFileSync(path.join(root, 'drafts-v6', 'ALL-v6.draft.json'), 'utf8'));
const tax = all.topics.find((t) => t.id === 'tax-refunds');
const G = ['tx-grant-2024', 'tx-grant-2025'];
const INC = { low: 'i1', lowmid: 'i2', mid: 'i3', high: 'i5' };
const INC_OVERRIDE = { 'rg2-f4': 'i4', 'rg2-f5': 'i4' };
const SHAPES = ['kids12', 'kids3', 'single', 'age55', 'adjwage'];
const repl = (arr) => (arr || []).reduce((o, id) => o.concat(id === 'tx-grant' ? G : [id]), []);

function migrateTax(s) {
  const a = s.answers; if (!a || !a.grantfam) return;
  const tod = a.grantfam.includes('toddler');
  a.grantfam = a.grantfam.filter((x) => x !== 'toddler');
  if (a.grantfam.some((x) => SHAPES.includes(x))) {
    a.grantyrs = ['y24', 'y25'];
    if (a.grantfam.some((x) => ['kids12', 'kids3', 'single'].includes(x))) a.todyr = tod ? ['b24'] : ['none'];
  }
  if (a.inc === 'nowork') { a.grantyrs = ['none']; delete a.inc; delete a.todyr; }
  else if (a.inc) a.inc = INC_OVERRIDE[s.id] || INC[a.inc] || a.inc;
  s.answers = E.pruneAnswers(tax, a);
  if (s.expect) ['mustInclude', 'mustNotInclude', 'exactFindings'].forEach((k) => { if (s.expect[k]) s.expect[k] = repl(s.expect[k]); });
  s.v6Note = 'answers migrated to the v6 work-grant questions (grantyrs both years; toddler = born 2024; income bands in NIS)';
}

// life-insurance duplicates are no longer flagged (owner decision 4: health only)
const LIFE_ONLY = {
  'ip-01': (s) => { s.expect = { outcome: 'none', mustNotInclude: ['ip-dup'] }; },
  'ip-11': (s) => { s.expect.mustInclude = (s.expect.mustInclude || []).filter((x) => x !== 'ip-dup'); s.expect.exactFindings = (s.expect.exactFindings || []).filter((x) => x !== 'ip-dup'); s.expect.mustNotInclude = ['ip-dup']; },
  'ip-v4-02': (s) => { s.expect = { outcome: 'none', mustNotInclude: ['ip-dup'] }; },
  'rg4-s2': (s) => { s.expect = { outcome: 'none', mustNotInclude: ['ip-dup'] }; s.role = 'false-alarm-guard'; },
  'rg4-m3': (s) => { s.expect = { outcome: 'insufficient', mustNotInclude: ['ip-dup'] }; s.role = 'false-alarm-guard'; }
};

const files = fs.readdirSync(src).filter((f) => f.endsWith('.json'));
let migrated = 0, lifeFixed = 0;
files.forEach((f) => {
  const arr = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
  arr.forEach((s) => {
    if (s.topic === 'tax-refunds' && s.answers && s.answers.grantfam) { migrateTax(s); migrated++; }
    else if (s.topic === 'tax-refunds' && s.expect) ['mustInclude', 'mustNotInclude', 'exactFindings'].forEach((k) => { if (s.expect[k]) s.expect[k] = repl(s.expect[k]); });
    if (LIFE_ONLY[s.id]) { LIFE_ONLY[s.id](s); s.v6Note = 'owner decision 4: duplicate-cover check is health insurance only; life-insurance overlap is no longer a finding'; lifeFixed++; }
  });
  fs.writeFileSync(path.join(dst, f.replace('-v5', '-v6')), JSON.stringify(arr, null, 2));
});

// the blind (independently written) scenarios get the same answer migration
{
  const arr = JSON.parse(fs.readFileSync(path.join(root, 'scenarios-blind', 'S1-v5.json'), 'utf8'));
  arr.forEach((s) => { if (s.topic === 'tax-refunds' && s.answers && s.answers.grantfam) migrateTax(s); else if (s.topic === 'tax-refunds' && s.expect) ['mustInclude', 'mustNotInclude', 'exactFindings'].forEach((k) => { if (s.expect[k]) s.expect[k] = repl(s.expect[k]); }); if (LIFE_ONLY[s.id]) LIFE_ONLY[s.id](s); });
  fs.writeFileSync(path.join(root, 'scenarios-blind', 'S1-v6.json'), JSON.stringify(arr, null, 2));
}

// ---------- dedicated work-grant tests (item 7) ----------
const base = { kind: ['emp'], events: ['none'] };
const mk = (id, role, title, answers, expect, why, extra) => Object.assign({ id, item: 7, role, topic: 'tax-refunds', title, kind: expect.outcome === 'found' ? 'opportunity' : 'none', answers: E.pruneAnswers(tax, Object.assign({}, base, answers)), expect, why, source: 'Tax Authority work-grant guides: https://taxes2024.mag.calltext.co.il/pages/65 and https://taxes2025.mag.calltext.co.il/pages/65 (read 2026-11-01)' }, extra || {});
const noAmounts = ['10,080', '10,260', '₪ ?490', '₪ ?500', 'מגיע לכם', 'אתם זכאים', 'פי שניים', 'כפול שכר'];
const W = [
  mk('wg-24-only', 'success', 'זוג (בדיוני) עם שני ילדים בני 7 ו-10, האב עבד רק בשנת 2024 בשכר נמוך', { grantfam: ['kids12'], grantyrs: ['y24'], todyr: ['none'], inc: 'i1' }, { outcome: 'found', exactFindings: ['tx-grant-2024'] }, 'בשנת המס 2024 הוא עבד, בטווח הכנסה נמוך לבעל משפחה; בשנת 2025 לא עבד, ולכן אין כלל לשנת 2025. בקשה לשנת 2024 אפשרית עד 31.12.2026.'),
  mk('wg-25-only', 'success', 'אם חד-הורית (בדיונית) לשני ילדים שהתחילה לעבוד רק ב-2025, שכר בינוני-נמוך', { grantfam: ['kids12', 'single'], grantyrs: ['y25'], todyr: ['none'], inc: 'i3' }, { outcome: 'found', exactFindings: ['tx-grant-2025'] }, 'הורה יחיד: תקרת ההכנסה הגבוהה ביותר במדריך. עבדה רק ב-2025, ולכן כלל 2025 בלבד.'),
  mk('wg-both-years', 'success', 'זוג (בדיוני) עם שלושה ילדים, עבדו בשתי השנים בשכר נמוך', { grantfam: ['kids3'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i1' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'עבד בשתי שנות המס, בטווח הנמוך: שני ממצאים נפרדים, אחד לכל שנה, כי מבקשים לכל שנה בנפרד.'),
  mk('wg-toddler-2022-24only', 'success', 'זוג (בדיוני) עם שני ילדים, אחד נולד ב-2022; האב עבד ב-2024 וב-2025 בשכר ממוצע של כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['b22'], inc: 'i2' }, { outcome: 'found', exactFindings: ['tx-grant-2024'], mustNotInclude: ['tx-grant-2025'] }, 'ילד שנולד ב-2022 הוא פעוט (מתחת ל-3) בשנת המס 2024 בלבד: בשנה שבה מלאו לו שנתיים. בשנת 2025 מלאו לו 3 והוא אינו פעוט. תקרת ההכנסה להורה לפעוט בשנת 2024 (כ-8,582 ₪) גבוהה מהרגיל, ולכן הכנסה כזו עשויה להיכלל רק בשנת 2024.'),
  mk('wg-toddler-2023-both', 'success', 'זוג (בדיוני) עם שני ילדים, אחד נולד ב-2023; עבדו בשתי השנים, שכר כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['b23'], inc: 'i2' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'ילד שנולד ב-2023 הוא פעוט בשתי השנים (שנה שבה מלאה לו שנה ב-2024, ושנתיים ב-2025).'),
  mk('wg-toddler-2025-born', 'success', 'זוג (בדיוני) עם שני ילדים, אחד נולד ב-2025; עבדו ב-2025 בלבד, שכר כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y25'], todyr: ['b25'], inc: 'i2' }, { outcome: 'found', exactFindings: ['tx-grant-2025'] }, 'בשנת הלידה הילד נחשב פעוט.'),
  mk('wg-toddler-3kids', 'success', 'זוג (בדיוני) עם שלושה ילדים, אחד נולד ב-2024; שכר כ-9,000 ₪ בשתי השנים', { grantfam: ['kids3'], grantyrs: ['y24', 'y25'], todyr: ['b24'], inc: 'i2' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'שלושה ילדים בהם פעוט: התקרה כ-9,243 (2024) ו-9,462 (2025), מעל 9,000.'),
  mk('wg-adjusted-wage', 'success', 'עובד (בדיוני) בן 35 בלי ילדים עם שכר מינימום מותאם, שכר נמוך בשתי השנים', { grantfam: ['adjwage'], grantyrs: ['y24', 'y25'], inc: 'i1' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'עובד עם שכר מינימום מותאם זכאי לבדיקה גם בלי ילד.'),
  mk('wg-age55', 'success', 'נורית (בדיונית), בת 58, בלי ילדים, שכר נמוך בשתי השנים', { grantfam: ['age55'], grantyrs: ['y24', 'y25'], inc: 'i1' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'גיל 55 ומעלה מזכה בבדיקה גם בלי ילדים.'),
  mk('wg-single-3kids-high', 'miss-guard', 'אם חד-הורית (בדיונית) לארבעה ילדים, שכר ממוצע כ-12,500 ₪', { grantfam: ['kids3', 'single'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i4' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'הורה יחיד עם שלושה ילדים ומעלה: התקרה כ-13,340 (2024) וכ-13,660 (2025).'),
  mk('wg-self-employed', 'miss-guard', 'עצמאית (בדיונית) עם שני ילדים, רואה חשבון מגיש את הדוחות, הכנסה נמוכה בשתי השנים', { kind: ['self'], selffile: 'acct', grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i1' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'המענק ניתן לשכירים ולעצמאים.'),
  mk('wg-unknown-income', 'miss-guard', 'אב לשניים (בדיוני) שאינו יודע להעריך את השכר הממוצע שלו', { grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'unk' }, { outcome: 'found', exactFindings: ['tx-grant-2024', 'tx-grant-2025'] }, 'הבדיקה הרשמית חינמית; אי אפשר להוציא את המשפחה מהבדיקה בלי נתון.'),
  mk('wg-high-income', 'false-alarm-guard', 'זוג (בדיוני) עם שני ילדים, שכר ממוצע כ-16,000 ₪', { grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i5' }, { outcome: 'none', mustNotInclude: G }, 'מעל כל תקרות ההכנסה שבמדריכים לכל סוגי המשפחות, בשתי השנים.'),
  mk('wg-couple-mid-no-toddler', 'false-alarm-guard', 'זוג (בדיוני) עם שני ילדים בני 6 ו-9, שכר ממוצע כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i2' }, { outcome: 'none', mustNotInclude: G }, 'תקרת ההכנסה לזוג עם 1-2 ילדים כ-7,220 (2024) וכ-7,289 (2025). רק הורה לפעוט מגיע לכ-8,582 או כ-8,781, ולכן אין סימן.'),
  mk('wg-single-1-2kids-over', 'false-alarm-guard', 'אב חד-הורי (בדיוני) לשני ילדים, שכר ממוצע כ-12,500 ₪', { grantfam: ['kids12', 'single'], grantyrs: ['y24', 'y25'], todyr: ['none'], inc: 'i4' }, { outcome: 'none', mustNotInclude: G }, 'תקרת הורה יחיד עם 1-2 ילדים כ-10,930 (2024) וכ-11,190 (2025).'),
  mk('wg-toddler-window-over-2025', 'false-alarm-guard', 'זוג (בדיוני) עם שני ילדים, אחד נולד ב-2022; עבדו רק ב-2025, שכר כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y25'], todyr: ['b22'], inc: 'i2' }, { outcome: 'none', mustNotInclude: G }, 'ילד שנולד ב-2022 אינו פעוט בשנת המס 2025. בלי פעוט, הכנסה כזו מעל תקרת זוג עם 1-2 ילדים.'),
  mk('wg-toddler-2025-in-2024-only', 'false-alarm-guard', 'זוג (בדיוני) עם שני ילדים, אחד נולד ב-2025; עבדו רק ב-2024, שכר כ-8,600 ₪', { grantfam: ['kids12'], grantyrs: ['y24'], todyr: ['b25'], inc: 'i2' }, { outcome: 'none', mustNotInclude: G }, 'בשנת המס 2024 הילד עדיין לא נולד; אין פעוט.'),
  mk('wg-relative-employer', 'false-alarm-guard', 'שכיר (בדיוני) נשוי ואב לשניים; כל שכרו מחברת המשפחה של אביו', { grantfam: ['kids12', 'relemp'], grantyrs: ['y24', 'y25'], todyr: ['none'] }, { outcome: 'none', mustNotInclude: G }, 'מי שכל הכנסתו ממעסיק קרוב אינו "שכיר" לעניין המענק.'),
  mk('wg-no-work-years', 'false-alarm-guard', 'אם (בדיונית) לשני ילדים שלא עבדה בשתי השנים', { grantfam: ['kids12'], grantyrs: ['none'] }, { outcome: 'none', mustNotInclude: G }, 'מענק עבודה דורש הכנסה מעבודה באותה שנת מס.'),
  mk('wg-age55-over', 'false-alarm-guard', 'גבר (בדיוני) בן 60 בלי ילדים, שכר ממוצע כ-10,000 ₪', { grantfam: ['age55'], grantyrs: ['y24', 'y25'], inc: 'i3' }, { outcome: 'none', mustNotInclude: G }, 'תקרת בן 55 ומעלה בלי ילדים כ-7,220 (2024) וכ-7,289 (2025).')
];
// copy / wording guards on the result text
W.find((s) => s.id === 'wg-24-only').expect.textMustMatch = ['31\\.12\\.2026', 'שנת המס 2024'];
W.find((s) => s.id === 'wg-25-only').expect.textMustMatch = ['31\\.12\\.2027', 'שנת המס 2025'];
W.find((s) => s.id === 'wg-24-only').expect.textMustNotMatch = noAmounts;
W.find((s) => s.id === 'wg-both-years').expect.textMustNotMatch = noAmounts.concat(['שנת המס 2026']);
W.push({ id: 'wg-copy-no-spouse-income', item: 7, role: 'copy-guard', topic: 'tax-refunds', title: 'ללא שאלת הכנסת בן/בת זוג וללא כפולות של שכר המינימום בשאלות המענק', kind: 'copy', answers: { kind: ['none'] }, expect: { outcome: 'none' }, copyCheck: { topic: 'tax-refunds', fields: ['help:grantfam', 'help:grantyrs', 'help:todyr', 'help:inc', 'rules'], mustNotMatch: ['פי שניים', 'פי אחד וחצי', 'כפול שכר המינימום', 'הכנסת בן/בת הזוג נלקחת', 'מה הכנסת'], mustMatch: [] } });
W.push({ id: 'wg-copy-self-neutral', item: 7, role: 'copy-guard', topic: 'tax-refunds', title: 'ניסוח ממצא הדוח השנתי לעצמאים: עובדתי, בלי טענה להפרת חובה', kind: 'copy', answers: { kind: ['none'] }, expect: { outcome: 'none' }, copyCheck: { topic: 'tax-refunds', fields: ['help:selffile'], mustNotMatch: ['קנס', 'הפרה', 'עבירה', 'חייבים להגיש'], mustMatch: [] } });
const selfScn = { id: 'wg-self-wording', item: 7, role: 'success', topic: 'tax-refunds', title: 'עצמאי (בדיוני) שהוגש עבורו דוח שנתי רק לחלק מהשנים', kind: 'opportunity', answers: { kind: ['self'], selffile: 'partial', events: ['none'], grantfam: ['none'] }, expect: { outcome: 'found', exactFindings: ['tx-self'], textMustMatch: ['לוודא'], textMustNotMatch: ['קנס', 'ריבית', 'הפרת', 'עבירה', 'לא עמדתם', 'חייבים להגיש'] }, why: 'ניסוח עובדתי: אין קביעה שחלה חובה בשנה מסוימת ואין טענה להפרה.' };
selfScn.answers = E.pruneAnswers(tax, selfScn.answers); W.push(selfScn);
const hd = { id: 'wg-health-dup-wording', item: 7, role: 'success', topic: 'insurance-pension', title: 'ביטוח משלים של קופת חולים וגם פוליסת בריאות פרטית: ניסוח "חפיפה אפשרית"', kind: 'opportunity', answers: null, expect: { outcome: 'found', mustInclude: ['ip-dup'], textMustMatch: ['חפיפה אפשרית'], textMustNotMatch: ['יש לכם כפל', 'כפל ביטוח חיים', 'ביטוח חיים'] }, why: 'הכיסוי עשוי לחפוף חלקית; אין קביעה שיש כפל.' };
const ins = all.topics.find((t) => t.id === 'insurance-pension');
hd.answers = E.pruneAnswers(ins, { healthcov: ['hmo', 'private'], lifecov: ['none'], funds: 'one', lifeevents: ['none'] });
W.push(hd);

const regPath = path.join(dst, 'regression-v6.json');
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
W.forEach((s) => { if (s.answers && !s.copyCheck) s.answersV4 = s.answers; });
fs.writeFileSync(regPath, JSON.stringify(reg.concat(W), null, 2));
fs.writeFileSync(path.join(dst, 'workgrant-2024-2025.json'), JSON.stringify(W, null, 2));
console.log('migrated tax scenarios:', migrated, '; life-dup scenarios adjusted:', lifeFixed, '; new work-grant/wording tests:', W.length);
