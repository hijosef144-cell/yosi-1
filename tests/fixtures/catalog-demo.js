'use strict';
// Synthetic demo data for the catalog import tests. Every name, phone, e-mail, sheet id and price below is invented; nothing here comes from a real provider, person or agreement.
// The CSV is built the way the real Google Sheets export looks: UTF-8, CRLF line ends, every field quoted, header text as in the owners' tab.
const HEADERS = {
  domain: 'תחום', service: 'השירות המדויק', description: 'מה השירות נותן ללקוח', provider: 'שם הספק', business: 'עסק', phone: 'טלפון', email: 'אימייל', direction: 'כיוון הפניה',
  commissionModel: 'מודל תגמול', commissionPercent: 'אחוז עמלה', commissionFixed: 'עמלה קבועה', commissionPayer: 'מי משלם למי', contact: 'מצב קשר', agreement: 'מצב הסכם',
  notes: 'הערות וקישור להסכם', price: 'מחיר ₪ (שוק / לקוח)', pricingMode: 'אופן התמחור', priceTerms: 'תנאים והבהרות מחיר', priceSource: 'מקור מחיר / התכתבות', priceDate: 'תאריך מקור',
  activation: 'סטטוס הפעלה באתר', questionnaire: 'מיפוי שאלון נדרש', externalId: 'מזהה שירות',
};
const ORDER = Object.keys(HEADERS);
const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

// rows: [{ column key: text }]. opts: { omit: [column keys], title: 'text above the header', bom: bool, lf: bool, headers: { key: other header text }, extraRaw: 'text appended as is' }
function csv(rows, opts) {
  const o = opts || {}, keys = ORDER.filter((k) => !(o.omit || []).includes(k)), eol = o.lf ? '\n' : '\r\n';
  const lines = [];
  if (o.title) lines.push(q(o.title) + ',""'.repeat(keys.length - 1));
  lines.push(keys.map((k) => q((o.headers && o.headers[k]) || HEADERS[k])).join(','));
  for (const r of rows) lines.push(keys.map((k) => q(r[k])).join(','));
  return (o.bom ? '﻿' : '') + lines.join(eol) + eol + (o.extraRaw || '');
}

// ---- the demo file: one row of every kind the importer has to tell apart ------------------------------------------------------------------------------------------
const row = (over) => Object.assign({ domain: 'מיסים', direction: 'כספכם מפנה לספק' }, over);
const ROWS = {
  fixed: row({ service: 'בדיקת זכאות להחזר מס', description: 'בדיקה של החזרי מס לשכירים', provider: 'דנה לבני', business: 'לבני מס', phone: '0501234567', email: 'dana@example.test', contact: 'יצרתי קשר', agreement: 'טרם נדון', price: '1,200', pricingMode: 'מחיר קבוע', activation: 'ממתין לאישור להפניה', externalId: 'TX-01', notes: 'שוחחנו בטלפון, ממתינה להצעה מסודרת' }),
  marketFixed: row({ service: 'הגשת דוח שנתי', provider: 'דנה לבני', business: 'לבני מס', price: '900', pricingMode: 'מחיר קבוע', priceTerms: 'מחיר שוק לפי אתר הספק', priceSource: 'אתר הספק', priceDate: '2026-10-20', activation: 'ממתין', externalId: 'TX-02' }),
  percent: row({ domain: 'נדל"ן', service: 'ייעוץ משכנתא', provider: 'רועי שמש', phone: '521112233', contact: 'במו"מ', agreement: 'טיוטה', pricingMode: '10% מהחיסכון', activation: 'ממתין לאישור להפניה', externalId: 'RE-01' }),
  range: row({ domain: 'משפחה', service: 'ליווי הליך גירושין', provider: 'נועה אדלר', business: 'אדלר ושות', price: '', pricingMode: 'בין 5-8% מהסכום שנחסך', priceTerms: 'לפי היקף התיק', activation: '', externalId: 'FA-01' }),
  minimum: row({ domain: 'פנסיה', service: 'בדיקת חיסכון פנסיוני', provider: 'אורי כץ', business: 'כץ פיננסים', pricingMode: '3% מהסכום או לפחות 2,000 ₪', activation: 'ממתין', externalId: 'PN-01' }),
  quote: row({ domain: 'פנסיה', service: 'תכנון פרישה', provider: 'אורי כץ', business: 'כץ פיננסים', pricingMode: 'לפי הצעת מחיר', activation: 'טיוטה', externalId: 'PN-02' }),
  noProvider: row({ domain: 'ביטוח', service: 'סקירת כיסויים ביטוחיים', description: 'מיפוי ביטוחים קיימים', externalId: '' }),
  signedAndActive: row({ domain: 'מיסים', service: 'ייצוג מול רשות המסים', provider: 'יעל מורג', business: 'מורג ייצוג', contact: 'פעיל', agreement: 'חתום', price: '3,000', pricingMode: 'מחיר קבוע', activation: 'פעיל', externalId: 'TX-03' }),
  commission: row({ domain: 'מיסים', service: 'תכנון מס לעצמאים', provider: 'איתן גל', business: 'גל חשבות', commissionModel: 'אחוז', commissionPercent: '15%', commissionFixed: '500', commissionPayer: 'הספק משלם לכספכם', price: '1,500', pricingMode: 'מחיר קבוע', activation: 'ממתין', externalId: 'TX-04' }),
  placeholder: row({ domain: 'ביטוח' }),
  blank: {},
};
const FILE = csv([ROWS.fixed, ROWS.marketFixed, ROWS.percent, ROWS.range, ROWS.minimum, ROWS.quote, ROWS.noProvider, ROWS.signedAndActive, ROWS.commission, ROWS.placeholder, ROWS.blank]);

// ---- what already exists in the system (the snapshot the importer is given): ids and provenance as the database would hold them ------------------------------------
const EMPTY = () => ({ services: [], providers: [], engagements: [] });
const layer = (o) => Object.assign({ kind: 'unclassified', model: 'fixed', amount: 1200, percent_low: null, percent_high: null, minimum_amount: null, terms_text: 'מחיר קבוע', basis_missing: false, source_note: null, source_date: null, status: 'recorded', recorded_by: 'import:owner' }, o);
function existing() {
  return {
    services: [
      { id: 11, name: 'בדיקת זכאות להחזר מס', topic: 'מיסים', description: 'בדיקה של החזרי מס לשכירים', updated_by: 'import:owner' },
      { id: 12, name: 'ייעוץ משכנתא', topic: 'נדל"ן', description: null, updated_by: 'import:owner' },
    ],
    providers: [
      { id: 21, name: 'דנה לבני', business_name: 'לבני מס', contact_phone: '0501234567', contact_email: 'dana@example.test', updated_by: 'import:owner' },
      { id: 22, name: 'רועי שמש', business_name: null, contact_phone: null, contact_email: null, updated_by: 'import:owner' },
    ],
    engagements: [
      { professional_id: 21, service_id: 11, external_ref: 'TX-01', activation: 'pending', contact_state: 'contacted', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, terms_note: 'שוחחנו בטלפון, ממתינה להצעה מסודרת', updated_by: 'import:owner', layers: [layer({})] },
      { professional_id: 22, service_id: 12, external_ref: 'RE-01', activation: 'draft', contact_state: 'negotiating', agreement_state: 'draft', pricing_model: 'percent_of_result', pricing_id: null, terms_note: null, updated_by: 'import:owner', layers: [] },
    ],
  };
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const deepFreeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };

module.exports = { HEADERS, ORDER, ROWS, FILE, csv, row, existing, layer, EMPTY, clone, deepFreeze };
