/* Catalog import screen, stage 5c: load the CSV exported from the owners' Google Sheet, look at what it would do, approve it by hand, and save it, with the import engine and the two routes that already exist
 * (POST /catalog/imports/preview and /apply; the engine and its rules R1-R11 are the server's: this file shows them and asks, it does not decide them).
 * It plugs into the catalog screens (catalog.js) next to the editing module (catalog-edit.js), whose dialog kit and allow-list of requests it uses.
 *
 * What it keeps and what it never does:
 *   - the PREVIEW writes nothing (not even a log row); the file and everything typed or approved on this screen live in the memory of this page only: nothing is stored in the browser, and nothing is sent until a click;
 *   - the SAVE is one request, asked for by an explicit approval (a typed word, after a summary of what will be created and changed); the form locks while it sends, there is no automatic retry, and after an answer nobody can read
 *     there is only a check of the state (a new preview shows whether the rows were saved);
 *   - an import never activates anything: services are created switched off, engagements as a draft or as pending, prices only as REPORTED layers (never an approved price, never the provider's offer), commissions are ignored,
 *     nothing is deleted, and a value that a person edited by hand is overwritten only with a separate, explicit OK; the screen says all of this where the owner approves;
 *   - problems can be fixed without losing the work: unknown words and unknown columns are mapped here, the text of the file can be edited here, and the approvals and answers of every row that did not change are kept;
 *   - text from the file and from the server is always escaped; codes of the server are never shown, only words.
 */
