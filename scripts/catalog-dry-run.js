'use strict';
// A DRY RUN of the sheet import, on your own computer. It reads ONE csv file (the data tab of the sheet, exported as CSV in UTF-8) and says what the import would make of it:
// what it would create, what it would not read, and exactly what needs YOU before a real import (the phones that lost their zero, the questions, the rows with a problem, the prices to classify).
//   node scripts/catalog-dry-run.js <file.csv>            the summary and the list of what needs you
//   node scripts/catalog-dry-run.js <file.csv> --prices   plus a worksheet of the prices (row, service, wording, what the import reads from it)
// It connects to NO database and to no network, writes nothing (not even a file), and prints no contact detail: no provider name, no business, no phone, no e-mail, no sheet id; only row numbers, codes and
// counts (and, with --prices, the names of the services and the wording of the price, which are not contact details). The file is compared with an EMPTY catalog, so every row is "new".
const fs = require('fs');
const path = require('path');
const Imp = require('../netlify/functions/_kaspchem/catalog/import.js');
const { INTERNAL_TOPICS } = require('../netlify/functions/_kaspchem/catalog/internal-topics.js');

const TOPICS = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kaspchem', 'content', 'topics.json'), 'utf8')).topics.map((t) => ({ id: t.id, name: t.name })); } catch (e) { return []; } })().concat(INTERNAL_TOPICS.map((t) => ({ id: t.id, name: t.name })));
const KIND = { market: 'מחיר שוק', unclassified: 'לא מסווג (מדווח בלבד)', provider_offer: 'הצעת ספק' };
const MODEL = { fixed: 'קבוע', percent_of_result: 'אחוז מהתוצאה', percent_with_minimum: 'אחוז עם מינימום', variable: 'משתנה', quote: 'הצעת מחיר', tbd: 'לא נקבע' };
const CODE = { phone_restored: 'הטלפון נשמר בגיליון כמספר בלי אפס מוביל: צריך לאשר את הטלפון עם המקור', similar_service: 'שאלה: שירות בשם קרוב (ליצור חדש או לקשר לקיים)', similar_provider: 'שאלה: נותן שירות בשם קרוב', file_says_active_needs_manual: 'הגיליון אומר "מאושר/פעיל": ייקלט כממתין ודורש אישור מפורש' };

