// Generates the owner/professional review package of the deep check (Hebrew) from the route, the V6 draft and the engine, so every table is computed, not typed:
//   docs/research/raw/DEEP-CHECK-CONTENT-REVIEW.md            index + the general parts (profile, whom questions, per-person mechanism, gates, tiers, wording, readiness, decisions)
//   docs/research/raw/deep-review-by-domain/<domain>.md        one self-contained file per domain (+ profile), ready to forward to a professional
// Usage: node scripts/gen-deep-review.js [rawDir]   (default: docs/research/raw; the research folder is private and gitignored)
// Needs the V6 draft (docs/research/drafts-v6/PUBLISHABLE-v6.draft.json). Nothing here is published or sent anywhere. No content is invented: every question, option, rule,
// card text, source and open point comes from the V6 draft and the route; the only words of ours are the labels of the structure.
const fs = require('fs');
const path = require('path');
const E = require('../kaspchem/assets/engine.js');
const L = require('../kaspchem/assets/engine-deep-lint.js');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const ROUTE = read(path.join(root, 'kaspchem', 'content', 'routes.json')).topics.find((t) => t.id === 'deep');
const TEN = read(path.join(root, 'kaspchem', 'content', 'topics.json')).topics;
const V6F = path.join(root, 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
if (!fs.existsSync(V6F)) { console.error('V6 draft not found: link docs/research first'); process.exit(1); }
const V6 = read(V6F).topics;
const rawDir = process.argv[2] || path.join(root, 'docs', 'research', 'raw');
const dom = path.join(rawDir, 'deep-review-by-domain'); fs.mkdirSync(dom, { recursive: true });

const cfg6 = E.buildDeep(ROUTE, V6), cfg1 = E.buildDeep(Object.assign({}, ROUTE, { requires: [] }), TEN);
const lint6 = L.lintDeep(ROUTE, V6, { samples: 6000, seed: 7 }), lint1 = L.lintDeep(Object.assign({}, ROUTE, { requires: [] }), TEN, { samples: 6000, seed: 7 });
const q6 = {}; cfg6.questions.forEach((q) => { q6[q.id] = q; });
const md = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\n/g, ' ');
const BT = String.fromCharCode(96);
const code = (s) => BT + s + BT;
const tname = (id) => (V6.find((t) => t.id === id) || { name: id }).name;
const lab = (q, id) => ((q.options.find((o) => o.id === id)) || { label: id }).label;
const SUBJ = ROUTE.persons.subjects;
const UNV = {}; ROUTE.unverified.forEach((u) => { UNV[u.id] = u.reason; });
const CLS = { respondent: 'נוגע למשיב/ה בלבד', 'event-person': 'נוגע לאדם שהיה לו האירוע (אני / בן/בת הזוג / ילד/ה / הורה)', household: 'משק בית / ילדים / המשפחה', 'other-person': 'אדם אחר שתואר בשאלה עצמה' };
const BASIS = { 'official-fact': 'עובדה רשמית', 'professional-assumption': 'הנחה מקצועית', 'screening-heuristic': 'היוריסטיקת סינון' };
const CONF = { verified: 'מאומת במקורות', partial: 'חלקי', unverified: 'לא מאומת' };
const PRO = {
  'tax-refunds': 'יועץ/ת מס או רואה חשבון', 'insurance-pension': 'יועץ/ת פנסיוני/ת או סוכן/ת ביטוח מורשה', 'national-insurance': 'עורך/ת דין או יועץ/ת זכויות בביטוח לאומי',
  housing: 'מומחה/ית לארנונה ולסיוע בדיור (עורך/ת דין לשלטון מקומי)', mortgage: 'יועץ/ת משכנתאות מורשה', 'banking-loans': 'יועץ/ת פיננסי/ת או עורך/ת דין בנקאי',
  household: 'יועץ/ת ביטוח דירה ותכולה, או איש/אשת מקצוע בצרכנות', 'payslip-rights': 'עורך/ת דין לדיני עבודה', 'education-work': 'יועץ/ת תעסוקה והכשרה, או נציג/ת האגף לחיילים משוחררים',
  'lost-funds': 'יועץ/ת פנסיוני/ת ועורך/ת דין לענייני ירושה'
};
const lines = []; const P = (s) => lines.push(s === undefined ? '' : s);

// ---- conditions in words ----
function words(qs, c) {
  if (!c) return 'תמיד';
  const par = (x) => ((x.all || x.any) ? '(' + words(qs, x) + ')' : words(qs, x));
  if (c.all) return c.all.map(par).join(' וגם ');
  if (c.any) return c.any.map(par).join(' או ');
  if (c.not) return 'לא (' + words(qs, c.not) + ')';
  const q = qs[c.q]; if (!q) return c.q;
  return '״' + q.text.replace(/[?:]\s*$/, '').slice(0, 90) + '״ = ' + c.in.map((i) => '״' + lab(q, i) + '״').join(' או ');
}
const localQs = (t) => { const m = {}; t.questions.forEach((q) => { m[q.id] = q; }); return m; };
const profQs = {}; ROUTE.profile.questions.forEach((q) => { profQs['profile.' + q.id] = q; });
const pwords = (c) => words(Object.assign({}, profQs, q6), c);

// ---- engine-evaluated examples ----
function walk(cfg, over) {
  const a = {}; let q;
  while ((q = E.deepNext(cfg, a))) {
    if (over[q.id] !== undefined) { a[q.id] = over[q.id]; continue; }
    const plain = q.options.filter((o) => !o.unknown), ex = plain.filter((o) => o.exclusive)[0];
    a[q.id] = q.multi ? [(ex || plain[0]).id] : plain[0].id;
  }
  return a;
}
const sj = (f) => (f.subjectLabel ? ' [עבור: ' + f.subjectLabel + ']' : '');
function show(cfg, a) {
  const r = E.evaluateDeep(cfg, a), cards = (list) => list.map((c) => c.title + sj(c)).join('; ') || '—';
  const miss = (c) => ((c.parts ? c.parts[0] : c).missing || []).map((m) => m.text.replace(/[?]$/, '')).join(' / ');
  return { r, asked: Object.keys(a).length, high: cards(r.highCards),
    missing: r.missingItems.map((it) => (it.folded ? '**' + it.cards.length + ' נושאים תלויים בתשובה שחסרה** (' + it.missing.map((m) => m.text.replace(/[?]$/, '')).join(' / ') + ')' : it.card.title + sj(it.card) + ' [חסר: ' + miss(it.card) + ']')).join('; ') || '—' };
}
const BASE = { 'profile.home': 'owner', 'profile.mortgage': 'no', 'profile.worknow': 'employee', 'profile.workhist': ['emp'] };
const PERSONAS = [
  { name: 'א. משפחה צעירה בשכירות: נולד ילד השנה, שני ילדים קטנים, משכנתה בתכנון, לא ידוע אם הוגש דוח מס', over: { 'profile.home': 'renter', 'profile.mortgage': 'plan', 'profile.family': ['birth', 'kids'], 'tax-refunds.events': ['family'], 'tax-refunds.letters': 'unk', 'mortgage.offers': 'one', 'national-insurance.birthfacts': ['mom_unpaid'], 'housing.household': ['single_parent', 'daycare'], 'housing.bti': ['none'], 'housing.property': ['none'], 'housing.already': ['none'] } },
  { name: 'ב. המשיב/ה שכיר/ה; בן/בת הזוג בגיל פרישה ואינו/ה מקבל/ת קצבה', over: { 'profile.family': ['retire'], 'profile.who_retire': ['spouse'], 'national-insurance.retirefacts@spouse': ['nopension'] } },
  { name: 'ג. המשיב/ה וגם בן/בת הזוג הפסיקו לעבוד: הנתונים של כל אחד נשאלים בנפרד', over: { 'profile.family': ['stopped'], 'profile.who_stopped': ['me', 'spouse'], 'national-insurance.stopfacts': ['ok'], 'national-insurance.stopfacts@spouse': ['emp_noreg'], 'payslip-rights.emp@spouse': 'past', 'payslip-rights.lastslip@spouse': 'no', 'payslip-rights.unused@spouse': 'no' } },
  { name: 'ד. הורה שירת במילואים: שאלות המילואים ושאלות המס נשאלות עבור ההורה', over: { 'profile.family': ['reserve'], 'profile.who_reserve': ['parent'], 'national-insurance.reservefacts@parent': ['emp_unpaid'], 'tax-refunds.kind@parent': ['emp'], 'tax-refunds.letters@parent': 'never' } },
  { name: 'ה. מידע חלקי על בן/בת זוג: ״לא יודע/ת״ בשאלת העובדות שלו/ה, ו״מעדיפ/ה לא לענות״ בשאלה על מי נפגע', over: { 'profile.family': ['retire', 'health'], 'profile.who_retire': ['me', 'spouse'], 'profile.who_health': ['pna'], 'national-insurance.retirefacts': ['nopension'], 'national-insurance.retirefacts@spouse': ['unk'] } },
  { name: 'ו. גמלאי בבית משלו, בלי משכנתה, מעדיף לא לענות על שאלת המשפחה כולה', over: { 'profile.home': 'owner', 'profile.mortgage': 'no', 'profile.worknow': 'retired', 'profile.workhist': ['none'], 'profile.family': ['pna'] } }
];

