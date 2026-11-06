// Builds docs/research/drafts-v6 from drafts-v5 with the owner's v5 decisions applied (2026-11-01):
//  (2) tx-grant rebuilt per tax year (2024, 2025) from the Tax Authority guides, no spouse-income question, no minimum-wage multiples
//  (4) ip-dup: health insurance only, wording "worth checking a possible overlap"
//  (6) tx-self: factual wording, never implies a legal violation
// Idempotent: always rebuilds drafts-v6 from drafts-v5. Usage: node scripts/patch-v6.js
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..', 'docs', 'research');
const src = path.join(root, 'drafts-v5'); const dst = path.join(root, 'drafts-v6');
fs.mkdirSync(dst, { recursive: true });
fs.readdirSync(src).filter((f) => /^R\d.*\.json$/.test(f)).forEach((f) => fs.copyFileSync(path.join(src, f), path.join(dst, f)));
const listB = JSON.parse(fs.readFileSync(path.join(src, 'listB.json'), 'utf8'));

function load(topicId) {
  for (const f of fs.readdirSync(dst).filter((x) => /^R\d.*\.json$/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(dst, f), 'utf8'));
    const t = j.topics.find((x) => x.id === topicId);
    if (t) return { f, j, t };
  }
  throw new Error('topic not found ' + topicId);
}
const save = (o) => fs.writeFileSync(path.join(dst, o.f), JSON.stringify(o.j, null, 2));
const CHECKED = '2026-11-01';
const G24 = 'https://taxes2024.mag.calltext.co.il/pages/65', G25 = 'https://taxes2025.mag.calltext.co.il/pages/65';