function main(argv, io) {
  const out = []; const say = (s) => { out.push(s); if (io && io.write) io.write(s); };
  const files = argv.filter((a) => !a.startsWith('--')), prices = argv.includes('--prices'), unknown = argv.filter((a) => a.startsWith('--') && a !== '--prices');
  if (unknown.length || files.length !== 1) { say('שימוש: node scripts/catalog-dry-run.js <קובץ.csv> [--prices]'); return { code: 2, lines: out }; }
  let csv; try { csv = fs.readFileSync(files[0], 'utf8'); } catch (e) { say('לא ניתן לקרוא את הקובץ. בדקו את הנתיב.'); return { code: 2, lines: out }; }
  const p = Imp.buildPreview({ csv, existing: { services: [], providers: [], engagements: [] }, topics: TOPICS, maxRows: 300 });
  say('בדיקת ייבוא יבשה: לא נכתב דבר, לא נפתח חיבור לשום מסד נתונים. הקובץ מושווה לקטלוג ריק.');
  if (!p.ok) { say('הקובץ אינו שמיש: ' + (p.fileProblems || []).map((x) => x.code).join(', ')); say('מה לעשות: לייצא רק את לשונית הנתונים כ־CSV בקידוד UTF-8, עם שורת הכותרות המקורית.'); return { code: 1, lines: out }; }
  const s = p.summary;
  say('');
  say('הקובץ: כותרות בשורה ' + p.headerNumber + ', ' + s.rows_total + ' שורות עם תוכן: ' + s.new + ' חדשות, ' + s.skipped + ' דולגו (שורות ממלאות), ' + s.problem + ' בעיות.');
  if ((p.unknownColumns || []).length) say('עמודות שהייבוא אינו קורא: ' + p.unknownColumns.map((u) => '״' + u.text + '״').join(', '));
  if ((p.warnings || []).length) say('אזהרות על הקובץ: ' + p.warnings.join(', '));
  // what a full, explicit approval would make (decisions answered "new", phones confirmed): to say what would be created, never to save it
  const rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: [], acceptManual: [], confirmed: r.needsConfirmation, decisions: (r.decisions || []).length ? { service: { use: 'new' }, provider: { use: 'new' } } : undefined }; }
  const plan = Imp.planApply(p, { rows }, { services: [], providers: [], engagements: [] });
  say('');
  if (plan.ok) {
    const sm = plan.summary, kinds = {}; plan.operations.filter((o) => o.op === 'create_layer').forEach((o) => { kinds[o.layer.kind] = (kinds[o.layer.kind] || 0) + 1; });
    const doms = {}; plan.operations.filter((o) => o.op === 'create_service').forEach((o) => { const k = o.topic || 'ללא תחום'; doms[k] = (doms[k] || 0) + 1; });
    say('מה ייווצר אם תאשרו הכול: ' + (sm.create_provider || 0) + ' נותני שירות, ' + (sm.create_service || 0) + ' שירותים, ' + (sm.create_engagement || 0) + ' התקשרויות, ' + (sm.create_layer || 0) + ' מחירים מדווחים (' + Object.entries(kinds).map(([k, v]) => v + ' ' + (KIND[k] || k)).join(', ') + ').');
    const nameOf = (id) => (TOPICS.find((t) => t.id === id) || {}).name || id;
    say('תחומי השירותים: ' + Object.entries(doms).map(([k, v]) => v + ' ' + (k === 'ללא תחום' ? k : nameOf(k) + (INTERNAL_TOPICS.some((t) => t.id === k) ? ' (פנימי)' : ''))).join(', '));
    say('כל שירות ייווצר כבוי, כל התקשרות ממתינה לאישור (אף אחת לא פעילה או חתומה), כל מחיר הוא מדווח בלבד (לא מאושר ולא ציבורי), ושום עמלה אינה נקלטת.');
  } else say('לא ניתן לתכנן שמירה: ' + (plan.reason || '') + (plan.refused ? ' (' + plan.refused.slice(0, 5).map((r) => 'שורה ' + r.row + ': ' + r.reason).join('; ') + ')' : ''));
  const list = Imp.correctionList(p), phones = list.filter((x) => x.codes.includes('confirm:phone_restored')).map((x) => x.row);
  say('');
  say('מה דורש אתכם לפני ייבוא אמיתי (מספרי שורה וקודים בלבד, בלי פרטי קשר):');
  if (!list.length) say('  אין דבר.');
  if (phones.length) say('  אישור טלפון (' + phones.length + ' שורות): ' + phones.join(', ') + '. ' + CODE.phone_restored + '. אפשר גם להפוך את עמודת הטלפון בגיליון לטקסט (אז האפס נשמר ואין מה לאשר).');
  const byCode = {}; list.forEach((x) => x.codes.filter((c) => !c.startsWith('confirm:phone_restored')).forEach((c) => { (byCode[c] = byCode[c] || []).push(x.row); }));
  for (const [code, rs] of Object.entries(byCode)) { const key = code.replace(/^(decision|confirm):/, ''), prob = code.startsWith('problem:'); say('  ' + (prob ? 'בעיה (' + code.slice(8) + ')' : (CODE[key] || code)) + ' (שורות ' + rs.join(', ') + ')' + (prob ? ': יש לתקן את השורה בגיליון או למפות את הערך' : '')); }
  const noProv = p.rows.filter((r) => r.record && r.record.provider === null).map((r) => r.rowNumber); if (noProv.length) say('  שורות של שירות בלי נותן שירות (ייווצר שירות בלבד): ' + noProv.join(', '));
  const unclassified = p.rows.filter((r) => r.record && r.record.layer && r.record.layer.kind === 'unclassified').map((r) => r.rowNumber), market = p.rows.filter((r) => r.record && r.record.layer && r.record.layer.kind === 'market').map((r) => r.rowNumber);
  say('');
  say('מחירים: ' + market.length + ' נקראו כמחיר שוק (כי הניסוח בגיליון אומר זאת), ' + unclassified.length + ' נשארים "לא מסווג, מדווח בלבד" עד שתסווגו אותם במסך המחירים אחרי הייבוא (שורות ' + (unclassified.join(', ') || '-') + ').');
  const commission = (p.rows.filter((r) => (r.flags || []).includes('commission_not_imported')).length); if (commission) say('עמלה: ' + commission + ' שורות כוללות נתוני עמלה. הם אינם נקלטים (עד M1.1) ונשארים בגיליון בלבד.');
  if (prices) {
    say(''); say('גיליון עבודה למחירים (שורה | שירות | מה נקרא | ניסוח המחיר בגיליון | סיווג נוכחי):');
    for (const r of p.rows) { if (!r.record || !r.record.layer) continue; const l = r.record.layer, v = l.model === 'fixed' ? (l.amount != null ? l.amount + ' ש״ח' : 'ללא סכום') : (l.percent_low != null ? l.percent_low + (l.percent_high != null && l.percent_high !== l.percent_low ? '–' + l.percent_high : '') + '%' + (l.minimum_amount != null ? ', מינימום ' + l.minimum_amount + ' ש״ח' : '') : (MODEL[l.model] || l.model));
      say('  ' + r.rowNumber + ' | ' + r.record.service.name + ' | ' + (MODEL[l.model] || l.model) + ': ' + v + ' | ' + String(l.terms_text || '-').replace(/s+/g, ' ') + ' | ' + (KIND[l.kind] || l.kind)); }
  }
  say('');
  say('זו בדיקה בלבד. הייבוא האמיתי נעשה במסך "ייבוא מהגיליון" בקטלוג, אחרי שהמערכת פורסמה והקטלוג נפתח, ורק אחרי שתאשרו שורה-שורה.');
  return { code: 0, lines: out };
}
module.exports = { main };
if (require.main === module) { const r = main(process.argv.slice(2), { write: (s) => console.log(s) }); process.exit(r.code); }