// =========================================================================================================================================
// the domain files
// =========================================================================================================================================
const s6 = lint6.stats, s1 = lint1.stats;
const groupsFor = (ruleId) => ROUTE.persons.groups.filter((g) => g.rules.indexOf(ruleId) !== -1);
const ruleList = (t) => { const out = []; t.rules.forEach((r) => { if (r.id === 'ni-disability') { out.push({ r, id: 'ni-disability#1', when: r.when.any[0] }); out.push({ r, id: 'ni-disability#2', when: r.when.any[1] }); } else out.push({ r, id: r.id, when: r.when }); }); return out; };

function domainFile(t) {
  const L2 = []; const Q = (s) => L2.push(s === undefined ? '' : s);
  const qs = localQs(t), act = t.rules.filter((r) => r.status !== 'inactive'), inact = t.rules.filter((r) => r.status === 'inactive');
  const nUnv = act.filter((r) => UNV[t.id + '.' + r.id]).length;
  Q('# ' + t.name + ': סקירה מקצועית של הבדיקה המעמיקה');
  Q();
  Q('**קובץ זה עומד בפני עצמו** ומיועד להעברה ל' + (PRO[t.id] || 'איש/אשת מקצוע') + ' (הצעה שלי למי שכדאי שיבדוק). הוא נוצר אוטומטית מתוכן V6 (טיוטה, לא מפורסם) ומהנתיב של הבדיקה המעמיקה: **שום נוסח אינו מומצא כאן**. הבדיקה אינה קובעת זכאות: היא מסננת ומציגה ״כדאי לבדוק״, לפי תשובות העובדה של הפונה.');
  Q();
  Q('## 1. מה מתבקש מבעל/ת המקצוע');
  Q();
  Q('1. לאשר או לתקן **את נוסח השאלות והתשובות** (סעיף 2): האם הן מדויקות ומובנות לאדם מן השורה?');
  Q('2. לאשר או לתקן **את תנאי הסינון של כל כלל** (סעיף 3): האם התנאים, כפי שהם כתובים במילים, הם אכן הסימן שבגללו כדאי לבדוק את הנושא? האם חסר תנאי, או שיש תנאי מיותר או שגוי?');
  Q('3. לבדוק **את נוסח הכרטיס** שמוצג בתוצאה (הכותרת, ההסבר, הצעד המעשי, הגורם שמסייע והקישור הרשמי): נכון, זהיר, לא מבטיח?');
  Q('4. להתייחס **לנקודות הפתוחות** של כל כלל, ובמיוחד לכללים שסומנו ״חלקי״ (' + nUnv + ' בתחום זה).');
  Q();
  Q('## 2. השאלות');
  Q();
  Q('כל שאלה נשאלת רק אם כלל פעיל תלוי בה. ״מופיעה״ = התנאי שבו השאלה נשאלת. ״לא ידוע״ = תשובה שמטופלת כחסר מידע ולא כ״לא״.');
  Q();
  t.questions.forEach((q, i) => {
    const cq = q6[t.id + '.' + q.id];
    const used = act.some((r) => JSON.stringify(r.when).indexOf('"' + q.id + '"') !== -1) || t.questions.some((x) => x.showIf && JSON.stringify(x.showIf).indexOf('"' + q.id + '"') !== -1);
    Q('### שאלה ' + (i + 1) + ' (' + code(q.id) + '): ' + q.text);
    Q();
    if (q.help) Q('- **הערת עזר מתחת לשאלה:** ' + q.help);
    Q('- **סוג:** ' + (q.multi ? 'בחירה מרובה (תשובה בלעדית כמו ״אף אחד מאלה״ נבחרת לבדה)' : 'בחירה אחת'));
    const ders = (cfg6.derive || []).filter((d) => d.targets.indexOf(t.id + '.' + q.id) !== -1);
    const when = q.showIf ? words(qs, q.showIf) : 'תמיד';
    const gates = ((cq && cq.gatedBy) || []).map((gid) => ROUTE.gates.find((g) => g.id === gid)).filter(Boolean);
    Q('- **מופיעה:** ' + when + (gates.length ? ' ; ובנוסף רק אם: ' + gates.map((g) => pwords(g.show) + ' (' + g.why + ')').join(' ; ') : ''));
    if (ders.length) Q('- **נגזרת מהפרופיל (לא נשאלת שוב):** ' + ders.map((d) => '״' + (profQs[d.from] || {}).text + '״ ← ' + code(d.id)).join('; ') + ' (הטבלה המלאה בקובץ הפרופיל)');
    if (cq && cq.sensitive) Q('- **שאלה רגישה (רשות):** יש בה ״מעדיפ/ה לא לענות״ (= לא ידוע). השורה שמוצגת: ״' + cq.sensitiveWhy + '״');
    Q('- **תשובות:**');
    (cq || q).options.forEach((o) => Q('  - ' + o.label + (o.exclusive ? ' *(בלעדית)*' : '') + (o.unknown ? ' *(לא ידוע)*' : '') + (o.group ? ' · קבוצה: ' + o.group : '') + (o.hint ? ' · הסבר ליד התשובה: ' + o.hint : '')));
    const copies = cfg6.questions.filter((x) => x.copyOf === t.id + '.' + q.id);
    if (copies.length) Q('- **נשאלת גם עבור בני משפחה אחרים:** בנפרד לכל אדם שנבחר בשאלה ״מי״ (' + copies.map((c) => SUBJ[c.subject].label).join(' / ') + '), בנוסח זהה עם הקידומת ״עבור …״ ובאותן תשובות בדיוק; מופיעה רק כשהאדם נבחר.');
    if (!used) Q('- **הערה:** אף כלל פעיל אינו תלוי בשאלה זו (ראו הלינט).');
    Q();
  });
  Q('## 3. הכללים: תנאים, כרטיס, למי הכלל נוגע, ואימות');
  Q();
  Q('**איך נקבעת הרמה:** ״סבירות גבוהה״ = כל תנאי הכלל נכונים לפי התשובות. ״חסר מידע — כדאי להשלים בדיקה״ = אף תנאי אינו שקרי, אך לפחות תשובה אחת אינה ידועה (״לא יודע/ת״, ״מעדיפ/ה לא לענות״, או שהשאלה לא נענתה), והכרטיס אומר איזו שאלה חסרה (ועבור מי). תנאי שקרי: הכלל אינו מוצג כלל. אין אחוזים. כלל שמוזכרת בו במפורש התשובה ״לא יודע״ (למשל במענק העבודה) מפעיל על התשובה הזו כפי שכתוב.');
  Q();
  ruleList(t).filter((x) => x.r.status !== 'inactive').forEach((x) => {
    const r = x.r, f = r.finding, key = t.id + '.' + r.id, cls = ROUTE.persons.classes[t.id + '.' + x.id] || {}, grps = groupsFor(t.id + '.' + x.id);
    const refQs = []; E.condQs(x.when, (id) => { if (refQs.indexOf(id) === -1) refQs.push(id); });
    Q('### ' + code(x.id) + ': ' + f.title);
    Q();
    Q('- **תנאי הסינון במילים:** ' + words(qs, x.when));
    Q('- **שאלות שמכריעות:** ' + refQs.map((id) => '״' + (qs[id] ? qs[id].text.replace(/[?:]\s*$/, '') : id) + '״').join('; '));
    const listed = []; (function w(c) { if (!c) return; if (c.all) c.all.forEach(w); else if (c.any) c.any.forEach(w); else if (c.not) w(c.not); else if (c.q && qs[c.q]) (c.in || []).forEach((i) => { const o = qs[c.q].options.find((y) => y.id === i); if (o && o.unknown) listed.push('״' + o.label + '״ בשאלה ״' + qs[c.q].text.slice(0, 50) + '״'); }); })(x.when);
    if (listed.length) Q('- **שימו לב:** הכלל מפעיל במפורש גם על התשובה ' + listed.join(', ') + '.');
    Q('- **למי הכלל נוגע:** ' + (CLS[cls.class] || 'לא מסווג') + (cls.why ? '. ' + cls.why : ''));
    if (grps.length) {
      const g = grps[0];
      Q('- **בדיקה לפי אדם:** כן. נבדק לכל אדם שנבחר בשאלה ״' + ROUTE.profile.questions.find((p) => 'profile.' + p.id === g.who).text + '״ (' + g.subjects.map((s) => SUBJ[s].label).join(' / ') + '), עם התשובות של אותו אדם בלבד. ' + ((g.copyOnly && g.copyOnly.length) ? 'שאלות נוספות שנשאלות רק עבור בן משפחה אחר: ' + g.copyOnly.map((id) => code(id)).join(', ') + '. ' : '') + (g.implies ? 'האירוע עצמו (' + code(g.option) + ') הוא התשובה ' + Object.keys(g.implies).map((k) => code(k) + ' = ' + g.implies[k].join(', ')).join('; ') + '. ' : '') + 'הכרטיס מציג ״עבור: <האדם>״ ואומר שההתאמה נבדקה לפי התשובות על אותו אדם.');
    } else if (cls.class === 'respondent' || cls.class === 'household') Q('- **בדיקה לפי אדם:** לא. ' + (cls.class === 'respondent' ? 'הכלל נשען על מצב המשיב/ה, ואין אירוע משפחתי שמתאים לתנאיו.' : 'הכלל נוגע למשק הבית או לילדים, והשאלות כבר שואלות עליהם.'));
    Q('- **כרטיס התוצאה:**');
    Q('  - **כותרת:** ' + f.title);
    Q('  - **מה כדאי לבדוק:** ' + f.why);
    if (f.step) Q('  - **איך זה עובד:** ' + f.step);
    Q('  - **מי יכול לעזור:** ' + [f.official && f.official.url ? f.official.label + ' (' + f.official.url + (f.official.checked ? ', נבדק ' + f.official.checked : '') + ')' : null, f.refer].filter(Boolean).join(' ; '));
    (f.officialMore || []).forEach((m) => Q('  - **קישור נוסף:** ' + m.label + ' (' + m.url + ')'));
    const sc = r.source || {};
    Q('- **אימות:** ' + (UNV[key] ? '**חלקי** (נרשם בנתיב כלא מאומת): ' + UNV[key] : 'לא רשום כלא מאומת בנתיב') + ' | במקור הכלל: ' + (CONF[sc.confidence] || sc.confidence || '—') + (sc.checked ? ', נבדק ' + sc.checked : '') + ', בסיס: ' + (BASIS[r.basis] || r.basis || '—') + ', מוכנות: ' + (r.readiness || '—') + (sc.url ? ' | מקור: ' + sc.url : ''));
    if (r.needsFollowUp) Q('- **נקודות פתוחות לאיש המקצוע:** ' + r.needsFollowUp);
    else if (UNV[key]) Q('- **נקודות פתוחות לאיש המקצוע:** ' + UNV[key]);
    Q();
  });
  if (inact.length) { Q('### כללים לא פעילים (אינם נבדקים כיום)'); Q(); inact.forEach((r) => Q('- ' + code(r.id) + ': ' + r.finding.title)); Q(); }
  Q('## 4. שאלות פתוחות לאיש המקצוע (מרוכז)');
  Q();
  const open = [];
  ruleList(t).filter((x) => x.r.status !== 'inactive').forEach((x) => { const key = t.id + '.' + x.r.id; if (x.r.needsFollowUp || UNV[key]) { if (!open.some((o) => o[0] === x.r.id)) open.push([x.r.id, x.r.needsFollowUp || UNV[key]]); } });
  if (open.length) open.forEach(([id, txt]) => Q('- ' + code(id) + ': ' + txt)); else Q('- אין נקודות פתוחות רשומות בתוכן. עדיין מתבקשת בדיקה כללית של התנאים והנוסח (סעיף 1).');
  Q();
  Q('---');
  Q('*נוצר מ־scripts/gen-deep-review.js. הבדיקה המעמיקה כבויה לציבור עד שכל כללי V6 הרלוונטיים אומתו והנוסח אושר.*');
  fs.writeFileSync(path.join(dom, t.id + '.md'), L2.join('\n') + '\n');
}
V6.forEach(domainFile);

