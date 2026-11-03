// Flags user-facing copy that refers to questions, options or concepts that do not exist in the topic's current questionnaire.
// Usage: node scripts/check-copy-refs.js <ALL.draft.json> [--info]
//   exit code 1 when a FLAG is found (INFO lines are for manual review and never fail the run).
// What it checks, per topic (intro, question help/text, option labels, rule finding title/why/step/refer/official.label, messages):
//   1. CONCEPTS - a concept phrase (e.g. interest track, linkage, loan date, plan age) used in the copy when NO question/option of the
//      topic mentions that concept (the typical leftover after a question was deleted).
//   2. QUOTED ANSWERS - a quoted phrase that looks like an answer label ("not sure", "none of these", "other"...) that is not an existing
//      option label of the topic.
//   3. DEAD MESSAGES - an insufficient/insufficientBody message in a topic that has no "unknown" option (the message can never be shown).
//   4. REMOVED QUESTION IDS - any mention of a question id that exists in the archive (drafts-*/ARCHIVED-RULES.json) but not in the topic.
//   5. INFO - references to other questions ("the next question", "asked separately") for a human to confirm.
const fs = require('fs');
const path = require('path');

const file = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/check-copy-refs.js <ALL.draft.json> [--info]'); process.exit(2); }
const showInfo = process.argv.includes('--info');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// concept -> regex that detects the concept in free text. A concept is "supported" when a question text/help/option label matches it.
const CONCEPTS = [
  { name: 'סוג/מסלול ריבית', re: /(סוג|מסלול|מסלולי|סוגי) (ה)?ריבית|ריבית (קבועה|משתנה|פריים)|פריים/ },
  { name: 'מסלולי המשכנתה', re: /כל המסלולים|מסלולי המשכנתה|מסלולי המשכנתא|מסלולים של המשכנתה/ },
  { name: 'הצמדה', re: /הצמדה|צמוד(ה|ים)? למדד|צמודה/ },
  { name: 'מועד נטילת הלוואה/משכנתה', re: /מתי נלקח(ה)?|שנת (נטילת|לקיחת)|מועד (נטילת|לקיחת)|כמה שנים (עברו|יש) (מאז|למשכנתה)/ },
  { name: 'גיל פוליסה/חבילה/תוכנית', re: /גיל (ה)?(פוליסה|חבילה|תוכנית|משכנתה|משכנתא)|פוליסה ותיקה|חבילה ותיקה|חבילה ישנה/ },
  { name: 'חיוב מתחדש/חוזר', re: /חיוב (מתחדש|חוזר|קבוע) (מדי|כל) / },
  { name: 'מספר קווי סלולר', re: /מספר (ה)?קווים|כמה קווים/ },
  { name: 'מחזיק בחשבון (סטטוס)', re: /מחזיק (ב)?חשבון|בעל החשבון הוא/ },
  { name: 'מקורות/גורמים כלליים', re: /מאיזה גורמים|ממה גורמים|כמה גורמים מבטחים/ }
];
// phrases that look like an answer label when quoted
const ANSWERISH = /^(לא (בטוח|יודע|זוכר|בטוחים)|אף (אחד|אחת)|אחר|לא\b|כן\b)/;
// quoted official names that are NOT answers (extend when a legitimate quoted name triggers a flag)
const QUOTE_OK = /הר (ה)?(ביטוח|כסף)|ביטוחי הבריאות שלי|חסר דירה|ממדים|יד מכוונת|מי משלם|חיסכון לכל ילד|זהות|בודק|מענק|בקשה|הגשה|השוואה|סימולטור|ריסק|הצעה|אישור עקרוני|הבטחת הכנסה|הכנסה נמוכה|פעוט|קרוב|מוגבלות|ארנונה|ביטוח|דוח|קרן|תכולה|מבנה|חבר/;

const norm = (s) => String(s || '').replace(/[״"'׳`“”„]/g, '').replace(/[.,;:!?()]/g, ' ').replace(/\s+/g, ' ').trim();
let flags = 0; let infos = 0;
const out = (kind, topic, where, msg) => { if (kind === 'FLAG') flags++; else { infos++; if (!showInfo) return; } console.log(`${kind} [${topic}] ${where}: ${msg}`); };

// removed ids from archives (if present next to the file or in sibling drafts-v4)
const removedIds = new Set();
['drafts-v4', 'drafts-v5', path.basename(path.dirname(file))].forEach((d) => {
  const p = path.join(path.dirname(path.dirname(file)), d, 'ARCHIVED-RULES.json');
  try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); (Array.isArray(a) ? a : (a.rules || a.archived || [])).forEach((x) => { if (x && x.id) removedIds.add(x.id); }); if (a.questions) (Array.isArray(a.questions) ? a.questions : []).forEach((x) => { if (x && x.id) removedIds.add(x.id); }); } catch (e) { /* optional */ }
});

