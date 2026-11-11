/* Catalog prices, stage 5b-3: manage the internal price layers of an engagement and see every price with its state of approval.
 * It plugs into the catalog screens (catalog.js) next to the editing module (catalog-edit.js), whose dialog kit and allow-list of requests it uses: it sends nothing the editing module would not send.
 *
 * What the screens keep apart (and never mix):
 *   - REPORTED prices: the market price and a value not yet classified (from the sheet or typed in). Information with a source, not an offer and not an agreement.
 *   - the OFFERED price: the provider's offer to Kaspchem, with its state (recorded, waiting for an answer, answer received, declined). An offer is not an agreement.
 *   - what was AGREED with the provider: there is no price field for it; it is the state of the agreement and the note of the terms of the engagement, both reported by the owners (shown here, edited in "update the tracking").
 *   - the APPROVED price: only a row of the older "תמחור" tab that an owner approved there and that is linked to the engagement. Approving or publishing it stays in that tab; this module never does it.
 * Nothing here invents a price or an agreement of a provider: every figure is typed by a person or comes from a layer that a person (or the import, as "reported") recorded.
 * It never saves by itself, never sends twice (the dialog locks), never tries again by itself, and text from the server is always escaped.
 */
(function (root) {
  'use strict';
  var C = root.KaspchemCatalog, E = root.KaspchemCatalogEdit;
  if (!C || typeof C.extend !== 'function' || !E || !E.kit) return;
  var K = E.kit, T = C._t, esc = K.esc, L = T.labels;

  /* ---------- words ---------- */
  var KIND = {
    market: { title: 'מחיר שוק', edit: 'מחיר שוק', def: 'מה שמקובל בשוק, לידיעה בלבד. אינו הצעה ואינו התחייבות.' },
    provider_offer: { title: 'הצעת הספק', edit: 'הצעת הספק', def: 'מה שהספק הציע לכספכם. אין בכך הסכמה: הסכמה נרשמת רק במצב ההסכם של ההתקשרות.' },
    unclassified: { title: 'ערך שטרם סווג', edit: 'ערך שטרם סווג', def: 'ערך שדווח (למשל מהגיליון) בלי שנקבע מה הוא. רישום בלבד, ללא אישור.' }
  };
  var MODEL_HINT = 'קבוע: סכום אחד. אחוז מהתוצאה: שיעור או טווח. אחוז עם מינימום: שיעור וסכום מינימום. משתנה, הצעת מחיר או טרם נקבע: בלי מספרים, רק הטקסט.';
  var STATUS_HINT = 'ממתין לתשובה: ביקשתם הצעה והיא טרם התקבלה. התקבלה תשובה: אין בכך הסכמה.';
  var LAYER_CODE = {
    model_unknown: ['model', 'אופן התמחור אינו תקין.'], amount_negative: ['amount', 'הסכום אינו יכול להיות שלילי.'], percent_low_out_of_range: ['percent_low', 'האחוז חייב להיות מעל 0 ועד 100.'], percent_high_out_of_range: ['percent_high', 'האחוז חייב להיות מעל 0 ועד 100.'],
    minimum_negative: ['minimum_amount', 'המינימום אינו יכול להיות שלילי.'], percent_range_reversed: ['percent_high', 'סוף הטווח קטן מתחילתו.'], terms_text_too_long: ['terms_text', 'הטקסט ארוך מדי (עד 600 תווים).'], source_note_too_long: ['source_note', 'הטקסט ארוך מדי (עד 600 תווים).'],
    fixed_needs_an_amount_and_nothing_else: ['amount', 'מחיר קבוע דורש סכום בלבד, בלי אחוזים ובלי מינימום.'], percent_model_needs_a_percent_and_no_amount: ['percent_low', 'מודל באחוזים דורש אחוז ואינו מקבל סכום קבוע.'],
    minimum_needed: ['minimum_amount', 'מודל ״אחוז עם מינימום״ דורש סכום מינימום.'], no_numbers_allowed_for_this_model: ['model', 'במודל הזה אין מספרים. הטקסט נשמר כלשונו בשדה התנאים.'],
    only_an_offer_can_wait_for_an_answer: ['status', 'רק הצעת ספק יכולה להמתין לתשובה.'], status_unknown: ['status', 'מצב ההצעה אינו תקין.'], kind_unknown: [null, 'סוג השכבה אינו תקין.']
  };
  var SERVER_FIELD = { bad_model: ['model', 'אופן התמחור אינו תקין.'], bad_amount: ['amount', 'הסכום אינו תקין (מספר, 0 או יותר).'], bad_percent: ['percent_low', 'האחוז אינו תקין.'], bad_minimum: ['minimum_amount', 'המינימום אינו תקין.'], bad_terms_text: ['terms_text', 'נוסח התנאים אינו תקין.'],
    bad_status: ['status', 'מצב ההצעה אינו תקין.'], bad_source_note: ['source_note', 'המקור אינו תקין (עד 600 תווים, טקסט בלבד).'], bad_basis_missing: ['basis_missing', 'הערך אינו תקין.'], date_format: ['source_date', 'התאריך חייב להיות תאריך אמיתי.'], date_invalid: ['source_date', 'התאריך חייב להיות תאריך אמיתי.'] };
  function pairs(map) { return Object.keys(map).map(function (k) { return [k, map[k]]; }); }
  function lbl(map, k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : String(k); }

  /* ---------- the rule of a layer, in code (the same checks as the server and the database; a test keeps the three equal) ---------- */
  var MODELS = ['fixed', 'percent_of_result', 'percent_with_minimum', 'variable', 'quote', 'tbd'], STATUSES = ['recorded', 'awaiting_response', 'received', 'declined'], MAX_TEXT = 600;
  function has(v) { return v !== null && v !== undefined; }
  function layerProblems(l) {
    var p = [], kindOk = ['market', 'provider_offer', 'unclassified'].indexOf(l.kind) !== -1;
    if (MODELS.indexOf(l.model) === -1) p.push('model_unknown');
    if (!kindOk) p.push('kind_unknown');
    if (STATUSES.indexOf(l.status || 'recorded') === -1) p.push('status_unknown');
    if (l.kind !== 'provider_offer' && (l.status || 'recorded') !== 'recorded') p.push('only_an_offer_can_wait_for_an_answer');
    if (has(l.amount) && !(l.amount >= 0)) p.push('amount_negative');
    ['percent_low', 'percent_high'].forEach(function (f) { if (has(l[f]) && !(l[f] > 0 && l[f] <= 100)) p.push(f + '_out_of_range'); });
    if (has(l.minimum_amount) && !(l.minimum_amount >= 0)) p.push('minimum_negative');
    if (has(l.percent_low) && has(l.percent_high) && l.percent_high < l.percent_low) p.push('percent_range_reversed');
    if (has(l.terms_text) && l.terms_text.length > MAX_TEXT) p.push('terms_text_too_long');
    if (has(l.source_note) && l.source_note.length > MAX_TEXT) p.push('source_note_too_long');
    if (l.model === 'fixed' && !(has(l.amount) && !has(l.percent_low) && !has(l.percent_high) && !has(l.minimum_amount))) p.push('fixed_needs_an_amount_and_nothing_else');
    if ((l.model === 'percent_of_result' || l.model === 'percent_with_minimum') && !(has(l.percent_low) && !has(l.amount))) p.push('percent_model_needs_a_percent_and_no_amount');
    if (l.model === 'percent_with_minimum' && !has(l.minimum_amount)) p.push('minimum_needed');
    if (['variable', 'quote', 'tbd'].indexOf(l.model) !== -1 && (has(l.amount) || has(l.percent_low) || has(l.percent_high) || has(l.minimum_amount))) p.push('no_numbers_allowed_for_this_model');
    return p;
  }
  // which number boxes a model uses (the others are hidden and never sent)
  var USES = { fixed: ['amount'], percent_of_result: ['percent_low', 'percent_high'], percent_with_minimum: ['percent_low', 'percent_high', 'minimum_amount'], variable: [], quote: [], tbd: [] };
  // A number as a person types it: digits with an optional decimal POINT, or thousands in groups of three (1,150 or 1,150.50). Any other comma is refused, never guessed: "1,5" could be one and a half or a typing slip, and a price is not guessed.
  function toNumber(s) {
    var t = String(s == null ? '' : s).trim(); if (t === '') return null;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
    return NaN;
  }
  // the layer a form describes: only the boxes of the chosen model count, text as typed (edges trimmed, empty is nothing), the state only for an offer
  function layerFromForm(kind, v) {
    var uses = USES[v.model] || [], pick = function (f) { return uses.indexOf(f) === -1 ? null : toNumber(v[f]); };
    var text = function (s) { var t = String(s == null ? '' : s).trim(); return t === '' ? null : t; };
    return { kind: kind, model: v.model, amount: pick('amount'), percent_low: pick('percent_low'), percent_high: pick('percent_high'), minimum_amount: pick('minimum_amount'), terms_text: text(v.terms_text),
      status: kind === 'provider_offer' ? (v.status || 'recorded') : 'recorded', basis_missing: uses.indexOf('percent_low') !== -1 ? !!v.basis_missing : false, source_note: text(v.source_note), source_date: text(v.source_date) };
  }
  var LAYER_KEYS = ['model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'terms_text', 'status', 'basis_missing', 'source_note', 'source_date'];
  function bodyOf(l) { var out = {}; LAYER_KEYS.forEach(function (k) { out[k] = l[k]; }); return out; }
  function sameLayer(a, b) { return LAYER_KEYS.every(function (k) { var x = a[k] === undefined ? null : a[k], y = b[k] === undefined ? null : b[k]; return k === 'source_date' ? String(x || '').slice(0, 10) === String(y || '').slice(0, 10) : (typeof x === 'number' || typeof y === 'number' ? Number(x) === Number(y) && (x === null) === (y === null) : x === y); }); }
  // the answer of the server to a bad layer, in words, with the box it belongs to
  function layerRefine(e, d) {
    var code = e && e.message, codes = e && e.details && Array.isArray(e.details.codes) ? e.details.codes : [];
    if (code === 'layer_invalid' && codes.length) { var first = LAYER_CODE[codes[0]]; return { kind: 'validation', field: first && first[0] ? first[0] : 'model', message: codes.map(function (c) { return LAYER_CODE[c] ? LAYER_CODE[c][1] : 'שכבת המחיר אינה תקינה.'; }).filter(function (t, i, a) { return a.indexOf(t) === i; }).join(' ') }; }
    if (Object.prototype.hasOwnProperty.call(SERVER_FIELD, code)) return { kind: 'validation', field: SERVER_FIELD[code][0], message: SERVER_FIELD[code][1] };
    if (code === 'layer_exists') return { kind: 'stale', message: 'שכבה כזו כבר נרשמה בינתיים.' };
    if (code === 'only_unclassified_can_be_classified') return { kind: 'stale', message: 'רק ערך שטרם סווג אפשר לסווג.' };
    return d;
  }
  function dayText(iso) { return iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('he-IL') : ''; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  /* ---------- the form of one layer ---------- */
  function layerFields(kind, cur) {
    cur = cur || {};
    // a number is typed as text with the decimal keyboard: a price or a percentage may have a fraction, and the numeric keypad of a phone has no decimal point
    var num = function (id, label, value, hint) { return K.field(id, label, '<input id="ce-' + id + '" name="' + id + '" type="text" inputmode="decimal" class="ce-ltr" dir="ltr" autocomplete="off" value="' + esc(value === null || value === undefined ? '' : value) + '" aria-describedby="' + (hint ? 'ce-' + id + '-h ' : '') + 'ce-' + id + '-e">', hint); };
    var basis = '<div class="ce-field" data-field="basis_missing"><label class="ce-check"><input id="ce-basis_missing" name="basis_missing" type="checkbox"' + (cur.basis_missing ? ' checked' : '') + '> חסר בסיס לחישוב (לא ידוע מאיזה סכום האחוז)</label><p class="ce-fe" id="ce-basis_missing-e"></p></div>';
    return K.field('model', 'אופן התמחור', K.select('model', pairs(L.MODEL), cur.model || 'tbd', MODEL_HINT), MODEL_HINT) +
      '<div data-grp="amount">' + num('amount', 'סכום ₪', cur.amount, '') + '</div>' +
      '<div data-grp="percent">' + num('percent_low', 'אחוז (או תחילת טווח)', cur.percent_low, 'בין 0 ל־100.') + num('percent_high', 'סוף הטווח (אם יש)', cur.percent_high, '') + basis + '</div>' +
      '<div data-grp="minimum">' + num('minimum_amount', 'מינימום ₪', cur.minimum_amount, '') + '</div>' +
      K.field('terms_text', 'תנאים והבהרות (כלשונם)', K.textarea('terms_text', cur.terms_text, MAX_TEXT, 'מועתק כלשונו ואינו מתורגם למספרים. עד 600 תווים.'), 'מועתק כלשונו ואינו מתורגם למספרים. עד 600 תווים.') +
      (kind === 'provider_offer' ? K.field('status', 'מצב ההצעה', K.select('status', pairs(L.LAYER_STATUS), cur.status || 'recorded', STATUS_HINT), STATUS_HINT) : '') +
      K.field('source_note', 'מקור (אם יש)', K.input('source_note', cur.source_note, { max: 600, hint: 'תארו את המקור במילים, למשל מי מסר ומתי.' }), 'תארו את המקור במילים, למשל מי מסר ומתי.') +
      K.field('source_date', 'תאריך המקור (אם ידוע)', K.input('source_date', cur.source_date ? String(cur.source_date).slice(0, 10) : '', { type: 'date', maxv: today() }), '');
  }
  function showGroups(form) {
    var model = form.querySelector('#ce-model').value, uses = USES[model] || [];
    [].forEach.call(form.querySelectorAll('[data-grp]'), function (g) {
      var on = g.dataset.grp === 'amount' ? uses.indexOf('amount') !== -1 : g.dataset.grp === 'percent' ? uses.indexOf('percent_low') !== -1 : uses.indexOf('minimum_amount') !== -1;
      g.hidden = !on;
    });
  }
  function editLayer(h, d, kind) {
    var e = d.engagement, cur = (d.price_layers || {})[kind], spec = KIND[kind], path = '/catalog/engagements/' + e.provider_id + '/' + e.service_id + '/prices/' + kind;
    var ctl = K.openDialog({ title: (cur ? 'עריכת ' : 'רישום ') + spec.edit, focus: '#ce-model',
      intro: '<p><strong>' + esc(e.provider_name) + ' ← ' + esc(e.service_name) + '</strong></p><p>' + esc(spec.def) + '</p><p class="ct-small">אין כאן מחיר מאושר ואין הפעלה. ערך שלא הוזן נשאר ריק: המערכת אינה ממציאה מחיר.</p>',
      fields: layerFields(kind, cur), submit: cur ? 'שמירה' : 'לרשום',
      check: function (v) {
        var l = layerFromForm(kind, v), uses = USES[v.model] || [];
        for (var i = 0; i < uses.length; i++) if (Number.isNaN(toNumber(v[uses[i]]))) return { field: uses[i], message: 'יש להזין מספר (0 או יותר), עם נקודה לשבר, למשל 1150 או 7.5. פסיק מותר רק להפרדת אלפים (1,150).' };
        var codes = layerProblems(l); if (codes.length) { var m = LAYER_CODE[codes[0]] || [null, 'שכבת המחיר אינה תקינה.']; return { field: m[0] || 'model', message: m[1] }; }
        if (cur && sameLayer(l, cur)) return { field: 'model', message: 'לא בוצע שינוי, ולכן אין מה לשמור.' };
        return null;
      },
      onSubmit: function (v) {
        var body = { layer: bodyOf(layerFromForm(kind, v)) }; if (cur) body.expected_updated_at = cur.updated_at;
        K.write(h, ctl, 'PUT', path, body, { refine: layerRefine, ok: function () { ctl.close(); K.toast(cur ? 'השכבה עודכנה' : 'השכבה נרשמה'); h.reload(); },
          conflict: function () { K.stale(h, ctl, e.provider_id, e.service_id, 'השכבה השתנתה מאז שצפיתם בה.'); }, stale: function (dd) { K.stale(h, ctl, e.provider_id, e.service_id, dd.message); } });
      } });
    showGroups(ctl.form); ctl.form.addEventListener('change', function (ev) { if (ev.target && ev.target.id === 'ce-model') showGroups(ctl.form); });
  }

  /* ---------- classify a value that has no kind yet ---------- */
  function classify(h, d) {
    var e = d.engagement, u = d.price_layers.unclassified, have = d.price_layers, path = '/catalog/engagements/' + e.provider_id + '/' + e.service_id + '/prices/unclassified/classify';
    var ctl = K.openDialog({ title: 'סיווג ערך שטרם סווג', focus: '#ce-to',
      intro: '<p><strong>' + esc(e.provider_name) + ' ← ' + esc(e.service_name) + '</strong></p><p>הערך: <strong>' + esc(T.priceText(u)) + '</strong></p><p>הערך יעבור לשכבה שתבחרו, כמות שהוא. המחיר אינו משתנה, לא נוצר מחיר מאושר, ואין בכך הסכמה של הספק.</p>',
      fields: K.field('to', 'מה הערך הזה', K.select('to', [['market', 'מחיר שוק (מדווח, לידיעה בלבד)'], ['provider_offer', 'הצעת הספק (מוצע, ללא הסכמה)']], 'market'), 'אם כבר קיימת שכבה כזו, הסיווג נדחה ולא נשמר דבר.'),
      submit: 'לסווג', check: function (v) { return have[v.to] ? { field: 'to', message: 'כבר קיימת שכבת ״' + KIND[v.to].title + '״. יש לערוך אותה קודם.' } : null; },
      onSubmit: function (v) { K.write(h, ctl, 'POST', path, { to: v.to }, { refine: layerRefine, ok: function () { ctl.close(); K.toast('הערך סווג כ' + KIND[v.to].title); h.reload(); }, stale: function (dd) { K.stale(h, ctl, e.provider_id, e.service_id, dd.message); }, conflict: function () { K.stale(h, ctl, e.provider_id, e.service_id, 'השכבה השתנתה מאז שצפיתם בה.'); } }); } });
  }

  /* ---------- the approved price: link one of the older "תמחור" tab, or let go of it ---------- */
  function rowState(r) { return r.public ? 'מוצג לציבור' : r.approved ? 'מאושר, פנימי' : 'ממתין לאישור'; }
  function whyNot(r, e) {
    var out = [];
    if (!r.approved) out.push('לא מאושר (אישור נעשה בלשונית ״תמחור״)');
    if (r.price === null || r.price === undefined) out.push('אין בו סכום');
    if (r.provider_id !== null && String(r.provider_id) !== String(e.provider_id)) out.push('של נותן שירות אחר');
    if (String(r.service_id) !== String(e.service_id)) out.push('של שירות אחר');
    return out;
  }
  function linkPrice(h, d) {
    var e = d.engagement, ap = d.approved_price, base = '/catalog/engagements/' + e.provider_id + '/' + e.service_id, chosen = null;
    var ctl = K.openDialog({ title: ap ? 'החלפת המחיר המקושר' : 'קישור מחיר מאושר', focus: '[data-ce=submit]',
      intro: '<p><strong>' + esc(e.provider_name) + ' ← ' + esc(e.service_name) + '</strong></p><p>בוחרים שורה מהלשונית ״תמחור״ הקיימת. רק שורה <strong>מאושרת</strong>, בעלת סכום, של אותו שירות (כללית או של נותן השירות הזה) אפשר לקשר. הקישור אינו אישור ואינו הפעלה, והוא ייבדק שוב לפני כל הפעלה.</p>' +
        '<p class="ct-small">מחיר חדש, עריכה, אישור ופרסום נעשים בלשונית ״תמחור״.</p>',
      fields: '<div class="ce-field" data-field="pick"><fieldset class="cp-pick"><legend>השורות של השירות הזה</legend><div id="cp-rows" role="radiogroup" aria-describedby="cp-count"><p class="ct-loading" role="status">טוען…</p></div><p class="ct-small" id="cp-count" role="status" aria-live="polite"></p></fieldset><p class="ce-fe" id="ce-pick-e"></p></div>',
      submit: 'לקשר את המחיר', check: function () { return chosen ? null : { field: 'pick', message: 'יש לבחור שורה מאושרת מהרשימה.' }; },
      onSubmit: function () { K.write(h, ctl, 'POST', base + '/link-price', { pricing_id: chosen, expected_pricing_id: ap ? ap.id : null }, { refine: priceRefine, ok: function () { ctl.close(); K.toast('המחיר קושר להתקשרות. הוא ייבדק שוב לפני הפעלה'); h.reload(); }, conflict: function () { K.stale(h, ctl, e.provider_id, e.service_id, 'ההתקשרות או המחיר השתנו מאז שצפיתם בהם.'); }, stale: function (dd) { K.stale(h, ctl, e.provider_id, e.service_id, dd.message); } }); } });
    var box = ctl.form.querySelector('#cp-rows'), count = ctl.form.querySelector('#cp-count');
    h.get('/catalog/pricing-rows?service_id=' + e.service_id + '&for_provider_id=' + e.provider_id + '&for_service_id=' + e.service_id + '&limit=200').then(function (r) {
      if (!document.body.contains(ctl.el)) return;
      var rows = r.pricing_rows || [];
      box.innerHTML = rows.length ? rows.map(function (x) {
        var ok = x.fits_engagement === true && (!ap || x.id !== ap.id), why = whyNot(x, e), me = ap && x.id === ap.id;
        return '<label class="cp-row' + (ok ? '' : ' cp-off') + '"><input type="radio" name="pick" value="' + x.id + '"' + (ok ? '' : ' disabled') + '> <span><strong>' + esc(x.label) + '</strong> · ' + esc(x.price === null ? 'ללא סכום' : h.ils(x.price)) + ' · ' + esc(rowState(x)) + (x.provider_id ? '' : ' · כללי') +
          (me ? ' · <em>המקושר כעת</em>' : '') + (x.fits_engagement === true || me ? '' : '<br><span class="ct-small">אי אפשר לקשר: ' + esc(why.join(', ') || 'אינו מתאים להתקשרות') + '</span>') + (x.linked_count ? '<br><span class="ct-small">מקושר ל־' + x.linked_count + ' התקשרויות</span>' : '') + '</span></label>';
      }).join('') : '<p class="ct-small">אין שורות תמחור לשירות הזה. אפשר להוסיף ולאשר בלשונית ״תמחור״.</p>';
      count.textContent = rows.length ? rows.length + ' שורות' : '';
      box.addEventListener('change', function (ev) { if (ev.target && ev.target.name === 'pick') chosen = Number(ev.target.value); });
    }, function (err) { if (!document.body.contains(ctl.el)) return; var dd = K.describe(err); if (dd.kind === 'auth') { ctl.close(); return h.ctx.fail(err); } box.innerHTML = '<p class="ct-small">לא ניתן היה לטעון את הרשימה. לא נשלח דבר. סגרו ופתחו שוב.</p>'; });
  }
  function priceRefine(e, d) {
    var code = e && e.message;
    if (code === 'engagement_active') return { kind: 'stale', message: 'ההתקשרות פעילה. יש להשהות אותה לפני החלפת המחיר המקושר. לא נשמר דבר.' };
    if (code === 'price_not_eligible') return { kind: 'stale', message: 'השורה אינה קיימת, אינה מאושרת, אין בה סכום, או שאינה שייכת לשירות ולנותן השירות של ההתקשרות. לא נשמר דבר.' };
    return layerRefine(e, d);
  }
  function unlinkPrice(h, d) {
    var e = d.engagement, ap = d.approved_price, path = '/catalog/engagements/' + e.provider_id + '/' + e.service_id + '/unlink-price';
    var ctl = K.openDialog({ title: 'ניתוק המחיר המקושר', focus: '[data-ce=submit]', danger: true,
      intro: '<p><strong>' + esc(e.provider_name) + ' ← ' + esc(e.service_name) + '</strong></p><p>המחיר <strong>' + esc(ap.label || '') + '</strong> (' + esc(ap.price === null ? 'ללא סכום' : h.ils(ap.price)) + ') יינתק מההתקשרות. השורה בלשונית ״תמחור״ לא נמחקת ולא משתנה. מודל התמחור של ההתקשרות יחזור ל״טרם נקבע״, ויהיה צורך לקשר מחיר מאושר שוב לפני כל הפעלה.</p>',
      fields: '', submit: 'לנתק',
      onSubmit: function () { K.write(h, ctl, 'POST', path, { expected_pricing_id: ap.id }, { refine: priceRefine, ok: function () { ctl.close(); K.toast('המחיר נותק'); h.reload(); }, conflict: function () { K.stale(h, ctl, e.provider_id, e.service_id, 'ההתקשרות השתנתה מאז שצפיתם בה.'); }, stale: function (dd) { K.stale(h, ctl, e.provider_id, e.service_id, dd.message); } }); } });
  }

  /* ---------- the tools on the engagement card ---------- */
  function btn(a, text, cls) { return '<button type="button" class="btn ' + (cls || 'sec') + '" data-cp="' + a + '">' + esc(text) + '</button>'; }
  function toolsHtml(d) {
    var e = d.engagement, lay = d.price_layers || {}, ap = d.approved_price, working = e.activation === 'active', html = '';
    html += btn('market', (lay.market ? 'עריכת ' : 'רישום ') + KIND.market.edit);
    html += btn('provider_offer', (lay.provider_offer ? 'עריכת ' : 'רישום ') + KIND.provider_offer.edit);
    html += btn('unclassified', (lay.unclassified ? 'עריכת ' : 'רישום ') + KIND.unclassified.edit);
    if (lay.unclassified) html += btn('classify', 'סיווג הערך שטרם סווג');
    if (!working) { html += btn('link', ap ? 'החלפת המחיר המקושר' : 'קישור מחיר מאושר', ''); if (ap) html += btn('unlink', 'ניתוק המחיר המקושר'); }
    return '<div class="cp-tools"><p class="ct-small cp-legend"><strong>איך לקרוא:</strong> מחיר שוק וערך שטרם סווג הם <strong>מדווחים</strong> (מידע עם מקור). הצעת הספק היא <strong>מוצעת</strong> ואינה הסכמה. מה שסוכם עם הספק הוא מצב ההסכם והערת התנאים של ההתקשרות (דיווח שלכם). <strong>מאושר</strong> הוא רק המחיר המקושר מהלשונית ״תמחור״ שאושר שם.</p>' +
      '<div class="cp-bar" role="group" aria-label="ניהול שכבות המחיר">' + html + '</div>' + (working ? '<p class="ct-small">ההתקשרות פעילה: כדי להחליף או לנתק את המחיר המקושר יש להשהות אותה.</p>' : '') +
      '<p class="ct-small cp-agreed"><strong>מה סוכם עם הספק (דיווח של הבעלים, לא אימות):</strong> מצב ההסכם: ' + esc(lbl(L.AGREEMENT, e.agreement_state)) + (e.terms_note ? '. הערת התנאים: ' + esc(e.terms_note) : '. אין הערת תנאים') + '. אין שדה של מחיר מוסכם נפרד.</p></div>';
  }
  function afterDraw(kind, d, h) {
    if (kind !== 'engagement') return;
    var host = h.body.querySelector('#ct-price-tools'); if (!host) return;
    host.innerHTML = toolsHtml(d);
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-cp]'); if (!b) return; var a = b.dataset.cp;
      if (a === 'market' || a === 'provider_offer' || a === 'unclassified') editLayer(h, d, a); else if (a === 'classify') classify(h, d); else if (a === 'link') linkPrice(h, d); else if (a === 'unlink') unlinkPrice(h, d);
    });
  }

  /* ---------- the screen of all the prices ---------- */
  var FILTER_NAME = { '': 'הכול', no_price: 'בלי שום מחיר', unclassified: 'יש ערך שטרם סווג', offer: 'יש הצעת ספק', awaiting_answer: 'הצעה שממתינה לתשובה', linked: 'מחיר מקושר', linked_problem: 'מחיר מקושר שאינו מתאים' };
  var PAGE = 50, S = { view: 'by', q: '', filter: '', offset: 0, seq: 0 };
  function layerCell(l, withStatus) {
    if (!l) return '<span class="ct-unset">אין</span>';
    return esc(T.priceText(l)) + (withStatus && l.status && l.status !== 'recorded' ? ' ' + '<span class="ct-pill ct-' + (l.status === 'declined' ? 'bad' : 'warn') + '">' + esc(lbl(L.LAYER_STATUS, l.status)) + '</span>' : '') + (l.basis_missing ? ' <span class="ct-small">(חסר בסיס)</span>' : '');
  }
  function pill(text, tone) { return '<span class="ct-pill ct-' + tone + '">' + esc(text) + '</span>'; }
  function linkedCell(x, h) {
    if (!x) return '<span class="ct-unset">לא מקושר</span>';
    return esc(x.label || '') + ' · ' + esc(x.price === null ? 'ללא סכום' : h.ils(x.price)) + ' ' + (x.approved ? pill(x.public ? 'מאושר ומוצג' : 'מאושר', 'ok') : pill('ממתין לאישור', 'warn')) + (x.fits ? '' : ' ' + pill('אינו מתאים להתקשרות', 'bad'));
  }
  function byTable(r, h) {
    if (!r.prices.length) return T.emptyHtml('אין התקשרויות לתצוגה', 'לא נמצאו התקשרויות שמתאימות לסינון.');
    return '<table class="tbl ct-tbl ct-hist"><caption class="sr">שכבות המחיר לפי התקשרות</caption><thead><tr><th>התקשרות</th><th>מצב</th><th>מחיר שוק (מדווח)</th><th>הצעת הספק (מוצע)</th><th>ערך שטרם סווג (מדווח)</th><th>מחיר מקושר (מאושר רק כשמסומן)</th></tr></thead><tbody>' + r.prices.map(function (x) {
      return '<tr><td data-label="התקשרות"><button type="button" class="ct-link" data-ct="open-eng" data-p="' + x.provider_id + '" data-s="' + x.service_id + '">' + esc(x.provider_name) + ' ← ' + esc(x.service_name) + '</button></td><td data-label="מצב">' + T.actPill(x.activation) + '</td><td data-label="מחיר שוק">' + layerCell(x.layers.market, false) + '</td><td data-label="הצעת הספק">' + layerCell(x.layers.provider_offer, true) + '</td><td data-label="שטרם סווג">' + layerCell(x.layers.unclassified, false) + '</td><td data-label="מחיר מקושר">' + linkedCell(x.linked, h) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function rowsTable(r, h) {
    if (!r.pricing_rows.length) return T.emptyHtml('אין שורות תמחור', 'שורות מחיר נוספות ומאושרות בלשונית ״תמחור״.');
    return '<table class="tbl ct-tbl ct-hist"><caption class="sr">שורות הלשונית תמחור</caption><thead><tr><th>תיאור</th><th>מחיר ללקוח</th><th>שירות</th><th>נותן שירות</th><th>מצב</th><th>מקושר</th></tr></thead><tbody>' + r.pricing_rows.map(function (x) {
      return '<tr><td data-label="תיאור">' + esc(x.label) + '</td><td data-label="מחיר">' + esc(x.price === null ? 'ללא סכום' : h.ils(x.price)) + '</td><td data-label="שירות">' + esc(x.service_name || '') + '</td><td data-label="נותן שירות">' + (x.provider_name ? esc(x.provider_name) : '<span class="ct-unset">כללי</span>') + '</td><td data-label="מצב">' + (x.public ? pill('מוצג לציבור', 'ok') : x.approved ? pill('מאושר, פנימי', 'ok') : pill('ממתין לאישור', 'warn')) +
        '</td><td data-label="מקושר">' + (x.linked_count ? esc(String(x.linked_count)) + ' התקשרויות' + (x.linked_working ? ' (' + x.linked_working + ' פעילות)' : '') : '<span class="ct-unset">לא מקושר</span>') + '</td></tr>';
    }).join('') + '</tbody></table>';
  }
  function pager(r) {
    var end = Math.min(r.offset + r.limit, r.total);
    return r.total > r.limit ? '<nav class="ct-pager" aria-label="דפדוף"><button type="button" class="btn sec" data-cpp="-1"' + (r.offset ? '' : ' disabled') + '>→ הקודם</button><span role="status">' + (r.offset + 1) + '–' + end + ' מתוך ' + r.total + '</span><button type="button" class="btn sec" data-cpp="1"' + (end >= r.total ? ' disabled' : '') + '>הבא ←</button></nav>' : '';
  }
  // Entering the screen from the menu starts from the first view, with no filter and no search; the views and the filters then move inside the screen (drawScreen).
  function enter(h, body) { var seq = S.seq; S = { view: 'by', q: '', filter: '', offset: 0, seq: seq }; drawScreen(h, body); }
  function drawScreen(h, body) {
    var my = ++S.seq, wrap = document.createElement('div'); wrap.className = 'cp'; body.innerHTML = ''; body.appendChild(wrap);   // a wrapper of its own per drawing: its listeners go with it
    wrap.innerHTML = '<h2 id="ct-h" tabindex="-1">מחירים</h2>' +
      '<p class="ct-note">המחירים כאן מוצגים בנפרד לפי מה שהם: <strong>מדווחים</strong> (שוק, ערך שטרם סווג), <strong>מוצעים</strong> (הצעת ספק) ו<strong>מאושרים</strong> (רק שורה מהלשונית ״תמחור״ שאושרה שם ומקושרת להתקשרות). מה שסוכם עם הספק נרשם במצב ההסכם של ההתקשרות. אין כאן הפעלה ואין פרסום.</p>' +
      '<div class="cp-views" role="group" aria-label="תצוגה"><button type="button" class="btn ' + (S.view === 'by' ? '' : 'sec') + '" data-cpv="by" aria-pressed="' + (S.view === 'by') + '">לפי התקשרות</button><button type="button" class="btn ' + (S.view === 'rows' ? '' : 'sec') + '" data-cpv="rows" aria-pressed="' + (S.view === 'rows') + '">שורות מהלשונית ״תמחור״</button>' +
        '<button type="button" class="btn sec" data-cpv="tab">לאישור או פרסום: ללשונית ״תמחור״</button></div>' +
      '<form class="panel row ct-filters" role="search" aria-label="סינון מחירים" novalidate><div><label for="cp-q">חיפוש לפי שם' + (S.view === 'rows' ? ' או תיאור' : '') + '</label><input id="cp-q" type="search" autocomplete="off" value="' + esc(S.q) + '"></div>' +
        (S.view === 'by' ? '<div><label for="cp-f">סינון</label><select id="cp-f">' + Object.keys(FILTER_NAME).map(function (k) { return '<option value="' + k + '"' + (k === S.filter ? ' selected' : '') + '>' + esc(FILTER_NAME[k]) + '</option>'; }).join('') + '</select></div>' : '') + '</form>' +
      '<p id="cp-count" class="ct-count" role="status" aria-live="polite"></p><div id="cp-res" class="scroll"><p class="ct-loading" role="status">טוען…</p></div>';
    var res = wrap.querySelector('#cp-res'), count = wrap.querySelector('#cp-count'), timer = null;
    function qs() { var p = ['limit=' + PAGE, 'offset=' + S.offset]; if (S.q.trim()) p.push('q=' + encodeURIComponent(S.q.trim())); if (S.view === 'by' && S.filter) p.push('filter=' + S.filter); return '?' + p.join('&'); }
    function load() {
      var mine = ++S.seq; res.innerHTML = '<p class="ct-loading" role="status">טוען…</p>';
      h.get((S.view === 'by' ? '/catalog/prices' : '/catalog/pricing-rows') + qs()).then(function (r) {
        if (mine !== S.seq || !document.body.contains(res)) return;
        res.innerHTML = (S.view === 'by' ? byTable(r, h) : rowsTable(r, h)) + pager(r); count.textContent = r.total ? r.total + (S.view === 'by' ? ' התקשרויות' : ' שורות') : '';
      }, function (e) { if (mine !== S.seq || !document.body.contains(res)) return; var d = K.describe(e); if (d.kind === 'auth') return h.ctx.fail(e); res.innerHTML = '<div class="ce-bad" role="alert">לא ניתן היה לטעון את המחירים. לא נשמר ולא שונה דבר.</div><p><button type="button" class="btn sec" data-cpr="1">ניסיון חוזר</button></p>'; });
    }
    wrap.querySelector('#cp-q').addEventListener('input', function (ev) { S.q = ev.target.value; S.offset = 0; clearTimeout(timer); timer = setTimeout(load, 250); });
    var f = wrap.querySelector('#cp-f'); if (f) f.addEventListener('change', function (ev) { S.filter = ev.target.value; S.offset = 0; load(); });
    wrap.querySelector('form').addEventListener('submit', function (ev) { ev.preventDefault(); });
    wrap.addEventListener('click', function (ev) {
      var v = ev.target.closest('[data-cpv]'), p = ev.target.closest('[data-cpp]'), r = ev.target.closest('[data-cpr]');
      if (v) { if (v.dataset.cpv === 'tab') return h.ctx.go && h.ctx.go('pricing'); if (S.view !== v.dataset.cpv) { S.view = v.dataset.cpv; S.offset = 0; S.filter = ''; drawScreen(h, body); } }
      else if (p) { S.offset = Math.max(0, S.offset + Number(p.dataset.cpp) * PAGE); load(); } else if (r) load();
    });
    load();
  }

  C.extend({ afterDraw: afterDraw, screens: [{ key: 'prices', label: 'מחירים', after: 'engagements', draw: enter }] });
  root.KaspchemCatalogPrices = { _t: { layerProblems: layerProblems, layerFromForm: layerFromForm, bodyOf: bodyOf, sameLayer: sameLayer, layerRefine: layerRefine, priceRefine: priceRefine, USES: USES, LAYER_CODE: LAYER_CODE, KIND: KIND, FILTER_NAME: FILTER_NAME, toolsHtml: toolsHtml, byTable: byTable, rowsTable: rowsTable, whyNot: whyNot, rowState: rowState, toNumber: toNumber } };
})(typeof window !== 'undefined' ? window : this);