// ---- the profile file ----
(function () {
  const Q = []; const W = (s) => Q.push(s === undefined ? '' : s);
  W('# הפרופיל ושאלות ״מי״: סקירה מקצועית של הבדיקה המעמיקה'); W();
  W('**קובץ זה עומד בפני עצמו.** הפרופיל נשאל פעם אחת בתחילת הבדיקה; שאלות ״מי״ נשאלות רק כשנבחרה בשאלת המשפחה תשובה שמשמעותה תלויה באדם. הוא נוצר אוטומטית מהנתיב. **הנוסח הוא הצעה שלי לאישור.**'); W();
  W('## 1. השאלות'); W();
  ROUTE.profile.questions.forEach((q, i) => {
    const tq = q6['profile.' + q.id];
    W('### ' + (i + 1) + '. ' + q.text); W();
    if (q.help) W('- **הערת עזר:** ' + q.help);
    W('- **מופיעה:** ' + (q.showIf ? 'רק כאשר נבחרה בשאלת המשפחה התשובה ״' + lab(q6['profile.' + q.showIf.q], q.showIf.in[0]) + '״' : 'תמיד'));
    W('- **סוג:** ' + (q.multi ? 'בחירה מרובה' : 'בחירה אחת') + (/^who_/.test(q.id) ? ' (כל אדם שנבחר הוא ״נושא״ נפרד: נשאלות עבורו שאלות העובדות, והכללים נבדקים לפי התשובות שלו)' : ''));
    if (tq.sensitive) W('- **רגישה (רשות):** ״' + tq.sensitiveWhy + '״ ' + ROUTE.messages.sensitiveNote);
    W('- **תשובות:**'); tq.options.forEach((o) => W('  - ' + o.label + (o.exclusive ? ' *(בלעדית)*' : '') + (o.unknown ? ' *(לא ידוע)*' : '') + (o.group ? ' · קבוצה: ' + o.group : '') + (o.hint ? ' · הסבר: ' + o.hint : '')));
    W();
  });
  W('## 2. מה כל תשובת פרופיל ממלאת בשאלות התחומים'); W();
  W('| שאלת פרופיל | תשובה | שאלת תחום שממולאת | תשובה בתחום |'); W('|---|---|---|---|');
  ROUTE.facts.forEach((f) => {
    if (!cfg6.derive.some((d) => d.id === f.id)) return;
    const pq = q6[f.from];
    Object.keys(f.map).forEach((o) => Object.keys(f.map[o]).forEach((t2) => { const tq = q6[t2]; W('| ' + md(pq.text) + ' | ' + md(lab(pq, o)) + ' | ' + code(t2) + ' ' + md(tq.text.slice(0, 50)) + ' | ' + md([].concat(f.map[o][t2]).map((v) => lab(tq, v)).join(' · ')) + ' |'); }));
  });
  W(); W('## 3. שערים'); W();
  ROUTE.gates.forEach((g) => W('- ' + code(g.id) + ': ' + (g.topic ? 'תחום ' + tname(g.topic) : g.questions.join(', ')) + ' מוצג רק כאשר ' + pwords(g.show) + '. ' + g.why));
  W(); W('## 4. נקודות לאיש המקצוע'); W();
  W('- האם שאלות הפרופיל (מצב מגורים, משכנתה, מצב תעסוקתי, עבודה בשש שנות המס, המשפחה) מנוסחות נכון ואינן מבקשות מידע מיותר?');
  W('- האם רשימת האירועים בשאלת המשפחה מספקת, והאם ״מי״ מנוסחת באופן ברור?');
  W('- אילו מהשאלות הרגישות ראוי שיהיו רשות (כרגע ' + cfg6.questions.filter((q) => q.sensitive && !q.copyOf).length + ')?');
  W(); W('---'); W('*נוצר מ־scripts/gen-deep-review.js.*');
  fs.writeFileSync(path.join(dom, 'profile.md'), Q.join('\n') + '\n');
})();

