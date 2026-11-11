(function () {
  'use strict';
  var E = window.KaspchemEngine;
  var view = document.getElementById('view'), tabsEl = document.getElementById('tabs');
  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var TEST_USER = LOCAL ? new URLSearchParams(location.search).get('test') : null; // local dev/test only; the server ignores it in production
  var TABS = [['dash', 'סקירה'], ['requests', 'בקשות טיפול'], ['impact', 'השפעה'], ['forms', 'שאלונים'], ['services', 'שירותים'], ['pricing', 'תמחור'], ['pros', 'בעלי מקצוע'], ['catalog', 'קטלוג ספקים'], ['settings', 'הגדרות'], ['audit', 'יומן שינויים']];
  var STATUS = { new: 'חדש', contacted: 'נוצר קשר', in_progress: 'בטיפול', awaiting_client: 'ממתין ללקוח', done: 'הושלם', closed: 'סגור', spam: 'ספאם' };
  var AGR = { none: 'אין הסכם', in_talks: 'במשא ומתן', signed: 'חתום', ended: 'הסתיים' };
  var topicNames = {};
  var ERR_IMPACT = {
    bad_families: 'יש להזין מספר שלם של משפחות (0 או יותר)', bad_amount: 'יש להזין סכום בשקלים (מספר, עד שתי ספרות אחרי הנקודה)',
    split_baseline: 'נתוני ההתחלה מפוצלים לכמה שורות; פנו אליי לאיחוד', request_not_done: 'אפשר לרשום סכום רק לבקשה בסטטוס הושלם',
    outcome_exists: 'כבר נרשם סכום לבקשה הזו', no_outcome: 'לא נרשם סכום לבקשה הזו', several_outcomes: 'הסכום מורכב מכמה רישומים ישנים; אפשר להסיר אותם, אך לא לערוך מכאן', use_impact_api: 'הגדרה זו משתנה רק מלשונית ״השפעה״', bad_value: 'ערך לא תקין'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m) { var t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2600); }
  function fdate(d) { return d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''; }
  function money(n) { return n == null || n === '' ? '' : Number(n).toLocaleString('he-IL') + ' ₪'; }

  /* ---------- auth ---------- */
  function api(method, path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (method !== 'GET') h['X-Kaspchem'] = '1'; // CSRF guard checked by the server
    if (TEST_USER) { h['x-test-user'] = TEST_USER; }
    return fetch('/api/kaspchem/admin' + path, { method: method, headers: h, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw apiError(r.status, j); return j; }); });
  }
  // What an error answer may hand on to the screens: the code, the server's own plain-language message, and a short list of fields that hold only codes or flags. Nothing else of the answer
  // (no raw body, nothing the server did not name here) goes on, so no SQL, no connection detail and no personal detail can reach a screen this way.
  var SAFE_CODE_LISTS = ['errors', 'missing', 'codes'], SAFE_FLAGS = ['documented_only'], SAFE_CODE = /^[a-z0-9_:>.-]{1,80}$/;
  function safeDetails(j) {
    var out = {};
    SAFE_CODE_LISTS.forEach(function (k) { var v = j[k]; if (Array.isArray(v) && v.length <= 30 && v.every(function (x) { return typeof x === 'string' && SAFE_CODE.test(x); })) out[k] = v.slice(); });
    SAFE_FLAGS.forEach(function (k) { if (typeof j[k] === 'boolean') out[k] = j[k]; });
    return out;
  }
  function apiError(status, j) {
    j = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    var e = new Error(typeof j.error === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(j.error) ? j.error : 'error');
    e.status = status; e.userMessage = typeof j.message === 'string' ? j.message.slice(0, 600) : undefined; e.details = safeDetails(j);
    return e;
  }
  function fail(e) {
    if (e.status === 401) return gate('פג תוקף ההתחברות. יש להתחבר מחדש.');
    if (e.status === 403) return gate('אין לחשבון הזה הרשאת מנהל לכספכם.');
    var known = Object.assign({}, ERR_IMPACT, {
      compensation_blocked: 'עמלת הפניה חסומה בתחום הזה עד אישור משפטי בכתב',
      price_linked_to_active_engagement: 'המחיר משויך להתקשרות פעילה בקטלוג הספקים. יש להשהות אותה בקטלוג לפני שינוי המחיר. לא נשמר דבר.',
      phone_exists: 'מספר הטלפון כבר רשום אצל פונה אחר',
      bad_phone: 'מספר טלפון לא תקין', bad_email: 'כתובת דוא״ל לא תקינה', bad_name: 'שם לא תקין', nothing_to_update: 'אין מה לעדכן'
    });
    if (e.message === 'managed_in_catalog') return managedInCatalog(e);
    if (e.message === 'deep_not_ready') return toast(e.userMessage || 'הבדיקה המעמיקה אינה מוכנה להפעלה');
    toast('שגיאה: ' + (known[e.message] || e.message || 'לא ידועה'));
  }
  // While the catalog is open the older screens of services and providers are read only: say so where the person is looking, and offer the way to the catalog. (Nothing was saved.)
  function managedInCatalog(e) {
    var old = document.getElementById('mic'); if (old) old.remove();
    var box = document.createElement('div'); box.id = 'mic'; box.className = 'warn'; box.style.margin = '1rem 0'; box.setAttribute('role', 'alert');
    box.innerHTML = '<strong>העריכה כאן הועברה לקטלוג הספקים.</strong> ' + esc(e.userMessage || 'הנתון הזה מנוהל עכשיו בקטלוג הספקים ואי אפשר לשנות אותו מכאן.') + ' לא נשמר דבר. <button type="button" class="btn sec mini" id="mic-go">מעבר לקטלוג ספקים</button>';
    view.insertBefore(box, view.firstChild);
    document.getElementById('mic-go').onclick = function () { go('catalog'); };
    box.scrollIntoView({ block: 'nearest' }); toast('הנתון מנוהל בקטלוג הספקים');
  }
  function authBox(title, inner) { tabsEl.hidden = true; document.getElementById('who').textContent = ''; view.innerHTML = '<section class="gate"><h1>' + title + '</h1>' + inner + '</section>'; }
  function gate(msg) {
    authBox('ניהול כספכם', '<p>הכניסה למנהלים מוזמנים בלבד.</p><form id="lf" novalidate><div class="field"><label for="le">דוא״ל</label><input id="le" type="email" autocomplete="username" dir="ltr" style="text-align:right" required></div><div class="field"><label for="lp">סיסמה</label><input id="lp" type="password" autocomplete="current-password" dir="ltr" style="text-align:right" required></div><p class="err" role="alert" id="lerr">' + esc(msg || '') + '</p><button class="btn" type="submit">כניסה</button><p><button type="button" class="btn link" id="forgot">שכחתי סיסמה</button></p></form>');
    document.getElementById('lf').onsubmit = function (e) {
      e.preventDefault();
      KaspAuth.login(le.value.trim(), lp.value).then(boot).catch(function () { document.getElementById('lerr').textContent = 'הכניסה נכשלה. בדקו דוא״ל וסיסמה.'; });
    };
    document.getElementById('forgot').onclick = function () {
      var em = le.value.trim(); if (!em) { document.getElementById('lerr').textContent = 'הזינו דוא״ל ולחצו שוב.'; return; }
      KaspAuth.requestPasswordRecovery(em).catch(function () {}).then(function () { document.getElementById('lerr').textContent = 'אם החשבון קיים, נשלח אליו קישור לאיפוס סיסמה.'; });
    };
  }
  function setPassword(title, onSubmit) {
    authBox(title, '<form id="pf2" novalidate><div class="field"><label for="np">סיסמה חדשה (לפחות 10 תווים)</label><input id="np" type="password" autocomplete="new-password" dir="ltr" style="text-align:right" minlength="10" required></div><p class="err" role="alert" id="perr"></p><button class="btn" type="submit">שמירה</button></form>');
    document.getElementById('pf2').onsubmit = function (e) { e.preventDefault(); if (np.value.length < 10) { perr.textContent = 'הסיסמה קצרה מדי.'; return; } onSubmit(np.value).then(function () { history.replaceState(null, '', location.pathname); boot(); }).catch(function (x) { perr.textContent = 'לא הצלחנו לשמור: ' + (x && x.message || ''); }); };
  }
  function boot() {
    api('GET', '/me').then(function (r) {
      document.getElementById('who').textContent = r.email;
      tabsEl.hidden = false;
      tabsEl.innerHTML = TABS.map(function (t) { return '<button data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '<button data-t="out">יציאה</button>';
      tabsEl.onclick = function (e) { var b = e.target.closest('button'); if (!b) return; if (b.dataset.t === 'out') { (TEST_USER ? Promise.resolve() : KaspAuth.logout()).then(function () { location.href = location.pathname; }); return; } go(b.dataset.t); };
      return api('GET', '/questionnaires').then(function (q) { q.topics.forEach(function (t) { topicNames[t.id] = t.name; }); go('dash'); });
    }).catch(fail);
  }
  if (TEST_USER) boot();
  else KaspAuth.handleAuthCallback().then(function (r) {
    if (r && r.type === 'invite' && r.token) return setPassword('קביעת סיסמה לחשבון', function (p) { return KaspAuth.acceptInvite(r.token, p); });
    if (r && r.type === 'recovery') return setPassword('איפוס סיסמה', function (p) { return KaspAuth.updateUser({ password: p }); });
    return KaspAuth.getUser().then(function (u) { if (u) boot(); else gate(''); });
  }).catch(function () { gate(''); });

  // Copy column headers onto cells so the phone layout can show "label: value" rows.
  function labelCells() {
    [].forEach.call(view.querySelectorAll('table.tbl'), function (t) {
      var heads = [].map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
      [].forEach.call(t.querySelectorAll('tbody tr'), function (tr) { [].forEach.call(tr.children, function (td, i) { if (!td.dataset.label && heads[i]) td.dataset.label = heads[i]; }); });
    });
  }
  new MutationObserver(labelCells).observe(view, { childList: true, subtree: true });

  function go(t) {
    [].forEach.call(tabsEl.querySelectorAll('button'), function (b) { b.setAttribute('aria-current', b.dataset.t === t ? 'page' : 'false'); });
    ({ dash: dash, requests: requests, impact: impact, forms: forms, services: services, pricing: pricing, pros: pros, catalog: catalog, settings: settings, audit: audit })[t]();
    view.focus({ preventScroll: true });
  }
  var H = function (title, extra) { return '<div class="view-h"><h1>' + title + '</h1>' + (extra || '') + '</div>'; };
  var topicOpts = function (sel, blank) { return (blank ? '<option value="">' + blank + '</option>' : '') + Object.keys(topicNames).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(topicNames[k]) + '</option>'; }).join(''); };

  /* ---------- dashboard ---------- */
  function dash() {
    api('GET', '/stats').then(function (s) {
      var by = {}; s.byStatus.forEach(function (r) { by[r.status] = r.n; });
      var total = s.byStatus.reduce(function (a, r) { return a + r.n; }, 0);
      view.innerHTML = H('סקירה') +
        '<div class="grid"><div class="stat"><b>' + (by['new'] || 0) + '</b><span>פניות חדשות</span></div><div class="stat"><b>' + (by.in_progress || 0) + '</b><span>בטיפול</span></div><div class="stat"><b>' + total + '</b><span>סה״כ בקשות</span></div></div>' +
        '<h2 style="margin:1.5rem 0 .6rem">כסף מאושר</h2><p class="warn">המספרים כוללים אך ורק הכנסות שהוזנו ואושרו ידנית. אין הערכות או נתוני דמה.</p>' +
        '<div class="grid"><div class="stat"><b>' + money(s.approved.revenue) + '</b><span>הכנסות מאושרות</span></div><div class="stat"><b>' + money(s.approved.cost) + '</b><span>עלויות</span></div><div class="stat"><b>' + money(s.approved.profit) + '</b><span>רווח (' + s.approved.count + ' רשומות)</span></div></div>' +
        '<h2 style="margin:1.5rem 0 .6rem">פניות לפי תחום</h2>' +
        (s.byTopic.length ? '<table class="tbl"><tbody>' + s.byTopic.map(function (r) { return '<tr><td>' + esc(topicNames[r.topic] || r.topic) + '</td><td>' + r.n + '</td></tr>'; }).join('') + '</tbody></table>' : '<p>עדיין אין פניות.</p>');
    }).catch(fail);
  }

  /* ---------- requests ---------- */
  var rq = { status: '', topic: '', q: '' };
  function requests() {
    view.innerHTML = H('בקשות טיפול') +
      '<div class="panel row"><div><label for="fs">סטטוס</label><select id="fs"><option value="">הכול</option>' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (rq.status === k ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="ft">תחום</label><select id="ft">' + topicOpts(rq.topic, 'הכול') + '</select></div><div><label for="fq">חיפוש שם/טלפון</label><input id="fq" type="search" value="' + esc(rq.q) + '"></div><div><button class="btn" id="fgo">סינון</button></div></div><div id="rlist" class="scroll"></div>';
    document.getElementById('fgo').onclick = function () { rq = { status: fs.value, topic: ft.value, q: fq.value }; load(); };
    function load() {
      var qs = Object.keys(rq).filter(function (k) { return rq[k]; }).map(function (k) { return k + '=' + encodeURIComponent(rq[k]); }).join('&');
      api('GET', '/requests' + (qs ? '?' + qs : '')).then(function (r) {
        document.getElementById('rlist').innerHTML = r.requests.length ?
          '<table class="tbl req"><thead><tr><th>#</th><th>שם</th><th>טלפון</th><th>תחום</th><th>תוצאה</th><th>סטטוס</th><th>אחראי</th><th>תאריך</th></tr></thead><tbody>' + r.requests.map(function (x) {
            return '<tr class="click" tabindex="0" data-id="' + x.id + '"><td>' + x.id + '</td><td>' + esc(x.name) + (x.applicant_requests > 1 ? ' <span class="pill">' + x.applicant_requests + ' בקשות</span>' : '') + '</td><td dir="ltr">' + esc(x.phone) + '</td><td>' + esc(topicNames[x.topic] || x.topic) + '</td><td>' + ({ found: 'זוהה נושא', insufficient: 'חסר מידע', none: 'לא זוהה' }[x.outcome]) + '</td><td><span class="pill ' + x.status + '">' + STATUS[x.status] + '</span></td><td>' + esc(x.assignee || '') + '</td><td>' + fdate(x.created_at) + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p class="panel">אין בקשות שמתאימות לסינון.</p>';
        [].forEach.call(document.querySelectorAll('tr.click'), function (tr) { tr.onclick = function () { detail(tr.dataset.id, load); }; tr.onkeydown = function (e) { if (e.key === 'Enter') detail(tr.dataset.id, load); }; });
      }).catch(fail);
    }
    load();
  }

  function detail(id, done) {
    return Promise.all([api('GET', '/requests/' + id), api('GET', '/services'), api('GET', '/professionals')]).then(function (a) {
      var d = a[0], r = d.request;
      var dr = document.createElement('div'); dr.className = 'drawer'; dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true'); dr.setAttribute('aria-label', 'פרטי בקשה');
      dr.innerHTML = '<div><div class="view-h"><h1>בקשה ' + r.id + '</h1><button class="btn sec" id="x">סגירה</button></div>' +
        '<p><strong>' + esc(r.name) + '</strong> · <span dir="ltr">' + esc(r.phone) + '</span>' + (r.email ? ' · <span dir="ltr">' + esc(r.email) + '</span>' : '') + '<br>' + esc(topicNames[r.topic] || r.topic) + ' · גרסת שאלון ' + esc(r.questionnaire_ver) + ' · ' + fdate(r.created_at) + '</p>' +
        '<div class="row"><div><label for="ds">סטטוס</label><select id="ds">' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (r.status === k ? ' selected' : '') + '>' + STATUS[k] + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="da">אחראי</label><input id="da" type="text" value="' + esc(r.assignee || '') + '"></div>' +
        '<div><label for="dv">שירות</label><select id="dv"><option value="">—</option>' + a[1].services.map(function (s) { return '<option value="' + s.id + '"' + (String(r.service_id) === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div>' +
        '<div><label for="dp">בעל מקצוע</label><select id="dp"><option value="">—</option>' + a[2].professionals.map(function (s) { return '<option value="' + s.id + '"' + (String(r.professional_id) === String(s.id) ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select></div></div>' +
        '<p><button class="btn" id="dsave" style="margin-top:.8rem">שמירה</button></p>' +
        '<h2 style="margin:1.2rem 0 .5rem">ממצאים והפניה מוצעת</h2>' + (r.findingDetails && r.findingDetails.length ? '<ul>' + r.findingDetails.map(function (d) { return '<li>' + (d.tierLabel ? '<span class="pill">' + esc(d.tierLabel) + '</span> ' : '') + (d.subjectLabel ? '<span class="pill">עבור: ' + esc(d.subjectLabel) + '</span> ' : '') + '<b>' + esc(d.title) + '</b>' + (d.unverified ? ' <span class="pill">כלל לא מאומת</span>' : '') + (d.refer ? '<br><small>הפניה: ' + esc(d.refer) + '</small>' : '') + (d.serviceTag ? ' <span class="pill">' + esc(d.serviceTag) + '</span>' : '') + '</li>'; }).join('') + '</ul>' : (r.findingTitles.length ? '<ul>' + r.findingTitles.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '<p>אין.</p>')) +
        '<h2 style="margin:1.2rem 0 .5rem">תשובות</h2>' + r.readable.map(function (x) { return '<div class="qa"><b>' + esc(x.question) + '</b>' + esc(x.answer) + '</div>'; }).join('') +
        '<h2 style="margin:1.2rem 0 .5rem">הסכמות</h2>' + d.consents.map(function (c) { return '<div class="qa">' + (c.kind === 'contact' ? 'חזרה בנושא הבדיקה' : 'תוכן שיווקי') + ': <b style="display:inline">' + (c.granted ? 'אושר' : 'לא אושר') + '</b> · ' + fdate(c.created_at) + ' · ' + esc(c.text_version) + '</div>'; }).join('') +
        '<h2 style="margin:1.2rem 0 .5rem">הערות</h2>' + d.notes.map(function (n) { return '<div class="note-i"><small>' + esc(n.author) + ' · ' + fdate(n.created_at) + '</small><br>' + esc(n.body) + '</div>'; }).join('') +
        '<textarea id="nb" aria-label="הערה חדשה"></textarea><p><button class="btn sec" id="nadd" style="margin-top:.5rem">הוספת הערה</button></p>' +
        '<h2 style="margin:1.2rem 0 .5rem">הכנסות</h2>' + d.revenues.map(function (v) { return '<div class="qa">' + money(v.amount) + ' (עלות ' + money(v.cost) + ') · ' + ({ pending: 'ממתין לאישור', approved: 'מאושר', rejected: 'נדחה' }[v.status]) + (v.status === 'pending' ? ' <button class="btn mini sec" data-rv="' + v.id + '" data-s="approved">אישור</button> <button class="btn mini sec" data-rv="' + v.id + '" data-s="rejected">דחייה</button>' : '') + '</div>'; }).join('') +
        '<div class="row"><div><label for="ra">סכום (₪)</label><input id="ra" type="number" min="0" step="0.01"></div><div><label for="rc">עלות (₪)</label><input id="rc" type="number" min="0" step="0.01"></div><div><button class="btn sec" id="radd">הוספת הכנסה</button></div></div>' +
        '<h2 style="margin:1.2rem 0 .5rem">סכום שנחסך או הושג</h2>' + outcomeBlock(d.outcome, r.status) +
        '<h2 style="margin:1.2rem 0 .5rem">עיון ותיקון פרטים</h2><p><button class="btn sec" id="aexp">ייצוא נתוני הפונה (JSON)</button> <button class="btn sec" id="aedit" aria-expanded="false" aria-controls="afix">תיקון פרטים</button></p>' +
        '<form id="afix" hidden class="panel row" novalidate><div><label for="an">שם</label><input id="an" type="text" value="' + esc(r.name) + '"></div><div><label for="ap">טלפון</label><input id="ap" type="tel" dir="ltr" value="' + esc(r.phone) + '"></div><div><label for="ae">דוא״ל</label><input id="ae" type="email" dir="ltr" value="' + esc(r.email || '') + '"></div><div><button class="btn" id="asave">שמירת התיקון</button></div></form>' +
        '</div>';
      document.body.appendChild(dr);
      var close = function () { dr.remove(); if (done) done(); };
      dr.querySelector('#x').focus(); dr.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
      dr.querySelector('#x').onclick = close;
      var act = function (p) { return p.then(function () { toast('נשמר'); close(); detail(id, done); }).catch(fail); };
      dr.querySelector('#dsave').onclick = function () {
        var toDone = dr.querySelector('#ds').value === 'done' && r.status !== 'done';
        var p = api('PATCH', '/requests/' + id, { status: dr.querySelector('#ds').value, assignee: dr.querySelector('#da').value, service_id: dr.querySelector('#dv').value, professional_id: dr.querySelector('#dp').value });
        if (!toDone) { act(p); return; }
        var dialogNeeded = d.outcome.any === 0; // a request that already has recorded amounts never gets a dialog: nothing recorded is overwritten or hidden
        // Marked completed: the status is already saved. The dialog records the outcome (or "nothing to count"); cancelling it leaves the status as it is.
        p.then(function () {
          toast('נשמר'); close();
          return detail(id, done).then(function () { if (dialogNeeded) amountDialog({ requestId: id, current: null, fromDone: true, onSaved: function () { [].forEach.call(document.querySelectorAll('.drawer'), function (x) { x.remove(); }); detail(id, done); } }); });
        }).catch(fail);
      };
      dr.querySelector('#aexp').onclick = function () {
        api('GET', '/applicants/' + r.applicant_id + '/export').then(function (j) {
          var url = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' }));
          var a = document.createElement('a'); a.href = url; a.download = 'applicant-' + r.applicant_id + '.json'; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 2000); toast('הקובץ ירד. הייצוא נרשם ביומן');
        }).catch(fail);
      };
      dr.querySelector('#aedit').onclick = function () { var f = dr.querySelector('#afix'); f.hidden = !f.hidden; this.setAttribute('aria-expanded', String(!f.hidden)); if (!f.hidden) dr.querySelector('#an').focus(); };
      dr.querySelector('#afix').onsubmit = function (e) { e.preventDefault(); act(api('PATCH', '/applicants/' + r.applicant_id, { name: dr.querySelector('#an').value, phone: dr.querySelector('#ap').value, email: dr.querySelector('#ae').value })); };
      dr.querySelector('#nadd').onclick = function () { var v = dr.querySelector('#nb').value.trim(); if (v) act(api('POST', '/requests/' + id + '/notes', { body: v })); };
      dr.querySelector('#radd').onclick = function () { var a = dr.querySelector('#ra').value; if (a !== '') act(api('POST', '/requests/' + id + '/revenues', { amount: a, cost: dr.querySelector('#rc').value || 0 })); };
      var refresh = function () { dr.remove(); detail(id, done); };
      var oedit = dr.querySelector('#oedit'); if (oedit) oedit.onclick = function () { amountDialog({ requestId: id, current: d.outcome.count === 1 ? d.outcome.amount : null, onSaved: refresh }); };
      var orem = dr.querySelector('#orem'); if (orem) orem.onclick = function () { if (confirm(d.outcome.count > 1 ? 'להסיר את כל הסכומים של הטיפול?' : 'להסיר את הסכום מהמונה?')) api('POST', '/requests/' + id + '/outcome/remove', {}).then(function () { toast('הסכום הוסר'); refresh(); }).catch(fail); };
      [].forEach.call(dr.querySelectorAll('[data-rv]'), function (b) { b.onclick = function () { act(api('POST', '/revenues/' + b.dataset.rv + '/decide', { status: b.dataset.s })); }; });
    }).catch(fail);
  }

  /* ---------- generic simple CRUD tables ---------- */
  function services() {
    api('GET', '/services').then(function (r) {
      view.innerHTML = H('קטלוג שירותים') +
        '<form class="panel row" id="sf"><div><label for="sn">שם שירות</label><input id="sn" type="text" required></div><div><label for="st">תחום</label><select id="st">' + topicOpts('', 'כללי') + '</select></div><div><label for="sd">תיאור</label><input id="sd" type="text"></div><div><button class="btn">הוספה</button></div></form>' +
        '<div class="scroll"><table class="tbl"><thead><tr><th>שם</th><th>תחום</th><th>תיאור</th><th>פעיל</th><th></th></tr></thead><tbody>' + r.services.map(function (s) {
          return '<tr><td>' + esc(s.name) + '</td><td>' + esc(topicNames[s.topic] || '') + '</td><td>' + esc(s.description || '') + '</td><td>' + (s.active ? 'כן' : 'לא') + '</td><td><button class="btn mini sec" data-t="' + s.id + '" data-a="' + (s.active ? 0 : 1) + '">' + (s.active ? 'השבתה' : 'הפעלה') + '</button></td></tr>';
        }).join('') + '</tbody></table></div>';
      document.getElementById('sf').onsubmit = function (e) { e.preventDefault(); api('POST', '/services', { name: sn.value, topic: st.value, description: sd.value }).then(function () { toast('נוסף'); services(); }).catch(fail); };
      [].forEach.call(view.querySelectorAll('[data-t]'), function (b) { b.onclick = function () { var s = r.services.filter(function (x) { return String(x.id) === b.dataset.t; })[0]; api('PATCH', '/services/' + s.id, { name: s.name, topic: s.topic, description: s.description, active: b.dataset.a === '1' }).then(services).catch(fail); }; });
    }).catch(fail);
  }

  function pros() {
    api('GET', '/professionals').then(function (r) {
      view.innerHTML = H('בעלי מקצוע') + '<p class="warn">הניתוב לבעלי מקצוע ידני בשלב זה. הפניה אוטומטית תופעל רק לאחר הסדרת הסכמים והרשאות.</p>' +
        '<form class="panel row" id="pf"><div><label for="pn">שם</label><input id="pn" type="text" required></div><div><label for="pc">יצירת קשר</label><input id="pc" type="text"></div><div><label for="pt">תחומי התמחות</label><select id="pt" multiple size="4">' + topicOpts('') + '</select></div><div><label for="pa">סטטוס הסכם</label><select id="pa">' + Object.keys(AGR).map(function (k) { return '<option value="' + k + '">' + AGR[k] + '</option>'; }).join('') + '</select></div><div><button class="btn">הוספה</button></div></form>' +
        '<div class="scroll"><table class="tbl"><thead><tr><th>שם</th><th>קשר</th><th>תחומים</th><th>הסכם</th></tr></thead><tbody>' + r.professionals.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.contact || '') + '</td><td>' + (p.topics || []).map(function (t) { return esc(topicNames[t] || t); }).join(', ') + '</td><td>' + AGR[p.agreement_status] + '</td></tr>'; }).join('') + '</tbody></table></div>';
      document.getElementById('pf').onsubmit = function (e) { e.preventDefault(); api('POST', '/professionals', { name: pn.value, contact: pc.value, topics: [].map.call(pt.selectedOptions, function (o) { return o.value; }), agreement_status: pa.value }).then(function () { toast('נוסף'); pros(); }).catch(fail); };
    }).catch(fail);
  }

  // Catalog screens (stage 5a, read only): everything they need from this file is handed over here; they only ever call api('GET', ...).
  function catalog() {
    if (!window.KaspchemCatalog) { view.innerHTML = H('קטלוג ספקים') + '<p class="panel">מסכי הקטלוג לא נטענו.</p>'; return; }
    window.KaspchemCatalog.open({ api: api, view: view, fail: fail, go: go,
      topicName: function (t) { return topicNames[t] || t || ''; },
      topics: function () { return Object.keys(topicNames).map(function (k) { return [k, topicNames[k]]; }); } });
  }

  function pricing() {
    Promise.all([api('GET', '/pricing'), api('GET', '/services')]).then(function (a) {
      var rows = a[0].pricing, sv = a[1].services;
      view.innerHTML = H('תמחור') + '<p class="warn">כל המחירים מוזנים ידנית על ידך. אין ערכי ברירת מחדל. מחיר מוצג לציבור רק אם אושר וסומן כציבורי, ועריכתו מבטלת את האישור.</p><p class="warn">עמלה על הפניה חסומה כברירת מחדל בכל התחומים. אפשר להזין עמלה רק לשירות שהתחום שלו הופעל בהגדרות (<code>private.compensation_topics</code>), ורק אחרי אישור משפטי בכתב לאותו תחום.</p>' +
        '<form class="panel row" id="xf"><div><label for="xl">תיאור</label><input id="xl" type="text" required></div><div><label for="xs">שירות</label><select id="xs"><option value="">—</option>' + sv.map(function (s) { return '<option value="' + s.id + '">' + esc(s.name) + '</option>'; }).join('') + '</select></div><div><label for="xp">מחיר ללקוח ₪</label><input id="xp" type="number" min="0" step="0.01"></div><div><label for="xc">עלות ₪</label><input id="xc" type="number" min="0" step="0.01"></div><div><label for="xm">עמלה ₪</label><input id="xm" type="number" min="0" step="0.01"></div><div><button class="btn">הוספה</button></div></form>' +
        '<div class="scroll"><table class="tbl"><thead><tr><th>תיאור</th><th>מחיר</th><th>עלות</th><th>עמלה</th><th>סטטוס</th><th></th></tr></thead><tbody>' + rows.map(function (p) {
          return '<tr><td>' + esc(p.label) + '</td><td>' + money(p.price) + '</td><td>' + money(p.cost) + '</td><td>' + money(p.commission) + '</td><td>' + (p.public ? 'ציבורי' : p.approved ? 'מאושר, פנימי' : 'ממתין לאישור') + '</td><td>' +
            (!p.approved ? '<button class="btn mini sec" data-ap="' + p.id + '" data-pub="0">אישור פנימי</button> <button class="btn mini" data-ap="' + p.id + '" data-pub="1">אישור ופרסום</button>' : (p.public ? '<button class="btn mini sec" data-un="' + p.id + '">הסרה מהציבור</button>' : '<button class="btn mini" data-ap="' + p.id + '" data-pub="1">פרסום</button>')) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      document.getElementById('xf').onsubmit = function (e) { e.preventDefault(); api('POST', '/pricing', { label: xl.value, service_id: xs.value, price: xp.value, cost: xc.value, commission: xm.value }).then(function () { toast('נוסף. ממתין לאישור'); pricing(); }).catch(fail); };
      [].forEach.call(view.querySelectorAll('[data-ap]'), function (b) { b.onclick = function () { if (b.dataset.pub !== '1' || confirm('המחיר יוצג לציבור באתר. להמשיך?')) api('POST', '/pricing/' + b.dataset.ap + '/approve', { public: b.dataset.pub === '1' }).then(pricing).catch(fail); }; });
      [].forEach.call(view.querySelectorAll('[data-un]'), function (b) { b.onclick = function () { api('POST', '/pricing/' + b.dataset.un + '/unpublish', {}).then(pricing).catch(fail); }; });
    }).catch(fail);
  }

  function settings() {
    // The deep check's readiness panel: a plain checklist. While anything is unmet the switch cannot be turned ON (the server refuses too); turning it OFF is always possible.
    function deepPanel(rd, cur) {
      var on = cur['public.deep_enabled'] === true, items = rd.items.map(function (i) {
        return '<li class="' + (i.ok ? 'ok' : 'no') + '"><b aria-hidden="true">' + (i.ok ? '✓' : '✗') + '</b> ' + esc(i.label) + ' <span class="pill">' + (i.ok ? 'מתקיים' : 'לא מתקיים') + '</span>' +
          (!i.ok && i.detail && i.detail.length ? '<details><summary>' + i.detail.length + ' כללים</summary><ul>' + i.detail.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></details>' : '') + '</li>';
      }).join('');
      var blocked = !rd.ready && !on;
      return '<div class="panel" id="dp-panel"><h2 style="margin-bottom:.6rem">בדיקה מעמיקה</h2>' +
        (rd.ready ? '' : '<p class="warn" id="dp-notready"><strong>הבדיקה המעמיקה אינה מוכנה להפעלה.</strong> עד שכל התנאים מתקיימים אי אפשר להפעיל אותה לציבור.</p>') +
        '<ul class="dp-check" style="list-style:none;padding:0;margin:.4rem 0 .8rem;display:grid;gap:.35rem">' + items + '</ul>' +
        '<p>מצב המתג כעת: <strong id="dp-state">' + (on ? 'דלוק (מוצגת לציבור)' : 'כבוי') + '</strong></p>' +
        '<label style="display:flex;gap:.6rem;font-weight:700"><input type="checkbox" id="dpe"' + (on ? ' checked' : '') + (blocked ? ' disabled' : '') + '> להציג את הבדיקה המעמיקה לציבור</label></div>';
    }
    Promise.all([api('GET', '/settings'), api('GET', '/deep/readiness')]).then(function (res) {
      var r = res[0], rd = res[1];
      var cur = {}; r.settings.forEach(function (s) { cur[s.key] = s.value; });
      view.innerHTML = H('הגדרות') +
        '<div class="panel"><h2 style="margin-bottom:.6rem">מיתוג ומבנה</h2><p><strong>כספכם</strong> מוצג לציבור כארגון חסד, בשיתוף <strong>מצפן כלכלי</strong> כגוף המקצועי. הבדיקה הראשונית חינמית, ושירותי המשך עשויים להיות בתשלום לפי מחיר ותנאים שמוצגים מראש. לא נקבע באתר אם כספכם עמותה רשומה ומי הגוף שמקבל את התשלום, ולכן אין לציין זאת עד שיוכרע.</p></div>' +
        '<div class="panel"><h2 style="margin-bottom:.6rem">פתיחה לציבור</h2><p class="warn">כל עוד זה כבוי, האתר מציג שאלונים ותוצאות אך אינו מקבל פניות. הפעילו רק לאחר שעורך דין אישר את מדיניות הפרטיות, תנאי השימוש ונוסח ההסכמות, והחלפתם את הטיוטות בדפים.</p><label style="display:flex;gap:.6rem;font-weight:700"><input type="checkbox" id="la"' + (cur['public.legal_approved'] === true ? ' checked' : '') + '> הנוסחים המשפטיים אושרו, אפשר לקבל פניות</label></div>' +
        deepPanel(rd, cur) +
        '<div class="panel"><h2 style="margin-bottom:.6rem">פרטי הגוף המשפטי (רשות)</h2><p>טקסט חופשי שיוצג בעמוד הציבורי ובתחתיתו, למשל שם הגוף ומספר רישום. מלאו רק לאחר שהמבנה המשפטי אושר. ריק = לא מוצג דבר.</p><div class="row"><div><label for="od">פרטים להצגה</label><textarea id="od" maxlength="300">' + esc(cur['public.org_details'] || '') + '</textarea></div><div><button class="btn" id="ods">שמירה</button></div></div></div>';
      document.getElementById('la').onchange = function (e) { if (e.target.checked && !confirm('לאשר שהנוסחים המשפטיים אושרו ולפתוח לקבלת פניות?')) { e.target.checked = false; return; } api('PUT', '/settings', { key: 'public.legal_approved', value: e.target.checked }).then(function () { toast(e.target.checked ? 'האתר מקבל פניות' : 'קבלת פניות כבויה'); }).catch(fail); };
      document.getElementById('dpe').onchange = function (e) { if (e.target.checked && !confirm('להציג את הבדיקה המעמיקה לציבור ולקבל ממנה פניות?')) { e.target.checked = false; return; } api('PUT', '/settings', { key: 'public.deep_enabled', value: e.target.checked }).then(function () { var st = document.getElementById('dp-state'); if (st) st.textContent = e.target.checked ? 'דלוק (מוצגת לציבור)' : 'כבוי'; toast(e.target.checked ? 'הבדיקה המעמיקה מוצגת לציבור' : 'הבדיקה המעמיקה כבויה'); }).catch(function (er) { e.target.checked = !e.target.checked; fail(er); }); };
      document.getElementById('ods').onclick = function () { api('PUT', '/settings', { key: 'public.org_details', value: od.value.trim() }).then(function () { toast('נשמר'); }).catch(fail); };
    }).catch(fail);
  }

  function audit() {
    api('GET', '/audit').then(function (r) {
      view.innerHTML = H('יומן שינויים') + '<div class="scroll"><table class="tbl"><thead><tr><th>זמן</th><th>מי</th><th>פעולה</th><th>עצם</th></tr></thead><tbody>' + r.audit.map(function (a) { return '<tr><td>' + fdate(a.created_at) + '</td><td>' + esc(a.actor) + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.entity + ' ' + a.entity_id) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }).catch(fail);
  }

  /* ---------- impact: starting numbers, the on/off switch, a preview; and the amount of one completed treatment ---------- */
  function imoney(n) { var v = Number(n); return v.toLocaleString('he-IL', { minimumFractionDigits: Math.round(v * 100) % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 }) + ' ₪'; } // exact: agorot shown in full
  function errMsg(e) { return ERR_IMPACT[e.message] || e.message || 'שגיאה'; }
  // Plain parsing of what a person types: "12,345.00", "₪ 12.5", "1 000". Returns the canonical string or null.
  function typedAmount(s, allowZero) { var t = String(s).replace(/[\s,₪]/g, ''); if (!/^\d{1,9}(\.\d{1,2})?$/.test(t) || (!allowZero && !(Number(t) > 0))) return null; return t; }
  function typedFamilies(s) { var t = String(s).replace(/[\s,]/g, ''); return /^\d{1,6}$/.test(t) ? t : null; }
  var fmt2 = function (n) { return Number(n).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };

  // The small dialog: ONE money field. Used when a request is marked done, and to record or correct the amount from the request.
  // o: { requestId, current (number or null), fromDone, onSaved }. Closing it never changes anything (the status change is already saved).
  function amountDialog(o) {
    var md = document.createElement('div'); md.className = 'ia-modal'; md.setAttribute('role', 'dialog'); md.setAttribute('aria-modal', 'true'); md.setAttribute('aria-labelledby', 'ia-t');
    md.innerHTML = '<form novalidate><h2 id="ia-t">' + (o.fromDone ? 'הבקשה סומנה כהושלמה' : 'סכום שנחסך או הושג') + '</h2>' +
      '<p class="ia-small">הסכום יתווסף למונה באתר. אפשר גם לדלג, ולרשום אותו אחר כך מתוך הבקשה.</p>' +
      '<div class="field"><label for="io-amt">סכום שנחסך או הושג (₪)</label><div class="ia-money"><input id="io-amt" type="text" inputmode="decimal" autocomplete="off" value="' + esc(o.current != null ? fmt2(o.current) : '') + '"><span class="ia-cur" aria-hidden="true">₪</span></div></div>' +
      '<p class="err" role="alert" id="io-err"></p>' +
      '<div class="ia-actions"><button class="btn" type="submit">שמירה</button><button class="btn sec" type="button" id="io-skip">' + (o.fromDone ? 'ללא סכום' : 'ביטול') + '</button></div></form>';
    document.body.appendChild(md);
    var g = function (id) { return md.querySelector('#io-' + id); };
    var opener = document.activeElement;
    var close = function () { md.remove(); if (opener && document.contains(opener)) opener.focus(); }; // focus goes back to where the admin was
    md.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    g('skip').onclick = close;
    g('amt').focus();
    md.querySelector('form').onsubmit = function (e) {
      e.preventDefault();
      var v = typedAmount(g('amt').value, false);
      if (!v) { g('err').textContent = ERR_IMPACT.bad_amount; return; }          // the typed value stays
      api('PUT', '/requests/' + o.requestId + '/outcome', { amount: v }).then(function () { toast('הסכום נשמר'); close(); if (o.onSaved) o.onSaved(); })
        .catch(function (x) { if (x.status === 401 || x.status === 403) { close(); fail(x); } else g('err').textContent = errMsg(x); });
    };
  }
  // In the request drawer: the recorded amount, with edit and remove, nothing more.
  function outcomeBlock(o, status) {
    if (o.count > 1) return '<div class="qa"><b style="display:inline">' + imoney(o.amount) + '</b></div><p class="ia-small">הסכום מורכב מכמה רישומים ישנים; אפשר להסיר אותם, אך לא לערוך מכאן</p><p><button class="btn mini sec" id="orem">הסרה</button></p>';
    if (o.count === 1) return '<div class="qa"><b style="display:inline">' + imoney(o.amount) + '</b></div><p><button class="btn mini sec" id="oedit">עריכה</button> <button class="btn mini sec" id="orem">הסרה</button></p>';
    return status === 'done' ? '<p>לא נרשם סכום.</p><p><button class="btn mini sec" id="oedit">רישום סכום</button></p>' : '<p class="ia-small">אפשר לרשום סכום כשהבקשה בסטטוס ״הושלם״.</p>';
  }

  function impact() {
    api('GET', '/impact').then(function (r) {
      var s = r.start;
      view.innerHTML = H('השפעה') +
        '<form class="panel ia-card" id="ia-form" novalidate>' +
        '<div class="field"><label for="ia-fam">כמה משפחות כבר עזרנו להן?</label><input id="ia-fam" type="text" inputmode="numeric" autocomplete="off" value="' + esc(s.families) + '"' + (s.split ? ' readonly' : '') + '></div>' +
        '<div class="field"><label for="ia-amt">כמה כסף חסכנו או השגנו? (₪)</label><div class="ia-money"><input id="ia-amt" type="text" inputmode="decimal" autocomplete="off" value="' + esc(fmt2(s.amount)) + '"' + (s.split ? ' readonly' : '') + '><span class="ia-cur" aria-hidden="true">₪</span></div></div>' +
        (s.split ? '<p class="warn" role="note">נתוני ההתחלה מפוצלים לכמה שורות; פנו אליי לאיחוד</p>' : '') +
        '<p class="err" id="ia-err" role="alert"></p>' +
        (s.split ? '' : '<button class="btn ia-save" type="submit">שמירה</button>') + '</form>' +
        '<div class="panel ia-card"><div class="ia-swrow"><span class="ia-swlabel" id="ia-swl">להציג באתר?</span><button type="button" class="ia-sw" id="ia-sw" role="switch" aria-labelledby="ia-swl"><span class="ia-knob" aria-hidden="true"></span><span class="ia-swt" id="ia-swt"></span></button></div></div>' +
        '<div class="panel ia-card"><h2 class="ia-h">כך זה נראה באתר</h2><p class="ia-badge" id="ia-badge"></p><div id="ia-prev" class="ia-prevbox"></div><p class="ia-small" id="ia-quiet"></p></div>';
      paint(r);
      var err = document.getElementById('ia-err'), fam = document.getElementById('ia-fam'), amt = document.getElementById('ia-amt');
      document.getElementById('ia-form').onsubmit = function (e) {
        e.preventDefault();
        var f = typedFamilies(fam.value), a = typedAmount(amt.value, true);
        if (!f) { err.textContent = ERR_IMPACT.bad_families; fam.focus(); return; }   // typed values are never cleared by an error
        if (!a) { err.textContent = ERR_IMPACT.bad_amount; amt.focus(); return; }
        err.textContent = '';
        api('PUT', '/impact', { families: f, amount: a }).then(function () {
          toast('נשמר. המספרים עודכנו' + (document.getElementById('ia-sw').getAttribute('aria-checked') === 'true' ? ' באתר' : ''));
          return api('GET', '/impact').then(function (n) { fam.value = n.start.families; amt.value = fmt2(n.start.amount); paint(n); });
        }).catch(function (x) { if (x.status === 401 || x.status === 403) fail(x); else { err.textContent = errMsg(x); toast(errMsg(x)); } });
      };
      document.getElementById('ia-sw').onclick = function () {
        var on = this.getAttribute('aria-checked') !== 'true';
        api('POST', '/impact/counter', { enabled: on }).then(function () {
          toast(on ? 'המונה דלוק באתר' : 'המונה כבוי באתר');
          return api('GET', '/impact').then(paint);
        }).catch(fail);
      };
    }).catch(fail);
  }
  // Redraws the switch, the preview and the quiet line from a GET /impact answer (the typed fields are not touched).
  function paint(r) {
    var on = r.enabled === true, sw = document.getElementById('ia-sw');
    sw.setAttribute('aria-checked', String(on)); document.getElementById('ia-swt').textContent = on ? 'כן' : 'לא';
    var badge = document.getElementById('ia-badge');
    badge.textContent = r.shown ? 'מוצג כרגע באתר' : 'כרגע לא מוצג לציבור'; badge.className = 'ia-badge' + (r.shown ? ' on' : '');
    var t = r.total, hhmm = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).format(new Date(r.as_of));
    document.getElementById('ia-prev').innerHTML = (t.families > 0 || t.amount > 0) ?
      '<div class="imp-grid">' + (t.families > 0 ? '<p class="imp-fam"><span class="imp-num">' + esc(Number(t.families).toLocaleString('he-IL')) + '</span> <span class="imp-cap">' + (t.families === 1 ? 'משפחה נעזרה' : 'משפחות נעזרו') + '</span></p>' : '') +
        (t.amount > 0 ? '<p class="imp-fam imp-money"><span class="imp-num">' + esc(imoney(t.amount)) + '</span> <span class="imp-cap">נחסכו או הושגו עבור משפחות</span></p>' : '') + '</div><p class="imp-upd">נכון ל־' + hhmm + '</p>'
      : '<p class="imp-upd">אין עדיין מספרים להצגה.</p>';
    document.getElementById('ia-quiet').innerHTML = 'מתוך הסכום: נוספו אוטומטית מטיפולים שהושלמו &mdash; ' + esc(Number(r.auto.families).toLocaleString('he-IL')) + ' משפחות, ' + esc(imoney(r.auto.amount)) + '.<br>' +
      'טיפולים שהושלמו לפני נקודת ההתחלה כלולים כבר במספרים שהזנתם. מכאן ואילך טיפול שמסומן ״הושלם״ ויש בו סכום יתווסף אוטומטית.<br>' +
      'אם משפחה שכבר נכללת במספר ההתחלה חוזרת עם טיפול חדש, היא תיספר שוב אלא אם יש לה רשומה קודמת במערכת.';
  }

  /* ---------- questionnaire editor ---------- */
  function forms() {
    api('GET', '/questionnaires').then(function (r) {
      view.innerHTML = H('עריכת שאלונים') + '<p class="warn">עריכה נשמרת כטיוטה. רק ״פרסום״ מעדכן את האתר הציבורי, ואפשר לחזור לגרסה קודמת.</p><div class="scroll"><table class="tbl"><thead><tr><th>תחום</th><th>גרסה חיה</th><th>טיוטה</th><th></th></tr></thead><tbody>' +
        r.topics.map(function (t) { var d = t.versions.filter(function (v) { return v.status === 'draft'; })[0]; return '<tr><td>' + esc(t.name) + '</td><td>' + esc(t.live) + '</td><td>' + (d ? 'יש טיוטה (v' + d.version + ')' : '—') + '</td><td>' + (t.kind === 'deep' ? '<small>נערך בקובץ התוכן</small>' : '<button class="btn mini" data-e="' + t.id + '">עריכה</button>') + '</td></tr>'; }).join('') + '</tbody></table></div>';
      [].forEach.call(view.querySelectorAll('[data-e]'), function (b) { b.onclick = function () { edit(b.dataset.e); }; });
    }).catch(fail);
  }

  function edit(topic) {
    Promise.all([api('GET', '/questionnaires/' + topic), api('GET', '/questionnaires')]).then(function (a) {
      var cfg = JSON.parse(JSON.stringify(a[0].draft ? a[0].draft.content : a[0].live));
      var versions = a[1].topics.filter(function (t) { return t.id === topic; })[0].versions;
      var draftMode = !!a[0].draft;
      draw();
      function qOptions(q) { return q.options.map(function (o, oi) { return '<div class="optrow"><input type="text" aria-label="נוסח תשובה" data-f="olabel" data-q="' + q.__i + '" data-o="' + oi + '" value="' + esc(o.label) + '"><label><input type="checkbox" data-f="ounk" data-q="' + q.__i + '" data-o="' + oi + '"' + (o.unknown ? ' checked' : '') + '> ״לא יודע״</label><button class="btn mini sec" data-a="odel" data-q="' + q.__i + '" data-o="' + oi + '" aria-label="מחיקת תשובה">✕</button></div>'; }).join(''); }
      function condEditor(cond, hk, ownIdx) {
        // Flat editor: mode (all/any) + list of {q,in}. Anything more nested stays editable as raw JSON.
        var flat = !cond || cond.q || ((cond.all || cond.any) && (cond.all || cond.any).every(function (c) { return c.q; }));
        if (!flat) return '<label>תנאי (מתקדם, JSON)</label><textarea data-f="cjson" data-h="' + hk + '">' + esc(JSON.stringify(cond, null, 1)) + '</textarea>';
        var fl = flatten(cond);
        return '<div><label>תנאי</label><select data-f="cmode" data-h="' + hk + '" aria-label="סוג תנאי"><option value="all"' + (fl.mode === 'all' ? ' selected' : '') + '>כל התנאים מתקיימים</option><option value="any"' + (fl.mode === 'any' ? ' selected' : '') + '>לפחות אחד מתקיים</option></select>' +
          fl.list.map(function (c, ci) {
            var q = cfg.questions.filter(function (x) { return x.id === c.q; })[0];
            return '<div class="qa"><select data-f="cq" data-h="' + hk + '" data-c="' + ci + '" aria-label="שאלה">' + cfg.questions.map(function (x, xi) { return xi === ownIdx ? '' : '<option value="' + x.id + '"' + (x.id === c.q ? ' selected' : '') + '>' + esc((xi + 1) + '. ' + x.text.slice(0, 50)) + '</option>'; }).join('') + '</select> ' +
              (q ? q.options.map(function (o) { return '<label style="font-weight:400;display:inline-flex;gap:.3rem;margin-inline-end:.8rem"><input type="checkbox" data-f="cin" data-h="' + hk + '" data-c="' + ci + '" value="' + o.id + '"' + ((c.in || []).indexOf(o.id) !== -1 ? ' checked' : '') + '>' + esc(o.label) + '</label>'; }).join('') : '') +
              ' <button class="btn mini sec" data-a="cdel" data-h="' + hk + '" data-c="' + ci + '">הסרת תנאי</button></div>';
          }).join('') + '<button class="btn mini sec" data-a="cadd" data-h="' + hk + '">הוספת תנאי</button></div>';
      }
      function flatten(c) { return !c ? { mode: 'all', list: [] } : c.q ? { mode: 'all', list: [c] } : { mode: c.any ? 'any' : 'all', list: (c.all || c.any) }; }
      function pack(mode, list) { return list.length === 1 ? list[0] : (mode === 'any' ? { any: list } : { all: list }); }
      function holderOf(hk) { return hk[0] === 's' ? cfg.questions[Number(hk.slice(1))] : cfg.rules[Number(hk.slice(1))]; }
      function getCond(hk) { return hk[0] === 's' ? holderOf(hk).showIf : holderOf(hk).when; }
      function setCond(hk, v) { var h = holderOf(hk); if (hk[0] === 's') { if (v) h.showIf = v; else delete h.showIf; } else h.when = v || { all: [] }; }
      function draw() {
        cfg.questions.forEach(function (q, i) { q.__i = i; });
        view.innerHTML = H('עריכה: ' + esc(topicNames[topic]), '<span><button class="btn sec" id="bk">חזרה</button></span>') +
          '<div class="panel"><label for="intro">טקסט פתיחה</label><textarea id="intro">' + esc(cfg.intro || '') + '</textarea></div>' +
          '<h2 style="margin:1rem 0 .5rem">שאלות</h2>' + cfg.questions.map(function (q, i) {
            return '<div class="qcard"><h3>שאלה ' + (i + 1) + ' <small>(מזהה ' + esc(q.id) + ')</small></h3>' +
              '<label>נוסח השאלה</label><textarea data-f="text" data-q="' + i + '">' + esc(q.text) + '</textarea>' +
              '<div class="row"><div><label>הסבר קצר (רשות)</label><input type="text" data-f="help" data-q="' + i + '" value="' + esc(q.help || '') + '"></div><div><label>הודעת חיזוק אחרי התשובה</label><input type="text" data-f="encourage" data-q="' + i + '" value="' + esc(q.encourage || '') + '"></div></div>' +
              '<label style="margin-top:.6rem">תשובות</label>' + qOptions(q) + '<button class="btn mini sec" data-a="oadd" data-q="' + i + '">הוספת תשובה</button>' +
              '<div style="margin-top:.7rem"><label>הצגת השאלה</label>' + (q.showIf ? condEditor(q.showIf, 's' + i, i) + '<button class="btn mini sec" data-a="sshow-off" data-q="' + i + '" style="margin-top:.4rem">להציג תמיד</button>' : '<span>תמיד </span><button class="btn mini sec" data-a="sshow-on" data-q="' + i + '">הצגה מותנית</button>') + '</div>' +
              '<div style="margin-top:.7rem"><button class="btn mini sec" data-a="qup" data-q="' + i + '"' + (i === 0 ? ' disabled' : '') + '>הזזה למעלה</button> <button class="btn mini sec" data-a="qdown" data-q="' + i + '"' + (i === cfg.questions.length - 1 ? ' disabled' : '') + '>הזזה למטה</button> <button class="btn mini danger" data-a="qdel" data-q="' + i + '">מחיקת שאלה</button></div></div>';
          }).join('') + '<button class="btn sec" data-a="qadd">הוספת שאלה</button>' +
          '<h2 style="margin:1.5rem 0 .5rem">כללים (מה נחשב ״ממצא״)</h2>' + cfg.rules.map(function (r, i) {
            return '<div class="qcard"><h3>כלל ' + (i + 1) + '</h3><label>כותרת הממצא</label><input type="text" data-f="rtitle" data-r="' + i + '" value="' + esc(r.finding.title) + '"><label>הסבר ללקוח</label><textarea data-f="rwhy" data-r="' + i + '">' + esc(r.finding.why) + '</textarea>' + condEditor(r.when, 'r' + i, -1) + '<div style="margin-top:.6rem"><button class="btn mini danger" data-a="rdel" data-r="' + i + '">מחיקת כלל</button></div></div>';
          }).join('') + '<button class="btn sec" data-a="radd">הוספת כלל</button>' +
          '<h2 style="margin:1.5rem 0 .5rem">הודעות תוצאה</h2><div class="panel">' + ['found', 'insufficient', 'none', 'insufficientBody', 'noneBody'].map(function (k) { return '<label>' + ({ found: 'כותרת: זוהה (השתמשו ב-{n})', insufficient: 'כותרת: חסר מידע', none: 'כותרת: לא זוהה', insufficientBody: 'גוף: חסר מידע', noneBody: 'גוף: לא זוהה' }[k]) + '</label><input type="text" data-f="msg" data-k="' + k + '" value="' + esc((cfg.messages || {})[k] || '') + '" style="margin-bottom:.5rem">'; }).join('') + '</div>' +
          '<div id="errs"></div><div class="panel" style="position:sticky;bottom:0;display:flex;gap:.6rem;flex-wrap:wrap"><button class="btn sec" id="sd">שמירת טיוטה</button><button class="btn sec" id="pv">תצוגה מקדימה</button><button class="btn" id="pub">פרסום</button>' + (draftMode ? '<button class="btn danger" id="dis">ביטול הטיוטה</button>' : '') + '</div>' +
          '<div id="pvbox"></div>' +
          '<h2 style="margin:1.5rem 0 .5rem">היסטוריית גרסאות</h2><table class="tbl"><tbody>' + versions.map(function (v) { return '<tr><td>v' + v.version + '</td><td>' + ({ draft: 'טיוטה', published: 'חי', archived: 'בארכיון' }[v.status]) + '</td><td>' + fdate(v.published_at || v.created_at) + '</td><td>' + (v.status === 'archived' ? '<button class="btn mini sec" data-a="rb" data-id="' + v.id + '">החזרה לגרסה זו</button>' : '') + '</td></tr>'; }).join('') + '</tbody></table>';
        wire();
      }
      function clean() { var c = JSON.parse(JSON.stringify(cfg)); c.questions.forEach(function (q) { delete q.__i; if (!q.help) delete q.help; if (!q.encourage) delete q.encourage; if (q.showIf && !q.showIf.q && !(q.showIf.all || q.showIf.any || q.showIf.not)) delete q.showIf; }); return c; }
      function sync() { /* write inputs back to cfg */
        view.querySelectorAll('[data-f]').forEach(function (el) {
          var f = el.dataset.f, qi = el.dataset.q, ri = el.dataset.r;
          if (f === 'text') cfg.questions[qi].text = el.value; else if (f === 'help') cfg.questions[qi].help = el.value; else if (f === 'encourage') cfg.questions[qi].encourage = el.value;
          else if (f === 'olabel') cfg.questions[qi].options[el.dataset.o].label = el.value;
          else if (f === 'ounk') { if (el.checked) cfg.questions[qi].options[el.dataset.o].unknown = true; else delete cfg.questions[qi].options[el.dataset.o].unknown; }
          else if (f === 'rtitle') cfg.rules[ri].finding.title = el.value; else if (f === 'rwhy') cfg.rules[ri].finding.why = el.value;
          else if (f === 'msg') { cfg.messages = cfg.messages || {}; cfg.messages[el.dataset.k] = el.value; }
        });
        cfg.intro = document.getElementById('intro').value;
        var keys = {};
        view.querySelectorAll('[data-h][data-f]').forEach(function (el) { keys[el.dataset.h] = true; });
        Object.keys(keys).forEach(function (hk) {
          var els = [].slice.call(view.querySelectorAll('[data-f][data-h="' + hk + '"]'));
          var js = els.filter(function (e) { return e.dataset.f === 'cjson'; })[0];
          if (js) { try { setCond(hk, JSON.parse(js.value)); } catch (e) {} return; }
          var fl = flatten(getCond(hk));
          var m = els.filter(function (e) { return e.dataset.f === 'cmode'; })[0];
          var list = fl.list.map(function (c, ci) {
            var qs = els.filter(function (e) { return e.dataset.f === 'cq' && e.dataset.c == ci; })[0];
            var ins = els.filter(function (e) { return e.dataset.f === 'cin' && e.dataset.c == ci && e.checked; }).map(function (e) { return e.value; });
            return { q: qs ? qs.value : c.q, in: qs && qs.value !== c.q ? [] : ins };
          });
          setCond(hk, list.length ? pack(m ? m.value : fl.mode, list) : null);
        });
      }
      function wire() {
        document.getElementById('bk').onclick = forms;
        view.onchange = function (e) { if (e.target.dataset.f === 'cq' || e.target.dataset.f === 'cmode') { sync(); draw(); } };
        view.onclick = function (e) {
          var b = e.target.closest('[data-a]'); if (!b) return; sync();
          var a = b.dataset.a, qi = Number(b.dataset.q), ri = Number(b.dataset.r), ci = Number(b.dataset.c);
          if (a === 'cadd' || a === 'cdel') {
            var hk = b.dataset.h, fl = flatten(getCond(hk)), list = fl.list;
            if (a === 'cadd') { var own = hk[0] === 's' ? cfg.questions[Number(hk.slice(1))].id : null; var first = cfg.questions.filter(function (q) { return q.id !== own; })[0]; list.push({ q: first.id, in: [] }); } else list.splice(ci, 1);
            setCond(hk, list.length ? pack(fl.mode, list) : null); draw(); return;
          }
          if (a === 'oadd') { var q = cfg.questions[qi]; q.options.push({ id: 'o' + Date.now().toString(36), label: 'תשובה חדשה' }); }
          else if (a === 'odel') { var qq = cfg.questions[qi]; var oid = qq.options[b.dataset.o].id; qq.options.splice(b.dataset.o, 1); if (JSON.stringify(cfg).indexOf('"' + oid + '"') !== -1 && qq.options.length) toast('שימו לב: ייתכן שכללים עדיין מפנים לתשובה שנמחקה. הבדיקה בשמירה תציג זאת.'); }
          else if (a === 'qup' || a === 'qdown') { var j = a === 'qup' ? qi - 1 : qi + 1; var t = cfg.questions[qi]; cfg.questions[qi] = cfg.questions[j]; cfg.questions[j] = t; }
          else if (a === 'qdel') { if (!confirm('למחוק את השאלה?')) return; cfg.questions.splice(qi, 1); }
          else if (a === 'qadd') cfg.questions.push({ id: 'q' + Date.now().toString(36), text: 'שאלה חדשה?', options: [{ id: 'yes', label: 'כן' }, { id: 'no', label: 'לא' }, { id: 'unk', label: 'לא בטוח/ה', unknown: true }] });
          else if (a === 'sshow-on') { var other = cfg.questions.filter(function (x, xi) { return xi < qi; })[0]; if (!other) { toast('אין שאלה קודמת להתנות בה'); return; } cfg.questions[qi].showIf = { q: other.id, in: [] }; }
          else if (a === 'sshow-off') delete cfg.questions[qi].showIf;
          else if (a === 'radd') cfg.rules.push({ id: 'r' + Date.now().toString(36), when: { all: [] }, finding: { title: 'ממצא חדש', why: 'הסבר' } });
          else if (a === 'rdel') { if (!confirm('למחוק את הכלל?')) return; cfg.rules.splice(ri, 1); }
          else if (a === 'rb') { api('POST', '/questionnaires/' + topic + '/rollback', { id: b.dataset.id }).then(function () { toast('הגרסה הוחזרה'); forms(); }).catch(fail); return; }
          draw();
        };
        document.getElementById('sd').onclick = function () { sync(); save().then(function (r) { showErrs(r.errors); toast('הטיוטה נשמרה'); draftMode = true; }).catch(fail); };
        document.getElementById('pub').onclick = function () { sync(); var errs = E.lint(clean()); if (errs.length) return showErrs(errs); if (!confirm('לפרסם את השאלון לאתר הציבורי?')) return; save().then(function () { return api('POST', '/questionnaires/' + topic + '/publish', {}); }).then(function (r) { if (!r.ok) return showErrs(r.errors); toast('פורסם (גרסה ' + r.version + ')'); forms(); }).catch(fail); };
        var dis = document.getElementById('dis'); if (dis) dis.onclick = function () { if (confirm('לבטל את הטיוטה?')) api('POST', '/questionnaires/' + topic + '/discard', {}).then(forms).catch(fail); };
        document.getElementById('pv').onclick = function () { sync(); preview(clean()); };
      }
      function save() { return api('PUT', '/questionnaires/' + topic + '/draft', { content: clean() }); }
      function showErrs(errs) { document.getElementById('errs').innerHTML = errs && errs.length ? '<div class="errs" role="alert"><b>יש לתקן לפני פרסום:</b><ul>' + errs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : ''; }
      function preview(c) {
        var ans = {}, box = document.getElementById('pvbox');
        (function paint() {
          var vis = E.visibleQuestions(c, ans);
          var ev = E.evaluate(c, ans), complete = vis.every(function (q) { return ans[q.id] != null; });
          box.innerHTML = '<div class="panel pv"><h2>תצוגה מקדימה (לא נשמרת)</h2>' + vis.map(function (q) { return '<p><b>' + esc(q.text) + '</b><br>' + q.options.map(function (o) { return '<button type="button" class="opt" role="radio" aria-checked="' + (ans[q.id] === o.id) + '" data-q="' + q.id + '" data-o="' + o.id + '"><span class="dot"></span>' + esc(o.label) + '</button>'; }).join(' ') + '</p>'; }).join('') +
            (complete ? '<div class="pv-res"><b>' + ({ found: 'זוהה: ' + ev.count + ' ממצאים', insufficient: 'חסר מידע', none: 'לא זוהה נושא' }[ev.outcome]) + '</b><ul>' + ev.findings.map(function (f) { return '<li>' + esc(f.title) + '</li>'; }).join('') + '</ul></div>' : '<p>ענו על כל השאלות כדי לראות תוצאה.</p>') + '</div>';
          box.onclick = function (e) { var b = e.target.closest('.opt'); if (!b) return; ans[b.dataset.q] = b.dataset.o; ans = E.pruneAnswers(c, ans); paint(); };
        })();
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }).catch(fail);
  }
})();