// ---------- tax-refunds ----------
{
  const o = load('tax-refunds'); const t = o.t;
  const qi = (id) => t.questions.findIndex((q) => q.id === id);
  const worker = { q: 'kind', in: ['emp', 'self'] };

  // grantfam: facts only; toddler moves to its own year-specific question; no income of the spouse, no assets
  const gf = t.questions[qi('grantfam')];
  gf.text = 'מה מהבאים נכון לגביכם בשנות המס 2024 ו-2025?';
  gf.help = 'אפשר לסמן כמה. אלה עובדות שאתם יודעים. פרטים כמו הכנסת בן/בת הזוג או נכסים אינם נשאלים כאן: הבדיקה המפורטת נעשית בבודק הרשמי של רשות המסים. ילד נחשב אם טרם מלאו לו 19 במהלך שנת המס.';
  gf.options = gf.options.filter((o2) => o2.id !== 'toddler');

  // grantyrs: which tax years the person worked in (the rules and deadlines differ per year)
  const grantyrs = {
    id: 'grantyrs', multi: true,
    text: 'באילו משנות המס האלה עבדתם (כשכיר/ה או כעצמאי/ת)?',
    help: 'מענק עבודה מבוקש לכל שנת מס בנפרד, ולכל שנה יש מועד אחרון להגשה.',
    showIf: { all: [worker, { q: 'grantfam', in: ['kids12', 'kids3', 'single', 'age55', 'adjwage'] }] },
    options: [
      { id: 'y24', label: 'בשנת 2024' },
      { id: 'y25', label: 'בשנת 2025' },
      { id: 'none', label: 'לא עבדתי באף אחת מהשנתיים', exclusive: true }
    ]
  };
  // todyr: toddler = child under 3 (in the year of birth, the year they turn 1, the year they turn 2)
  const todyr = {
    id: 'todyr', multi: true,
    text: 'באילו שנים נולדו ילדיכם הקטנים?',
    help: 'סמנו שנת לידה אם נולד לכם ילד באחת מהשנים האלה. לפי מדריכי רשות המסים יש מענק נוסף להורה לפעוט (ילד שטרם מלאו לו 3), בשנת הלידה, בשנה שבה מלאה לו שנה ובשנה שבה מלאו לו שנתיים.',
    showIf: { all: [{ q: 'inc', in: ['i2'] }, { q: 'grantfam', in: ['kids12', 'kids3', 'single'] }] }, // asked only where it can change the result (a middle income band)
    options: [
      { id: 'b22', label: 'ב-2022' },
      { id: 'b23', label: 'ב-2023' },
      { id: 'b24', label: 'ב-2024' },
      { id: 'b25', label: 'ב-2025' },
      { id: 'none', label: 'אף ילד לא נולד בשנים האלה', exclusive: true }
    ]
  };
  // inc: absolute NIS bands (not minimum-wage multiples); only a coarse screen against the highest published ceilings, never a decision
  const inc = t.questions[qi('inc')];
  inc.text = 'מה היה בערך השכר החודשי ברוטו שלכם (כולל הכנסה מעסק) בחודשים שעבדתם בשנות המס האלה?';
  inc.help = 'ממוצע לחודשי עבודה בפועל. הערכה גסה מספיקה. הסכומים המזכים משתנים בין שנות המס ובין סוגי משפחות, ולכן ההכרעה היא בבודק הרשמי בלבד.';
  inc.showIf = { all: [{ q: 'grantyrs', in: ['y24', 'y25'] }, { q: 'grantfam', in: ['kids12', 'kids3', 'single', 'age55', 'adjwage'] },
    { not: { all: [{ q: 'grantfam', in: ['relemp'] }, { not: { q: 'kind', in: ['self'] } }] } }] };
  inc.options = [
    { id: 'i1', label: 'עד בערך 7,500 ₪' },
    { id: 'i2', label: 'בערך 7,500 עד 9,500 ₪' },
    { id: 'i3', label: 'בערך 9,500 עד 11,500 ₪' },
    { id: 'i4', label: 'בערך 11,500 עד 14,000 ₪' },
    { id: 'i5', label: 'מעל 14,000 ₪' },
    { id: 'unk', label: 'לא יודע/ת', unknown: true }
  ];
  // order: ... grantfam, grantyrs, inc, todyr (todyr only for the middle income band)
  const ii = qi('inc'); t.questions.splice(ii, 0, grantyrs); t.questions.splice(qi('inc') + 1, 0, todyr);

  // two year-specific rules instead of the single tx-grant
  const old = t.rules.find((r) => r.id === 'tx-grant');
  const shape = (y) => ({ q: 'grantyrs', in: [y] });
  const base = (y) => [shape(y), { q: 'grantfam', in: ['kids12', 'kids3', 'single', 'age55', 'adjwage'] },
    { not: { all: [{ q: 'grantfam', in: ['relemp'] }, { not: { q: 'kind', in: ['self'] } }] } }];
  const tod = (ys) => ({ q: 'todyr', in: ys });
  const incomeScreen = (toddlerYears) => ({ any: [
    { q: 'inc', in: ['i1', 'unk'] },
    { all: [{ q: 'inc', in: ['i2'] }, { any: [{ q: 'grantfam', in: ['kids3', 'single'] }, tod(toddlerYears)] }] },
    { all: [{ q: 'inc', in: ['i3'] }, { q: 'grantfam', in: ['single'] }] },
    { all: [{ q: 'inc', in: ['i4'] }, { q: 'grantfam', in: ['single'] }, { q: 'grantfam', in: ['kids3'] }] }
  ] });
  const common = (y, guide) => ({
    status: 'active', readiness: 'needs-verification',
    basis: 'screening-heuristic', serviceTag: 'work-grant-filing',
    official: {
      label: 'בדיקת זכאות למענק עבודה (רשות המסים)',
      url: 'https://www.misim.gov.il/gmmhszakaut/', checked: CHECKED
    },
    officialMore: [
      { label: 'מדריך רשות המסים: מענק עבודה לשנת המס ' + y, url: guide, checked: CHECKED },
      { label: 'הגשת בקשה למענק עבודה', url: 'https://www.gov.il/he/service/submitting-an-online-claim-for-job-grant', checked: CHECKED },
      { label: 'סימולציה: מענק עבודה (רשות המסים)', url: 'https://www.misim.gov.il/shmaanakavoda/frmFirst.aspx', checked: CHECKED }
    ],
    refer: 'אפשר להגיש בעצמכם, בחינם, באינטרנט או בסניף דואר. אם תרצו עזרה, אפשר לפנות דרך כספכם בשיתוף מצפן כלכלי. אם יש עלות, היא תוצג מראש.'
  });
  const mk = (y, guide, deadline, toddlerYears, toddlerText, extraNote) => {
    const c = common(y, guide);
    return Object.assign({
      id: 'tx-grant-' + y,
      when: { all: base('y' + String(y).slice(2)).concat([incomeScreen(toddlerYears)]) },
      finding: {
        title: 'כדאי לבדוק זכאות למענק עבודה לשנת המס ' + y,
        group: 'work-grant', groupTitle: 'כדאי לבדוק זכאות למענק עבודה', section: 'שנת המס ' + y,
        groupIntro: 'מענק עבודה הוא תוספת הכנסה מרשות המסים לשכירים ולעצמאים בהכנסה נמוכה עד בינונית, והוא מבוקש לכל שנת מס בנפרד. לפי העובדות שמסרתם (גיל וילדים, חודשי עבודה והערכה גסה של השכר) ייתכן שכדאי לבדוק את השנים שלהלן. הזכאות תלויה גם בפרטים שאינם נשאלים כאן (הכנסות נוספות במשפחה, נכסי מקרקעין, קרבה למעסיק), והסכומים משתנים בין שנות המס. אין כאן קביעת זכאות או סכום: ההכרעה היא של רשות המסים בלבד.',
        groupStep: 'פתחו את בודק הזכאות הרשמי של רשות המסים (חינם, בלי כניסה לחשבון; מותר לבדוק רק מספר מוגבל של פעמים לכל מספר זהות, ולכן הכינו את הפרטים מראש) ובדקו כל שנה בנפרד. אם הוא מצביע על זכאות, הגישו בקשה לכל שנה באינטרנט או בסניף דואר.',
        why: 'שנת המס ' + y + ': ' + deadline + ' ' + toddlerText,
        step: 'אם הבודק מצביע על זכאות לשנת ' + y + ', הגישו בקשה לשנה זו בלי לדחות.',
        official: c.official, officialMore: c.officialMore, refer: c.refer
      }
    }, { status: c.status, readiness: c.readiness, basis: c.basis, serviceTag: c.serviceTag,
      source: { url: guide, checked: CHECKED, confidence: 'verified' }, adminNote: extraNote });
  };
  const note = (y, ceil) => 'v6 (2026-11-01) rebuilt per tax year from the Tax Authority guide for ' + y + ' (page 65 of the annual guide, read in full 2026-11-01). Owner decisions applied: no spouse-income question, no minimum-wage multiples. The income question uses absolute monthly NIS bands as a coarse SCREEN only: a rule fires when the band can overlap the published ceiling of at least one family shape the person ticked (ceilings, avg monthly income over actual working months, ' + y + ': ' + ceil + '). Toddler = child under 3: year of birth, the year the child turns 1, the year the child turns 2 (the guide gives the rule, not birth years; derived: ' + (y === 2024 ? 'born 2022-2024' : 'born 2023-2025') + '). The guide has no direct link to a checker; the checker URL is the one verified in M1 row 10. Residual known errors: the spouse income, assets test and the employer-relative test beyond the ticked option are not asked; 18-20 year old parents not modelled; an unknown income answer fires the finding (the check is free). Held until the manual list-B check (READINESS-V6): the rule is shown ACTIVE in the full draft and INACTIVE in the publishable variant.';
  t.rules.splice(t.rules.indexOf(old), 1,
    mk(2024, G24, 'המועד האחרון להגשת בקשה הוא 31.12.2026.', ['b22', 'b23', 'b24'],
      'לפי המדריך, ילד שנולד ב-2022 עד 2024 נחשב פעוט בשנת המס הזו, וקיימת בגללו תוספת נפרדת, גם להכנסה מעט גבוהה מהרגיל.',
      note(2024, 'couple/55+ 1-2 children 7,220; 3+ children 7,910; toddler worker 8,582 (1-2 children) / 9,243 (3); single parent 10,930 (1-2) / 13,340 (3+); max regular grant 10,080 + up to 490 per toddler; claims 1.1.2025-31.12.2026')),
    mk(2025, G25, 'המועד האחרון להגשת בקשה הוא 31.12.2027.', ['b23', 'b24', 'b25'],
      'לפי המדריך, ילד שנולד ב-2023 עד 2025 נחשב פעוט בשנת המס הזו, וקיימת בגללו תוספת נפרדת, גם להכנסה מעט גבוהה מהרגיל.',
      note(2025, 'couple/55+ 1-2 children 7,289; 3+ children 8,020; toddler worker 8,781 (1-2) / 9,462 (3); single parent 11,190 (1-2) / 13,660 (3+); toddler single 11,063 / 13,474; max regular grant 10,260 + up to 500 per toddler; claims 1.1.2026-31.12.2027')));

  // tx-self: factual wording, no implication of a violation
  const ts = t.rules.find((r) => r.id === 'tx-self');
  ts.finding.title = 'כדאי לוודא שהוגש דוח שנתי לכל שנות העבודה כעצמאי/ת';
  ts.finding.why = 'לפי מדריך רשות המסים, עצמאים מגישים בדרך כלל דוח שנתי. לפי תשובתכם הוגש דוח רק לחלק מהשנים, או שאינכם יודעים להצביע על שנה שהוגש בה דוח. ייתכן שיש הסבר (למשל שנה ראשונה לעסק, או דוח שהוגש דרך מייצג), ואין כאן קביעה אם חלה עליכם חובת הגשה בשנה מסוימת: זה תלוי בהכנסה ובנסיבות. כדאי לוודא את המצב מול רשות המסים או מול רואה החשבון.';
  ts.finding.step = 'בדקו באזור האישי באתר רשות המסים לאילו שנים מופיעים דוח או הודעת שומה, ושאלו את רואה החשבון או היועץ שמטפל בכם. אם נמצאה שנה בלי דוח, פנו לבעל מקצוע מוסמך כדי להבין מה נדרש.';
  ts.adminNote += ' v6 (2026-11-01, decision 6): wording is factual only; no statement that the user breached a duty, no penalties/interest mention, title says "worth verifying".';
  const s = t.questions.find((q) => q.id === 'selffile');
  s.help = 'עצמאים מגישים בדרך כלל דוח שנתי. הודעות מרשות המסים מגיעות לרוב אל מי שמגיש בשמכם, ולכן העדר מכתב בבית אינו אומר שלא הוגש דוח. אפשר לבדוק באזור האישי באתר רשות המסים או לשאול את רואה החשבון.';
  save(o);
}