// ---- the folder index ----
(function () {
  const Q = []; const W = (s) => Q.push(s === undefined ? '' : s);
  W('# חבילת הסקירה המקצועית של הבדיקה המעמיקה: אינדקס'); W();
  W('כל קובץ כאן עומד בפני עצמו ואפשר להעביר אותו לאיש/אשת המקצוע המתאימים. הכול נוצר אוטומטית מתוכן V6 (טיוטה, לא מפורסם) ומהנתיב.'); W();
  W('| קובץ | נושא | מי כדאי שיבדוק (הצעה) | כללים פעילים | מתוכם חלקיים |'); W('|---|---|---|---|---|');
  W('| [profile.md](profile.md) | הפרופיל ושאלות ״מי״ | מי שמכיר/ה את שאלון הפתיחה | — | — |');
  V6.forEach((t) => { const act = t.rules.filter((r) => r.status !== 'inactive'); W('| [' + t.id + '.md](' + t.id + '.md) | ' + t.name + ' | ' + (PRO[t.id] || '') + ' | ' + act.length + ' | ' + act.filter((r) => UNV[t.id + '.' + r.id]).length + ' |'); });
  fs.writeFileSync(path.join(dom, 'README.md'), Q.join('\n') + '\n');
})();

// =========================================================================================================================================
// the main document
// =========================================================================================================================================
P('# הבדיקה המעמיקה (תבדקו אותי לעומק): סקירת תוכן לאישורכם');
P();
P('**סטטוס:** מסמך סקירה לבעלי המוצר, נוצר מהקוד של הענף deep-5 (לא פורסם, לא מוזג). כל הטבלאות מחושבות אוטומטית מהנתיב ' + code('deep') + ' ב־' + code('kaspchem/content/routes.json') + ', מטיוטת V6 (לא מפורסמת) ומהמנוע, ונוצרות מחדש בפקודה ' + code('node scripts/gen-deep-review.js') + '. **כל הנוסח כאן הוא הצעה שלי לאישורכם; שום דבר לא מומצא מעבר לכללי V6 ולנוסח הקיים.**');
P();
P('## אינדקס החבילה');
P();
P('1. **המסמך הזה:** החלקים הכלליים (פרופיל ושאלות ״מי״, מנגנון הבדיקה לפי אדם וטבלת הסיווג של כל הכללים, שערים, רמות ונוסח, מוכנות להפעלה, החלטות שלכם).');
P('2. **התיקייה ' + code('deep-review-by-domain/') + ' (באותה תיקייה):** קובץ לכל תחום, מוכן להעברה לאיש/אשת מקצוע: ' + ['[profile](deep-review-by-domain/profile.md)'].concat(V6.map((t) => '[' + t.id + '](deep-review-by-domain/' + t.id + '.md)')).join(', ') + '. בכל קובץ: נוסח השאלות והתשובות, מתי כל שאלה נשאלת, כל כלל במילים (תנאים, כרטיס, למי נוגע, רמה), סטטוס האימות, ושאלות פתוחות לאיש המקצוע.');
P();
P('**בקצרה:** הבדיקה המעמיקה היא אותו מנוע כמו עשרת התחומים והבדיקה המהירה. היא שואלת פרופיל קצר פעם אחת, ממלאת מהפרופיל שאלות מקבילות במפורש בלבד, שואלת שאלות תחום רק כשרלוונטי, ו**בודקת גם בני משפחה**: כשהמשיב/ה מדווח/ת על אירוע של בן/בת זוג, ילד/ה או הורה, נשאלות עבורם שאלות העובדות של הכלל הקיים, והכללים הקיימים (ורק הם) נבדקים לפי תשובות אותו אדם. התוצאה: **סבירות גבוהה** (כל תנאי הכלל נכונים), **חסר מידע — כדאי להשלים בדיקה** (אף תנאי אינו שקרי אך חסרה תשובה, והיא נקראת בשמה ובשם האדם) ו**סבירות נמוכה** (מנגנון קיים אך כבוי: אין כלל חלש בנתיב). אין אחוזים, ואין ממצא שלא כתוב בכלל קיים. הבדיקה **כבויה כברירת מחדל** ואינה ניתנת להפעלה מהדשבורד עד שהיא מוכנה (סעיף 9). **זמן המילוי לא נמדד ואינו מובטח.**');
P();

