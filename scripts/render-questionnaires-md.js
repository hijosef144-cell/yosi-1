// Renders a questionnaire draft JSON as a readable Hebrew markdown spec (questions, branching, rules, result content, sources).
// Usage: node scripts/render-questionnaires-md.js docs/research/drafts/ALL-v2.draft.json docs/research/QUESTIONNAIRES-V2.md
const fs = require('fs');
const E = require('../kaspchem/assets/engine.js');
const [inFile, outFile] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const stats = require('child_process').execFileSync('node', [require('path').join(__dirname, 'analyze-questionnaires.js'), inFile, '--json'], { encoding: 'utf8' });
const S = Object.fromEntries(JSON.parse(stats).map((r) => [r.topic, r]));

function cond(t, c) {
  if (!c) return 'תמיד';
  if (c.all) return c.all.map((x) => cond(t, x)).join(' וגם ');
  if (c.any) return '(' + c.any.map((x) => cond(t, x)).join(' או ') + ')';
  if (c.not) return 'לא (' + cond(t, c.not) + ')';
  const q = t.questions.find((x) => x.id === c.q);
  const labels = (c.in || []).map((id) => ((q && q.options.find((o) => o.id === id)) || { label: id }).label);
  return `«${q ? q.text.replace(/\?$/, '') : c.q}» = ${labels.join(' / ')}`;
}
const conf = { verified: 'אומת', partial: 'אומת חלקית', unverified: 'לא אומת' };
let md = `# הצעת שאלונים משופרים: כספכם (טיוטה, לא פורסמה)\n\nנוצר אוטומטית מ-\`${inFile}\`. אין לפרסם לפני סקירת המחקר ואישור. כל כלל מציין מקור, רמת אימות ושלב המשך. אין סכומים ואין הבטחות; כל ממצא הוא "כדאי לבדוק/לברר".\n\n`;
md += '## סטטיסטיקת נתיבים (כל שילובי התשובות, משקל שווה)\n\n| תחום | נתיבים | שאלות לנתיב | זוהה / חסר מידע / לא זוהה | ממצאים ממוצע |\n|---|---|---|---|---|\n';
data.topics.forEach((t) => { const s = S[t.id]; md += `| ${t.name} | ${s.paths} | ${s.qPerPath.min}–${s.qPerPath.max} (ממוצע ${s.qPerPath.avg}) | ${s.outcomePct.found}% / ${s.outcomePct.insufficient}% / ${s.outcomePct.none}% | ${s.avgFindings} |\n`; });
md += '\n';
data.topics.forEach((t, i) => {
  md += `\n---\n\n## ${i + 1}. ${t.name}\n\n_${t.tagline || ''}_\n\n**פתיח:** ${t.intro || ''}\n\n### שאלות\n\n`;
  t.questions.forEach((q, n) => {
    md += `${n + 1}. **${q.text}**${q.help ? ` _(עזרה: ${q.help})_` : ''}\n`;
    md += `   - מוצגת אם: ${cond(t, q.showIf)}\n`;
    md += `   - תשובות: ${q.options.map((o) => o.label + (o.unknown ? ' (לא בטוח/ה)' : '')).join(' | ')}\n`;
  });
  md += '\n### כללי זיהוי ותוכן התוצאה\n\n';
  (t.rules || []).forEach((r) => {
    const f = r.finding || {};
    md += `- **${f.title}** \`${r.id}\`\n  - מתי: ${cond(t, r.when)}\n  - הסבר למשתמש: ${f.why}\n`;
    if (f.step) md += `  - צעד מעשי: ${f.step}\n`;
    if (f.official) md += `  - מסלול רשמי להגשה עצמית: [${f.official.label}](${f.official.url})\n`;
    if (f.refer) md += `  - הפניה להמשך טיפול: ${f.refer}\n`;
    if (r.source) md += `  - מקור: ${r.source.url || '—'} · נבדק ${r.source.checked || '—'} · ${conf[r.source.confidence] || r.source.confidence || '—'}${r.needsFollowUp ? ' · דרוש המשך בדיקה: ' + (typeof r.needsFollowUp === 'string' ? r.needsFollowUp : 'כן') : ''}\n`;
  });
  const m = t.messages || {};
  md += `\n### מסכי תוצאה אחרים\n\n- **חסר מידע:** ${m.insufficient || ''} — ${m.insufficientBody || ''}\n- **לא זוהה:** ${m.none || ''} — ${m.noneBody || ''}\n`;
  const lint = E.lint(t); if (lint.length) md += `\n> שגיאות lint: ${lint.join('; ')}\n`;
});
fs.writeFileSync(outFile, md);
console.log('wrote', outFile, md.length, 'chars');