// ---------- insurance-pension: ip-dup health only ----------
{
  const o = load('insurance-pension'); const r = o.t.rules.find((x) => x.id === 'ip-dup');
  r.when = { any: r.when.any.filter((c) => c.all.every((x) => x.q === 'healthcov')) };
  if (r.when.any.length !== 6) throw new Error('ip-dup: expected 6 health pairs, got ' + r.when.any.length);
  r.finding.title = 'כדאי לבדוק חפיפה אפשרית בין כיסויי ביטוח הבריאות שלכם';
  r.finding.why = 'סימנתם שביטוח בריאות נוסף על הסל הציבורי מגיע אליכם ביותר מגורם אחד, למשל ביטוח משלים של קופת חולים וגם פוליסה פרטית. כיסויים כאלה עשויים לחפוף חלקית, אבל אין כאן קביעה שיש כפל: ייתכן שכל כיסוי מוסיף דבר שונה. באתר ״ביטוחי הבריאות שלי״ של רשות שוק ההון (בהרצה) מוצגים כיסויי הבריאות שלכם, ובהר הביטוח אפשר לראות פוליסות בתוקף.';
  r.finding.step = 'היכנסו ל״ביטוחי הבריאות שלי״ או להר הביטוח (בהזדהות ממשלתית) ועברו על הכיסויים. בדקו עם הגוף המבטח מה מכסה כל פוליסה לפני שמבטלים משהו. הנתונים עלולים להכיל שגיאות; אם יש סתירה, בדקו מול חברת הביטוח.';
  r.finding.official = { label: 'ביטוחי הבריאות שלי (רשות שוק ההון, בהרצה)', url: 'https://hit.cma.gov.il/', checked: CHECKED };
  r.finding.officialMore = [
    { label: 'הר הביטוח', url: 'https://harb.cma.gov.il/', checked: CHECKED },
    { label: 'חיפוש סוכנים ויועצים מורשים', url: 'https://www.gov.il/he/service/agents_and_consultants_search', checked: CHECKED }
  ];
  r.adminNote += ' v6 (2026-11-01, decision 4): health insurance ONLY. Life-insurance pairs (private+bank, private+employer, bank+employer) removed: owner approved duplicate-cover checking for health only. Wording is "worth checking a possible overlap", never a claim that a duplicate exists. `lifecov` stays: it feeds ip-family/ip-nocover/ip-mortgage-life.';
  save(o);
}