// ---- 1 profile ----
P('## 1. שאלות הפרופיל ושאלות ״מי״ במלואן');
P();
P('הפרופיל: 5 שאלות בסיס. בנוסף ארבע שאלות ״מי״, אחת לכל תשובה בשאלת המשפחה שמשמעותה תלויה באדם (הפסיק לעבוד, נפגע או חולה, שירת במילואים, בגיל פרישה), **רק כשהתשובה נבחרה**. פירוט מלא: [deep-review-by-domain/profile.md](deep-review-by-domain/profile.md). שאלות ״מי״: מדובר בכם, בבן/בת הזוג, בילד/ה או בהורה (בחירה מרובה, עם ״מעדיפ/ה לא לענות״). **בחירה בכמה אנשים היא בחירה בכמה ״נושאים״: לכל אחד נשאלות שאלות העובדות בנפרד.**');
P();
ROUTE.profile.questions.forEach((q, i) => {
  const tq = q6['profile.' + q.id];
  P('### שאלה ' + (i + 1) + ': ' + q.text);
  P();
  P('- **מופיעה:** ' + (q.showIf ? 'רק כאשר נבחרה בשאלת המשפחה התשובה ״' + lab(q6['profile.' + q.showIf.q], q.showIf.in[0]) + '״' : 'תמיד'));
  if (q.help) P('- **הערת עזר:** ' + q.help);
  P('- **סוג:** ' + (q.multi ? 'בחירה מרובה' : 'בחירה אחת'));
  if (tq.sensitive) P('- **רגישה (רשות):** ״' + tq.sensitiveWhy + '״ ' + ROUTE.messages.sensitiveNote);
  P('- **תשובות:** ' + tq.options.map((o) => o.label + (o.exclusive ? ' (בלעדית)' : '')).join(' · '));
  P();
});

// ---- 2 per-person mechanism ----
P('## 2. בדיקה לפי אדם: המנגנון');
P();
P('**העיקרון:** כספכם עוזרת לכל המשפחה. כשמדווחים על אירוע של בן/בת זוג, ילד/ה או הורה, הבדיקה מחפשת גם זכויות והזדמנויות שרלוונטיות **לאותו אדם**, ומציגה ממצא **עבורו**, עם תווית ברורה (״עבור: בן/בת הזוג״). **לעולם לא מייחסים למשיב/ה זכות של אדם אחר**, ובאותה מידה **לא מעבירים ל״חסר מידע״ ממצא של בן משפחה** כשתנאי הכלל נענו.');
P();
P('**איך זה עובד (בנייה בעת טעינת התוכן, בלי לגעת במנוע הכללים):** לכל קבוצת אירוע נבנים עותקים של שאלות העובדות ושל הכללים לכל אדם שנבחר, עם מזהים כמו ' + code('national-insurance.stopfacts@spouse') + ' ו־' + code('national-insurance.ni-unemp@spouse') + '. **תנאי העותק הם תנאי הכלל המקורי, מוחלפים לעותקי השאלות של אותו אדם** (ושום תנאי אינו מוסף או מומצא). נוסח השאלה: ״עבור בן/בת הזוג: <הנוסח המקורי>״ ושורת עזר ״ענו לפי מצבו/ה של בן/בת הזוג, לא לפי מצבכם״. עותק שהיה צריך להישען על תשובה של המשיב/ה עצמו/ה נפסל בלינט. המשיב/ה (״אני״) נשאר עם השאלות והכללים המקוריים, והאירוע נחשב רק אם ״אני״ נבחר.');
P();
P('| אירוע (שאלת המשפחה) | אנשים | שאלות עובדות שנשאלות לכל אדם | שאלות נוספות לבני משפחה אחרים בלבד | כללים שנבדקים לכל אדם |');
P('|---|---|---|---|---|');
ROUTE.persons.groups.forEach((g) => {
  P('| ' + code(g.option) + ': ' + md(lab(q6[g.question], g.option)) + ' | ' + g.subjects.map((s) => SUBJ[s].label).join(' / ') + ' | ' + (g.factQuestions || []).map((x) => code(x)).join(', ') + ' | ' + ((g.copyOnly || []).map((x) => code(x)).join(', ') || '—') + (g.implies ? ' (האירוע עצמו הוא התשובה ' + Object.keys(g.implies).map((k) => code(k) + ' = ' + g.implies[k].join(',')).join('; ') + ')' : '') + ' | ' + g.rules.map((x) => code(x.split('.').slice(1).join('.'))).join(', ') + ' |');
});
P();
P('**שילובים:** ״אני״ + בן/בת זוג: שתי קבוצות שאלות ושני ממצאים נפרדים, והעובדות לעולם אינן משמשות את האדם האחר. **מידע חלקי** על בן משפחה: ״גבוהה״ רק אם כל תנאי הכלל ידועים ונכונים לו/לה; ״חסר מידע״ שמזכיר את השאלה ואת האדם כשהשאר לא ידוע ואף תנאי אינו שקרי; כלום אם תנאי שקרי. ״מעדיפ/ה לא לענות״ (בשאלת ״מי״ או בשאלת עובדות) הוא לא ידוע: לעולם לא ״לא״ ולעולם לא גבוה. אם ״מי״ נענתה ״מעדיפ/ה לא לענות״, כל הכללים של האירוע חסרי מידע, והתוצאה מציגה **כרטיס אחד ורגוע** (״חסרה תשובה אחת, והיא משפיעה על כמה תחומים בבדיקה״) עם הכפתור ״להשלמת התשובה״.');
P();

