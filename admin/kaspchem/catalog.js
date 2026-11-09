/* Catalog screens for the admin area, stage 5a: READ ONLY.
 * Providers, their services, the state of every engagement, the four kinds of price, the import history and the change log.
 * Every request this file makes is a GET to /api/kaspchem/admin/catalog/... (one helper, below, refuses anything else). There is no form that saves, no create / edit / approve / activate / import
 * control, and no button that does nothing: every button on these screens either moves between screens, filters, pages, or asks the server again after a failure.
 * Nothing about commissions or compensation is requested or shown (the server does not send it either). Text from the server is always escaped before it is put on the page.
 * The pure functions (labels, price text, the HTML of each block) are exposed on KaspchemCatalog._t so the tests can run them without a browser.
 */
(function (root) {
  'use strict';

  /* ---------- labels ---------- */
  var ACTIVATION = { draft: 'טיוטה', pending: 'ממתין לאישור', active: 'פעיל', paused: 'מושהה', retired: 'הוצא משימוש' };
  var ACT_TONE = { draft: 'muted', pending: 'warn', active: 'ok', paused: 'warn', retired: 'muted' };
  var CONTACT = { none: 'אין קשר', contacted: 'נוצר קשר', negotiating: 'במשא ומתן', active: 'שיתוף פעולה פעיל', stopped: 'הופסק' };
  var CONTACT_TONE = { none: 'muted', contacted: 'warn', negotiating: 'warn', active: 'ok', stopped: 'bad' };
  var AGREEMENT = { not_discussed: 'לא נדון', draft: 'טיוטת הסכם', signed: 'חתום', ended: 'הסתיים' };
  var AGR_TONE = { not_discussed: 'muted', draft: 'warn', signed: 'ok', ended: 'muted' };
  var MODEL = { fixed: 'מחיר קבוע', percent_of_result: 'אחוז מהתוצאה', percent_with_minimum: 'אחוז עם מינימום', variable: 'משתנה לפי מורכבות', quote: 'הצעת מחיר לכל מקרה', tbd: 'טרם נקבע' };
  var PROVIDER_STATE = { available: 'זמין', paused: 'מושהה', archived: 'בארכיון' };
  var PS_TONE = { available: 'ok', paused: 'warn', archived: 'muted' };
  var DELIVERY = { portal: 'דרך פורטל', manual: 'ידני (הצוות מזין)' };
  var LAYER_STATUS = { recorded: 'נרשם', awaiting_response: 'ממתין לתשובה', received: 'התקבלה תשובה', declined: 'נדחה' };
  var ENTITY = { provider: 'נותן שירות', service: 'שירות', engagement: 'התקשרות', catalog_import: 'ייבוא' };
  var ACTIONS = {
    'catalog.provider.view': 'צפייה בכרטיס נותן שירות', 'catalog.provider.create': 'יצירת נותן שירות', 'catalog.provider.update': 'עדכון נותן שירות',
    'catalog.service.create': 'יצירת שירות', 'catalog.service.update': 'עדכון שירות', 'catalog.service.settings.create': 'יצירת הגדרות שירות', 'catalog.service.settings.update': 'עדכון הגדרות שירות', 'catalog.service.clearance': 'אישור משפטי של שירות',
    'catalog.engagement.create': 'יצירת התקשרות', 'catalog.engagement.update': 'עדכון התקשרות', 'catalog.engagement.submit': 'שליחת התקשרות לאישור', 'catalog.engagement.withdraw': 'משיכת התקשרות', 'catalog.engagement.activate': 'הפעלת התקשרות',
    'catalog.engagement.pause': 'השהיית התקשרות', 'catalog.engagement.resume': 'חידוש התקשרות', 'catalog.engagement.retire': 'הוצאת התקשרות משימוש',
    'catalog.price.classify': 'סיווג מחיר', 'catalog.price.link': 'קישור מחיר', 'catalog.price.unlink': 'ניתוק מחיר', 'catalog.import.apply': 'החלת ייבוא'
  };
  var PROBLEMS = {
    too_many_rows: 'יותר מדי שורות בקובץ', duplicate_engagement: 'התקשרות כפולה בקובץ', duplicate_external_ref: 'מזהה חיצוני כפול', external_ref_belongs_to_another_engagement: 'המזהה החיצוני שייך להתקשרות אחרת',
    ambiguous_existing_service: 'כמה שירותים קיימים מתאימים', ambiguous_existing_provider: 'כמה נותני שירות קיימים מתאימים', ambiguous_existing_engagement: 'כמה התקשרויות קיימות מתאימות', price_not_numeric: 'המחיר אינו מספר'
  };
  var ENFORCED = { database: 'נאכף בבסיס הנתונים', server: 'נאכף בשרת', later: 'שלב עתידי' };
  var SCREENS = [['overview', 'סקירה'], ['providers', 'נותני שירות'], ['services', 'שירותים'], ['engagements', 'התקשרויות'], ['imports', 'היסטוריית ייבוא'], ['history', 'יומן שינויים']];
  var PARENT = { provider: 'providers', service: 'services', engagement: 'engagements' };
  var PAGE = 50, ENG_PAGE = 200, ENG_CAP = 1000;

  /* ---------- small pure helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function has(map, key) { return Object.prototype.hasOwnProperty.call(map, key); }
  function lbl(map, key) { return has(map, key) ? map[key] : (key == null ? '' : String(key)); }
  function pill(text, tone) { return '<span class="ct-pill ct-' + (tone || 'muted') + '">' + esc(text) + '</span>'; }
  function unset(text) { return '<span class="ct-unset">' + esc(text || 'לא הוזן') + '</span>'; }
  function val(v, text) { return v == null || v === '' ? unset(text) : esc(v); }
  function ltr(v) { return v == null || v === '' ? unset() : '<span dir="ltr">' + esc(v) + '</span>'; }
  function num(n) { return Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 }); }
  function ils(n) { if (n == null || n === '') return ''; var v = Number(n); return v.toLocaleString('he-IL', { minimumFractionDigits: Math.round(v * 100) % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }) + ' ₪'; }
  function when(d) { return d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  function whenH(d) { return d ? '<span dir="ltr" class="ct-nw">' + esc(when(d)) + '</span>' : ''; }
  function mail(v) { return v ? '<span dir="ltr">' + esc(v) + '</span>' : ''; }   // a date with a time keeps its own left-to-right order inside the right-to-left page
  function day(d) { return d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('he-IL') : ''; }
  function pctRange(lo, hi) { if (lo == null) return ''; return hi == null || Number(hi) === Number(lo) ? num(lo) + '%' : num(lo) + '–' + num(hi) + '%'; }
  function kv(label, valueHtml) { return '<div class="ct-kv"><dt>' + esc(label) + '</dt><dd>' + valueHtml + '</dd></div>'; }
  function plural(n, one, many) { return n === 1 ? one : many; }

  // The price of one layer, in words, by its model.
  function priceText(l) {
    if (!l) return '';
    if (l.model === 'fixed') return ils(l.amount);
    if (l.model === 'percent_of_result') return pctRange(l.percent_low, l.percent_high) + ' מהתוצאה';
    if (l.model === 'percent_with_minimum') return pctRange(l.percent_low, l.percent_high) + ' מהתוצאה, לא פחות מ־' + ils(l.minimum_amount);
    if (l.model === 'variable') return 'משתנה לפי מורכבות';
    if (l.model === 'quote') return 'הצעת מחיר לכל מקרה';
    return 'טרם נקבע';
  }
  function layerBody(l) {
    var bits = ['<p class="ct-amount">' + esc(priceText(l)) + '</p>'];
    if (l.terms_text) bits.push('<p class="ct-quote">״' + esc(l.terms_text) + '״</p>');
    if (l.status && l.status !== 'recorded') bits.push('<p>' + pill(lbl(LAYER_STATUS, l.status), l.status === 'declined' ? 'bad' : 'warn') + '</p>');
    if (l.basis_missing) bits.push('<p class="ct-small">חסר בסיס לחישוב</p>');
    var src = [];
    if (l.source_note) src.push('מקור: ' + esc(l.source_note));
    if (l.source_date) src.push('תאריך: ' + esc(day(l.source_date)));
    if (src.length) bits.push('<p class="ct-small">' + src.join(' · ') + '</p>');
    return bits.join('');
  }
  function priceCard(cls, title, definition, bodyHtml) {
    return '<section class="ct-price ct-price-' + cls + '" aria-label="' + esc(title) + '"><h3>' + esc(title) + '</h3><p class="ct-def">' + esc(definition) + '</p><div class="ct-pbody">' + bodyHtml + '</div></section>';
  }
  var NONE = function (t) { return '<p class="ct-none">' + esc(t) + '</p>'; };

  // The four kinds of price of one engagement, kept apart: market, documented, approved, public.
  function priceSection(d) {
    var L = d.price_layers || {}, ap = d.approved_price;
    var doc = (L.provider_offer ? '<h4>הצעת הספק לכספכם</h4>' + layerBody(L.provider_offer) : '') + (L.unclassified ? '<h4>ערך שטרם סווג</h4>' + layerBody(L.unclassified) : '');
    var approved, pub;
    if (!ap) { approved = NONE('אין מחיר מקושר'); pub = NONE('לא מוצג לציבור'); }
    else {
      approved = '<p class="ct-amount">' + esc(ils(ap.price)) + '</p><p>' + (ap.approved ? pill('מאושר', 'ok') : pill('מקושר, לא אושר', 'warn')) + '</p><p class="ct-small">' + esc(ap.label || '') + '</p>' +
        (ap.approved ? '' : '<p class="ct-small">עדיין לא אושר, ולכן אינו נחשב מחיר מאושר.</p>');
      pub = ap.public ? '<p class="ct-amount">' + esc(ils(ap.price)) + '</p><p>' + pill('מוצג באתר', 'ok') + '</p>' : NONE(ap.approved ? 'מאושר לשימוש פנימי בלבד, לא מוצג לציבור' : 'לא מוצג לציבור');
    }
    return '<div class="ct-prices">' +
      priceCard('market', 'מחיר שוק', 'מה שמקובל בשוק, לידיעה בלבד. אינו הצעה ואינו התחייבות.', L.market ? layerBody(L.market) : NONE('לא תועד מחיר שוק')) +
      priceCard('doc', 'מחיר מתועד', 'מה שנרשם: הצעת הספק וערכים שטרם סווגו. רישום בלבד, ללא אישור.', doc || NONE('לא תועד מחיר')) +
      priceCard('approved', 'מחיר מאושר', 'המחיר ללקוח שאושר בלשונית ״תמחור״. פנימי עד שמפרסמים אותו.', approved) +
      priceCard('public', 'מחיר ציבורי', 'מה שמוצג לציבור באתר. נקבע רק בלשונית ״תמחור״.', pub) + '</div>';
  }
  function checklistHtml(c) {
    var items = (c.items || []).map(function (i) {
      return '<li class="ct-ck ' + (i.ok ? 'ok' : 'no') + '"><b aria-hidden="true">' + (i.ok ? '✓' : '✗') + '</b><span class="ct-cklabel">' + esc(i.label) + '</span> ' +
        pill(i.ok ? 'מתקיים' : (i.blocking ? 'חסר' : 'לא חוסם בשלב זה'), i.ok ? 'ok' : (i.blocking ? 'bad' : 'muted')) + ' <span class="ct-small">' + esc(lbl(ENFORCED, i.enforced)) + '</span></li>';
    }).join('');
    var miss = (c.missing || []).length;
    var sum = c.documented_only ? '<p class="ct-note">מודל התמחור של ההתקשרות הזו אפשר לתעד, אבל אי אפשר להפעיל אותו.</p>' : '';
    sum += c.can_activate ? '<p>כל התנאים להפעלה מתקיימים. ההפעלה עצמה אינה זמינה במסכים האלה.</p>' : '<p><strong>חסרים ' + miss + ' ' + plural(miss, 'תנאי', 'תנאים') + ' כדי שההתקשרות תהיה פעילה.</strong></p>';
    return sum + '<ul class="ct-checklist">' + items + '</ul>';
  }
  // One state of a provider / engagement as a pill.
  function tone(map, k) { return has(map, k) ? map[k] : 'muted'; }
  var actPill = function (a) { return pill(lbl(ACTIVATION, a), tone(ACT_TONE, a)); };
  var contactPill = function (c) { return pill(lbl(CONTACT, c), tone(CONTACT_TONE, c)); };
  var agrPill = function (a) { return pill(lbl(AGREEMENT, a), tone(AGR_TONE, a)); };
  var provPill = function (s) { return pill(lbl(PROVIDER_STATE, s), tone(PS_TONE, s)); };

  function priceChips(e) {
    var k = e.price_layers || [], out = [];
    if (k.indexOf('market') !== -1) out.push('<span class="ct-chip">שוק</span>');
    if (k.indexOf('provider_offer') !== -1 || k.indexOf('unclassified') !== -1) out.push('<span class="ct-chip">מתועד</span>');
    if (e.price_linked) out.push('<span class="ct-chip ct-chip-link">מקושר</span>');
    return out.length ? out.join(' ') : unset('אין מחיר');
  }

  /* ---------- error states ---------- */
  function classify(e) {
    if (!e || e.status === undefined) return 'network';
    if (e.status === 401) return 'auth';
    if (e.status === 403) return e.message === 'catalog_disabled' ? 'closed' : 'forbidden';
    if (e.status === 404) return 'notfound';
    if (e.status === 503) return 'unavailable';
    return 'server';
  }
  var ERRORS = {
    closed: ['הקטלוג כבוי', 'הקטלוג סגור כרגע, ולכן לא מוצגים כאן נתונים. פתיחתו נעשית בהחלטה נפרדת של בעלי המערכת.', true],
    forbidden: ['אין הרשאה', 'מסכי הקטלוג זמינים לבעלי המערכת בלבד.', false],
    unavailable: ['השירות אינו זמין כרגע', 'אי אפשר היה לבדוק אם הקטלוג פתוח, ולכן הוא נשאר סגור. אפשר לנסות שוב.', true],
    network: ['אין חיבור לשרת', 'הבקשה לא הגיעה לשרת. לא נשמר ולא שונה דבר. אפשר לנסות שוב.', true],
    notfound: ['הרשומה לא נמצאה', 'ייתכן שהקישור ישן. אפשר לחזור לרשימה.', false],
    server: ['אירעה שגיאה בשרת', 'הנתונים לא נטענו. לא נשמר ולא שונה דבר. אפשר לנסות שוב.', true]
  };
  function errorHtml(kind) {
    var x = ERRORS[kind] || ERRORS.server;
    return '<div class="panel ct-state ct-state-' + kind + '" role="alert"><h2 tabindex="-1">' + esc(x[0]) + '</h2><p>' + esc(x[1]) + '</p>' +
      (x[2] ? '<p><button type="button" class="btn sec" data-ct="retry">' + (kind === 'closed' ? 'בדיקה מחדש' : 'ניסיון חוזר') + '</button></p>' : '') +
      (kind === 'notfound' ? '<p><button type="button" class="btn sec" data-ct="back">חזרה</button></p>' : '') + '</div>';
  }
  var loadingHtml = function () { return '<p class="ct-loading" role="status">טוען…</p>'; };
  function emptyHtml(title, text) { return '<div class="panel ct-state ct-empty"><h2 tabindex="-1">' + esc(title) + '</h2><p>' + esc(text) + '</p></div>'; }

  /* ---------- the HTML of each screen (pure) ---------- */
  function overviewHtml(o) {
    var total = o.services.total + o.providers.total + o.engagements.total;
    if (!total) return emptyHtml('הקטלוג ריק', 'עדיין אין שירותים, נותני שירות או התקשרויות בקטלוג. כשיתווספו, הם יוצגו כאן.');
    var acts = Object.keys(ACTIVATION).map(function (k) {
      var n = (o.engagements.by_activation || {})[k] || 0;
      return '<li><button type="button" class="ct-link" data-ct="eng-filter" data-act="' + k + '">' + actPill(k) + '</button> <b>' + num(n) + '</b></li>';
    }).join('');
    var models = Object.keys(o.engagements.by_pricing_model || {}).map(function (k) { return '<li><span>' + esc(lbl(MODEL, k)) + '</span> <b>' + num(o.engagements.by_pricing_model[k]) + '</b></li>'; }).join('');
    var li = o.last_import;
    return '<h2 id="ct-h" tabindex="-1" class="sr">סקירה</h2><div class="grid">' +
      '<div class="stat"><b>' + num(o.services.total) + '</b><span>שירותים (' + num(o.services.active) + ' פעילים, ' + num(o.services.not_cleared) + ' ללא אישור משפטי)</span></div>' +
      '<div class="stat"><b>' + num(o.providers.total) + '</b><span>נותני שירות (' + num(o.providers.paused) + ' מושהים, ' + num(o.providers.archived) + ' בארכיון)</span></div>' +
      '<div class="stat"><b>' + num(o.engagements.total) + '</b><span>התקשרויות</span></div></div>' +
      '<div class="ct-cols"><div class="panel"><h3>התקשרויות לפי מצב</h3><ul class="ct-list">' + acts + '</ul></div>' +
      '<div class="panel"><h3>לפי מודל תמחור</h3>' + (models ? '<ul class="ct-list">' + models + '</ul>' : '<p class="ct-small">אין התקשרויות.</p>') + '</div>' +
      '<div class="panel"><h3>ייבוא אחרון</h3>' + (li ? '<dl class="ct-dl">' + kv('תאריך', whenH(li.created_at)) + kv('מקור', esc(String(li.source).toUpperCase())) + kv('שורות בקובץ', num(li.rows_total)) + kv('נוצרו / עודכנו / דולגו', num(li.rows_created) + ' / ' + num(li.rows_updated) + ' / ' + num(li.rows_skipped)) + kv('בעיות', num(li.problems)) + kv('בוצע על ידי', esc(li.imported_by)) + '</dl>' : '<p class="ct-small">עדיין לא בוצע ייבוא.</p>') + '</div></div>' +
      '<p class="ct-small ct-foot">מסכי הקטלוג אינם מציגים נתוני תגמול או עמלות, ואינם משנים נתונים.</p>';
  }

  function optionsHtml(map, sel, blank) { return '<option value="">' + esc(blank) + '</option>' + Object.keys(map).map(function (k) { return '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(map[k]) + '</option>'; }).join(''); }
  function pagerHtml(total, offset, limit) {
    if (total <= limit) return '';
    var from = offset + 1, to = Math.min(total, offset + limit);
    return '<nav class="ct-pager" aria-label="עמודים">' + (offset > 0 ? '<button type="button" class="btn sec mini" data-ct="page" data-d="-1">הקודם</button>' : '') + '<span>' + num(from) + '–' + num(to) + ' מתוך ' + num(total) + '</span>' + (to < total ? '<button type="button" class="btn sec mini" data-ct="page" data-d="1">הבא</button>' : '') + '</nav>';
  }
  function providersTable(r, filtered) {
    if (!r.providers.length) return filtered ? emptyHtml('לא נמצאו נותני שירות', 'אין נותני שירות שמתאימים לסינון.') : emptyHtml('אין נותני שירות', 'עדיין לא נוספו נותני שירות לקטלוג.');
    return '<table class="tbl ct-tbl"><caption class="sr">נותני שירות</caption><thead><tr><th>שם</th><th>עסק או ארגון</th><th>מצב</th><th>אופן העברה</th><th>התקשרויות</th></tr></thead><tbody>' + r.providers.map(function (p) {
      return '<tr class="click" data-ct-row="provider" data-id="' + p.id + '"><td><button type="button" class="ct-link" data-ct="open-provider" data-id="' + p.id + '">' + esc(p.name) + '</button></td><td>' + val(p.business_name, '—') + '</td><td>' + provPill(p.state) +
        (p.state === 'paused' && p.paused_until ? ' <span class="ct-small">עד ' + esc(day(p.paused_until)) + '</span>' : '') + '</td><td>' + esc(lbl(DELIVERY, p.delivery_method)) + '</td><td>' + (p.engagements ? num(p.engagements) + ' (' + num(p.engagements_active) + ' פעילות)' : unset('אין שירותים')) + '</td></tr>';
    }).join('') + '</tbody></table>' + pagerHtml(r.total, r.offset, r.limit);
  }
  function servicesTable(r, filtered, topicName) {
    if (!r.services.length) return filtered ? emptyHtml('לא נמצאו שירותים', 'אין שירותים שמתאימים לסינון.') : emptyHtml('אין שירותים', 'עדיין לא נוספו שירותים לקטלוג.');
    return '<table class="tbl ct-tbl"><caption class="sr">שירותים</caption><thead><tr><th>שם</th><th>תחום</th><th>פעיל</th><th>אישור משפטי</th><th>התקשרויות</th><th>קוד</th></tr></thead><tbody>' + r.services.map(function (s) {
      return '<tr class="click" data-ct-row="service" data-id="' + s.id + '"><td><button type="button" class="ct-link" data-ct="open-service" data-id="' + s.id + '">' + esc(s.name) + '</button></td><td>' + val(s.topic ? topicName(s.topic) : '', '—') + '</td><td>' + (s.active ? pill('פעיל', 'ok') : pill('כבוי', 'muted')) + '</td><td>' + (s.legal_cleared ? pill('אושר', 'ok') : pill('לא אושר', 'warn')) + '</td><td>' +
        (s.engagements ? num(s.engagements) + ' (' + num(s.engagements_active) + ' פעילות)' : unset('אין')) + '</td><td>' + ltr(s.code) + '</td></tr>';
    }).join('') + '</tbody></table>' + pagerHtml(r.total, r.offset, r.limit);
  }
  function engagementsTable(rows, filtered, total, capped, offset) {
    if (!rows.length) return filtered ? emptyHtml('לא נמצאו התקשרויות', 'אין התקשרויות שמתאימות לסינון.') : emptyHtml('אין התקשרויות', 'עדיין לא נוספו התקשרויות בין נותני שירות לשירותים.');
    var page = rows.slice(offset, offset + PAGE);
    return '<table class="tbl ct-tbl"><caption class="sr">התקשרויות</caption><thead><tr><th>נותן שירות</th><th>שירות</th><th>הפעלה</th><th>קשר</th><th>הסכם</th><th>מודל תמחור</th><th>מחיר</th></tr></thead><tbody>' + page.map(function (e) {
      return '<tr class="click" data-ct-row="engagement" data-p="' + e.provider_id + '" data-s="' + e.service_id + '"><td><button type="button" class="ct-link" data-ct="open-eng" data-p="' + e.provider_id + '" data-s="' + e.service_id + '">' + esc(e.provider_name) + '</button></td><td>' + esc(e.service_name) + '</td><td>' + actPill(e.activation) + '</td><td>' + contactPill(e.contact_state) + '</td><td>' + agrPill(e.agreement_state) + '</td><td>' + esc(lbl(MODEL, e.pricing_model)) + '</td><td>' + priceChips(e) + '</td></tr>';
    }).join('') + '</tbody></table>' + pagerHtml(rows.length, offset, PAGE) +
      '<p class="ct-small ct-foot">מחיר: ״שוק״ = יש מחיר שוק מתועד · ״מתועד״ = יש הצעת ספק או ערך שטרם סווג · ״מקושר״ = משויכת שורת תמחור (האישור והפרסום מוצגים בכרטיס ההתקשרות).</p>' +
      (capped ? '<p class="warn">מוצגות ' + num(rows.length) + ' התקשרויות מתוך ' + num(total) + '. צמצמו את הסינון כדי לראות את השאר.</p>' : '');
  }
  function providerHtml(d) {
    var p = d.provider, es = d.engagements || [];
    var rows = es.length ? '<div class="scroll"><table class="tbl ct-tbl"><caption class="sr">שירותים משויכים</caption><thead><tr><th>שירות</th><th>הפעלה</th><th>קשר</th><th>הסכם</th><th>מודל תמחור</th></tr></thead><tbody>' + es.map(function (e) {
      return '<tr class="click" data-ct-row="engagement" data-p="' + p.id + '" data-s="' + e.service_id + '"><td><button type="button" class="ct-link" data-ct="open-eng" data-p="' + p.id + '" data-s="' + e.service_id + '">' + esc(e.service_name) + '</button></td><td>' + actPill(e.activation) + '</td><td>' + contactPill(e.contact_state) + '</td><td>' + agrPill(e.agreement_state) + '</td><td>' + esc(lbl(MODEL, e.pricing_model)) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="ct-none">לנותן השירות הזה אין שירותים משויכים עדיין.</p>';
    return '<h2 id="ct-h" tabindex="-1">' + esc(p.name) + ' ' + provPill(p.state) + '</h2>' +
      '<div class="panel"><h3>פרטי נותן השירות</h3><dl class="ct-dl">' + kv('שם', esc(p.name)) + kv('עסק או ארגון', val(p.business_name)) + kv('טלפון', ltr(p.contact_phone)) + kv('דוא״ל', ltr(p.contact_email)) +
      kv('אופן העברה', esc(lbl(DELIVERY, p.delivery_method))) + kv('קיבולת פתוחה', p.capacity_open == null ? unset() : num(p.capacity_open)) +
      (p.state === 'paused' ? kv('מושהה עד', esc(day(p.paused_until))) : '') + (p.state === 'archived' ? kv('הועבר לארכיון', esc(day(p.archived_at))) : '') + kv('הערות פנימיות', p.internal_notes ? '<span class="ct-prewrap">' + esc(p.internal_notes) + '</span>' : unset('אין')) + '</dl>' +
      '<p class="ct-small">פרטי הקשר גלויים לבעלי המערכת בלבד. פתיחת הכרטיס נרשמת ביומן השינויים (מי פתח ואיזה נותן שירות, בלי פרטי הקשר).</p></div>' +
      '<div class="panel"><h3>שירותים משויכים (' + num(es.length) + ')</h3>' + rows + '</div>';
  }
  function serviceHtml(d, topicName) {
    var s = d.service, st = d.settings || {}, es = d.engagements || [], sim = d.similar_services || [];
    var tags = (st.finding_tags || []).map(function (t) { return '<span class="ct-chip">' + esc(t) + '</span>'; }).join(' ');
    var topics = (st.topics || []).map(function (t) { return '<span class="ct-chip">' + esc(topicName(t)) + '</span>'; }).join(' ');
    var rows = es.length ? '<div class="scroll"><table class="tbl ct-tbl"><caption class="sr">נותני שירות של השירות</caption><thead><tr><th>נותן שירות</th><th>הפעלה</th><th>קשר</th><th>הסכם</th><th>מודל תמחור</th></tr></thead><tbody>' + es.map(function (e) {
      return '<tr class="click" data-ct-row="engagement" data-p="' + e.provider_id + '" data-s="' + s.id + '"><td><button type="button" class="ct-link" data-ct="open-eng" data-p="' + e.provider_id + '" data-s="' + s.id + '">' + esc(e.provider_name) + '</button></td><td>' + actPill(e.activation) + '</td><td>' + contactPill(e.contact_state) + '</td><td>' + agrPill(e.agreement_state) + '</td><td>' + esc(lbl(MODEL, e.pricing_model)) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<p class="ct-none">אין נותני שירות לשירות הזה עדיין.</p>';
    return '<h2 id="ct-h" tabindex="-1">' + esc(s.name) + ' ' + (s.active ? pill('פעיל', 'ok') : pill('כבוי', 'muted')) + '</h2>' +
      '<div class="panel"><h3>פרטי השירות</h3><dl class="ct-dl">' + kv('תחום', s.topic ? esc(topicName(s.topic)) : unset()) + kv('תיאור', val(s.description)) + kv('נוצר', whenH(s.created_at)) + kv('קוד שירות', ltr(st.code)) + kv('תגי ממצאים', tags || unset('אין')) + kv('תחומי שאלון', topics || unset('אין')) +
      kv('אישור משפטי', st.legal_cleared ? pill('אושר', 'ok') + ' <span class="ct-small">' + [mail(st.legal_cleared_by), whenH(st.legal_cleared_at)].filter(Boolean).join(' · ') + '</span>' + (st.legal_note ? '<br><span class="ct-small">' + esc(st.legal_note) + '</span>' : '') : pill('לא אושר', 'warn')) +
      kv('מוצע לציבור', st.offered ? pill('כן', 'ok') : pill('לא', 'muted') + ' <span class="ct-small">הצעה לציבור חסומה בשלב זה</span>') + '</dl></div>' +
      '<div class="panel"><h3>נותני שירות משויכים (' + num(es.length) + ')</h3>' + rows + '</div>' +
      (sim.length ? '<div class="panel"><h3>שירותים בשם דומה (לבדיקת כפילות)</h3><ul class="ct-list">' + sim.map(function (x) { return '<li><button type="button" class="ct-link" data-ct="open-service" data-id="' + x.id + '">' + esc(x.name) + '</button> ' + (x.score === 1 ? pill('אותו שם', 'warn') : '<span class="ct-small">דמיון ' + Math.round(x.score * 100) + '%</span>') + '</li>'; }).join('') + '</ul></div>' : '');
  }
  function engagementHtml(d) {
    var e = d.engagement;
    return '<h2 id="ct-h" tabindex="-1">' + esc(e.provider_name) + ' ← ' + esc(e.service_name) + '</h2>' +
      '<p class="ct-links"><button type="button" class="ct-link" data-ct="open-provider" data-id="' + e.provider_id + '">לכרטיס נותן השירות</button> <button type="button" class="ct-link" data-ct="open-service" data-id="' + e.service_id + '">לכרטיס השירות</button></p>' +
      '<div class="panel"><h3>מצב ההתקשרות</h3><dl class="ct-dl">' + kv('הפעלה', actPill(e.activation)) + kv('קשר', contactPill(e.contact_state)) + kv('הסכם', agrPill(e.agreement_state)) + kv('מודל תמחור', esc(lbl(MODEL, e.pricing_model))) +
      kv('עדיפות', e.priority == null ? unset() : num(e.priority)) + kv('מזהה מהגיליון', ltr(e.external_ref)) + kv('הערת תנאים', e.terms_note ? '<span class="ct-prewrap">' + esc(e.terms_note) + '</span>' : unset('אין')) +
      (e.paused_reason ? kv('סיבת השהיה', esc(e.paused_reason)) : '') + (e.retired_at ? kv('הוצא משימוש', whenH(e.retired_at) + (e.retired_reason ? ' · ' + esc(e.retired_reason) : '')) : '') +
      kv('עודכן לאחרונה', [mail(e.updated_by), whenH(e.updated_at)].filter(Boolean).join(' · ') || unset()) + '</dl></div>' +
      '<div class="panel"><h3>מה חסר כדי שההתקשרות תהיה פעילה</h3>' + checklistHtml(d.checklist || {}) + '</div>' +
      '<div class="panel"><h3>ארבע שכבות מחיר, בנפרד</h3>' + priceSection(d) + '<p class="ct-small">מחירים אלה מוצגים לקריאה בלבד. אישור ופרסום של מחיר נעשים בלשונית ״תמחור״ הקיימת.</p></div>';
  }
  function importsTable(r) {
    if (!r.imports.length) return emptyHtml('עדיין לא בוצע ייבוא', 'כשיבוצע ייבוא של קובץ, הוא יירשם כאן.');
    return '<table class="tbl ct-tbl"><caption class="sr">היסטוריית ייבוא</caption><thead><tr><th>תאריך</th><th>מקור</th><th>שורות</th><th>נוצרו</th><th>עודכנו</th><th>דולגו</th><th>בעיות</th><th>בוצע על ידי</th><th>טביעת קובץ</th></tr></thead><tbody>' + r.imports.map(function (i) {
      var probs = Array.isArray(i.problems) ? i.problems : [];
      var list = probs.length ? '<details><summary>' + num(probs.length) + ' ' + plural(probs.length, 'בעיה', 'בעיות') + '</summary><ul>' + probs.map(function (p) { return '<li>' + (p.row ? 'שורה ' + esc(p.row) + ': ' : '') + esc(has(PROBLEMS, p.code) ? PROBLEMS[p.code] : p.code) + (p.field ? ' <span class="ct-small" dir="ltr">(' + esc(p.field) + ')</span>' : '') + '</li>'; }).join('') + '</ul></details>' : unset('אין');
      return '<tr><td>' + whenH(i.created_at) + '</td><td>' + esc(String(i.source).toUpperCase()) + '</td><td>' + num(i.rows_total) + '</td><td>' + num(i.rows_created) + '</td><td>' + num(i.rows_updated) + '</td><td>' + num(i.rows_skipped) + '</td><td>' + list + '</td><td>' + esc(i.imported_by) + '</td><td>' + ltr(String(i.file_sha256 || '').slice(0, 10)) + '</td></tr>';
    }).join('') + '</tbody></table>' + pagerHtml(r.total, r.offset, r.limit);
  }
  function historyTable(r, filtered) {
    if (!r.history.length) return filtered ? emptyHtml('אין רישומים לסינון', 'לא נמצאו רישומים שמתאימים לסינון.') : emptyHtml('אין רישומים', 'שינויים בקטלוג יירשמו כאן.');
    return '<table class="tbl ct-tbl"><caption class="sr">יומן שינויים בקטלוג</caption><thead><tr><th>זמן</th><th>מי</th><th>פעולה</th><th>עצם</th><th>שדות</th></tr></thead><tbody>' + r.history.map(function (h) {
      var fields = h.detail && Array.isArray(h.detail.fields) ? h.detail.fields.join(', ') : '';
      return '<tr><td>' + whenH(h.created_at) + '</td><td>' + esc(h.actor) + '</td><td>' + esc(lbl(ACTIONS, h.action)) + '</td><td>' + esc(lbl(ENTITY, h.entity)) + ' <span class="ct-small" dir="ltr">' + esc(h.entity_id) + '</span></td><td>' + (fields ? '<span dir="ltr">' + esc(fields) + '</span>' : unset('—')) + '</td></tr>';
    }).join('') + '</tbody></table>' + pagerHtml(r.total, r.offset, r.limit);
  }

  /* ---------- the screens (DOM) ---------- */
  var ctx = null, rootEl = null, body = null, S = null, seq = 0, timer = null;

  function get(path) { return ctx.api('GET', path); }   // the only way this file talks to the server
  function qs(o) { var p = Object.keys(o).filter(function (k) { return o[k] !== '' && o[k] != null; }).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }); return p.length ? '?' + p.join('&') : ''; }
  function fresh() { return { screen: 'overview', arg: null, stack: [], f: { providers: { q: '', state: '', offset: 0 }, services: { q: '', topic: '', active: '', offset: 0 }, engagements: { q: '', activation: '', model: '', contact: '', agreement: '', offset: 0 }, imports: { offset: 0 }, history: { entity: '', offset: 0 } }, eng: null }; }

  function open(c) {
    ctx = c; S = fresh(); seq++;
    c.view.innerHTML = '<div id="ct-root" class="ct"><div class="view-h"><h1>קטלוג ספקים</h1><span class="ct-ro">לקריאה בלבד</span></div><nav class="ct-nav" aria-label="מסכי הקטלוג">' +
      SCREENS.map(function (s) { return '<button type="button" data-ct="nav" data-v="' + s[0] + '">' + esc(s[1]) + '</button>'; }).join('') + '</nav><div id="ct-body" class="ct-body"></div></div>';
    rootEl = c.view.querySelector('#ct-root'); body = rootEl.querySelector('#ct-body');
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('tr[data-ct-row]')) { e.preventDefault(); openRow(e.target); } });
    rootEl.addEventListener('input', onInput); rootEl.addEventListener('change', onInput);
    render();
  }
  function paintNav() {
    var cur = PARENT[S.screen] || S.screen;
    [].forEach.call(rootEl.querySelectorAll('.ct-nav button'), function (b) { b.setAttribute('aria-current', b.dataset.v === cur ? 'page' : 'false'); });
  }
  function go(screen, arg, push) {
    if (push) S.stack.push({ screen: S.screen, arg: S.arg }); else S.stack = [];
    S.screen = screen; S.arg = arg == null ? null : arg; render();
  }
  function back() { var p = S.stack.pop(); if (!p) return go('overview'); S.screen = p.screen; S.arg = p.arg; render(); }
  function focusHeading() { var h = body.querySelector('#ct-h') || body.querySelector('.ct-state h2'); if (h) h.focus({ preventScroll: true }); }
  function fail(target, e, again) {
    var k = classify(e);
    if (k === 'auth') return ctx.fail(e);
    if (k === 'closed') return closedShell();                  // a closed catalog shows nothing but that: no menu that leads nowhere
    target.innerHTML = errorHtml(k); S.retry = again; focusHeading();
  }
  function closedShell() {
    rootEl.innerHTML = '<div class="view-h"><h1>קטלוג ספקים</h1></div><div id="ct-body" class="ct-body">' + errorHtml('closed') + '</div>';
    body = rootEl.querySelector('#ct-body'); S.retry = function () { open(ctx); }; focusHeading();
  }
  function render() {
    paintNav(); seq++;
    var fn = { overview: scrOverview, providers: scrProviders, services: scrServices, engagements: scrEngagements, imports: scrImports, history: scrHistory, provider: scrProvider, service: scrService, engagement: scrEngagement }[S.screen];
    fn();
  }
  // Loads one thing into `target`. A slower earlier answer never overwrites a later screen.
  function load(path, target, done) {
    var my = ++seq; target.innerHTML = loadingHtml();
    function again() { load(path, target, done); }
    // Two separate handlers: a failed request is classified by the server's answer; a bug while drawing is a different thing and is never reported as a network problem.
    get(path).then(function (r) { if (my !== seq) return; drawn(target, again, function () { done(r); }); }, function (e) { if (my !== seq) return; fail(target, e, again); });
  }
  function drawn(target, again, draw) {
    try { draw(); } catch (x) { if (root.console && root.console.error) root.console.error('catalog: drawing failed', x); target.innerHTML = errorHtml('server'); S.retry = again; }
  }

  function scrOverview() { load('/catalog/overview', body, function (o) { body.innerHTML = overviewHtml(o); focusHeading(); }); }

  // A list screen: the filter bar is drawn once, only the results below it are redrawn.
  function listShell(label, filtersHtml, f, clearable) {
    body.innerHTML = '<h2 id="ct-h" tabindex="-1" class="sr">' + esc(label.replace('סינון ', '')) + '</h2><form class="panel row ct-filters" role="search" aria-label="' + esc(label) + '" novalidate>' + filtersHtml + '<div class="ct-clear"' + (clearable(f) ? '' : ' hidden') + '><button type="button" class="btn sec" data-ct="clear">ניקוי סינון</button></div></form><p id="ct-count" class="ct-count" role="status" aria-live="polite"></p><div id="ct-res" class="scroll"></div>';
    return body.querySelector('#ct-res');
  }
  function setCount(text) { var c = body.querySelector('#ct-count'); if (c) c.textContent = text; }
  function showClear(on) { var c = body.querySelector('.ct-clear'); if (c) c.hidden = !on; }
  var anyFilter = function (f, keys) { return keys.some(function (k) { return !!f[k]; }); };

  function scrProviders() {
    var f = S.f.providers;
    var res = listShell('סינון נותני שירות',
      '<div><label for="ct-q">חיפוש לפי שם או עסק</label><input id="ct-q" data-f="q" type="search" autocomplete="off" value="' + esc(f.q) + '"></div><div><label for="ct-st">מצב</label><select id="ct-st" data-f="state">' + optionsHtml(PROVIDER_STATE, f.state, 'הכול') + '</select></div>', f, function (x) { return anyFilter(x, ['q', 'state']); });
    loadProviders(res);
  }
  function loadProviders(res) {
    var f = S.f.providers; showClear(anyFilter(f, ['q', 'state']));
    load('/catalog/providers' + qs({ q: f.q, state: f.state, limit: PAGE, offset: f.offset }), res, function (r) {
      res.innerHTML = providersTable(r, anyFilter(f, ['q', 'state'])); setCount(r.total ? num(r.total) + ' ' + plural(r.total, 'נותן שירות', 'נותני שירות') : '');
    });
  }
  function scrServices() {
    var f = S.f.services, topics = ctx.topics();
    var res = listShell('סינון שירותים',
      '<div><label for="ct-q">חיפוש לפי שם שירות</label><input id="ct-q" data-f="q" type="search" autocomplete="off" value="' + esc(f.q) + '"></div><div><label for="ct-tp">תחום</label><select id="ct-tp" data-f="topic"><option value="">הכול</option>' + topics.map(function (t) { return '<option value="' + esc(t[0]) + '"' + (t[0] === f.topic ? ' selected' : '') + '>' + esc(t[1]) + '</option>'; }).join('') + (f.topic && !topics.some(function (t) { return t[0] === f.topic; }) ? '<option value="' + esc(f.topic) + '" selected>' + esc(f.topic) + '</option>' : '') + '</select></div>' +
      '<div><label for="ct-ac">מצב</label><select id="ct-ac" data-f="active">' + optionsHtml({ true: 'פעיל', false: 'כבוי' }, f.active, 'הכול') + '</select></div>', f, function (x) { return anyFilter(x, ['q', 'topic', 'active']); });
    loadServices(res);
  }
  function loadServices(res) {
    var f = S.f.services; showClear(anyFilter(f, ['q', 'topic', 'active']));
    load('/catalog/services' + qs({ q: f.q, topic: f.topic, active: f.active, limit: PAGE, offset: f.offset }), res, function (r) {
      res.innerHTML = servicesTable(r, anyFilter(f, ['q', 'topic', 'active']), ctx.topicName); setCount(r.total ? num(r.total) + ' ' + plural(r.total, 'שירות', 'שירותים') : '');
    });
  }
  // Engagements: the server filters by state and by pricing model; the text search and the two state filters work on everything that was loaded (up to ENG_CAP).
  function scrEngagements() {
    var f = S.f.engagements;
    var res = listShell('סינון התקשרויות',
      '<div><label for="ct-q">חיפוש לפי נותן שירות או שירות</label><input id="ct-q" data-f="q" type="search" autocomplete="off" value="' + esc(f.q) + '"></div>' +
      '<div><label for="ct-ac">הפעלה</label><select id="ct-ac" data-f="activation" data-server="1">' + optionsHtml(ACTIVATION, f.activation, 'הכול') + '</select></div>' +
      '<div><label for="ct-ct">קשר</label><select id="ct-ct" data-f="contact">' + optionsHtml(CONTACT, f.contact, 'הכול') + '</select></div>' +
      '<div><label for="ct-ag">הסכם</label><select id="ct-ag" data-f="agreement">' + optionsHtml(AGREEMENT, f.agreement, 'הכול') + '</select></div>' +
      '<div><label for="ct-md">מודל תמחור</label><select id="ct-md" data-f="model" data-server="1">' + optionsHtml(MODEL, f.model, 'הכול') + '</select></div>', f, function (x) { return anyFilter(x, ['q', 'activation', 'model', 'contact', 'agreement']); });
    loadEngagements(res, true);
  }
  function engagementRows() {
    var f = S.f.engagements, q = f.q.trim().toLowerCase();
    return S.eng.rows.filter(function (e) {
      return (!f.contact || e.contact_state === f.contact) && (!f.agreement || e.agreement_state === f.agreement) && (!q || (e.provider_name + ' ' + e.service_name).toLowerCase().indexOf(q) !== -1);
    });
  }
  function paintEngagements(res) {
    var f = S.f.engagements, rows = engagementRows(), filt = anyFilter(f, ['q', 'activation', 'model', 'contact', 'agreement']);
    showClear(filt);
    res.innerHTML = engagementsTable(rows, filt, S.eng.total, S.eng.capped, f.offset);
    setCount(rows.length ? num(rows.length) + ' ' + plural(rows.length, 'התקשרות', 'התקשרויות') + (filt ? ' מתוך ' + num(S.eng.rows.length) : '') : '');
  }
  function loadEngagements(res, needFetch) {
    var f = S.f.engagements, key = f.activation + '|' + f.model;
    if (!needFetch && S.eng && S.eng.key === key) return paintEngagements(res);
    var my = ++seq; res.innerHTML = loadingHtml();
    var rows = [], total = 0;
    function page(offset) {
      return get('/catalog/engagements' + qs({ activation: f.activation, pricing_model: f.model, limit: ENG_PAGE, offset: offset })).then(function (r) {
        rows = rows.concat(r.engagements); total = r.total;
        if (rows.length < total && rows.length < ENG_CAP) return page(offset + ENG_PAGE);
      });
    }
    var again = function () { loadEngagements(res, true); };
    page(0).then(function () { if (my !== seq) return; S.eng = { key: key, rows: rows, total: total, capped: rows.length < total }; drawn(res, again, function () { paintEngagements(res); }); },
      function (e) { if (my !== seq) return; fail(res, e, again); });
  }
  function scrImports() {
    var f = S.f.imports;
    load('/catalog/imports' + qs({ limit: 20, offset: f.offset }), body, function (r) { body.innerHTML = '<h2 id="ct-h" tabindex="-1" class="sr">היסטוריית ייבוא</h2>' + importsTable(r); focusHeading(); });
  }
  function scrHistory() {
    var f = S.f.history;
    var res = listShell('סינון יומן שינויים', '<div><label for="ct-en">עצם</label><select id="ct-en" data-f="entity">' + optionsHtml(ENTITY, f.entity, 'הכול') + '</select></div>', f, function (x) { return !!x.entity; });
    loadHistory(res);
  }
  function loadHistory(res) {
    var f = S.f.history; showClear(!!f.entity);
    load('/catalog/history' + qs({ entity: f.entity, limit: PAGE, offset: f.offset }), res, function (r) { res.innerHTML = historyTable(r, !!f.entity); setCount(r.total ? num(r.total) + ' ' + plural(r.total, 'רישום', 'רישומים') : ''); });
  }
  function scrProvider() { load('/catalog/providers/' + encodeURIComponent(S.arg), body, function (d) { body.innerHTML = backBar() + providerHtml(d); focusHeading(); }); }
  function scrService() { load('/catalog/services/' + encodeURIComponent(S.arg), body, function (d) { body.innerHTML = backBar() + serviceHtml(d, ctx.topicName); focusHeading(); }); }
  function scrEngagement() { load('/catalog/engagements/' + encodeURIComponent(S.arg[0]) + '/' + encodeURIComponent(S.arg[1]), body, function (d) { body.innerHTML = backBar() + engagementHtml(d); focusHeading(); }); }
  function backBar() { return '<p class="ct-back"><button type="button" class="btn sec mini" data-ct="back">→ חזרה</button></p>'; }

  /* ---------- events ---------- */
  function openRow(tr) {
    var k = tr.dataset.ctRow;
    if (k === 'provider') go('provider', tr.dataset.id, true); else if (k === 'service') go('service', tr.dataset.id, true); else if (k === 'engagement') go('engagement', [tr.dataset.p, tr.dataset.s], true);
  }
  function onClick(e) {
    var b = e.target.closest('[data-ct]');
    if (!b) { var tr = e.target.closest('tr[data-ct-row]'); if (tr) openRow(tr); return; }
    var a = b.dataset.ct;
    if (a === 'nav') go(b.dataset.v);
    else if (a === 'back') back();
    else if (a === 'retry') { if (S.retry) S.retry(); else render(); }
    else if (a === 'open-provider') go('provider', b.dataset.id, true);
    else if (a === 'open-service') go('service', b.dataset.id, true);
    else if (a === 'open-eng') go('engagement', [b.dataset.p, b.dataset.s], true);
    else if (a === 'eng-filter') { S.f.engagements = { q: '', activation: b.dataset.act, model: '', contact: '', agreement: '', offset: 0 }; go('engagements'); }
    else if (a === 'clear') { S.f[S.screen] = fresh().f[S.screen]; render(); }
    else if (a === 'page') {
      var f = S.f[S.screen], step = Number(b.dataset.d) * (S.screen === 'imports' ? 20 : PAGE); f.offset = Math.max(0, f.offset + step);
      if (S.screen === 'engagements') paintEngagements(body.querySelector('#ct-res')); else render();
      rootEl.scrollIntoView({ block: 'start' });
    }
  }
  function onInput(e) {
    var el = e.target, name = el.dataset && el.dataset.f; if (!name || !S.f[S.screen]) return;
    var f = S.f[S.screen];
    if (e.type === 'input' && el.tagName === 'SELECT') return;     // a select is handled on "change"
    if (e.type === 'change' && el.tagName !== 'SELECT') return;     // a text box is handled while typing
    f[name] = el.value; f.offset = 0;
    var res = body.querySelector('#ct-res'); if (!res) return;
    clearTimeout(timer);
    var run = function () {
      if (S.screen === 'providers') loadProviders(res); else if (S.screen === 'services') loadServices(res); else if (S.screen === 'history') loadHistory(res);
      else if (S.screen === 'engagements') loadEngagements(res, false);
    };
    if (el.tagName === 'SELECT') run(); else timer = setTimeout(run, 250);
  }

  root.KaspchemCatalog = {
    open: open,
    _t: { esc: esc, lbl: lbl, priceText: priceText, layerBody: layerBody, priceSection: priceSection, checklistHtml: checklistHtml, classify: classify, errorHtml: errorHtml, overviewHtml: overviewHtml, providersTable: providersTable, servicesTable: servicesTable,
      engagementsTable: engagementsTable, providerHtml: providerHtml, serviceHtml: serviceHtml, engagementHtml: engagementHtml, importsTable: importsTable, historyTable: historyTable, emptyHtml: emptyHtml, priceChips: priceChips,
      labels: { ACTIVATION: ACTIVATION, CONTACT: CONTACT, AGREEMENT: AGREEMENT, MODEL: MODEL, PROVIDER_STATE: PROVIDER_STATE, DELIVERY: DELIVERY, LAYER_STATUS: LAYER_STATUS, ENTITY: ENTITY, ACTIONS: ACTIONS, ENFORCED: ENFORCED } }
  };
})(typeof window !== 'undefined' ? window : this);