// ---------- list B manual verification (docs/research/raw/L1-listB-v6.md, 2026-11-01): wording fixes supported by the official pages read ----------
function rule(id) { for (const f of fs.readdirSync(dst).filter((x) => /^R\d.*\.json$/.test(x))) { const j = JSON.parse(fs.readFileSync(path.join(dst, f), 'utf8')); for (const t of j.topics) { const r = t.rules.find((x) => x.id === id); if (r) return { f, j, r }; } } throw new Error('rule ' + id); }
function fix(id, edits) {
  const o = rule(id);
  edits.forEach(([field, from, to]) => {
    const f = o.r.finding; const src2 = f[field];
    if (from === null) { f[field] = to; return; }
    if (typeof src2 !== 'string' || !src2.includes(from)) throw new Error(id + '.' + field + ': text not found: ' + from.slice(0, 40));
    f[field] = src2.replace(from, to);
  });
  o.r.adminNote = (o.r.adminNote || '') + ' v6 (2026-11-01): manual check done (raw/L1-listB-v6.md); wording aligned to what the official page says.';
  fs.writeFileSync(path.join(dst, o.f), JSON.stringify(o.j, null, 2));
}
fix('lf-inherit-open', [['step', 'או לצו קיום צוואה', 'או (למי שזכאי לפי הצוואה) לצו קיום צוואה']]);
fix('lf-inherit-search', [['why', 'בבנקים הוא מציג חשבונות מכל סוג, ללא יתרה', 'בבנקים הוא מציג באילו בנקים קיימים חשבונות על שם הנפטר/ת (ביתרת זכות או חובה), בלי מספר חשבון, סוג חשבון או יתרה']]);
fix('hs-empty', [['why', ' ייתכן שרשות מסוימת מקבלת תקופת שיפוץ כנכס ריק, לפי הנוהל שלה.', ''], ['step', 'ראיות שהנכס ריק (למשל חשבונות מים וחשמל)', 'ראיות שהנכס ריק (למשל חשבונות חשמל ומים, כפי שמבקשת עיריית ירושלים)']]);
{ const o = rule('hs-empty'); o.r.finding.officialMore.forEach((m) => { if (m.url.endsWith("/property/unused/")) { m.url = m.url.replace('/unused/', '/empty/'); m.label = 'דוגמה: עיריית ירושלים, נכס ריק'; } }); fs.writeFileSync(path.join(dst, o.f), JSON.stringify(o.j, null, 2)); }
fix('hs-damaged', [['step', ' הודיעו לרשות כשהנכס חוזר לשימוש.', ' הפטור תלוי בהוכחת מצב הנכס.'], ['step', 'צרפו ראיות לנזק ולכך שאין מתגוררים בנכס (למשל תמונות, חוות דעת מקצועית, חשבונות מים וחשמל).', 'צרפו ראיות לנזק ולכך שאין מתגוררים בנכס (למשל תמונות).']]);
fix('hs-daycare', [['why', 'הדרגה תלויה בסוג המסגרת', 'הדרגה תלויה, בין היתר, בסוג המסגרת']]);
fix('ps-bal', [['why', 'כשהיתרה לא מופיעה קשה לדעת כמה ימים צברתם ומה נותר.', 'כשהיתרה לא מופיעה קשה לדעת כמה ימים צברתם ומה נותר. לפי החוק אין חובה לציין את יתרת המחלה הצבורה כשהמעסיק מבטח את העובד בביטוח מחלה, ולכן ייתכן שיש לכך הסבר.']]);
{ const o = rule('ps-bal'); o.r.finding.official = { label: 'חוק הגנת השכר (נוסח באתר נבו)', url: 'https://www.nevo.co.il/law_html/law00/71689.htm', checked: CHECKED }; o.r.source = Object.assign({}, o.r.source, { url: 'https://www.nevo.co.il/law_html/law00/71689.htm', checked: CHECKED }); fs.writeFileSync(path.join(dst, o.f), JSON.stringify(o.j, null, 2)); }
fix('ni-disability', [['why', 'כשמחלה או מגבלה ארוכת טווח מקטינה', 'כשמחלה או מגבלה מקטינה'], ['why', ' חלק מהקצבאות הנוספות (למשל שירותים מיוחדים) בודקים בנפרד.', ' הטבות נוספות בביטוח הלאומי נבדקות בנפרד.']]);
fix('ni-supplement', [['why', 'שהקצבה היא עיקר הכנסתם', 'בעלי הכנסה נמוכה'], ['why', ' התוספת דורשת תביעה נפרדת ואינה מצורפת אוטומטית לקצבה.', ' התוספת דורשת הגשת תביעה. התנאים כוללים בין היתר מבחני הכנסה ונכסים, ולכן כדאי לעבור עליהם באתר.']]);
fix('ni-survivors', [['step', 'בדקו בעמוד התביעה אם יש מועד אחרון, ולא כדאי לדחות.', 'לפי עמוד התביעה של הביטוח הלאומי יש להגיש תביעה תוך 12 חודשים מיום הפטירה (עם תשלום רטרואקטיבי של עד 12 חודשים בהגשה מאוחרת), ולכן לא כדאי לדחות.']]);
fix('hh-ins-two', [['step', 'כדי לראות אילו פוליסות רשומות על שמכם.', 'כדי לראות אילו פוליסות רשומות על שמכם. אם פוליסת הדירה אינה מופיעה שם, בררו מול חברת הביטוח.']]);
fix('hh-ins-none', [['why', '(למשל מים, אש או גניבה)', '(למשל שיטפון, אש או גניבה)'], ['why', ' אם יש משכנתא או חוזה שכירות, ייתכן שההסכם מתייחס לביטוח; כדאי לבדוק בו.', '']]);
fix('ed-haredi-employment', [['why', ' יש גם הכשרות מקצועיות הממומנות בחלקן ומיועדות לציבור זה.', ''], ['why', 'ליווי אישי, הכשרות והשמה', 'ליווי אישי והשמה']]);

// ---------- list B for v6 ----------
// after the manual check only these stay held: Har HaBituach home-policy coverage and the dira.cma.gov.il result screen (CAPTCHA) need a person
const B6 = ['hh-ins-two', 'hh-ins-none'];
fs.writeFileSync(path.join(dst, 'listB.json'), JSON.stringify(B6, null, 2));
console.log('drafts-v6 built; list B:', B6.length);