P('### טבלת סיווג של כל כללי V6 (כל התחומים)');
P();
P('מקרא: **משיב/ה** = נשען על מצב המשיב/ה בלבד; **אדם שהיה לו אירוע** = יש עותק לכל אדם שנבחר; **משק בית** = ילדים, דיור, חשבונות הבית (השאלות כבר שואלות על כולם); **אדם אחר** = האדם שתואר בשאלה עצמה (למשל מי שזקוק לעזרה). ״נתמך לפי אדם״ = יש עותקים, כי תנאי הכלל עצמו ושאלות שהבדיקה יכולה לשאול עליו/ה תומכים בכך. אחרת: לא ניחשנו, וההסבר בעמודה האחרונה.');
P();
P('| תחום | כלל | כותרת הכרטיס | סיווג | נתמך לפי אדם | שאלות שנשאלות לכל אדם | מה הכרטיס מציג | הסבר |');
P('|---|---|---|---|---|---|---|---|');
V6.forEach((t) => ruleList(t).filter((x) => x.r.status !== 'inactive').forEach((x) => {
  const id = t.id + '.' + x.id, c = ROUTE.persons.classes[id] || {}, g = groupsFor(id)[0], bid = t.id + '.' + x.r.id;
  P('| ' + t.name + ' | ' + code(x.id) + ' | ' + md(x.r.finding.title) + ' | ' + (CLS[c.class] || '—') + ' | ' + (g ? 'כן (' + g.subjects.filter((s) => s !== 'me').map((s) => SUBJ[s].label).join(', ') + ')' : 'לא') + ' | ' + (g ? (g.factQuestions || []).concat(g.copyOnly || []).map((q) => code(q.split('.').slice(1).join('.'))).join(', ') : '—') + ' | ' + (g ? 'כרטיס עם ״עבור: <אדם>״ לכל אדם שעומד בתנאים' : (c.class === 'other-person' ? 'כרטיס על האדם שתואר בשאלה' : 'כרטיס רגיל')) + ' | ' + md(c.why) + (UNV[bid] ? ' **(לא מאומת: ' + md(UNV[bid]) + ')**' : '') + ' |');
}));
P();
P('**סיכום:** ' + (() => { const cnt = {}; Object.keys(ROUTE.persons.classes).forEach((k) => { const c = ROUTE.persons.classes[k].class; cnt[c] = (cnt[c] || 0) + 1; }); return Object.keys(cnt).map((c) => CLS[c] + ': ' + cnt[c]).join(' | '); })() + '. (61 כללים פעילים: כלל נכות כללית מפוצל לשניים, ענף הבריאות וענף העזרה.)');
P();
P('**כללים שאין להם עותק לפי אדם, ולמה (החלטה שלא לנחש):** מענק העבודה (תנאיו נשענים על ילדים, גיל והכנסה של המשיב/ה, ואין בשאלת המשפחה אירוע שמתאים להם), תלוש השכר הנוכחי (עבודה נוכחית), ביטוחים וחיסכון פנסיוני (השאלה ״ענו לגבי אדם אחד: אתם עצמכם״), בנקאות, וכל כללי הלימודים והעבודה (שאלת ״מישהו מבני המשפחה״ כבר משפחתית, בלי ״מי״). בכולם אין תנאי של הכלל שאפשר לבדוק על בן משפחה בשאלות שהבדיקה שואלת, ולכן הבדיקה אינה מציגה ממצא לבן משפחה ואינה מניחה שיש. **מה שחסר מוצג במפורש כשיש שאלה חסרה; כשאין בכלל שאלה כזו, הדבר מתועד כאן בלבד.**');
P();

// ---- facts + gates ----
P('## 3. מה כל תשובת פרופיל ממלאת (עובדות מוצהרות)');
P();
P('| שאלת פרופיל | תשובה | שאלת תחום שממולאת | תשובה בתחום |');
P('|---|---|---|---|');
ROUTE.facts.forEach((f) => {
  if (!cfg6.derive.some((d) => d.id === f.id)) return;
  const pq = q6[f.from];
  Object.keys(f.map).forEach((o) => Object.keys(f.map[o]).forEach((t2) => { const tq = q6[t2]; P('| ' + md(pq.text) + ' | ' + md(lab(pq, o)) + ' | ' + code(t2) + ' ' + md(tq.text.slice(0, 50)) + ' | ' + md([].concat(f.map[o][t2]).map((v) => lab(tq, v)).join(' · ')) + ' |'); }));
});
P();
P('כל שורה היא הצהרה מפורשת: ״תשובת הפרופיל הזו היא תשובה זו בשאלת התחום״. שאלה ממולאת לא נשאלת שוב. **עובדות שנגזרות מהפרופיל הן רק על המשיב/ה** (עבודה כיום, עבודה בשש שנות המס) או ברמת המשפחה (שאלת המשפחה ← ' + code('national-insurance.now') + '): תשובה על בן משפחה אחר אינה ממלאת שאלה של המשיב/ה.');
P();
P('## 4. שערי רלוונטיות');
P();
P('| שער | מסתיר | מוצג רק כש… | הסיבה |');
P('|---|---|---|---|');
ROUTE.gates.forEach((g) => P('| ' + code(g.id) + ' | ' + md(g.topic ? 'כל תחום ' + tname(g.topic) : g.questions.join(', ')) + ' | ' + md(pwords(g.show)) + ' | ' + md(g.why) + ' |'));
P();
P('**שער ביטוח הדירה (g-homeins): הוסר** (בסבב הקודם). ביטוח תכולה אינו תלוי בחיוב ארנונה, ואין ב־V6 אפשרות ״אין לי בכלל דירה״; לכן השאלה נשאלת בכל מצב מגורים. **שער זכויות עובדים (g-payslip):** מוסתר רק מעצמאי/ת או גמלאי/ת שלא עבדו כשכירים בשש השנים; כל השאר נשאלים (ייתכן שסיימו עבודה לאחרונה). נבדק בטסט לכל צירוף. עותקי השאלות לפי אדם אינם נתונים לשער (הם נוגעים לבן משפחה, לא למצבו של המשיב/ה).');
P();

// ---- 5 sensitive ----
P('## 5. שאלות רגישות: הסט הסופי');
P();
P('כולן רשות עם ״מעדיפ/ה לא לענות״ (= לא ידוע, לא ״לא״) ושורה ניטרלית שמסבירה למה שואלים. נשאלות רק כי כלל פעיל תלוי בהן (הלינט נכשל אחרת). **הסט (' + cfg6.questions.filter((q) => q.sensitive && !q.copyOf).length + '):** ' + cfg6.questions.filter((q) => q.sensitive && !q.copyOf).map((q) => code(q.id)).join(', ') + '. כל עותק לפי אדם של שאלה רגישה רגיש באותה מידה.');
P();
P('| שאלה | נוסח | למה שואלים (השורה שמוצגת) |');
P('|---|---|---|');
cfg6.questions.filter((q) => q.sensitive && !q.copyOf).forEach((q) => P('| ' + code(q.id) + ' | ' + md(q.text) + ' | ' + md(q.sensitiveWhy) + ' |'));
P();

// ---- 6 tiers and wording ----
P('## 6. רמות, כותרות ונוסח (כל המחרוזות לאישור)');
P();
P('**שלוש רמות** (השמות מדויקים): **' + ROUTE.messages.highTitle + '** (שורה מתחת: ״' + ROUTE.messages.highSub + '״), **' + ROUTE.messages.missingTitle + '**, **' + ROUTE.messages.lowTitle + '** (המנגנון והתצוגה קיימים בקוד אך **כבויים**: אין כלל חלש בנתיב, ולכן הרמה הזו לא מופיעה לעולם). כותרת העמוד ניטרלית: ״' + ROUTE.messages.resultTitle + '״, ושורת הספירה מתחתיה (״N נושאים בסבירות גבוהה שכדאי לבדוק״). **חלקי כרטיס:** ' + ROUTE.messages.partGet + ' / ' + ROUTE.messages.partHow + ' / ' + ROUTE.messages.partHelp + ' (שונה מ״מה אפשר לקבל״). **תווית אדם בכרטיס:** ״' + ROUTE.messages.subjectLine + '״ ו־״' + ROUTE.messages.subjectNote + '״ (לבן משפחה אחר בלבד).');
P();
P('**קובייה בדף הבית:** ״תבדקו אותי לעומק״ / ״' + ROUTE.tagline + '״. **פתיח:** ' + ROUTE.intro);
P();
P('| מפתח | נוסח |');
P('|---|---|');
Object.keys(ROUTE.messages).forEach((k) => P('| ' + code(k) + ' | ' + md(ROUTE.messages[k]) + ' |'));
P();
P('**נוסח של כללי V6 עצמם (לא שלנו):** 20 שדות בכללי V6 משתמשים במילה ״זכאות״ (כמעט תמיד בצורה ״כדאי לבדוק זכאות ל…״) או ״מאושר״ במובן ניטרלי. הם מנוסחים כבדיקה ולא כקביעה; רשימה קבועה בטסט כדי שחדש יעורר תשומת לב.');
P();

