'use strict';
// Catalog import, pure CSV reading: the text of a file in, rows and a column map out. Nothing is read from disk and nothing is sent anywhere.
const { valueKey, normText } = require('./text.js');

const MAX_BYTES = 1024 * 1024;   // 1 MB
const MAX_RECORDS = 5000;

// RFC 4180 reader: quoted fields, "" inside quotes, commas and line breaks inside quotes, CRLF / LF / CR line ends, an optional BOM. A row's number is its position in the file
// (the first record is 1), so the owner can find it in the spreadsheet. Problems are reported with their row number; the text is never altered or repaired.
function parseCsv(input, opts) {
  const o = Object.assign({ maxBytes: MAX_BYTES, maxRecords: MAX_RECORDS, delimiter: ',' }, opts || {});
  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > o.maxBytes) return { rows: [], problems: [{ code: 'file_too_large', bytes, max: o.maxBytes }], bytes };
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (text.includes('�')) return { rows: [], problems: [{ code: 'bad_encoding' }], bytes };   // the file was not UTF-8 (a Hebrew Windows export, for example)
  const problems = [], rows = [], D = o.delimiter;
  let row = [], field = '', inQuotes = false, quoted = false, afterQuote = false, any = false;
  const endField = () => { row.push(field); field = ''; quoted = false; afterQuote = false; any = true; };
  const endRow = () => { endField(); rows.push(row); row = []; any = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; afterQuote = true; } }
      else field += c;
      continue;
    }
    if (c === '"' && field === '' && !quoted && !afterQuote) { inQuotes = true; quoted = true; any = true; continue; }
    if (c === D) { endField(); continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); continue; }
    if (afterQuote) problems.push({ code: 'stray_text_after_quote', row: rows.length + 1 });   // text right after a closing quote: kept as written, but reported
    field += c; any = true;
  }
  if (inQuotes) problems.push({ code: 'unterminated_quote', row: rows.length + 1 });
  if (any || field !== '' || row.length) endRow();
  if (rows.length > o.maxRecords) return { rows: [], problems: problems.concat([{ code: 'too_many_rows', rows: rows.length, max: o.maxRecords }]), bytes };
  return { rows, problems, bytes };
}

// The columns the importer knows, by every header name they appear under. Names are compared by valueKey (no quotes, no spaces, no punctuation).
const COLUMNS = {
  domain: ['תחום'],
  service: ['השירות המדויק', 'שירות מדויק', 'שירות'],
  description: ['מה השירות נותן ללקוח', 'תיאור השירות'],
  provider: ['שם הספק', 'ספק', 'שם נותן השירות', 'שם היועץ / הספק', 'שם היועץ'],   // 'שם היועץ / הספק' is the header of the owners' own sheet
  business: ['עסק', 'עסק / ארגון', 'עסק/ארגון', 'ארגון', 'שם העסק'],
  phone: ['טלפון', 'טלפון הספק'],
  email: ['אימייל', 'דוא"ל', 'דואל', 'מייל', 'email', 'e-mail'],
  direction: ['כיוון הפניה', 'כיוון ההפניה'],
  commissionModel: ['מודל תגמול', 'מודל התגמול'],
  commissionPercent: ['אחוז עמלה', 'אחוז העמלה'],
  commissionFixed: ['עמלה קבועה'],
  commissionPayer: ['מי משלם למי', 'מי משלם למי? / בסיס לחישוב'],
  contact: ['מצב קשר', 'מצב הקשר'],
  agreement: ['מצב הסכם', 'מצב ההסכם'],
  notes: ['הערות וקישור להסכם', 'הערות / קישור להסכם', 'הערות'],
  price: ['מחיר ₪ (שוק / לקוח)', 'מחיר שוק / לקוח', 'מחיר ללקוח ₪', 'מחיר ללקוח', 'מחיר'],
  pricingMode: ['אופן התמחור', 'אופן תמחור', 'אופן התמחור ללקוח'],
  priceTerms: ['תנאים והבהרות מחיר', 'תנאים והבהרות'],
  priceSource: ['מקור מחיר / התכתבות', 'מקור מחיר'],
  priceDate: ['תאריך מקור'],
  activation: ['סטטוס הפעלה באתר', 'סטטוס הפעלה'],
  questionnaire: ['מיפוי שאלון נדרש'],
  externalId: ['מזהה שירות'],
};
const REQUIRED = ['domain', 'service'];
const EXPECTED = ['provider', 'externalId', 'contact', 'agreement', 'activation', 'price', 'pricingMode'];   // missing: reported, the import goes on without them
const LOOKUP = new Map(); for (const [key, names] of Object.entries(COLUMNS)) names.forEach((n) => { if (!LOOKUP.has(valueKey(n))) LOOKUP.set(valueKey(n), key); });

// The header row is the first row (of the first 50) that holds both "תחום" and the service column. Rows above it (a title, a note) are ignored.
function detectHeader(rows, opts) {
  const columnMap = (opts && opts.columnMap) || {};   // an owner's own mapping: { "header text in the file": "column key" }
  const custom = new Map(Object.entries(columnMap).map(([h, k]) => [valueKey(h), k]));
  const keyOf = (cell) => custom.get(valueKey(cell)) || LOOKUP.get(valueKey(cell));
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 50); i++) { const keys = rows[i].map(keyOf); if (keys.includes('domain') && keys.includes('service')) { headerIndex = i; break; } }
  if (headerIndex < 0) return { headerIndex: -1, columns: {}, unknown: [], problems: [{ code: 'header_not_found' }], warnings: [] };
  const problems = [], warnings = [], columns = {}, unknown = [], seen = {};
  rows[headerIndex].forEach((cell, idx) => {
    const key = keyOf(cell);
    if (!key) { if (normText(cell)) unknown.push({ index: idx, text: normText(cell) }); return; }
    if (key in columns) { (seen[key] = seen[key] || [columns[key]]).push(idx); return; }
    columns[key] = idx;
  });
  Object.keys(seen).forEach((key) => problems.push({ code: 'duplicate_column', column: key, indexes: seen[key] }));
  REQUIRED.filter((k) => !(k in columns)).forEach((k) => problems.push({ code: 'missing_required_column', column: k }));
  EXPECTED.filter((k) => !(k in columns)).forEach((k) => warnings.push({ code: 'missing_column', column: k }));
  return { headerIndex, headerNumber: headerIndex + 1, columns, unknown, problems, warnings };
}

// Every record after the header as { rowNumber, cells: { column key: text }, blank, extra }. A column the file does not have is absent from `cells` (not an empty string), so
// "the file says nothing about this" can be told from "the file says it is empty".
function rowObjects(rows, header) {
  const out = [];
  if (!header || header.headerIndex < 0) return out;
  const keys = Object.keys(header.columns);
  for (let i = header.headerIndex + 1; i < rows.length; i++) {
    const r = rows[i], cells = {};
    keys.forEach((k) => { const v = r[header.columns[k]]; cells[k] = v == null ? '' : v; });
    const width = rows[header.headerIndex].length;
    const extra = r.slice(width).some((x) => normText(x) !== '');
    out.push({ rowNumber: i + 1, cells, blank: r.every((x) => normText(x) === ''), extra });
  }
  return out;
}

module.exports = { parseCsv, detectHeader, rowObjects, COLUMNS, REQUIRED, EXPECTED, MAX_BYTES, MAX_RECORDS };