data.topics.forEach((t) => {
  const qTexts = [];
  t.questions.forEach((q) => { qTexts.push(q.text || '', q.help || '', q.encourage || ''); q.options.forEach((o) => qTexts.push(o.label || '')); });
  const qBlob = qTexts.join(' \n ');
  const labels = []; t.questions.forEach((q) => q.options.forEach((o) => labels.push(norm(o.label))));
  const hasUnknown = t.questions.some((q) => q.options.some((o) => o.unknown));
  const qids = new Set(t.questions.map((q) => q.id));

  // copy that appears on the result screen or around the questions (not question text itself)
  const copy = [];
  copy.push(['intro', t.intro]);
  t.questions.forEach((q) => { copy.push(['help:' + q.id, q.help]); copy.push(['encourage:' + q.id, q.encourage]); });
  Object.entries(t.messages || {}).forEach(([k, v]) => copy.push(['messages.' + k, v]));
  t.rules.forEach((r) => {
    const f = r.finding || {};
    ['title', 'why', 'step', 'refer'].forEach((k) => copy.push([r.id + '.' + k + (r.status === 'inactive' ? ' (inactive)' : ''), f[k]]));
    if (f.official) copy.push([r.id + '.official.label', f.official.label]);
  });

  // 1. concepts
  copy.forEach(([where, text]) => {
    if (!text) return;
    CONCEPTS.forEach((c) => {
      if (c.re.test(text) && !c.re.test(qBlob)) out('FLAG', t.id, where, `mentions "${c.name}" but no question/option in this topic does ("${(text.match(c.re) || [''])[0]}")`);
    });
  });

  // 2. quoted answers
  copy.forEach(([where, text]) => {
    if (!text) return;
    const re = /[״"“]([^״"”]{2,60})[״"”]/g; let m;
    while ((m = re.exec(text))) {
      const p = norm(m[1]);
      if (!ANSWERISH.test(p) || QUOTE_OK.test(p)) continue;
      if (!labels.some((l) => l === p || l.indexOf(p) !== -1 || p.indexOf(l) !== -1)) out('FLAG', t.id, where, `quotes an answer "${m[1]}" that is not an option label in this topic`);
    }
  });

  // 2b. near-miss quotes: every word of the quote appears in ONE option label, but the quote is not a contiguous part of it (a shortened, stale quote)
  copy.forEach(([where, text]) => {
    if (!text) return;
    const re = /[״"“]([^״"”]{4,80})[״"”]/g; let m2;
    while ((m2 = re.exec(text))) {
      const p = norm(m2[1]); const toks = p.split(' ').filter((w) => w.length > 1); if (toks.length < 2) continue;
      if (labels.some((l) => l.indexOf(p) !== -1)) continue;
      const hit = labels.find((l) => toks.every((w) => l.indexOf(w) !== -1));
      if (hit) out('FLAG', t.id, where, `quote "${m2[1]}" is a shortened form of the option "${hit}" (quote the option as written)`);
    }
  });

  // 3. dead messages
  const m = t.messages || {};
  if (!hasUnknown && (m.insufficient || m.insufficientBody)) out(/ענית|סימנת/.test(m.insufficientBody || '') ? 'FLAG' : 'INFO', t.id, 'messages.insufficient*', 'topic has no "unknown" option, so the insufficient message can never be shown' + (/ענית|סימנת/.test(m.insufficientBody || '') ? ' and it claims the user answered something (remove the claim or add a real unknown option)' : ' (harmless generic text; keep it neutral)'));
  if (hasUnknown && !m.insufficientBody) out('INFO', t.id, 'messages.insufficientBody', 'topic has unknown options but no insufficientBody');

  // 4. removed ids
  removedIds.forEach((id) => {
    if (qids.has(id) || t.rules.some((r) => r.id === id)) return;
    const idRe = new RegExp('(^|[^\\w-])' + id.replace(/[-]/g, '\\-') + '($|[^\\w-])');
    copy.forEach(([where, text]) => { if (text && idRe.test(text)) out('FLAG', t.id, where, `mentions removed id ${id}`); });
  });

  // 5. info: cross-question references
  copy.concat(t.questions.map((q) => ['text:' + q.id, q.text])).forEach(([where, text]) => {
    if (!text) return;
    const re = /(בשאלה (הבאה|הקודמת|על|הזו|הזאת)|נשאלי?ם בנפרד|בשאלון|ענית|ענו על|סימנתם|סימנת)/g; let mm;
    while ((mm = re.exec(text))) out('INFO', t.id, where, `refers to the questionnaire: "…${text.slice(Math.max(0, mm.index - 15), mm.index + 45)}…" (confirm it matches the current questions)`);
  });
});

console.log(`\ncheck-copy-refs: ${flags} flag(s), ${infos} info line(s)${showInfo ? '' : ' (run with --info to list)'} in ${path.basename(file)}`);
process.exit(flags ? 1 : 0);