// ---- 7 path length ----
const hist = (s) => Object.keys(s.histogram).map(Number).sort((a, b) => a - b).map((k) => k + ':' + s.histogram[k]).join(' ');
const asked = (over) => Object.keys(walk(cfg6, Object.assign({}, BASE, over))).length;
P('## 7. אורך מסלול (מספר השאלות שהמשיב עונה עליהן)');
P();
P('| תוכן | מינימום אפשרי | **מקסימום אפשרי** | חציון (משיבים מדומים) | ממוצע | אחוזון 90 |');
P('|---|---|---|---|---|---|');
P('| V6 (הטיוטה) | ' + s6.exactMin + ' | **' + s6.exactMax + '** | ' + s6.median + ' | ' + s6.mean + ' | ' + s6.p90 + ' |');
P('| עשרת התחומים הישנים (מצב בדיקה בלבד) | ' + s1.exactMin + ' | **' + s1.exactMax + '** | ' + s1.median + ' | ' + s1.mean + ' | ' + s1.p90 + ' |');
P();
P('המקסימום והמינימום מחושבים **במדויק** על כל צירופי התשובות (לא דגימה). **המקסימום ' + s6.exactMax + ' הוא המקרה הקיצוני** שבו נבחרים כל ארבעת האירועים לכל האנשים האפשריים; הוא גדל מ־52 (לפני שאלות לפי אדם) כי כל אדם נוסף מוסיף שאלות עובדות. החציון והממוצע הם מ־6,000 משיבים מדומים (בחירה אחידה בבחירה אחת, וכל אפשרות בבחירה מרובה בהסתברות 0.3, כלומר משפחות עמוסות יותר מהרגיל). **דוגמאות:** מסלול בלי אירועים משפחתיים: ' + asked({ 'profile.family': ['none'] }) + ' שאלות; אירוע אחד של המשיב/ה (פרישה, ״אני״): ' + asked({ 'profile.family': ['retire'], 'profile.who_retire': ['me'] }) + '; אירוע אחד של בן/בת זוג: ' + asked({ 'profile.family': ['retire'], 'profile.who_retire': ['spouse'] }) + '; בן/בת זוג שהפסיקו לעבוד (שאלות התלוש האחרון ונוספות): ' + asked({ 'profile.family': ['stopped'], 'profile.who_stopped': ['spouse'] }) + '; אני ובן/בת זוג שהפסיקו לעבוד: ' + asked({ 'profile.family': ['stopped'], 'profile.who_stopped': ['me', 'spouse'] }) + '. התפלגות V6 (שאלות:משיבים): ' + hist(s6) + '. **זמן מילוי: לא נמדד, ואין בבדיקה הבטחת זמן.** לא נוספו שאלות לשום מטרה אחרת מלבד בדיקה לפי אדם.');
P();

// ---- 8 examples ----
P('## 8. הרמות בפועל: דוגמאות שהרצתי במנוע');
P();
P('כל דוגמה היא מסלול מלא על טיוטת V6. התוצאה היא מה שהמנוע מחזיר (לא נכתב ידנית). שאלות שלא פורטו נענו בתשובה הראשונה ברשימה, או ״אף אחד מאלה״ בבחירה מרובה.');
P();
PERSONAS.forEach((p) => {
  const a = walk(cfg6, Object.assign({}, BASE, p.over)), s = show(cfg6, a);
  P('### ' + p.name);
  P();
  P('- שאלות שנענו: **' + s.asked + '**');
  P('- **סבירות גבוהה (' + s.r.counts.highCards + '):** ' + s.high);
  P('- **חסר מידע — כדאי להשלים בדיקה (' + s.r.counts.missingItems + ' פריטים, ' + s.r.counts.missingCards + ' נושאים):** ' + s.missing);
  P();
});
P('**כלל ברזל שנבדק בטסט:** (1) כשכל התשובות ידועות, רמת הסבירות הגבוהה ברמת המשיב/ה שווה **בדיוק** לממצאי כל תחום בנפרד (V6 ועשרת התחומים, 4,000 מסלולים). (2) **לכל אדם שנבחר ולכל כלל בקבוצה, יש ממצא גבוה עבורו אם ורק אם הכלל המקורי, במנוע התחום הבודד, מתקיים על העובדות של אותו אדם** (4,000 מסלולים): אף ממצא לא הוחמץ ואף ממצא לא הומצא, ואין ממצא לאדם שלא נבחר.');
P();

// ---- 9 unverified / readiness ----
P('## 9. מוכנות להפעלה, וכללים שאינם מאומתים');
P();
P('הבדיקה **כבויה לציבור** ו**אינה ניתנת להפעלה** עד שכל שלושת התנאים מתקיימים. הדשבורד (לשונית הגדרות) מציג רשימת בדיקה, מנטרל את המתג ומסביר מה חסר; השרת מסרב (409, בלי לכתוב כלום). כיבוי תמיד מותר ומיידי.');
P();
P('| תנאי | מצב כרגע | איך משתנה |');
P('|---|---|---|');
P('| תוכן V6 מפורסם והתחומים הנדרשים זמינים | נבדק מול התוכן המוגש (כרגע: עשרת התחומים הישנים ← **לא מתקיים**) | פרסום V6 |');
P('| כל כללי V6 הרלוונטיים אומתו מקצועית | **לא מתקיים** (' + ROUTE.unverified.length + ' כללים ברשימה) | הסרת כל הכללים מהרשימה ' + code('unverified') + ' בנתיב, אחרי אימות |');
P('| נוסח הבדיקה אושר על ידי הבעלים | **לא מתקיים** (' + code('approved: ' + ROUTE.approved) + ') | שינוי ' + code('approved') + ' ל־true בנתיב, כשינוי מפורש (לא מכפתור) |');
P();
P('**13 הכללים החלקיים (נרשמו בנתיב כ־unverified עם סיבה):**');
P();
P('| כלל | סיבה |');
P('|---|---|');
ROUTE.unverified.forEach((u) => P('| ' + code(u.id) + ' | ' + md(u.reason) + ' |'));
P();
P('הם פעילים בבדיקה המעמיקה בדיוק כפי שהם פעילים בבדיקת התחום, ואינם מוצגים כמאומתים. בדשבורד, בפנייה של בדיקה מעמיקה, ממצא מכלל כזה מסומן ״כלל לא מאומת״.');
P();
P('### הנתיב דורש תוכן מסוים (requires), ומה קורה כשחסר');
P();
P('הנתיב מצהיר מה הוא דורש: עשרת התחומים וגם צורות שאלה של V6 (' + ROUTE.requires.filter((r) => r.indexOf('.') !== -1).map((r) => code(r)).join(', ') + '). אם משהו חסר, הבדיקה אינה זמינה (לציבור: כמו מתג כבוי; בדפדפן עם נתיב חסר: ״הבדיקה המעמיקה אינה זמינה כרגע״ + ״נסו שוב״). אין הרצה חלקית בייצור; מצב מצומצם קיים רק לבדיקות. כשהתוכן לא נטען (שגיאה, 15 שניות, תשובה לא תקינה): ״לא הצלחנו לטעון את הבדיקה״ + ״נסו שוב״ + קישור לדף הראשי; בלי תוכן או תוצאה חלקיים.');
P();

