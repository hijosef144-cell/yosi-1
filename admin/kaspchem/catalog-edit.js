/* Catalog editing, stage 5b-1: providers and services (create, view, edit, states, service settings, the record of a legal clearance).
 * It plugs into the read-only catalog screens (catalog.js) and adds its buttons to them.
 *
 * What it never does:
 *   - it sends nothing but the seven routes listed in ROUTES below (one helper, `send`, refuses every other path and method); no engagement, no price, no import, no activation, no delete;
 *   - it never saves by itself: only a click on the button of an open form sends anything; closing a form sends nothing;
 *   - it never sends twice: the form is locked from the moment it sends, and a second click or a second Enter does nothing;
 *   - it never tries again by itself, whatever the answer; after an answer nobody can read ("unknown result") it offers a refresh and no resend;
 *   - it never overwrites what someone else changed: every edit carries the values the person saw, and a mismatch is shown (who changed it, what the value is now) before anything is written.
 * Text from the server is escaped; error codes are never shown, only plain Hebrew.
 */
(function (root) {
  'use strict';
  var C = root.KaspchemCatalog;
  if (!C || typeof C.extend !== 'function') return;

  /* ---------- the only routes this file may call ---------- */
  var ROUTES = [
    ['POST', /^\/catalog\/providers$/], ['PATCH', /^\/catalog\/providers\/\d+$/], ['POST', /^\/catalog\/providers\/\d+\/(pause|resume|archive|unarchive)$/],
    ['POST', /^\/catalog\/services$/], ['PATCH', /^\/catalog\/services\/\d+$/], ['PUT', /^\/catalog\/services\/\d+\/settings$/], ['POST', /^\/catalog\/services\/\d+\/clearance$/]
  ];
  function allowed(method, path) { return ROUTES.some(function (r) { return r[0] === method && r[1].test(path); }); }
  function send(ctx, method, path, body) {
    if (!allowed(method, path)) { var e = new Error('route_not_allowed'); e.internal = true; return Promise.reject(e); }
    return ctx.api(method, path, body);
  }

  /* ---------- small helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg) { var t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2800); }
  function norm(v) { return v == null ? '' : typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.slice().sort().join(',') : String(v); }
  function same(a, b) { return norm(a) === norm(b); }
  function dayText(iso) { var p = String(iso).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(iso); }
  var ACTIVE_NOTE = 'סימון פנימי בלבד: אינו משפיע על האתר הציבורי ולא על תהליכי ההפניה.';
  var FIELD_LABEL = { name: 'שם', business_name: 'עסק או ארגון', contact_phone: 'טלפון', contact_email: 'דוא״ל', internal_notes: 'הערות פנימיות', capacity_open: 'קיבולת פתוחה', delivery_method: 'אופן העברה', topic: 'תחום', description: 'תיאור', active: 'שירות פעיל (פנימי)', finding_tags: 'תגי ממצאים', topics: 'תחומי שאלון' };
  var DELIVERY = { portal: 'דרך פורטל', manual: 'ידני (הצוות מזין)' };

  /* ---------- plain Hebrew for every answer the write layer can give (a test checks that no code of the server is missing) ---------- */
  var MSG = {
    bad_name: 'השם חייב להכיל בין תו אחד ל־120 תווים.', bad_topic: 'התחום אינו תקין.', bad_description: 'התיאור אינו תקין (עד 600 תווים).', bad_active: 'הערך בשדה ״שירות פעיל״ אינו תקין.',
    bad_code: 'קוד השירות חייב להיות באנגלית קטנה, ספרות ומקף, באורך 2 עד 40 תווים.', bad_tags: 'התגים אינם תקינים: עד 12 תגים, באנגלית קטנה, ספרות ומקף, עד 40 תווים לכל תג.', bad_topics: 'תחומי השאלון אינם תקינים.',
    bad_business_name: 'שם העסק אינו תקין (עד 200 תווים).', bad_phone: 'מספר הטלפון אינו תקין.', bad_email: 'כתובת הדוא״ל אינה תקינה.', bad_notes: 'ההערות אינן תקינות (עד 1000 תווים).',
    bad_capacity: 'הקיבולת חייבת להיות מספר שלם, 0 או יותר.', bad_delivery_method: 'אופן ההעברה אינו תקין.', reason_required: 'חובה לכתוב סיבה.', bad_reason: 'הסיבה אינה תקינה (עד 300 תווים).',
    bad_until: 'תאריך ההשהיה חייב להיות עתידי ובתוך שנה.', bad_cleared: 'הערך אינו תקין.', bad_note: 'ההערה אינה תקינה (עד 600 תווים).',
    bad_source: 'פרטי המקור אינם תקינים (עד 200 תווים, טקסט בלבד).', source_has_contact_detail: 'אי אפשר לכלול במקור מספר טלפון, כתובת דוא״ל, מספר ארוך (כמו מספר זיהוי) או קישור. תארו את המסמך במילים (סוג ותאריך), ושמרו את המסמך עצמו מחוץ למערכת.',
    bad_source_kind: 'סוג המקור אינו תקין.', bad_approved_on: 'תאריך האישור חייב להיות תאריך אמיתי, לא עתידי ולא לפני שנת 2000.', bad_clearance_reason: 'הסיבה אינה תקינה (עד 300 תווים, טקסט בלבד).',
    reason_has_contact_detail: 'אי אפשר לכלול בסיבה מספר טלפון, כתובת דוא״ל, מספר ארוך (כמו מספר זיהוי) או קישור. כתבו את הסיבה במילים.', field_not_for_registration: 'שגיאה פנימית בטופס. לא נשלח דבר.', field_not_for_cancellation: 'שגיאה פנימית בטופס. לא נשלח דבר.',
    bad_contact_state: 'מצב הקשר אינו תקין.', bad_agreement_state: 'מצב ההסכם אינו תקין.', bad_terms_note: 'הערת התנאים אינה תקינה (עד 1000 תווים).', bad_priority: 'העדיפות אינה תקינה.', bad_external_ref: 'המזהה מהגיליון אינו תקין.',
    bad_provider_id: 'נותן השירות אינו תקין.', bad_service_id: 'השירות אינו תקין.', bad_pricing_id: 'המחיר אינו תקין.', bad_expected: 'הערך הקודם אינו תקין.', bad_expected_updated_at: 'זמן העדכון הקודם אינו תקין.',
    bad_model: 'מודל התמחור אינו תקין.', bad_amount: 'הסכום אינו תקין.', bad_percent: 'האחוז אינו תקין.', bad_minimum: 'המינימום אינו תקין.', bad_terms_text: 'נוסח התנאים אינו תקין.', bad_status: 'הסטטוס אינו תקין.',
    bad_basis_missing: 'הערך אינו תקין.', bad_source_note: 'מקור המחיר אינו תקין.', bad_target: 'היעד אינו תקין.', bad_csv: 'הקובץ אינו תקין.', bad_mappings: 'המיפוי אינו תקין.', bad_column_map: 'מיפוי העמודות אינו תקין.', bad_approvals: 'האישורים אינם תקינים.',
    bad_json: 'הבקשה אינה תקינה.', bad_body: 'שגיאה פנימית בטופס. לא נשלח דבר.', unknown_field: 'שגיאה פנימית בטופס. לא נשלח דבר.', expected_required: 'שגיאה פנימית בטופס. לא נשלח דבר.', nothing_to_change: 'לא בוצע שינוי, ולכן אין מה לשמור.',
    bad_id: 'המספר אינו תקין.', too_large: 'הבקשה גדולה מדי.',
    conflict: 'הנתון השתנה מאז שצפיתם בו.', conflict_retry: 'הפעולה התנגשה בפעולה אחרת. לא נשמר דבר. יש לרענן ולנסות שוב.', busy_retry: 'המערכת עסוקה כרגע. לא נשמר דבר. אפשר לנסות שוב בעוד רגע.',
    write_timeout: 'השמירה לקחה יותר מדי זמן ובוטלה. לא נשמר דבר. אפשר לנסות שוב.', catalog_unavailable: 'אי אפשר היה לבדוק אם הקטלוג פתוח, ולכן לא נשמר דבר. אפשר לנסות שוב.',
    result_unknown: 'לא ידוע אם הפעולה נשמרה. אל תשלחו שוב לפני שבדקתם מה המצב.', server_error: 'אירעה שגיאה בשרת. ייתכן שהפעולה לא הושלמה. אל תשלחו שוב לפני שבדקתם מה המצב.',
    catalog_disabled: 'הקטלוג כבוי כרגע, ולכן לא נשמר דבר.', forbidden: 'אין הרשאה לפעולה הזו.', csrf: 'הבקשה נדחתה בבדיקת האבטחה, ולכן לא נשמר דבר. יש לרענן את הדף.', not_found: 'הרשומה לא נמצאה. ייתכן שהקישור ישן.', unauthenticated: 'פג תוקף ההתחברות.',
    similar_service_exists: 'כבר קיים שירות בשם דומה.', similar_provider_exists: 'כבר קיים נותן שירות בשם דומה.', duplicate: 'כבר קיימת רשומה כזו.',
    service_has_public_price: 'לשירות הזה יש מחיר שמוצג באתר, ולכן אי אפשר לשנות את שמו או את התחום שלו. אפשר להסיר את המחיר מהציבור בלשונית ״תמחור״ ואז לערוך.',
    settings_exist: 'הגדרות השירות כבר נוצרו. יש לרענן.', code_in_use: 'הקוד כבר בשימוש בשירות אחר.', settings_required: 'יש ליצור קודם את הגדרות השירות.',
    active_engagements_exist: 'יש לנותן השירות או לשירות התקשרות פעילה, ולכן אי אפשר לבצע את הפעולה.', already_archived: 'נותן השירות כבר בארכיון.', not_paused: 'נותן השירות אינו מושהה.', not_archived: 'נותן השירות אינו בארכיון.', provider_archived: 'נותן השירות בארכיון. יש לבטל קודם את הארכוב.',
    engagement_exists: 'ההתקשרות כבר קיימת.', external_ref_in_use: 'המזהה מהגיליון כבר בשימוש.', layer_exists: 'שכבת המחיר כבר קיימת.', engagement_active: 'ההתקשרות פעילה. יש להשהות אותה קודם.', price_not_eligible: 'המחיר אינו מתאים להתקשרות הזו.',
    only_unclassified_can_be_classified: 'אפשר לסווג רק שכבה שטרם סווגה.', transition_refused: 'המעבר אינו מותר במצב הנוכחי.', layer_invalid: 'שכבת המחיר אינה תקינה.', provider_or_service_not_found: 'נותן השירות או השירות לא נמצאו.',
    bad_reference: 'הרשומה שאליה מתייחסים לא נמצאה.', rule_violation: 'הפעולה מפרה כלל מובנה של המערכת.', managed_in_catalog: 'הנתון הזה מנוהל בקטלוג הספקים.',
    activation_disabled: 'ההפעלה אינה זמינה בשלב זה.', seen_changed: 'המצב השתנה מאז שצפיתם בו.', confirmation_required: 'נדרש אישור מפורש.', preview_stale: 'התצוגה המקדימה כבר אינה תואמת.', rows_refused: 'חלק מהשורות אינן ניתנות לשמירה.'
  };
  // which field of a form a validation answer belongs to
  var FIELD_OF = { bad_name: 'name', bad_topic: 'topic', bad_description: 'description', bad_active: 'active', bad_code: 'code', bad_tags: 'finding_tags', bad_topics: 'topics', bad_business_name: 'business_name', bad_phone: 'contact_phone', bad_email: 'contact_email',
    bad_notes: 'internal_notes', bad_capacity: 'capacity_open', bad_delivery_method: 'delivery_method', reason_required: 'reason', bad_reason: 'reason', bad_until: 'until', bad_note: 'note',
    bad_source: 'source', source_has_contact_detail: 'source', bad_source_kind: 'source_kind', bad_approved_on: 'approved_on', bad_clearance_reason: 'reason', reason_has_contact_detail: 'reason' };
  var GENERIC = 'הפעולה לא הושלמה. לא נשמר דבר.';
  function msg(code) { return Object.prototype.hasOwnProperty.call(MSG, code) ? MSG[code] : GENERIC; }
  var NOT_SAVED = ['busy_retry', 'conflict_retry', 'write_timeout', 'catalog_unavailable'];   // the server says: rolled back, nothing was written
  // The records the server found for a name that already exists. Its sentence reads "...: name (מספר 12), other (מספר 7). ..."; only the names and numbers are taken from it, the sentence itself is never shown.
  function dupItems(text) {
    var s = String(text || ''), from = s.indexOf(': '), out = [];
    if (from === -1) return out;
    var re = /(?:^|, )([^]*?) \(מספר (\d{1,15})\)(?=,|\.|$)/g, m, tail = s.slice(from + 2);
    while ((m = re.exec(tail)) && out.length < 3) out.push({ id: Number(m[2]), name: m[1].trim() });
    return out;
  }
  // What the person is told, and what the screen does next, for one failed request. Only text written in this file is ever shown: the server's own sentence and its codes never reach the screen.
  function describe(e) {
    var code = e && e.message, status = e && e.status;
    if (e && e.internal) return { kind: 'form', message: msg('bad_body') };
    if (status === 401) return { kind: 'auth' };
    if (NOT_SAVED.indexOf(code) !== -1) return { kind: 'busy', message: msg(code) };
    // no answer at all, a gateway page or a server fault: the write may or may not have happened
    if (status === undefined || status >= 500 || code === 'result_unknown' || code === 'server_error') return { kind: 'unknown', message: msg(code === 'server_error' ? 'server_error' : 'result_unknown') };
    if (status === 403) return { kind: code === 'catalog_disabled' ? 'closed' : 'forbidden', message: msg(code === 'catalog_disabled' ? 'catalog_disabled' : 'forbidden') };
    if (status === 404) return { kind: 'notfound', message: msg('not_found') };
    if (code === 'conflict') return { kind: 'conflict', message: msg('conflict') };
    if (code === 'similar_service_exists' || code === 'similar_provider_exists') return { kind: 'duplicate', message: msg(code), items: dupItems(e.userMessage) };
    if (Object.prototype.hasOwnProperty.call(FIELD_OF, code)) return { kind: 'validation', field: FIELD_OF[code], message: msg(code) };
    return { kind: 'state', message: msg(code) };
  }

  /* ---------- the values of a form, and what changed ---------- */
  function convert(f, v) {
    if (f === 'active') return !!v;
    if (f === 'capacity_open') return v === '' || v == null ? null : Number(v);
    if (f === 'finding_tags' || f === 'topics') return v;
    var t = typeof v === 'string' ? v.trim() : v;
    return f === 'name' ? t : (t === '' ? null : t);
  }
  // Only the fields that changed are sent, each with the value the person saw before (compare-and-set on the server).
  function diffFields(fields, original, values) {
    var changes = {}, expected = {};
    fields.forEach(function (f) { if (!same(original[f], values[f])) { changes[f] = convert(f, values[f]); expected[f] = original[f] === undefined ? null : original[f]; } });
    return { changes: changes, expected: expected, count: Object.keys(changes).length };
  }
  var TAG = /^[a-z0-9-]{1,40}$/;
  function parseTags(text) { var seen = {}, out = []; String(text || '').split(/[\s,;]+/).forEach(function (t) { t = t.trim().toLowerCase(); if (t && !seen[t]) { seen[t] = true; out.push(t); } }); return out; }
  function tagsProblem(list) { return list.length > 12 ? 'bad_tags' : (list.some(function (t) { return !TAG.test(t); }) ? 'bad_tags' : null); }
  function serviceCode(id, attempt) { return 'svc-' + id + (attempt ? '-' + attempt : ''); }
  // The kinds of source of a reported approval (the same four the server accepts; a test keeps the two lists equal).
  var SOURCE_KINDS = [['written_opinion', 'חוות דעת משפטית בכתב'], ['email', 'אישור בדוא״ל'], ['meeting_summary', 'סיכום פגישה'], ['other', 'אחר']];
  function kindLabel(k) { for (var i = 0; i < SOURCE_KINDS.length; i++) if (SOURCE_KINDS[i][0] === k) return SOURCE_KINDS[i][1]; return ''; }
  // The note kept in the ROW of the service, which is what the card shows as the current report: the kind and short source, the day of the approval itself, and a remark; only what the person typed.
  // (The journal keeps the structured facts of every event, each in its own row; the remark is kept in the card only.)
  function clearanceNote(kind, source, date, remark) {
    var parts = [], src = [kindLabel(kind), source && source.trim()].filter(Boolean).join(' — ');
    if (src) parts.push('מקור: ' + src);
    if (date) parts.push('תאריך האישור: ' + dayText(date));
    if (remark && remark.trim()) parts.push('הערה: ' + remark.trim());
    return parts.length ? parts.join(' · ') : null;
  }
  function pauseUntilIso(dateText) { var t = new Date(dateText + 'T00:00:00'); return Number.isNaN(t.getTime()) ? null : t.toISOString(); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function dateInput(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /* ---------- form pieces ---------- */
  function field(id, label, control, hint) {
    return '<div class="ce-field" data-field="' + id + '"><label for="ce-' + id + '">' + esc(label) + '</label>' + control + (hint ? '<p class="ce-hint" id="ce-' + id + '-h">' + esc(hint) + '</p>' : '') + '<p class="ce-fe" id="ce-' + id + '-e"></p></div>';
  }
  function described(id, hint) { return ' aria-describedby="' + (hint ? 'ce-' + id + '-h ' : '') + 'ce-' + id + '-e"'; }
  function input(id, value, o) {
    o = o || {};
    return '<input id="ce-' + id + '" name="' + id + '" type="' + (o.type || 'text') + '"' + (o.ltr ? ' class="ce-ltr" dir="ltr"' : '') + (o.max ? ' maxlength="' + o.max + '"' : '') + (o.min != null ? ' min="' + o.min + '"' : '') + (o.maxv ? ' max="' + o.maxv + '"' : '') + (o.type === 'number' ? ' step="1" inputmode="numeric"' : '') +
      ' value="' + esc(value == null ? '' : value) + '" autocomplete="off"' + (o.required ? ' required' : '') + described(id, o.hint) + '>';
  }
  function textarea(id, value, max, hint) { return '<textarea id="ce-' + id + '" name="' + id + '" maxlength="' + max + '"' + described(id, hint) + '>' + esc(value == null ? '' : value) + '</textarea>'; }
  function select(id, options, value, hint) {
    return '<select id="ce-' + id + '" name="' + id + '"' + described(id, hint) + '>' + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(value == null ? '' : value) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
  }
  function readForm(form) {
    var out = {};
    [].forEach.call(form.elements, function (el) {
      if (!el.name || el.type === 'submit' || el.type === 'button') return;
      if (el.type === 'checkbox') { if (el.dataset.group) { out[el.dataset.group] = out[el.dataset.group] || []; if (el.checked) out[el.dataset.group].push(el.value); } else out[el.name] = el.checked; }
      else out[el.name] = el.value;
    });
    return out;
  }
  function topicOptions(h, current) {
    var list = h.ctx.topics().slice(), have = list.some(function (t) { return t[0] === current; });
    if (current && !have) list.push([current, current]);
    return [['', 'ללא תחום']].concat(list);
  }
  var PROVIDER_FIELDS = ['name', 'business_name', 'contact_phone', 'contact_email', 'capacity_open', 'delivery_method', 'internal_notes'];
  function providerFields(p) {
    return field('name', 'שם', input('name', p.name, { max: 120, required: true }), '') + field('business_name', 'עסק או ארגון', input('business_name', p.business_name, { max: 200 }), '') +
      field('contact_phone', 'טלפון', input('contact_phone', p.contact_phone, { type: 'tel', ltr: true, max: 40, hint: 'פרטי הקשר גלויים לבעלי המערכת בלבד.' }), 'פרטי הקשר גלויים לבעלי המערכת בלבד.') + field('contact_email', 'דוא״ל', input('contact_email', p.contact_email, { type: 'email', ltr: true, max: 200 }), '') +
      field('capacity_open', 'קיבולת פתוחה', input('capacity_open', p.capacity_open, { type: 'number', min: 0 }), 'כמה פניות אפשר לשלוח כרגע. אפשר להשאיר ריק.') +
      field('delivery_method', 'אופן העברה', select('delivery_method', [['portal', DELIVERY.portal], ['manual', DELIVERY.manual]], p.delivery_method || 'portal'), '') + field('internal_notes', 'הערות פנימיות', textarea('internal_notes', p.internal_notes, 1000), '');
  }

  /* ---------- the dialog: one form, locked while it sends, never closes by itself on an error ---------- */
  function openDialog(opts) {
    var opener = document.activeElement, busy = false, dirty = false, closed = false;
    var wrap = document.createElement('div');
    wrap.className = 'ce-modal'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true'); wrap.setAttribute('aria-labelledby', 'ce-title');
    wrap.innerHTML = '<form class="ce-form" novalidate><h2 id="ce-title" tabindex="-1">' + esc(opts.title) + '</h2>' + (opts.intro ? '<div class="ce-intro">' + opts.intro + '</div>' : '') +
      '<div class="ce-fields">' + opts.fields + '</div><div class="ce-panel" hidden></div><div class="ce-status" role="alert"></div>' +
      '<div class="ce-actions"><button class="btn' + (opts.danger ? ' danger' : '') + '" type="submit" data-ce="submit">' + esc(opts.submit) + '</button><button class="btn sec" type="button" data-ce="cancel">ביטול</button></div></form>';
    document.body.appendChild(wrap);
    var form = wrap.querySelector('form'), status = wrap.querySelector('.ce-status'), panel = wrap.querySelector('.ce-panel'), fields = wrap.querySelector('.ce-fields'), actions = wrap.querySelector('.ce-actions'), submit = wrap.querySelector('[data-ce=submit]');
    var sealedFn = null;
    var ctl = {
      el: wrap, form: form,
      isBusy: function () { return busy; },
      // After this the form can never be brought back (something was already written): Escape and the close button close it and call `fn`.
      seal: function (fn) { sealedFn = fn || function () {}; },
      isSealed: function () { return !!sealedFn; },
      busy: function (on) { busy = on; form.setAttribute('aria-busy', on ? 'true' : 'false'); [].forEach.call(form.querySelectorAll('input, select, textarea, button'), function (el) { el.disabled = on; }); submit.textContent = on ? 'שומר…' : opts.submit; },
      status: function (text, kind) { status.className = 'ce-status' + (text ? ' ce-' + (kind === 'busy' || kind === 'state' ? 'warn' : 'bad') : ''); status.textContent = text || ''; },
      clearErrors: function () { ctl.status(''); [].forEach.call(wrap.querySelectorAll('.ce-field'), function (f) { f.classList.remove('bad'); var p = f.querySelector('.ce-fe'); if (p) p.textContent = ''; var i = f.querySelector('input, select, textarea'); if (i) i.removeAttribute('aria-invalid'); }); },
      fieldError: function (name, text) {
        var f = wrap.querySelector('.ce-field[data-field="' + name + '"]');
        if (!f) return ctl.status(text, 'bad');
        f.classList.add('bad'); f.querySelector('.ce-fe').textContent = text; var i = f.querySelector('input, select, textarea'); if (i) { i.setAttribute('aria-invalid', 'true'); i.focus(); }
      },
      // `onClick` REPLACES the previous handler of the panel (never adds one), so a button can never run twice for one click.
      showPanel: function (html, onClick) { fields.hidden = true; actions.hidden = true; panel.hidden = false; panel.innerHTML = html; panel.onclick = onClick || null; ctl.status(''); var b = panel.querySelector('button'); if (b) b.focus(); },
      back: function () { if (sealedFn) return; panel.hidden = true; panel.innerHTML = ''; panel.onclick = null; fields.hidden = false; actions.hidden = false; ctl.busy(false); },
      close: function () { if (closed) return; closed = true; document.removeEventListener('keydown', onKey, true); wrap.remove(); if (opener && document.contains(opener)) opener.focus(); },
      markDirty: function () { dirty = true; },
      // the person pressed Escape or Cancel: nothing was sent; with typed changes they are asked first
      askClose: function () {
        if (busy || closed) return;
        if (sealedFn) { var f = sealedFn; ctl.close(); return f(); }
        if (!dirty) return ctl.close();
        ctl.showPanel('<p><strong>לסגור בלי לשמור?</strong> השינויים שהקלדתם לא יישמרו.</p><p class="ce-actions"><button class="btn danger" type="button" data-ce="discard">כן, לסגור</button><button class="btn sec" type="button" data-ce="keep">חזרה לעריכה</button></p>');
      },
      // after an answer nobody can read: no resend, only a refresh of what is saved
      showUnknown: function (text, refresh) {
        ctl.busy(false); ctl.showPanel('<div class="ce-bad" role="alert"><strong>לא ידוע אם נשמר.</strong> ' + esc(text) + '</div><p class="ce-actions"><button class="btn" type="button" data-ce="refresh">בדיקת המצב (רענון)</button><button class="btn sec" type="button" data-ce="close">סגירה</button></p>');
        ctl.onRefresh = refresh; ctl.seal(refresh);   // never a way back to the form, so nothing can be sent twice by mistake
      }
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ctl.askClose(); return; }
      if (e.key !== 'Tab') return;
      var els = [].filter.call(wrap.querySelectorAll('input, select, textarea, button'), function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!els.length) return;
      var first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey, true);
    form.addEventListener('input', ctl.markDirty); form.addEventListener('change', ctl.markDirty);
    form.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ce]'); if (!b) return; var a = b.dataset.ce;
      if (a === 'cancel') ctl.askClose(); else if (a === 'discard') ctl.close(); else if (a === 'close') { var s0 = sealedFn; ctl.close(); if (s0) s0(); } else if (a === 'keep') ctl.back(); else if (a === 'refresh') { var f = ctl.onRefresh; ctl.close(); if (f) f(); }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy || closed || !panel.hidden) return;      // a second click or a second Enter while sending does nothing
      ctl.clearErrors();
      var problem = opts.check ? opts.check(readForm(form)) : null;
      if (problem) return ctl.fieldError(problem.field, problem.message);
      opts.onSubmit(readForm(form), ctl);
    });
    var first = wrap.querySelector(opts.focus || 'input:not([type=hidden]), select, textarea');
    (first || wrap.querySelector('#ce-title')).focus();
    return ctl;
  }

  // One write, the one place that reads the answer. `on`: ok(result), duplicate(info), conflict(info). Nothing is repeated by itself.
  function write(h, ctl, method, path, body, on) {
    ctl.busy(true);
    return send(h.ctx, method, path, body).then(function (r) { on.ok(r); }, function (e) {
      var d = describe(e); ctl.busy(false);
      if (d.kind === 'auth') { ctl.close(); return h.ctx.fail(e); }
      if (d.kind === 'unknown') return ctl.showUnknown(d.message, function () { h.reload(); });
      if (d.kind === 'validation') return ctl.fieldError(d.field, d.message);
      if (d.kind === 'duplicate' && on.duplicate) return on.duplicate(d);
      if (d.kind === 'conflict' && on.conflict) return on.conflict(d);
      if (d.kind === 'closed') {   // the catalog was switched off while the form was open: nothing was written
        ctl.showPanel('<div class="ce-bad" role="alert">' + esc(d.message) + '</div><p class="ce-actions"><button class="btn" type="button" data-ce="refresh">רענון</button></p>');
        ctl.onRefresh = function () { h.reload(); }; return ctl.seal(ctl.onRefresh);
      }
      ctl.status(d.message, d.kind);
    });
  }

  /* ---------- a name that is already there: the person decides, nothing is created by itself ---------- */
  function showDuplicate(h, ctl, info, entity, again) {
    var items = info.items || [];
    var list = items.length ? '<ul class="ct-list">' + items.map(function (x) { return '<li>' + esc(x.name) + ' <span class="ct-small">(מספר ' + x.id + ')</span> <button class="btn sec mini" type="button" data-ce="open" data-id="' + x.id + '">פתיחה</button></li>'; }).join('') + '</ul>' : '';
    ctl.showPanel('<div class="ce-warn" role="alert"><strong>נמצאה רשומה דומה.</strong> ' + esc(info.message) + ' כדאי לבדוק שלא מדובר באותה רשומה.</div>' + list + '<p class="ce-actions"><button class="btn" type="button" data-ce="force">ליצור בכל זאת</button><button class="btn sec" type="button" data-ce="keep">חזרה לעריכה</button></p>', function (e) {
      var b = e.target.closest('[data-ce]'); if (!b || ctl.isBusy()) return;
      if (b.dataset.ce === 'open') { ctl.close(); h.go(entity, b.dataset.id, true); } else if (b.dataset.ce === 'force') { ctl.back(); again(); }
    });
  }

  /* ---------- somebody else changed it: say who and what, and let the person apply their own change on top, knowingly ---------- */
  function lastChange(h, entity, id) {
    return h.get('/catalog/history?entity=' + entity + '&entity_id=' + id + '&limit=200').then(function (r) {
      var rows = (r.history || []).filter(function (x) { return !/\.view$/.test(x.action); }); return rows[0] || null;
    }, function () { return null; });
  }
  function showConflict(h, ctl, spec) {
    ctl.busy(true);
    Promise.all([spec.current(), lastChange(h, spec.entity, spec.id)]).then(function (a) {
      ctl.busy(false); var cur = a[0], who = a[1], rows = [];
      Object.keys(spec.mine).forEach(function (f) { rows.push({ f: f, was: spec.expected[f], now: cur[f], mine: spec.mine[f] }); });
      var differ = rows.filter(function (r) { return !same(r.was, r.now); });
      var show = function (v, f) { return f === 'active' ? (v ? 'פעיל' : 'כבוי') : (Array.isArray(v) ? (v.length ? v.join(', ') : 'ריק') : (v == null || v === '' ? 'ריק' : String(v))); };
      var text = who ? ' בוצע על ידי <span dir="ltr">' + esc(who.actor) + '</span>' + (who.created_at ? ' ב־' + h.whenH(who.created_at) : '') + '.' : '';
      ctl.showPanel('<div class="ce-warn" role="alert"><strong>הנתון השתנה מאז שצפיתם בו.</strong>' + text + ' לא נשמר דבר.</div>' +
        (differ.length ? '<div class="scroll"><table class="tbl ct-tbl"><caption class="sr">שדות ששונו</caption><thead><tr><th>שדה</th><th>כשפתחתם</th><th>עכשיו</th><th>השינוי שלכם</th></tr></thead><tbody>' + differ.map(function (r) { return '<tr><td data-label="שדה">' + esc(FIELD_LABEL[r.f] || r.f) + '</td><td data-label="כשפתחתם">' + esc(show(r.was, r.f)) + '</td><td data-label="עכשיו">' + esc(show(r.now, r.f)) + '</td><td data-label="השינוי שלכם">' + esc(show(r.mine, r.f)) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<p>בשדות ששלחתם לא נמצא הבדל מול מה שראיתם. ייתכן שהנתון השתנה ושב לקדמותו.</p>') +
        '<p class="ce-actions"><button class="btn" type="button" data-ce="reapply">להחיל את השינוי שלי על הערכים הנוכחיים</button><button class="btn sec" type="button" data-ce="refresh">ביטול ורענון</button></p>', function (e) {
        var b = e.target.closest('[data-ce=reapply]'); if (!b || ctl.isBusy()) return;
        spec.reapply(cur);
      });
      ctl.onRefresh = function () { h.reload(); };
    }, function () {
      // the other values could not be read: the write itself was refused, so nothing was saved
      ctl.busy(false); ctl.showPanel('<div class="ce-warn" role="alert"><strong>הנתון השתנה מאז שצפיתם בו.</strong> לא ניתן היה לבדוק מה השתנה. לא נשמר דבר.</div><p class="ce-actions"><button class="btn" type="button" data-ce="refresh">רענון</button></p>');
      ctl.onRefresh = function () { h.reload(); }; ctl.seal(ctl.onRefresh);
    });
  }

  /* ---------- providers ---------- */
  function newProvider(h) {
    var ctl = openDialog({ title: 'נותן שירות חדש', fields: providerFields({}), submit: 'יצירת נותן שירות', check: function (v) { return v.name.trim() ? null : { field: 'name', message: 'חובה להזין שם.' }; },
      onSubmit: function (v) { createProvider(h, ctl, v, false); } });
  }
  function createProvider(h, ctl, v, force) {
    var body = { delivery_method: v.delivery_method || 'portal' };
    ['name', 'business_name', 'contact_phone', 'contact_email', 'internal_notes'].forEach(function (f) { var t = (v[f] || '').trim(); if (t) body[f] = t; });
    if (v.capacity_open !== '') body.capacity_open = Number(v.capacity_open);
    if (force) body.allow_duplicate = true;
    write(h, ctl, 'POST', '/catalog/providers', body, {
      ok: function (r) { ctl.close(); toast('נותן השירות נוצר'); h.go('provider', r.id, true); },
      duplicate: function (d) { showDuplicate(h, ctl, d, 'provider', function () { createProvider(h, ctl, v, true); }); }
    });
  }
  function editProvider(h, d) {
    var p = d.provider, ctl = openDialog({ title: 'עריכת נותן שירות', fields: providerFields(p), submit: 'שמירה', check: function (v) { return v.name.trim() ? null : { field: 'name', message: 'חובה להזין שם.' }; },
      onSubmit: function (v) {
        var diff = diffFields(PROVIDER_FIELDS, p, v);
        if (!diff.count) return ctl.status('לא בוצע שינוי, ולכן אין מה לשמור.', 'state');
        saveProvider(h, ctl, p, diff.changes, diff.expected);
      } });
  }
  function saveProvider(h, ctl, p, changes, expected) {
    write(h, ctl, 'PATCH', '/catalog/providers/' + p.id, { changes: changes, expected: expected }, {
      ok: function () { ctl.close(); toast('נשמר'); h.reload(); },
      conflict: function () {
        showConflict(h, ctl, { entity: 'provider', id: p.id, expected: expected, mine: changes, current: function () { return h.get('/catalog/providers/' + p.id).then(function (r) { return r.provider; }); },
          reapply: function (cur) {
            var c2 = {}, e2 = {}; Object.keys(changes).forEach(function (f) { if (!same(cur[f], changes[f])) { c2[f] = changes[f]; e2[f] = cur[f] === undefined ? null : cur[f]; } });
            if (!Object.keys(c2).length) { ctl.close(); toast('כבר מעודכן'); return h.reload(); }
            saveProvider(h, ctl, p, c2, e2);
          } });
      }
    });
  }
  function providerState(h, d, action) {
    var p = d.provider, id = p.id, path = '/catalog/providers/' + id + '/' + action, tomorrow = new Date(Date.now() + 86400000), limit = new Date(Date.now() + 365 * 86400000);
    var spec = {
      pause: { title: p.state === 'paused' ? 'שינוי השהיה' : 'השהיית נותן שירות', intro: '<p>בזמן ההשהיה לא ישלחו לנותן השירות פניות חדשות. אפשר לחדש בכל רגע.</p>', submit: 'השהיה',
        fields: field('until', 'מושהה עד (תחילת התאריך)', input('until', '', { type: 'date', min: dateInput(tomorrow), maxv: dateInput(limit), required: true }), '') + field('reason', 'סיבה', textarea('reason', '', 300), 'חובה. תירשם ביומן.'),
        body: function (v) { return { until: pauseUntilIso(v.until), reason: v.reason.trim() }; },
        check: function (v) { if (!v.until || !pauseUntilIso(v.until)) return { field: 'until', message: 'יש לבחור תאריך עתידי.' }; return v.reason.trim() ? null : { field: 'reason', message: 'חובה לכתוב סיבה.' }; }, ok: 'נותן השירות הושהה' },
      resume: { title: 'חידוש נותן שירות', intro: '<p>נותן השירות יחזור להיות זמין.</p>', submit: 'חידוש', fields: '', body: function () { return {}; }, ok: 'נותן השירות חודש' },
      archive: { title: 'ארכוב נותן שירות', intro: '<p><strong>נותן השירות יוסתר מהרשימות הרגילות ולא ייבחר להתקשרויות חדשות.</strong> לא נמחק דבר, ואפשר לבטל את הארכוב.</p>', submit: 'ארכוב', danger: true,
        fields: field('reason', 'סיבה', textarea('reason', '', 300), 'חובה. תירשם ביומן.'), body: function (v) { return { reason: v.reason.trim() }; }, check: function (v) { return v.reason.trim() ? null : { field: 'reason', message: 'חובה לכתוב סיבה.' }; }, ok: 'נותן השירות הועבר לארכיון' },
      unarchive: { title: 'ביטול ארכוב', intro: '<p>נותן השירות יחזור לרשימות הרגילות.</p>', submit: 'ביטול ארכוב', fields: '', body: function () { return {}; }, ok: 'הארכוב בוטל' }
    }[action];
    var ctl = openDialog({ title: spec.title, intro: spec.intro, fields: spec.fields, submit: spec.submit, danger: spec.danger, check: spec.check, focus: spec.fields ? null : '[data-ce=submit]',
      onSubmit: function (v) { write(h, ctl, 'POST', path, spec.body(v), { ok: function () { ctl.close(); toast(spec.ok); h.reload(); } }); } });
  }

  /* ---------- services ---------- */
  var SERVICE_FIELDS = ['name', 'topic', 'description', 'active'];
  function serviceFields(h, s, isNew) {
    return field('name', 'שם השירות', input('name', s.name, { max: 120, required: true }), '') + field('topic', 'תחום', select('topic', topicOptions(h, s.topic), s.topic || ''), '') + field('description', 'תיאור', textarea('description', s.description, 600), '') +
      (isNew ? '' : field('active', 'שירות פעיל (פנימי)', '<label class="ce-check"><input id="ce-active" name="active" type="checkbox"' + (s.active ? ' checked' : '') + described('active', true) + '> שירות פעיל (פנימי)</label>', ACTIVE_NOTE));
  }
  function newService(h) {
    var ctl = openDialog({ title: 'שירות חדש', intro: '<p>השירות נוצר <strong>כבוי</strong> (סימון פנימי). קוד השירות נקבע אוטומטית ואינו משתנה אחר כך.</p>', fields: serviceFields(h, {}, true), submit: 'יצירת שירות', check: function (v) { return v.name.trim() ? null : { field: 'name', message: 'חובה להזין שם.' }; },
      onSubmit: function (v) { createService(h, ctl, v, false); } });
  }
  function createService(h, ctl, v, force) {
    var body = { name: v.name.trim() }; if (v.topic) body.topic = v.topic; if ((v.description || '').trim()) body.description = v.description.trim(); if (force) body.allow_duplicate = true;
    write(h, ctl, 'POST', '/catalog/services', body, {
      ok: function (r) { var open = function () { h.go('service', r.id, true); }; ctl.seal(open); settingsStep(h, ctl, r.id, 0, open); },   // from here on the form can never come back: the service exists
      duplicate: function (d) { showDuplicate(h, ctl, d, 'service', function () { createService(h, ctl, v, true); }); }
    });
  }
  // The service exists now. Its code is made right away, from its number; if that fails the person is told exactly what exists and what to do (the service is never created again).
  // `after` shows the card of the service. One attempt per click: nothing here repeats by itself.
  function settingsStep(h, ctl, id, attempt, after) {
    var code = serviceCode(id, attempt);
    ctl.busy(true); ctl.status('השירות נוצר. יוצר את הקוד ' + code + '…', 'busy');
    send(h.ctx, 'PUT', '/catalog/services/' + id + '/settings', { code: code, finding_tags: [], topics: [] }).then(function () { done(); }, function (e) {
      var d = describe(e); ctl.busy(false);
      if (d.kind === 'auth') { ctl.close(); return h.ctx.fail(e); }
      if (e && e.message === 'settings_exist') return done();
      var inUse = e && e.message === 'code_in_use', next = serviceCode(id, attempt + 1), unknown = d.kind === 'unknown';
      ctl.showPanel('<div class="ce-warn" role="alert"><strong>השירות נוצר (מספר ' + id + '), אבל הקוד שלו עדיין לא נקבע.</strong> ' + esc(unknown ? 'לא ידוע אם הקוד נשמר. בדקו את כרטיס השירות לפני שליחה נוספת.' : (inUse ? 'הקוד ' + code + ' כבר בשימוש.' : d.message)) + '</div><p class="ce-actions">' +
        (unknown ? '' : '<button class="btn" type="button" data-ce="again">' + (inUse ? 'ליצור עם הקוד ' + esc(next) : 'ניסיון נוסף ליצירת הקוד') + '</button>') + '<button class="btn sec" type="button" data-ce="open">' + (after ? 'פתיחת השירות' : 'רענון') + '</button></p>', function (ev) {
        var b = ev.target.closest('[data-ce]'); if (!b || ctl.isBusy()) return;
        if (b.dataset.ce === 'again') settingsStep(h, ctl, id, inUse ? attempt + 1 : attempt, after); else if (b.dataset.ce === 'open') { ctl.close(); (after || function () { h.reload(); })(); }
      });
    });
    function done() { ctl.close(); toast('הקוד ' + code + ' נקבע'); (after || function () { h.reload(); })(); }
  }
  function editService(h, d) {
    var s = d.service, ctl = openDialog({ title: 'עריכת שירות', fields: serviceFields(h, s, false), submit: 'שמירה', check: function (v) { return v.name.trim() ? null : { field: 'name', message: 'חובה להזין שם.' }; },
      onSubmit: function (v) {
        var diff = diffFields(SERVICE_FIELDS, s, v);
        if (!diff.count) return ctl.status('לא בוצע שינוי, ולכן אין מה לשמור.', 'state');
        saveService(h, ctl, s, diff.changes, diff.expected);
      } });
  }
  function saveService(h, ctl, s, changes, expected) {
    write(h, ctl, 'PATCH', '/catalog/services/' + s.id, { changes: changes, expected: expected }, {
      ok: function () { ctl.close(); toast('נשמר'); h.reload(); },
      conflict: function () {
        showConflict(h, ctl, { entity: 'service', id: s.id, expected: expected, mine: changes, current: function () { return h.get('/catalog/services/' + s.id).then(function (r) { return r.service; }); },
          reapply: function (cur) {
            var c2 = {}, e2 = {}; Object.keys(changes).forEach(function (f) { if (!same(cur[f], changes[f])) { c2[f] = changes[f]; e2[f] = cur[f] === undefined ? null : cur[f]; } });
            if (!Object.keys(c2).length) { ctl.close(); toast('כבר מעודכן'); return h.reload(); }
            saveService(h, ctl, s, c2, e2);
          } });
      }
    });
  }
  function editSettings(h, d) {
    var s = d.service, st = d.settings || {}, topics = h.ctx.topics(), have = (st.topics || []).slice();
    var known = topics.map(function (t) { return t[0]; }), extra = have.filter(function (t) { return known.indexOf(t) === -1; });
    var boxes = topics.concat(extra.map(function (t) { return [t, t]; })).map(function (t) { return '<label class="ce-check"><input type="checkbox" data-group="topics" name="topics" value="' + esc(t[0]) + '"' + (have.indexOf(t[0]) !== -1 ? ' checked' : '') + '> ' + esc(t[1]) + '</label>'; }).join('');
    var ctl = openDialog({ title: 'הגדרות שירות', intro: '<p>קוד השירות: <strong dir="ltr">' + esc(st.code) + '</strong>. הוא נקבע פעם אחת ואינו משתנה.</p><p class="ct-small">התגים והתחומים משמשים להתאמת ממצאים לשירות. הם אינם משנים דבר באתר הציבורי.</p>',
      fields: field('finding_tags', 'תגי ממצאים', input('finding_tags', (st.finding_tags || []).join(', '), { ltr: true, hint: 'עד 12 תגים, מופרדים בפסיק: אותיות קטנות באנגלית, ספרות ומקף.' }), 'עד 12 תגים, מופרדים בפסיק: אותיות קטנות באנגלית, ספרות ומקף.') +
        '<fieldset class="ce-field" data-field="topics"><legend>תחומי שאלון</legend><div class="ce-checks">' + boxes + '</div><p class="ce-fe" id="ce-topics-e"></p></fieldset>',
      submit: 'שמירה', check: function (v) { var list = parseTags(v.finding_tags); return tagsProblem(list) ? { field: 'finding_tags', message: msg('bad_tags') } : null; },
      onSubmit: function (v) {
        var vals = { finding_tags: parseTags(v.finding_tags), topics: v.topics || [] }, diff = diffFields(['finding_tags', 'topics'], st, vals);
        if (!diff.count) return ctl.status('לא בוצע שינוי, ולכן אין מה לשמור.', 'state');
        saveSettings(h, ctl, s, diff.changes, diff.expected);
      } });
  }
  function saveSettings(h, ctl, s, changes, expected) {
    var body = Object.assign({}, changes, { expected: expected });
    write(h, ctl, 'PUT', '/catalog/services/' + s.id + '/settings', body, {
      ok: function () { ctl.close(); toast('נשמר'); h.reload(); },
      conflict: function () {
        showConflict(h, ctl, { entity: 'service', id: s.id, expected: expected, mine: changes, current: function () { return h.get('/catalog/services/' + s.id).then(function (r) { return r.settings; }); },
          reapply: function (cur) {
            var c2 = {}, e2 = {}; Object.keys(changes).forEach(function (f) { if (!same(cur[f], changes[f])) { c2[f] = changes[f]; e2[f] = cur[f] === undefined ? null : cur[f]; } });
            if (!Object.keys(c2).length) { ctl.close(); toast('כבר מעודכן'); return h.reload(); }
            saveSettings(h, ctl, s, c2, e2);
          } });
      }
    });
  }
  // The report of a legal clearance: only what the owner states. It documents a REPORT that a written approval was received; the system verifies nothing. Nothing is ticked for the person, nothing is assumed,
  // the server records who reported it and when, and every registration or cancellation is a new row of the journal: a later one never removes an earlier one.
  var CONTACT_HINT = 'בלי טלפון, דוא״ל, מספר זיהוי או קישור: אלה נדחים.';
  function clearance(h, d) {
    var s = d.service, st = d.settings || {}, today = dateInput(new Date());
    if (!st.legal_cleared) {
      var ctl = openDialog({ title: 'רישום דיווח על אישור משפטי', intro: '<p>זהו <strong>רישום של דיווח</strong> שלכם על אישור משפטי שכבר התקבל בכתב, לא בקשת אישור ולא הפעלה. המערכת רק מתעדת את הדיווח, ואינה מאמתת שהאישור התקבל.</p><p>הרישום נשמר על שם המנהל המחובר, עם זמן הרישום, ונוסף ליומן. רישום או ביטול נוספים לא מוחקים את הקודמים.</p>',
        fields: field('source_kind', 'סוג המקור (אם ידוע)', select('source_kind', [['', 'לא צוין']].concat(SOURCE_KINDS), ''), '') +
          field('source', 'פרטי המקור (אם יש)', input('source', '', { max: 200, hint: 'תארו את המסמך במילים, למשל סוג ותאריך. ' + CONTACT_HINT + ' הטקסט הזה נשמר ביומן, והמסמך עצמו נשמר מחוץ למערכת.' }), 'תארו את המסמך במילים, למשל סוג ותאריך. ' + CONTACT_HINT + ' הטקסט הזה נשמר ביומן, והמסמך עצמו נשמר מחוץ למערכת.') +
          field('approved_on', 'תאריך האישור (אם ידוע)', input('approved_on', '', { type: 'date', maxv: today }), '') +
          field('note', 'הערה', textarea('note', '', 300, 'נשמרת בכרטיס בלבד, לא ביומן.'), 'נשמרת בכרטיס בלבד, לא ביומן.') +
          '<div class="ce-field" data-field="confirm"><label class="ce-check"><input id="ce-confirm" name="confirm" type="checkbox"' + described('confirm', false) + '> אני מדווח שהתקבל אישור משפטי בכתב להפניה לסוג הזה של ספק, ושאני רושם את הדיווח עכשיו.</label><p class="ce-fe" id="ce-confirm-e"></p></div>',
        submit: 'לרשום את הדיווח', check: function (v) { if (!v.confirm) return { field: 'confirm', message: 'יש לסמן שהאישור התקבל.' }; var n = clearanceNote(v.source_kind, v.source, v.approved_on, v.note); return n && n.length > 600 ? { field: 'note', message: 'הטקסט ארוך מדי (עד 600 תווים בסך הכול).' } : null; },
        onSubmit: function (v) {
          var body = { cleared: true, expected_cleared: false }, note = clearanceNote(v.source_kind, v.source, v.approved_on, v.note);
          if (v.source_kind) body.source_kind = v.source_kind; if (v.source && v.source.trim()) body.source = v.source.trim(); if (v.approved_on) body.approved_on = v.approved_on; if (note) body.note = note;
          write(h, ctl, 'POST', '/catalog/services/' + s.id + '/clearance', body, { ok: function () { ctl.close(); toast('הדיווח על האישור המשפטי נרשם'); h.reload(); } });
        } });
    } else {
      var c2 = openDialog({ title: 'ביטול רישום האישור המדווח', intro: '<p>הרישום יבוטל והשירות יוצג כ״לא דווח אישור״. ההיסטוריה נשמרת ביומן ואינה נמחקת: מי דיווח ומתי, המקור והתאריך שדווחו, ומי ביטל, מתי ומדוע. אי אפשר לבטל כשיש התקשרות פעילה של השירות.</p>', danger: true,
        fields: field('reason', 'סיבה', textarea('reason', '', 300, 'חובה. נשמרת ביומן. ' + CONTACT_HINT), 'חובה. נשמרת ביומן. ' + CONTACT_HINT), submit: 'לבטל את הרישום', check: function (v) { return v.reason.trim() ? null : { field: 'reason', message: 'חובה לכתוב סיבה.' }; },
        onSubmit: function (v) { var reason = v.reason.trim(); write(h, c2, 'POST', '/catalog/services/' + s.id + '/clearance', { cleared: false, expected_cleared: true, reason: reason, note: 'ביטול הרישום: ' + reason }, { ok: function () { c2.close(); toast('רישום האישור בוטל'); h.reload(); } }); } });
    }
  }

  /* ---------- the buttons added to the screens ---------- */
  function bar(h, html, handlers) {
    var host = h.body.querySelector('#ct-h'), el = document.createElement('div');
    el.className = 'ce-bar'; el.innerHTML = html;
    if (host && host.parentNode === h.body) host.insertAdjacentElement('afterend', el); else h.body.insertBefore(el, h.body.firstChild);
    el.addEventListener('click', function (e) { var b = e.target.closest('[data-ce]'); if (b && handlers[b.dataset.ce]) handlers[b.dataset.ce](); });
    return el;
  }
  var button = function (a, text, cls) { return '<button type="button" class="btn ' + (cls || 'sec') + '" data-ce="' + a + '">' + esc(text) + '</button>'; };
  function afterDraw(kind, d, h) {
    if (kind === 'providers-list') return bar(h, button('new', 'נותן שירות חדש', ''), { 'new': function () { newProvider(h); } });
    if (kind === 'services-list') return bar(h, button('new', 'שירות חדש', ''), { 'new': function () { newService(h); } });
    if (kind === 'provider') {
      var st = d.provider.state, html = button('edit', 'עריכת פרטים', ''), hs = { edit: function () { editProvider(h, d); } };
      if (st === 'archived') { html += button('unarchive', 'ביטול ארכוב'); hs.unarchive = function () { providerState(h, d, 'unarchive'); }; }
      else {
        html += button('pause', st === 'paused' ? 'שינוי השהיה' : 'השהיה'); hs.pause = function () { providerState(h, d, 'pause'); };
        if (st === 'paused') { html += button('resume', 'חידוש'); hs.resume = function () { providerState(h, d, 'resume'); }; }
        html += button('archive', 'ארכוב', 'sec'); hs.archive = function () { providerState(h, d, 'archive'); };
      }
      return bar(h, html, hs);
    }
    if (kind === 'service') {
      var set = d.settings || {}, hasSettings = !!set.code, html2 = button('edit', 'עריכת פרטים', ''), hs2 = { edit: function () { editService(h, d); } };
      if (hasSettings) { html2 += button('settings', 'הגדרות שירות'); hs2.settings = function () { editSettings(h, d); }; html2 += button('clearance', set.legal_cleared ? 'ביטול רישום האישור המדווח' : 'רישום דיווח על אישור משפטי'); hs2.clearance = function () { clearance(h, d); }; }
      else { html2 += button('mksettings', 'יצירת הגדרות וקוד שירות'); hs2.mksettings = function () { createSettingsOnly(h, d); }; html2 += '<p class="ct-small ce-hint-line">לשירות הזה אין עדיין הגדרות וקוד, ולכן אי אפשר לרשום עבורו דיווח על אישור משפטי.</p>'; }
      return bar(h, html2, hs2);
    }
  }
  // A service made elsewhere has no settings row yet: the code is made from its number, by the person's click, in one confirmed step.
  function createSettingsOnly(h, d) {
    var id = d.service.id, ctl = openDialog({ title: 'יצירת הגדרות וקוד שירות', intro: '<p>הקוד ייקבע כ־<strong dir="ltr">' + esc(serviceCode(id, 0)) + '</strong> ואינו משתנה אחר כך.</p>', fields: '', submit: 'ליצירה', focus: '[data-ce=submit]', onSubmit: function () { ctl.seal(function () { h.reload(); }); settingsStep(h, ctl, id, 0, null); } });
  }

  C.extend({ afterDraw: afterDraw });
  root.KaspchemCatalogEdit = { _t: { ROUTES: ROUTES, allowed: allowed, describe: describe, MSG: MSG, FIELD_OF: FIELD_OF, diffFields: diffFields, parseTags: parseTags, tagsProblem: tagsProblem, serviceCode: serviceCode, clearanceNote: clearanceNote, kindLabel: kindLabel, SOURCE_KINDS: SOURCE_KINDS, pauseUntilIso: pauseUntilIso, dupItems: dupItems, same: same, norm: norm, convert: convert, msg: msg } };
})(typeof window !== 'undefined' ? window : this);