(function (root) {
  'use strict';
  var C = root.KaspchemCatalog, E = root.KaspchemCatalogEdit;
  if (!C || typeof C.extend !== 'function' || !E || !E.kit) return;
  var K = E.kit, T = C._t, esc = K.esc, L = T.labels;
  var MAX_BYTES = 1024 * 1024;

  /* ---------- words: every code the engine can give, in plain Hebrew ---------- */
  var FIELD = { service: 'השירות', provider: 'נותן השירות', business: 'העסק', phone: 'הטלפון', email: 'הדוא״ל', price: 'המחיר', externalId: 'מזהה הגיליון', direction: 'כיוון ההפניה', terms_note: 'ההערות', terms_text: 'תנאי המחיר', source_note: 'מקור המחיר', source_date: 'תאריך המקור',
    contact_state: 'מצב קשר', agreement_state: 'מצב הסכם', activation: 'סטטוס הפעלה' };
  var COLUMN = { domain: 'תחום', service: 'השירות המדויק', description: 'מה השירות נותן ללקוח', provider: 'שם הספק', business: 'עסק / ארגון', phone: 'טלפון', email: 'אימייל', direction: 'כיוון הפניה', commissionModel: 'מודל תגמול', commissionPercent: 'אחוז עמלה', commissionFixed: 'עמלה קבועה', commissionPayer: 'מי משלם למי',
    contact: 'מצב קשר', agreement: 'מצב הסכם', notes: 'הערות וקישור להסכם', price: 'מחיר', pricingMode: 'אופן התמחור', priceTerms: 'תנאים והבהרות מחיר', priceSource: 'מקור מחיר / התכתבות', priceDate: 'תאריך מקור', activation: 'סטטוס הפעלה באתר', questionnaire: 'מיפוי שאלון', externalId: 'מזהה שירות' };
  var FILE_PROBLEM = { file_too_large: 'הקובץ גדול מדי (עד 1MB).', bad_encoding: 'הקובץ אינו בקידוד UTF-8. ב-Google Sheets יש לייצא דרך ״קובץ, הורדה, ערכים מופרדים בפסיקים (CSV)״.', too_many_rows: 'יש בקובץ יותר מדי שורות.',
    unterminated_quote: 'יש מרכאות שלא נסגרו, ולכן אי אפשר לקרוא את הקובץ.', stray_text_after_quote: 'יש טקסט מיד אחרי מרכאות סוגרות. הטקסט נשמר כפי שהוא, ובכל זאת כדאי לבדוק את השורה.', header_not_found: 'לא נמצאה שורת כותרות עם העמודות ״תחום״ ו״השירות המדויק״.',
    duplicate_column: 'אותה עמודה מופיעה יותר מפעם אחת.', missing_required_column: 'חסרה עמודה שחובה שתהיה בקובץ.' };
  var WARNING = { missing_column: 'חסרה עמודה בקובץ. הייבוא ממשיך בלעדיה.', extra_cells: 'יש בשורה יותר תאים מהכותרות. התאים העודפים לא נקראו.', domain_missing: 'התחום ריק.', external_ref_missing: 'אין מזהה גיליון בשורה.', fixed_price_missing: 'כתוב ״קבוע״ אבל אין סכום. לא נרשם מחיר.' };
  var ROW_PROBLEM = { service_missing: 'חסר שם שירות.', name_too_long: 'השם ארוך מדי.', text_too_long: 'הטקסט ארוך מדי.', phone_has_letters: 'בטלפון יש אותיות.', phone_not_israeli: 'הטלפון אינו מספר ישראלי.', phone_unrecognized: 'הטלפון אינו מזוהה.', email_invalid: 'כתובת הדוא״ל אינה תקינה.',
    unknown_value: 'ערך שאינו מוכר. יש למפות אותו למטה לפני שאפשר להמשיך.', mapping_not_allowed: 'המיפוי שנבחר אינו מותר.', unsupported_direction: 'כיוון ההפניה אינו נתמך.', price_without_provider: 'יש מחיר אבל אין נותן שירות.', price_not_numeric: 'המחיר אינו מספר.', price_out_of_range: 'המחיר מחוץ לטווח.',
    date_format: 'התאריך אינו בפורמט מוכר. הפורמט הנדרש: שנה-חודש-יום, למשל 2026-10-25.', date_invalid: 'התאריך אינו תאריך אמיתי.', price_conflicts_with_mode: 'המחיר סותר את אופן התמחור שכתוב (למשל סכום לצד ״אחוז״).', minimum_not_numeric: 'סכום המינימום אינו מספר.', percent_range_reversed: 'טווח האחוזים הפוך.', percent_out_of_range: 'האחוז חייב להיות בין 0 ל־100.', percent_not_numeric: 'האחוז אינו מספר.',
    duplicate_external_ref: 'אותו מזהה גיליון מופיע ביותר משורה אחת.', duplicate_engagement: 'אותו נותן שירות ואותו שירות מופיעים ביותר משורה אחת.', external_ref_belongs_to_another_engagement: 'מזהה הגיליון שייך להתקשרות אחרת.', ambiguous_existing_service: 'כמה שירותים קיימים מתאימים לשם.',
    ambiguous_existing_provider: 'כמה נותני שירות קיימים מתאימים לשם.', ambiguous_existing_engagement: 'כמה התקשרויות קיימות מתאימות.' };
  var FLAG = { phone_restored: 'לטלפון הוחזר האפס שבהתחלה (הגיליון איבד אותו). יש לוודא את המספר.', file_says_collaboration_active_needs_manual: 'בקובץ כתוב ששיתוף הפעולה פעיל. הייבוא רושם ״במשא ומתן״ בלבד, ושיתוף פעולה פעיל נרשם רק בידי אדם.', file_says_signed_needs_manual: 'בקובץ כתוב שההסכם חתום. הייבוא רושם ״טיוטה״ בלבד, וחתימה נרשמת רק בידי אדם.',
    file_says_active_needs_manual: 'בקובץ כתוב שההתקשרות פעילה. הייבוא רושם ״ממתין לאישור״ בלבד: הפעלה אינה נעשית בייבוא.', contact_state_managed_in_system: 'מצב הקשר נוהל כבר במערכת, ולכן הקובץ לא ישנה אותו.', agreement_state_managed_in_system: 'מצב ההסכם נוהל כבר במערכת, ולכן הקובץ לא ישנה אותו.',
    activation_managed_in_system: 'מצב ההתקשרות נוהל כבר במערכת, ולכן הקובץ לא ישנה אותו.', pricing_model_managed_in_system: 'למחיר של ההתקשרות יש כבר מחיר קבוע מקושר, ולכן הקובץ לא ישנה את מודל התמחור.', commission_not_imported: 'עמלות לא מיובאות. עמודות העמלה נקראו רק כדי לדווח שהן הושמטו.',
    questionnaire_mapping_not_imported: 'מיפוי השאלון לא מיובא.', price_without_wording: 'יש סכום בלי אופן תמחור כתוב. הוא נרשם כערך שדווח ושטרם סווג.', unrecognized_pricing_text: 'אופן התמחור לא הובן. הטקסט נשמר כלשונו, בלי מספרים.', basis_missing: 'האחוז נרשם בלי בסיס לחישוב (לא ידוע מאיזה סכום).',
    price_unclassified: 'המחיר נרשם כערך שדווח ושטרם סווג: העמודה מערבבת מחיר שוק ומחיר ללקוח. אפשר לסווג אותו בכרטיס ההתקשרות.', read_as_fraction: 'הערך נקרא כשבר ולא כאחוז.', read_as_percent: 'הערך נקרא כאחוז.' };
  var REFUSED = { no_such_row: 'השורה אינה בתצוגה.', row_is_problem: 'בשורה יש בעיה.', row_is_skipped: 'השורה דולגה.', confirmation_missing: 'חסר אישור על הערה שדורשת אישור.', decision_missing: 'חסרה החלטה על שם דומה.', decision_unknown_id: 'ההחלטה מצביעה על רשומה שאינה קיימת.', change_blocked: 'שינוי חסום אושר.',
    engagement_already_exists: 'כבר קיימת התקשרות לזוג שנבחר.', engagement_twice_in_plan: 'אותה התקשרות נוצרת פעמיים באישורים.', external_ref_in_use: 'מזהה הגיליון כבר בשימוש.' };
  var CHANGE_FIELD = { topic: 'תחום', description: 'תיאור', business_name: 'עסק או ארגון', contact_phone: 'טלפון', contact_email: 'דוא״ל', contact_state: 'מצב קשר', agreement_state: 'מצב הסכם', activation: 'סטטוס הפעלה', pricing_model: 'אופן התמחור', terms_note: 'הערת תנאים', external_ref: 'מזהה הגיליון' };
  var ENTITY = { service: 'שירות', provider: 'נותן שירות', engagement: 'התקשרות', layer: 'שכבת מחיר' };
  var BLOCKED = { service_has_public_price: 'לשירות יש מחיר שמוצג באתר, ולכן אי אפשר לשנות את התחום שלו. השינוי מוצג ואינו ניתן לאישור.' };
  // what an import may ever set, in words (the same lists as the engine's SAFE_TARGETS)
  var TARGETS = { contact_state: ['none', 'contacted', 'negotiating'], agreement_state: ['not_discussed', 'draft'], activation: ['draft', 'pending'] };
  var MAP_KIND = { contact_state: 'contact', agreement_state: 'agreement', activation: 'activation' };
  var TARGET_LABEL = { contact_state: L.CONTACT, agreement_state: L.AGREEMENT, activation: L.ACTIVATION };
  var STATUS_NAME = { new: 'חדשה', changed: 'עם שינויים', unchanged: 'ללא שינוי', skipped: 'דולגה', problem: 'בעיה' }, STATUS_TONE = { new: 'ok', changed: 'warn', unchanged: 'muted', skipped: 'muted', problem: 'bad' };
  var SKIP_NAME = { blank: 'שורה ריקה', placeholder: 'שורה בלי שירות ובלי נותן שירות' };
  function has(m, k) { return Object.prototype.hasOwnProperty.call(m, k); }
  function word(m, k, fallback) { return has(m, k) ? m[k] : (fallback || 'אירעה בעיה בקובץ.'); }

  /* ---------- pure: texts of problems, signatures, approvals, the summary of what would be saved ---------- */
  function problemText(p, scope) {
    var code = String((p && p.code) || ''), base = code.indexOf('layer_invalid') === 0 ? 'מחיר שאינו תקין לפי כללי השכבות.' : word(scope === 'file' ? FILE_PROBLEM : ROW_PROBLEM, code);
    var extra = '';
    if (code === 'unknown_value') extra = ' (' + (has(FIELD, p.field) ? FIELD[p.field] + ': ' : '') + '״' + String(p.value || '') + '״)';
    else if (code === 'missing_required_column' || code === 'duplicate_column') extra = ' (' + word(COLUMN, p.column, String(p.column || '')) + ')';
    else if (p.field && has(FIELD, p.field) && scope !== 'file' && code !== 'unknown_value') extra = ' (' + FIELD[p.field] + ')';
    if (Array.isArray(p.rows) && p.rows.length) extra += ' בשורות ' + p.rows.join(', ') + '.';
    else if (p.row && scope === 'file') extra += ' בשורה ' + p.row + '.';
    return base + extra;
  }
  function warningText(w) { var code = typeof w === 'string' ? w : (w && w.code); return word(WARNING, code, 'יש בשורה נתון שכדאי לבדוק.') + (w && w.column ? ' (' + word(COLUMN, w.column, String(w.column)) + ')' : ''); }
  function flagText(f) { return word(FLAG, f, 'יש בשורה נתון שכדאי לבדוק.'); }
  // the identity of a row for the work done on it: if anything the approval depends on moves (who, what, how it compares with what exists, what must be decided), the approval is dropped and the owner is told
  function signature(row) { return JSON.stringify([row.status, row.record || null, (row.changes || []).map(function (c) { return [c.id, c.new, c.old, !!c.manual, c.blocked || null]; }), (row.decisions || []).map(function (d) { return [d.entity, d.type, (d.candidates || []).map(function (x) { return x.id; })]; }), row.needsConfirmation || [], row.service && row.service.action, row.provider && row.provider.action, row.engagement && row.engagement.action]); }
  function applicable(row) { return !!row && (row.status === 'new' || row.status === 'changed'); }
  // what ticking a row approves at first: the row, and every change that is not a hand-edited value and not blocked (each can be un-ticked); nothing that needs a decision or a confirmation is answered for the person
  function startApproval(row) {
    var a = { apply: true, decisions: {}, accept: [], acceptManual: [], confirmed: [] };
    (row.changes || []).forEach(function (c) { if (c.blocked) return; if (c.entity === 'layer' && c.field === 'create') { a.accept.push(c.id); return; } if (!c.manual) a.accept.push(c.id); });
    return a;
  }
  function rowReady(row, a) {   // whether the approval of a row is complete (the server asks for exactly this)
    if (!applicable(row) || !a || a.apply !== true) return false;
    if ((row.decisions || []).some(function (d) { var x = (a.decisions || {})[d.entity]; return !x || (x.use !== 'existing' && x.use !== 'new') || (x.use === 'existing' && (x.id === undefined || x.id === null)); })) return false;
    return (row.needsConfirmation || []).every(function (f) { return (a.confirmed || []).indexOf(f) !== -1; });
  }
  // keep the work done on rows that did not change when a new preview is made (a fixed mapping, a corrected cell elsewhere); returns what was kept and what was dropped
  function reconcile(approvals, sigs, preview) {
    var kept = { rows: {} }, keptSigs = {}, dropped = [];
    var byNumber = {}; (preview && preview.rows || []).forEach(function (r) { byNumber[r.rowNumber] = r; });
    Object.keys(approvals.rows || {}).forEach(function (n) {
      var row = byNumber[n];
      if (row && applicable(row) && sigs[n] === signature(row)) { kept.rows[n] = approvals.rows[n]; keptSigs[n] = sigs[n]; } else dropped.push(Number(n));
    });
    return { approvals: kept, sigs: keptSigs, dropped: dropped.sort(function (a, b) { return a - b; }) };
  }
  // what the saving would create and change, from the preview and the approvals, by the very order and rules of the engine (a test keeps this equal to the engine's own summary)
  function summarize(preview, approvals) {
    var s = { create_service: 0, update_service: 0, create_provider: 0, update_provider: 0, create_engagement: 0, update_engagement: 0, create_layer: 0, update_layer: 0 }, made = { service: {}, provider: {} };
    var byNumber = {}; (preview.rows || []).forEach(function (r) { byNumber[r.rowNumber] = r; });
    Object.keys((approvals && approvals.rows) || {}).filter(function (n) { return approvals.rows[n] && approvals.rows[n].apply === true; }).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (n) {
      var row = byNumber[n]; if (!row || !applicable(row)) return;
      var a = approvals.rows[n], rec = row.record, dec = a.decisions || {}, accept = a.accept || [], acceptManual = a.acceptManual || [];
      var svcExisting = (row.decisions || []).some(function (d) { return d.entity === 'service' && dec.service && dec.service.use === 'existing'; }) || row.service.action === 'existing';
      var provExisting = (row.decisions || []).some(function (d) { return d.entity === 'provider' && dec.provider && dec.provider.use === 'existing'; }) || (rec.provider && row.provider.action === 'existing');
      if (!svcExisting && !made.service[rec.service.key]) { made.service[rec.service.key] = 1; s.create_service++; }
      if (rec.provider && !provExisting && !made.provider[rec.provider.key]) { made.provider[rec.provider.key] = 1; s.create_provider++; }
      (row.changes || []).forEach(function (c) {
        if (c.entity === 'layer' && c.field === 'create') return;
        if (c.manual ? acceptManual.indexOf(c.id) === -1 : accept.indexOf(c.id) === -1) return;
        if (c.blocked) return;
        if (c.entity === 'service') { if (svcExisting) s.update_service++; } else if (c.entity === 'provider') { if (provExisting) s.update_provider++; } else if (c.entity === 'engagement') s.update_engagement++; else if (c.entity === 'layer') s.update_layer++;
      });
      if (rec.provider && row.engagement && row.engagement.action === 'new') { s.create_engagement++; if (rec.layer) s.create_layer++; }
      else if (rec.provider && row.engagement && row.engagement.action === 'existing' && rec.layer && accept.indexOf('layer.' + rec.layer.kind + '.create') !== -1 && (row.changes || []).some(function (c) { return c.id === 'layer.' + rec.layer.kind + '.create'; })) s.create_layer++;
    });
    Object.keys(s).forEach(function (k) { if (!s[k]) delete s[k]; });
    return s;
  }
  var OP_NAME = { create_service: ['שירותים חדשים (כבויים)', 'שירות חדש (כבוי)'], update_service: ['עדכוני שירות', 'עדכון שירות'], create_provider: ['נותני שירות חדשים', 'נותן שירות חדש'], update_provider: ['עדכוני נותן שירות', 'עדכון נותן שירות'],
    create_engagement: ['התקשרויות חדשות (טיוטה או ממתינות, אף אחת לא פעילה)', 'התקשרות חדשה (טיוטה או ממתינה, לא פעילה)'], update_engagement: ['עדכוני התקשרות', 'עדכון התקשרות'], create_layer: ['שכבות מחיר מדווחות חדשות', 'שכבת מחיר מדווחת חדשה'], update_layer: ['עדכוני שכבת מחיר מדווחת', 'עדכון שכבת מחיר מדווחת'] };
  function summaryHtml(s) {
    var keys = Object.keys(s); if (!keys.length) return '<p class="ct-small">לא אושר שינוי כלשהו.</p>';
    return '<ul class="cip-sum">' + keys.map(function (k) { return '<li><strong>' + esc(String(s[k])) + '</strong> ' + esc(OP_NAME[k][s[k] === 1 ? 1 : 0]) + '</li>'; }).join('') + '</ul>';
  }
  // values the engine does not know, to be mapped by the owner: one per word and kind, in order of appearance
  function unknownValues(preview) {
    var seen = {}, out = [];
    (preview.rows || []).forEach(function (r) { (r.problems || []).forEach(function (p) { if (p.code !== 'unknown_value' || !has(TARGETS, p.field)) return; var k = p.field + '|' + p.value; if (!seen[k]) { seen[k] = 1; out.push({ field: p.field, value: p.value, rows: [r.rowNumber] }); } else out.filter(function (u) { return u.field + '|' + u.value === k; })[0].rows.push(r.rowNumber); }); });
    return out;
  }
  function mappingsFrom(chosen) {   // chosen: { 'field|word': target } -> { contact: { word: target }, ... }
    var m = {};
    Object.keys(chosen || {}).forEach(function (k) { if (!chosen[k]) return; var i = k.indexOf('|'), field = k.slice(0, i), w = k.slice(i + 1); if (!has(MAP_KIND, field)) return; (m[MAP_KIND[field]] = m[MAP_KIND[field]] || {})[w] = chosen[k]; });
    return m;
  }
  function refusedText(r) { return 'שורה ' + r.row + ': ' + word(REFUSED, r.reason, 'השורה אינה ניתנת לשמירה.') + (r.why ? ' ' + word(BLOCKED, r.why, '') : ''); }
  // The server's refusals reach the screen as short codes ("r5:decision_missing:service": the row, the reason, and the entity or the reason of the block): the admin page lets nothing else through.
  function refusedList(codes) {
    return (Array.isArray(codes) ? codes : []).slice(0, 20).map(function (c) { var m = /^r(\d{1,6}):([a-z_]+)(?::([a-z_]+))?$/.exec(String(c)); if (!m) return null; var why = m[2] === 'change_blocked' ? m[3] : undefined; return refusedText({ row: Number(m[1]), reason: m[2], why: why }); }).filter(Boolean);
  }
  function valueText(f, v) {
    if (v === null || v === undefined || v === '') return 'ריק';
    if (f === 'contact_state') return word(L.CONTACT, v, String(v)); if (f === 'agreement_state') return word(L.AGREEMENT, v, String(v)); if (f === 'activation') return word(L.ACTIVATION, v, String(v)); if (f === 'pricing_model') return word(L.MODEL, v, String(v));
    if (f === 'topic' && topicNameFn) return String(topicNameFn(v) || v);   // a topic of the system is an id (banking-loans): said by its name where the page knows it
    return String(v);
  }
  function layerText(l) { return l ? T.priceText(l) : ''; }

  /* ---------- the state of this page (memory only) ---------- */
  var topicNameFn = null;
  var W = fresh();
  function fresh() { return { csv: null, name: '', bytes: 0, mappings: {}, columnMap: {}, chosenValues: {}, chosenColumns: {}, preview: null, approvals: { rows: {} }, sigs: {}, dropped: [], busy: false, error: null, result: null, filter: 'all', q: '', page: 0 }; }

  /* ---------- the screen ---------- */
  var ROW_PAGE = 25;
  function draw(h, body) {
    var el = document.createElement('div'); el.className = 'cip'; body.innerHTML = ''; body.appendChild(el);
    topicNameFn = h.ctx && typeof h.ctx.topicName === 'function' ? h.ctx.topicName : null;
    var api = { h: h, el: el, body: body, focused: false };
    wire(api); paint(api);
  }
  function paint(api) {
    var el = api.el; if (!document.body.contains(el)) return;
    var html = '<h2 id="ct-h" tabindex="-1">ייבוא מהגיליון</h2>' + intro();
    if (W.result) html += resultHtml(); else html += loadHtml() + (W.error ? '<div class="ce-bad" role="alert">' + esc(W.error) + '</div>' : '') + (W.preview ? reviewHtml() : '');
    var had = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    el.innerHTML = html; bindFile(api);
    if (!api.focused) { var hd = el.querySelector('#ct-h'); if (hd) hd.focus({ preventScroll: true }); api.focused = true; }
    else if (had) { var back = el.querySelector('#' + had); if (back && back.focus) back.focus({ preventScroll: true }); }
  }
  function intro() {
    return '<div class="ct-note cip-intro" role="note"><p><strong>איך זה עובד:</strong> מייצאים את הגיליון ל־CSV (UTF-8), טוענים כאן, ורואים תצוגה מקדימה של מה שייווצר ומה ישתנה. שום דבר לא נשמר עד שתאשרו בעצמכם, שורה אחרי שורה, ואז תאשרו את הייבוא כולו.</p>' +
      '<p>הייבוא <strong>אינו מפעיל דבר</strong>: שירותים נוצרים כבויים, התקשרויות נוצרות כטיוטה או ממתינות לאישור, מחירים נרשמים כ<strong>מדווחים</strong> בלבד (לא מאושרים ולא הצעת ספק), עמלות מתעלמים מהן, ושום דבר לא נמחק. ערך שנערך ידנית לא נדרס בלי אישור נפרד.</p></div>';
  }
  function loadHtml() {
    return '<section class="panel cip-load" aria-labelledby="cip-load-h"><h3 id="cip-load-h">1. טעינת הקובץ</h3><div class="row"><div><label for="cip-file">קובץ CSV מהגיליון</label><input id="cip-file" type="file" accept=".csv,text/csv"' + (W.busy ? ' disabled' : '') + '></div>' +
      '<div class="ce-bar"><button type="button" class="btn" data-cip="preview"' + (W.csv && !W.busy ? '' : ' disabled') + '>הצגת תצוגה מקדימה</button><button type="button" class="btn sec" data-cip="edit"' + (W.csv && !W.busy ? '' : ' disabled') + '>עריכת טקסט הקובץ</button><button type="button" class="btn sec" data-cip="template">הורדת כותרות לדוגמה</button>' + (W.csv ? '<button type="button" class="btn sec" data-cip="reset"' + (W.busy ? ' disabled' : '') + '>ניקוי והתחלה מחדש</button>' : '') + '</div></div>' +
      '<p class="ct-small" id="cip-file-info" role="status" aria-live="polite">' + (W.csv ? esc(W.name || 'הדבקה') + ' · ' + esc(String(W.bytes)) + ' בתים. ' + (W.preview ? 'הנתונים לא נשמרו.' : 'לחצו על ״הצגת תצוגה מקדימה״. עדיין לא נשלח דבר.') : 'הקובץ נקרא בדפדפן בלבד ולא נשלח עד שתלחצו על ״הצגת תצוגה מקדימה״.') + '</p>' + (W.busy ? '<p class="ct-loading" role="status">טוען…</p>' : '') + '</section>';
  }
  function pill(text, tone) { return '<span class="ct-pill ct-' + tone + '">' + esc(text) + '</span>'; }
  function reviewHtml() {
    var p = W.preview, s = p.summary || {}, html = '<section class="panel cip-review" aria-labelledby="cip-review-h"><h3 id="cip-review-h">2. תצוגה מקדימה</h3>';
    html += '<p class="ct-small">שורת הכותרות: ' + esc(String(p.headerNumber || '')) + ' · טביעת הקובץ <span dir="ltr">' + esc(String(p.fileSha256 || '').slice(0, 10)) + '</span>. הנתונים שבקובץ אינם נשמרים בשום מקום עד שתאשרו.</p>';
    if (W.dropped.length) html += '<p class="warn" role="status">בתצוגה החדשה ' + W.dropped.length + ' ' + (W.dropped.length === 1 ? 'שורה שאישרתם השתנתה' : 'שורות שאישרתם השתנו') + ' (שורות ' + esc(W.dropped.join(', ')) + '), ולכן האישור שלהן הוסר. שאר העבודה נשמרה.</p>';
    (p.fileProblems || []).length && (html += '<div class="ce-bad" role="alert"><strong>הקובץ אינו ניתן לשימוש כמו שהוא:</strong><ul>' + p.fileProblems.map(function (x) { return '<li>' + esc(problemText(x, 'file')) + '</li>'; }).join('') + '</ul></div>');
    (p.warnings || []).length && (html += '<div class="warn" role="note"><strong>שימו לב:</strong><ul>' + p.warnings.map(function (x) { return '<li>' + esc(warningText(x)) + '</li>'; }).join('') + '</ul></div>');
    html += columnMapHtml(p);
    if (!p.ok) return html + '<p class="ct-small">אפשר לתקן את הטקסט (״עריכת טקסט הקובץ״) או לטעון קובץ אחר; מה שנעשה כבר נשמר בדף.</p></section>';
    html += '<div class="cip-counts" role="status" aria-label="סיכום הקובץ">' + ['new', 'changed', 'unchanged', 'skipped', 'problem'].map(function (k) { return '<span>' + pill(STATUS_NAME[k], STATUS_TONE[k]) + ' <strong>' + esc(String(s[k] || 0)) + '</strong></span>'; }).join(' ') + ' <span>סך השורות <strong>' + esc(String(s.rows_total || 0)) + '</strong></span>' + (p.decisionsNeeded ? ' <span>' + pill('החלטות נדרשות', 'warn') + ' <strong>' + esc(String(p.decisionsNeeded)) + '</strong></span>' : '') + '</div>';
    html += valueMapHtml(p);
    if ((p.notInFile || []).length) html += '<p class="ct-small">התקשרויות שיש להן מזהה גיליון ואינן בקובץ: ' + esc(String(p.notInFile.length)) + '. הן לא ישתנו ולא יימחקו.</p>';
    html += '<form class="row ct-filters" role="search" aria-label="סינון שורות" novalidate><div><label for="cip-q">חיפוש בשורות (שירות או נותן שירות)</label><input id="cip-q" type="search" autocomplete="off" value="' + esc(W.q) + '"></div><div><label for="cip-f">הצגה</label><select id="cip-f">' +
      [['all', 'כל השורות'], ['new', 'חדשות'], ['changed', 'עם שינויים'], ['problem', 'עם בעיות'], ['decide', 'דורשות החלטה'], ['unchanged', 'ללא שינוי'], ['skipped', 'דולגו'], ['approved', 'שאישרתי']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === W.filter ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></div></form>';
    var rows = visibleRows(p), pages = Math.max(1, Math.ceil(rows.length / ROW_PAGE)); if (W.page >= pages) W.page = pages - 1;
    html += '<div class="ce-bar"><button type="button" class="btn sec" data-cip="approve-clean">סימון כל השורות החדשות והנקיות</button><button type="button" class="btn sec" data-cip="approve-none"' + (Object.keys(W.approvals.rows).length ? '' : ' disabled') + '>ביטול כל האישורים</button></div>';
    html += '<p class="ct-count" role="status" aria-live="polite">' + esc(String(rows.length)) + ' שורות מוצגות' + (pages > 1 ? ' · עמוד ' + (W.page + 1) + ' מתוך ' + pages : '') + '</p><div class="cip-rows">' + rows.slice(W.page * ROW_PAGE, (W.page + 1) * ROW_PAGE).map(rowHtml).join('') + '</div>';
    if (pages > 1) html += '<nav class="ct-pager" aria-label="דפדוף"><button type="button" class="btn sec" data-cip="prev"' + (W.page ? '' : ' disabled') + '>→ הקודם</button><span>עמוד ' + (W.page + 1) + ' מתוך ' + pages + '</span><button type="button" class="btn sec" data-cip="next"' + (W.page + 1 >= pages ? ' disabled' : '') + '>הבא ←</button></nav>';
    var sum = summarize(p, W.approvals), ready = approvedCount(), incomplete = incompleteRows();
    html += '<div class="cip-bottom" role="region" aria-label="סיכום האישורים"><h3>3. מה יישמר</h3>' + summaryHtml(sum) + '<p class="ct-small">' + esc(String(ready)) + ' שורות מאושרות' + (incomplete.length ? ' · בשורות ' + esc(incomplete.join(', ')) + ' האישור לא שלם (חסרה החלטה או אישור על הערה)' : '') + '.</p>' +
      '<div class="ce-bar"><button type="button" class="btn" data-cip="review"' + (ready && !incomplete.length && !W.busy ? '' : ' disabled') + '>בדיקה ואישור הייבוא</button></div></div>';
    return html + '</section>';
  }
  function columnMapHtml(p) {
    var unknown = p.unknownColumns || []; if (!unknown.length) return '';
    return '<div class="cip-cols panel" role="group" aria-label="עמודות שלא זוהו"><h4>עמודות שלא זוהו</h4><p class="ct-small">עמודות אלה בקובץ אינן מוכרות ולכן לא נקראו. אפשר למפות אותן לעמודה מוכרת, או להשאיר כך (הן יתעלמו). המיפוי לא משנה את הקובץ.</p>' + unknown.map(function (u, i) {
      return '<div class="cip-map"><label for="cip-col-' + i + '"><span dir="auto">' + esc(u.text) + '</span></label><select id="cip-col-' + i + '" data-cipcol="' + esc(u.text) + '"><option value="">להתעלם</option>' + Object.keys(COLUMN).map(function (k) { return '<option value="' + k + '"' + (W.chosenColumns[u.text] === k ? ' selected' : '') + '>' + esc(COLUMN[k]) + '</option>'; }).join('') + '</select></div>';
    }).join('') + '<div class="ce-bar"><button type="button" class="btn sec" data-cip="apply-columns">החלת מיפוי העמודות</button></div></div>';
  }
  function valueMapHtml(p) {
    var unk = unknownValues(p); if (!unk.length) return '';
    return '<div class="cip-vals panel" role="group" aria-label="ערכים שאינם מוכרים"><h4>ערכים שאינם מוכרים</h4><p class="ct-small">המילים האלה בקובץ אינן מוכרות, והשורות שלהן נעצרו. בחרו מה כל מילה אומרת, מתוך הערכים שייבוא רשאי לקבוע. ערכים כמו ״שיתוף פעולה פעיל״, ״חתום״ ו״פעיל״ נקבעים רק בידי אדם אחרי הייבוא.</p>' + unk.map(function (u, i) {
      var key = u.field + '|' + u.value;
      return '<div class="cip-map"><label for="cip-val-' + i + '">' + esc(word(FIELD, u.field)) + ': ״<span dir="auto">' + esc(u.value) + '</span>״ <span class="ct-small">(שורות ' + esc(u.rows.join(', ')) + ')</span></label><select id="cip-val-' + i + '" data-cipval="' + esc(key) + '"><option value="">לא נבחר</option>' + TARGETS[u.field].map(function (t) { return '<option value="' + t + '"' + (W.chosenValues[key] === t ? ' selected' : '') + '>' + esc(word(TARGET_LABEL[u.field], t, t)) + '</option>'; }).join('') + '</select></div>';
    }).join('') + '<div class="ce-bar"><button type="button" class="btn sec" data-cip="apply-values">החלת המיפוי</button></div></div>';
  }
  function visibleRows(p) {
    var q = W.q.trim().toLowerCase();
    return (p.rows || []).filter(function (r) {
      if (W.filter === 'approved') { if (!W.approvals.rows[r.rowNumber]) return false; } else if (W.filter === 'decide') { if (!(r.decisions || []).length) return false; } else if (W.filter !== 'all' && r.status !== W.filter) return false;
      if (!q) return true; var rec = r.record; return !!rec && (String(rec.service.name).toLowerCase().indexOf(q) !== -1 || (rec.provider && String(rec.provider.name).toLowerCase().indexOf(q) !== -1));
    });
  }
  function approvedCount() { return Object.keys(W.approvals.rows).filter(function (n) { return W.approvals.rows[n] && W.approvals.rows[n].apply === true; }).length; }
  function incompleteRows() {
    var byNumber = {}; (W.preview.rows || []).forEach(function (r) { byNumber[r.rowNumber] = r; });
    return Object.keys(W.approvals.rows).filter(function (n) { return byNumber[n] && !rowReady(byNumber[n], W.approvals.rows[n]); }).map(Number).sort(function (a, b) { return a - b; });
  }
  function entityLine(label, x, rec) {
    if (!x) return '';
    var what = x.action === 'existing' ? pill('קיים', 'ok') + ' <span class="ct-small">(מספר ' + esc(String(x.id !== undefined ? x.id : '')) + ')</span>' : x.action === 'new' ? pill('חדש', 'warn') : x.action === 'same_as_row' ? pill('כמו בשורה ' + esc(String(x.row)), 'muted') : pill('נדרשת החלטה', 'warn');
    return '<li><strong>' + esc(label) + ':</strong> <span dir="auto">' + esc(rec) + '</span> ' + what + '</li>';
  }
  function rowHtml(r) {
    var n = r.rowNumber, a = W.approvals.rows[n], rec = r.record, head = '<h4 class="cip-h"><span class="ct-nw">שורה ' + esc(String(n)) + '</span> ' + pill(STATUS_NAME[r.status] || r.status, STATUS_TONE[r.status] || 'muted') + (r.status === 'skipped' ? ' <span class="ct-small">' + esc(word(SKIP_NAME, r.reason, '')) + '</span>' : '') + '</h4>';
    if (r.status === 'skipped') return '<article class="cip-row cip-skipped" data-row="' + n + '">' + head + '</article>';
    var html = '<article class="cip-row cip-' + esc(r.status) + '" data-row="' + n + '">' + head + '<ul class="cip-ent">' + entityLine('שירות', r.service, rec.service.name) + (rec.provider ? entityLine('נותן שירות', r.provider, rec.provider.name + (rec.provider.business ? ' — ' + rec.provider.business : '')) : '<li class="ct-small">אין נותן שירות בשורה, ולכן אין התקשרות.</li>') +
      (r.engagement ? '<li><strong>התקשרות:</strong> ' + (r.engagement.action === 'new' ? pill('חדשה, תיווצר ' + (rec.engagement && rec.engagement.activation === 'pending' ? 'ממתינה לאישור' : 'כטיוטה') + ', לא פעילה', 'warn') : pill('קיימת', 'ok')) + '</li>' : '') +
      (rec.layer ? '<li><strong>מחיר (מדווח בלבד):</strong> ' + esc(KindName(rec.layer.kind)) + ' · <span dir="auto">' + esc(layerText(rec.layer)) + '</span> <span class="ct-small">לא מחיר מאושר ולא הצעת ספק</span></li>' : '') + '</ul>';
    if ((r.problems || []).length) html += '<div class="ce-bad" role="note"><strong>בעיות:</strong><ul>' + r.problems.map(function (x) { return '<li>' + esc(problemText(x, 'row')) + '</li>'; }).join('') + '</ul><p class="ct-small">אפשר לתקן בגיליון ולטעון שוב, או ב״עריכת טקסט הקובץ״. אישורים של שורות אחרות נשמרים.</p></div>';
    if ((r.warnings || []).length || (r.flags || []).length) html += '<ul class="cip-notes">' + (r.warnings || []).map(function (x) { return '<li>' + esc(warningText(x)) + '</li>'; }).join('') + (r.flags || []).map(function (x) { return '<li>' + esc(flagText(x)) + '</li>'; }).join('') + '</ul>';
    if ((r.changes || []).length) html += '<div class="cip-changes"><strong>שינויים לעומת מה שקיים:</strong><ul>' + r.changes.map(function (c) { return changeHtml(r, c, a); }).join('') + '</ul></div>';
    if ((r.decisions || []).length) html += r.decisions.map(function (d) { return decisionHtml(r, d, a); }).join('');
    if ((r.needsConfirmation || []).length) html += '<div class="cip-confirm"><strong>דורש אישור מפורש:</strong>' + r.needsConfirmation.map(function (f) { return '<label class="ce-check"><input type="checkbox" data-cipconfirm="' + n + '" value="' + esc(f) + '"' + (a && (a.confirmed || []).indexOf(f) !== -1 ? ' checked' : '') + (a ? '' : ' disabled') + '> ' + esc(flagText(f)) + ' ראיתי והבנתי.</label>'; }).join('') + '</div>';
    if (applicable(r)) html += '<label class="ce-check cip-apply"><input type="checkbox" data-cipapply="' + n + '"' + (a ? ' checked' : '') + '> אישור שורה ' + esc(String(n)) + '</label>' + (a && !rowReady(r, a) ? '<p class="ct-small cip-incomplete" role="status">האישור לא שלם: ' + esc(missingText(r, a)) + '</p>' : '');
    else if (r.status === 'unchanged') html += '<p class="ct-small">אין מה לשמור: הנתונים זהים למה שקיים.</p>';
    return html + '</article>';
  }
  function KindName(k) { return k === 'market' ? 'מחיר שוק' : k === 'provider_offer' ? 'הצעת הספק' : 'ערך שטרם סווג'; }
  function missingText(r, a) {
    var out = [];
    (r.decisions || []).forEach(function (d) { var x = (a.decisions || {})[d.entity]; if (!x || (x.use !== 'existing' && x.use !== 'new') || (x.use === 'existing' && (x.id === undefined || x.id === null))) out.push('חסרה החלטה על ' + (d.entity === 'service' ? 'שם השירות' : 'שם נותן השירות')); });
    (r.needsConfirmation || []).forEach(function (f) { if ((a.confirmed || []).indexOf(f) === -1) out.push('חסר אישור על הערה'); });
    return out.filter(function (t, i, all) { return all.indexOf(t) === i; }).join(', ') + '.';
  }
  function changeHtml(r, c, a) {
    var id = c.id, on = !!a && ((c.manual ? a.acceptManual : a.accept) || []).indexOf(id) !== -1, name = c.entity === 'layer' ? (c.field === 'create' ? 'שכבת מחיר חדשה: ' + KindName(c.kind) : 'שכבת מחיר: ' + KindName(c.kind)) : word(ENTITY, c.entity) + ': ' + word(CHANGE_FIELD, c.field, c.field);
    var values = c.entity === 'layer' ? (c.field === 'create' ? '<span dir="auto">' + esc(layerText(c.new)) + '</span>' : '<span dir="auto">' + esc(layerText(c.old)) + '</span> ← <span dir="auto">' + esc(layerText(c.new)) + '</span>') : '<span dir="auto">' + esc(valueText(c.field, c.old)) + '</span> ← <span dir="auto">' + esc(valueText(c.field, c.new)) + '</span>';
    return '<li><label class="ce-check"><input type="checkbox" data-cipchange="' + esc(id) + '" data-cipmanual="' + (c.manual ? '1' : '0') + '" data-row="' + r.rowNumber + '"' + (on ? ' checked' : '') + (a && !c.blocked ? '' : ' disabled') + '> ' + esc(name) + ': ' + values + '</label>' +
      (c.manual ? ' <span class="ct-small">הערך נערך ידנית: הסימון הזה הוא אישור נפרד לדרוס אותו.</span>' : '') + (c.entity === 'service' && c.field === 'topic' ? ' <span class="ct-small">התחום בגיליון הוא טקסט חופשי, ובשירות קיים הוא מזהה של תחום באתר: החלפה עלולה לנתק את השירות מהתחום. מומלץ לא לאשר.</span>' : '') + (c.blocked ? ' <span class="ct-small">' + esc(word(BLOCKED, c.blocked, 'השינוי חסום.')) + '</span>' : '') + '</li>';
  }
  function decisionHtml(r, d, a) {
    var cur = a && a.decisions && a.decisions[d.entity], entity = d.entity === 'service' ? 'שירות' : 'נותן שירות', name = 'cipdec-' + r.rowNumber + '-' + d.entity;
    var why = d.type === 'same_name_other_business' ? 'קיים נותן שירות באותו שם בעסק אחר' : 'קיים ' + entity + ' בשם דומה';
    return '<fieldset class="cip-dec"' + (a ? '' : ' disabled') + '><legend>' + esc(why) + '. מה לעשות? (שום דבר לא ימוזג אוטומטית)</legend>' + d.candidates.map(function (c) {
      return '<label class="ce-check"><input type="radio" name="' + name + '" data-cipdec="' + r.rowNumber + '" data-entity="' + d.entity + '" data-use="existing" data-id="' + esc(String(c.id)) + '"' + (cur && cur.use === 'existing' && String(cur.id) === String(c.id) ? ' checked' : '') + '> להשתמש בקיים: <span dir="auto">' + esc(c.name + (c.business ? ' — ' + c.business : '')) + '</span> <span class="ct-small">(מספר ' + esc(String(c.id)) + (c.score ? ', דמיון ' + Math.round(c.score * 100) + '%' : '') + ')</span></label>';
    }).join('') + '<label class="ce-check"><input type="radio" name="' + name + '" data-cipdec="' + r.rowNumber + '" data-entity="' + d.entity + '" data-use="new"' + (cur && cur.use === 'new' ? ' checked' : '') + '> ליצור ' + esc(entity) + ' חדש</label></fieldset>';
  }
  function resultHtml() {
    var r = W.result, applied = r && r.applied;
    return '<section class="panel cip-done" aria-labelledby="cip-done-h"><h3 id="cip-done-h">' + (applied ? 'הייבוא נשמר' : 'לא היה מה לשמור') + '</h3>' + (applied ? '<p>' + esc(String((r.rows_applied || []).length)) + ' שורות נשמרו, בעסקה אחת. כל מה שנוצר ממתין לבדיקה שלכם: שום דבר לא הופעל.</p>' + summaryHtml(r.operations || {}) : '<p>האישורים שנבחרו לא משנים דבר, ולכן לא נכתב דבר.</p>') +
      '<div class="ce-bar"><button type="button" class="btn" data-cipgo="providers">נותני השירות</button><button type="button" class="btn" data-cipgo="services">השירותים</button><button type="button" class="btn" data-cipgo="engagements">ההתקשרויות</button><button type="button" class="btn" data-cipgo="prices">המחירים</button><button type="button" class="btn sec" data-cipgo="imports">היסטוריית ייבוא</button><button type="button" class="btn sec" data-cip="again">ייבוא קובץ נוסף</button></div></section>';
  }

  /* ---------- actions ---------- */
  // the file box is a new element at every drawing; everything else is wired ONCE per screen (delegated on the wrapper), so nothing can run twice
  function bindFile(api) { var file = api.el.querySelector('#cip-file'); if (file) file.addEventListener('change', function () { readFile(api, file.files && file.files[0]); }); }
  function wire(api) {
    var el = api.el, h = api.h;
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-cip]'), g = ev.target.closest('[data-cipgo]');
      if (g) return h.go(g.dataset.cipgo);
      if (!b || b.disabled) return; var a = b.dataset.cip;
      if (a === 'preview') return runPreview(api, false); if (a === 'edit') return editText(api); if (a === 'template') return template(); if (a === 'reset' || a === 'again') { W = fresh(); return paint(api); }
      if (a === 'apply-columns') { W.columnMap = {}; Object.keys(W.chosenColumns).forEach(function (t) { if (W.chosenColumns[t]) W.columnMap[t] = W.chosenColumns[t]; }); return runPreview(api, true); }
      if (a === 'apply-values') { W.mappings = mappingsFrom(W.chosenValues); return runPreview(api, true); }
      if (a === 'approve-clean') { (W.preview.rows || []).forEach(function (r) { if (r.status === 'new' && !(r.decisions || []).length && !(r.needsConfirmation || []).length && !(r.problems || []).length) setApproval(r, true); }); return paint(api); }
      if (a === 'approve-none') { W.approvals = { rows: {} }; W.sigs = {}; return paint(api); }
      if (a === 'prev') { W.page = Math.max(0, W.page - 1); return paint(api); } if (a === 'next') { W.page += 1; return paint(api); }
      if (a === 'review') return reviewDialog(api);
    });
    el.addEventListener('change', function (ev) {
      var t = ev.target; if (!t || !t.dataset) return;
      if (t.dataset.cipcol !== undefined) { W.chosenColumns[t.dataset.cipcol] = t.value; return; }
      if (t.dataset.cipval !== undefined) { W.chosenValues[t.dataset.cipval] = t.value; return; }
      if (t.id === 'cip-f') { W.filter = t.value; W.page = 0; return paint(api); }
      var rows = W.preview ? W.preview.rows || [] : [], find = function (n) { return rows.filter(function (r) { return String(r.rowNumber) === String(n); })[0]; };
      if (t.dataset.cipapply !== undefined) { var r = find(t.dataset.cipapply); if (r) setApproval(r, t.checked); return paint(api); }
      var a = t.dataset.cipconfirm !== undefined ? W.approvals.rows[t.dataset.cipconfirm] : null;
      if (a) { a.confirmed = (a.confirmed || []).filter(function (f) { return f !== t.value; }); if (t.checked) a.confirmed.push(t.value); return paint(api); }
      if (t.dataset.cipchange !== undefined) { var ap = W.approvals.rows[t.dataset.row], list = t.dataset.cipmanual === '1' ? 'acceptManual' : 'accept'; if (ap) { ap[list] = (ap[list] || []).filter(function (x) { return x !== t.dataset.cipchange; }); if (t.checked) ap[list].push(t.dataset.cipchange); } return paint(api); }
      if (t.dataset.cipdec !== undefined) { var ad = W.approvals.rows[t.dataset.cipdec]; if (ad) { ad.decisions = ad.decisions || {}; ad.decisions[t.dataset.entity] = t.dataset.use === 'new' ? { use: 'new' } : { use: 'existing', id: t.dataset.id }; } return paint(api); }
    });
    el.addEventListener('input', function (ev) { if (ev.target && ev.target.id === 'cip-q') { W.q = ev.target.value; W.page = 0; clearTimeout(W.__t); W.__t = setTimeout(function () { var pos = ev.target.selectionStart; paint(api); var q = api.el.querySelector('#cip-q'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) { /* a search box that cannot keep its cursor */ } } }, 250); } });
  }
  function setApproval(row, on) {
    if (!applicable(row)) return;
    if (on) { W.approvals.rows[row.rowNumber] = W.approvals.rows[row.rowNumber] || startApproval(row); W.sigs[row.rowNumber] = signature(row); } else { delete W.approvals.rows[row.rowNumber]; delete W.sigs[row.rowNumber]; }
  }
  function readFile(api, f) {
    if (!f) return;
    if (f.size > MAX_BYTES) { W.error = 'הקובץ גדול מדי (' + f.size + ' בתים, עד 1MB).'; return paint(api); }
    var rd = new FileReader(); W.busy = true; W.error = null; paint(api);
    rd.onload = function () { W.busy = false; W.csv = String(rd.result || ''); W.name = f.name; W.bytes = f.size; W.error = null; W.preview = null; W.result = null; paint(api); };
    rd.onerror = function () { W.busy = false; W.error = 'לא ניתן היה לקרוא את הקובץ. לא נשלח דבר.'; paint(api); };
    rd.readAsText(f, 'utf-8');
  }
  function template() {
    var header = Object.keys(COLUMN).map(function (k) { return COLUMN[k]; });
    var csv = '﻿' + header.map(function (x) { return '"' + x.replace(/"/g, '""') + '"'; }).join(',') + '\r\n';
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'kaspchem-sheet-headers.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function runPreview(api, keepWork) {
    var h = api.h; if (!W.csv || W.busy) return;
    W.busy = true; W.error = null; paint(api);
    var body = { csv: W.csv }; if (Object.keys(W.mappings).length) body.mappings = W.mappings; if (Object.keys(W.columnMap).length) body.columnMap = W.columnMap;
    K.send(h.ctx, 'POST', '/catalog/imports/preview', body).then(function (r) {
      W.busy = false; var p = r.preview;
      var kept = keepWork || Object.keys(W.approvals.rows).length ? reconcile(W.approvals, W.sigs, p) : { approvals: { rows: {} }, sigs: {}, dropped: [] };
      W.preview = p; W.approvals = kept.approvals; W.sigs = kept.sigs; W.dropped = kept.dropped; W.page = 0; paint(api);
      var hd = api.el.querySelector('#cip-review-h'); if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: false }); }
    }, function (e) {
      W.busy = false; var d = K.describe(e); if (d.kind === 'auth') return h.ctx.fail(e);
      W.error = d.kind === 'unknown' ? 'לא התקבלה תשובה לבקשה. לא נשמר דבר (התצוגה המקדימה אינה כותבת). אפשר לנסות שוב.' : (d.kind === 'busy' ? d.message : e && e.message === 'too_large' ? 'הקובץ גדול מדי.' : e && e.message === 'bad_csv' ? 'הקובץ ריק.' : d.message || 'לא ניתן היה להפיק תצוגה מקדימה.'); paint(api);
    });
  }
  function editText(api) {
    var ctl = K.openDialog({ title: 'עריכת טקסט הקובץ', focus: '#ce-text',
      intro: '<p>אפשר לתקן כאן תאים בטקסט הקובץ (עדיין ב־CSV: ערכים מופרדים בפסיקים, מרכאות סביב תא עם פסיק). התיקון נשאר בדף בלבד ואינו משנה את הקובץ המקורי. אחרי השמירה תופק תצוגה מקדימה חדשה, ואישורים של שורות שלא השתנו יישמרו.</p>',
      fields: K.field('text', 'טקסט הקובץ', '<textarea id="ce-text" name="text" class="cip-text" dir="auto" spellcheck="false" aria-describedby="ce-text-e">' + esc(W.csv || '') + '</textarea>', ''), submit: 'שמירה והפקת תצוגה מקדימה',
      check: function (v) { if (!String(v.text).trim()) return { field: 'text', message: 'הטקסט ריק.' }; if (new Blob([v.text]).size > MAX_BYTES) return { field: 'text', message: 'הטקסט גדול מדי (עד 1MB).' }; return null; },
      onSubmit: function (v) { W.csv = v.text; W.bytes = new Blob([v.text]).size; W.name = (W.name || 'הדבקה') + ' (נערך)'; ctl.close(); runPreview(api, true); } });
  }
  function reviewDialog(api) {
    var h = api.h, p = W.preview, sum = summarize(p, W.approvals), count = approvedCount(), approvals = JSON.parse(JSON.stringify(W.approvals));
    var ctl = K.openDialog({ title: 'אישור הייבוא', focus: '#ce-confirmbox',
      intro: '<p><strong>' + esc(String(count)) + ' שורות מאושרות.</strong> זה מה שיישמר, בעסקה אחת (או שלא יישמר דבר):</p>' + summaryHtml(sum) +
        '<ul class="cip-never"><li>לא מופעל שום שירות או התקשרות: שירותים נוצרים כבויים, התקשרויות כטיוטה או ממתינות.</li><li>לא נוצר מחיר מאושר ולא הצעת ספק: מחירים נרשמים כמדווחים בלבד.</li><li>לא מיובאות עמלות, ושום דבר לא נמחק.</li><li>הקובץ עצמו לא נשמר; ביומן נשמרים רק טביעה, ספירות וקודים.</li></ul>',
      fields: '<div class="ce-field" data-field="ack"><label class="ce-check"><input id="ce-ack" name="ack" type="checkbox"> עברתי על השינויים והם נכונים.</label><p class="ce-fe" id="ce-ack-e"></p></div>' + K.field('confirmbox', 'אישור מוקלד: import', '<input id="ce-confirmbox" name="confirmbox" type="text" dir="ltr" class="ce-ltr" autocomplete="off" aria-describedby="ce-confirmbox-h ce-confirmbox-e">', 'כדי לאשר, הקלידו בדיוק את המילה import (באנגלית, באותיות קטנות).'),
      submit: 'לשמור את הייבוא',
      check: function (v) { if (!v.ack) return { field: 'ack', message: 'יש לסמן שעברתם על השינויים.' }; return String(v.confirmbox || '').trim() === 'import' ? null : { field: 'confirmbox', message: 'כדי לאשר יש להקליד בדיוק: import' }; },
      onSubmit: function () {
        var body = { csv: W.csv, previewId: p.previewId, approvals: approvals }; if (Object.keys(W.mappings).length) body.mappings = W.mappings; if (Object.keys(W.columnMap).length) body.columnMap = W.columnMap;
        K.write(h, ctl, 'POST', '/catalog/imports/apply', body, { refine: applyRefine,
          ok: function (r) { ctl.close(); W.result = r; K.toast(r.applied ? 'הייבוא נשמר' : 'לא היה מה לשמור'); paint(api); },
          stale: function (dd) { staleApply(api, ctl, dd.message); }, blocked: function (dd) { ctl.showPanel('<div class="ce-warn" role="alert"><strong>הייבוא לא נשמר.</strong> ' + esc(dd.message) + '</div>' + (dd.list ? '<ul>' + dd.list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') + '<p class="ce-actions"><button class="btn" type="button" data-ce="refresh">חזרה לתצוגה (העבודה נשמרה)</button></p>'); ctl.onRefresh = function () { paint(api); }; ctl.seal(ctl.onRefresh); },
          unknown: null });
      } });
    // after an answer nobody can read: a new preview is the check (rows that were saved show as "no change")
    ctl.__unknownRefresh = function () { runPreview(api, true); };
    var orig = ctl.showUnknown; ctl.showUnknown = function (text) { orig.call(ctl, text + ' לבדיקה: הפיקו תצוגה מקדימה חדשה. שורות שנשמרו יופיעו שם כ״ללא שינוי״. אל תשלחו שוב לפני כן.', function () { runPreview(api, true); }); };
  }
  function applyRefine(e, d) {
    var code = e && e.message, det = e && e.details || {};
    if (code === 'preview_stale') return { kind: 'stale', message: 'הקובץ או הנתונים במערכת השתנו מאז התצוגה המקדימה, ולכן לא נשמר דבר. יש להפיק תצוגה חדשה ולבדוק שוב.' };
    if (code === 'rows_refused') return { kind: 'blocked', message: 'חלק מהשורות שאושרו אינן ניתנות לשמירה, ולכן לא נשמר דבר.', list: refusedList(det.codes) };
    if (code === 'file_not_usable') return { kind: 'blocked', message: 'הקובץ אינו ניתן לשימוש, ולכן לא נשמר דבר.' };
    if (code === 'preview_not_usable' || code === 'preview_mismatch') return { kind: 'stale', message: 'התצוגה המקדימה כבר אינה תואמת, ולכן לא נשמר דבר. יש להפיק תצוגה חדשה.' };
    if (code === 'bad_approvals' || code === 'bad_csv' || code === 'bad_mappings' || code === 'bad_column_map') return { kind: 'blocked', message: 'שגיאה פנימית בטופס. לא נשמר דבר.' };
    return d;
  }
  function staleApply(api, ctl, text) {
    ctl.showPanel('<div class="ce-warn" role="alert"><strong>הייבוא לא נשמר.</strong> ' + esc(text) + '</div><p class="ce-actions"><button class="btn" type="button" data-ce="refresh">הפקת תצוגה חדשה (העבודה נשמרת)</button></p>');
    ctl.onRefresh = function () { runPreview(api, true); }; ctl.seal(ctl.onRefresh);
  }

  C.extend({ screens: [{ key: 'import', label: 'ייבוא מהגיליון', before: 'imports', draw: draw }] });
  root.KaspchemCatalogImport = { _t: { problemText: problemText, warningText: warningText, flagText: flagText, signature: signature, startApproval: startApproval, rowReady: rowReady, reconcile: reconcile, summarize: summarize, unknownValues: unknownValues, mappingsFrom: mappingsFrom, refusedText: refusedText, applyRefine: applyRefine, rowHtml: function (r, approvals) { var keep = W; W = fresh(); W.approvals = approvals || { rows: {} }; try { return rowHtml(r); } finally { W = keep; } },
    FILE_PROBLEM: FILE_PROBLEM, ROW_PROBLEM: ROW_PROBLEM, WARNING: WARNING, FLAG: FLAG, REFUSED: REFUSED, TARGETS: TARGETS, COLUMN: COLUMN, CHANGE_FIELD: CHANGE_FIELD, MAX_BYTES: MAX_BYTES } };
})(typeof window !== 'undefined' ? window : this);