// ---- 10 mybenefits ----
P('## 10. מה נלקח כהשראה מהשאלון הממשלתי (mybenefits) ומה לא');
P();
P('יש לי הקלטה של **מסלול אחד** בלבד, בלי מיפוי הסתעפויות. לכן לקחתי רק רעיונות של חוויה, ולא נוסח.');
P();
P('| רעיון | איפה בבדיקה המעמיקה | הערה |');
P('|---|---|---|');
P('| שאלות המשך מותנות | showIf של שאלות התחום, ושאלות ״מי״ | כל שאלה קיימת כי כלל שלנו תלוי בה |');
P('| בחירה מרובה בקבוצות | group (תצוגה בלבד) | כותרות קבוצה מעל תשובות |');
P('| הסבר ליד תשובה | hint (תצוגה בלבד) | משפטים שכבר קיימים בטיוטת V6 |');
P('| חזרה ודילוג | חזרה + ״דילוג על השאלה״ = ״לא יודע/ת״ או ״מעדיפ/ה לא לענות״ | מוצג רק כשיש תשובה כזו |');
P('| ספירה רצה של זכויות אפשריות | ״כרגע N נושאים שכדאי לבדוק״ | מהרמה הגבוהה בלבד, בלי סכום ובלי הבטחה |');
P('| פיצול סופי לרמות | סבירות גבוהה / חסר מידע / סבירות נמוכה (כבויה) | |');
P('| לכל זכות: מה כדאי לבדוק, איך, מי עוזר | שלושת חלקי הכרטיס | ממופים משדות קיימים |');
P('| בדיקה לכל המשפחה | שאלות ״מי״ וממצאים עם ״עבור: <אדם>״ | רק כללי V6 קיימים, לפי תנאיהם |');
P();
P('**מה לא הועתק:** אף שאלה, אף נוסח, אף סדר שאלות של השאלון הממשלתי.');
P();

// ---- 11 similar terms ----
P('## 11. בדיקת מונחים דומים');
P();
const coll6 = E.idCollisions(V6);
P('### 11.1 אותו מזהה, שאלות שונות');
P();
P('מזהים מקומיים שמופיעים בכמה תחומים ב־V6: ' + coll6.map((c) => code(c.id) + ' (' + c.topics.join(', ') + ')' + (c.same ? ' [אותה שאלה]' : ' [שאלות שונות]')).join('; ') + '. **המנוע לא ממזג אותם:** כל שאלה מזוהה כ־תחום.שאלה, ושיתוף בין תחומים רק דרך עובדה מוצהרת. עותקי השאלות לפי אדם מקבלים סיומת ' + code('@אדם') + ' ואינם מתערבבים עם שאלות המשיב/ה.');
P();
[
  ['11.2 ״מה מצבכם התעסוקתי״ כיום מול ״איך עבדתם בשש שנות המס האחרונות״', 'שתי שאלות שונות במכוון: הראשונה ממלאת את תלושי השכר (שכיר/ה כיום, עצמאי/ת אחר), השנייה את המסים ואת שער תלוש השכר. אין מיפוי ביניהן.'],
  ['11.3 ״גמלאי/ת״ בפרופיל מול ״אדם שהגיע לגיל הפרישה״ במשפחה', '״גמלאי/ת״ בפרופיל אינו ממלא את שאלת המשפחה. מי שבחר ״יש במשפחה אדם בגיל פרישה״ נשאל ״מי״; ״אני״ הופך את הכלל לכלל על המשיב/ה, ו״בן/בת זוג״ או ״הורה״ מציגים ממצא עבורם.'],
  ['11.4 ״הפסיק לעבוד״ מול ״פיטורים״ וסיום העסקה', 'האירוע בשאלת המשפחה (״הפסיק לעבוד כשכיר/ה או כעצמאי/ת״) מזין דמי אבטלה והבטחת הכנסה (ביטוח לאומי) ואת שאלות התלוש האחרון וימי החופשה (תלושי שכר) עבור האדם; המסים אינם מוזנים ממנו כי אין תשובה זהה בשאלת האירועים של המסים.'],
  ['11.5 שירות מילואים ב־3 מקומות', 'האירוע המשפחתי ״שירת במילואים בשנה האחרונה״ הוא בהכרח גם התשובה ״שירתי במילואים״ בשאלת האירועים של המסים (שש שנים כוללות שנה אחת), ולכן מזין את כלל ההחזר ואת תגמולי המילואים לאדם.'],
  ['11.6 ״ילדים״ בכמה גבולות גיל', 'ביטוח לאומי: מתחת ל־18; מענק עבודה: מתחת ל־19 בשנת המס; דיור: ילד במעון. שלושה גבולות שונים בחוק ולכן אין שאלת פרופיל אחת על ילדים.'],
  ['11.7 ״לא בטוח/ה״ מול ״לא יודע/ת״ מול ״מעדיפ/ה לא לענות״', 'שלושתן לא ידוע (חסר מידע). בשאלות עובדה רגילות יש ״לא יודע/ת״ או ״לא בטוח/ה״ (הנוסח של V6), ובשאלה רגישה נוספה ״מעדיפ/ה לא לענות״.']
].forEach((p) => { P('### ' + p[0]); P(); P('- ' + p[1]); P(); });

// ---- 12 decisions ----
P('## 12. החלטות שלכם');
P();
[
  '**אישור הנוסח** בסעיפים 1, 2, 5 ו־6: שאלות הפרופיל ושאלות ״מי״, נוסח שאלות העובדות לבן משפחה (״עבור בן/בת הזוג: …״ והמשפט ״ענו לפי מצבו/ה…״), תוויות הכרטיס, כותרות הרמות.',
  '**סיווג הכללים** (טבלת סעיף 2): במיוחד שדמי אבטלה, פגיעה בעבודה, נכות (ענף הבריאות), מילואים וקצבת זקנה נבדקים **לכל אדם שנבחר**, והחזר המס (tx-jobs) לבן משפחה רק כשהאירוע הוא מילואים.',
  '**כללים שאין להם עותק לפי אדם** (מענק עבודה, תלוש נוכחי, ביטוחים, בנקאות, לימודים ועבודה): האם להוסיף שאלה שתאפשר זאת? זה ידרוש תנאי בכלל עצמו או שאלת סינון חדשה, ולכן לא נעשה בלי החלטה.',
  '**חבילת הסקירה המקצועית** (התיקייה deep-review-by-domain): אילו אנשי מקצוע לשלוח לכל תחום (ההצעות בקבצים הן שלי).',
  '**מוכנות להפעלה:** שלושת התנאים בסעיף 9. כל עוד ' + ROUTE.unverified.length + ' כללים לא מאומתים והנוסח לא אושר, אי אפשר להפעיל מהדשבורד.',
  '**אורך מסלול:** מקסימום ' + s6.exactMax + ' שאלות במקרה הקיצוני (כל האירועים לכל האנשים); חציון ' + s6.median + ' (משיבים מדומים). **זמן מילוי לא נמדד ולא מובטח.**'
].forEach((d, i) => P((i + 1) + '. ' + d));
P();
fs.writeFileSync(path.join(rawDir, 'DEEP-CHECK-CONTENT-REVIEW.md'), lines.join('\n') + '\n');
console.log('written', rawDir, '| main', lines.length, 'lines | domains', V6.length + 1, 'files | V6 questions', cfg6.questions.length, '| exact path', s6.exactMin + '..' + s6.exactMax);
