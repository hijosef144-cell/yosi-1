/* =========================================================
   כרזת השקה — מצפן כלכלי (רכיב משותף לכל העמודים הציבוריים)

   טעינה בכל עמוד:  <script src="/static/launch-banner.js" defer></script>
   (scripts/apply-launch-banner.js מוסיף את התגית, וחוזר על עצמו בבטחה.)

   מה הרכיב עושה
   - מופיע פעם אחת בכניסה לאתר (אחרי כ־3 שניות), בלי קשר לעמוד הכניסה.
     מעבר בין עמודים לא מפעיל שוב את אנימציית הפתיחה ולא מאפס את המצב.
   - מזעור נשמר לאורך הביקור (sessionStorage); סגירה נשמרת 7 ימים (localStorage);
     נרשם בהצלחה: לא מציגים שוב טופס באותו דפדפן (localStorage).
   - 4 מצבי תצוגה לפי רוחב המסך (ראו tierFor): מגילה מלאה, מגילה קטנה בשוליים,
     לשונית צד, פס תחתון + חלונית הרשמה. הרכיב לא מכסה תוכן: רק לחיצה של
     המבקר פותחת חלונית מעל התוכן, והיא נסגרת בקלות.
   - אין חשיפת שם המיזם. אין הבטחת זכאות.
   - הרשמה: POST /api/email/initiative-waitlist ב־CRM. הצלחה מוצגת רק אחרי ש־
     השרת החזיר 201 עם ok:true. בשגיאה האימייל נשאר בשדה.

   כלים לבדיקות (לא פעילים בדומיין הייצור):
   - ?lbDemo=ok|err|verify  מדמה תשובת שרת (רק באתרי תצוגה מקדימה/מקומי)
   - ?lbApi=http://127.0.0.1:PORT  כתובת CRM לבדיקה (רק ב־localhost)
   - ?launch=reset  מאפס את מצב הכרזה בדפדפן (פתיחה, מזעור, סגירה, הרשמה)
   ========================================================= */
(function () {
  'use strict';
  var W = window, D = document, docEl = D.documentElement, loc = W.location;
  if (W.__lbLoaded) return;
  W.__lbLoaded = true;
  // לא בדפי ניהול, בכניסות מאובטחות, ב־API וכו'; ולא בתוך iframe.
  if (/^\/(admin|kaspchem|portal|api|\.netlify)(\/|$)/i.test(loc.pathname)) return;
  if (docEl.hasAttribute('data-lb-off')) return;
  if (W.self !== W.top) return;

  var KEY = 'lb.v1';           // localStorage: { closedUntil, joined }
  var SKEY = 'lb.s1';          // sessionStorage: { unfurled, min }
  var CFG = 'lb.cfg';          // sessionStorage: בדיקות בלבד
  var DAYS7 = 7 * 24 * 3600 * 1000;
  var CONSENT_VERSION = '2026-11-v1';
  var CONSENT_TEXT = 'אני מסכים/ה לקבל בדוא״ל עדכון על השקת המיזם החדש בשיתוף מצפן כלכלי. ניתן לבטל את ההרשמה בכל עת.';
  var PROD_HOSTS = { 'matzpenkalkali.com': 1, 'www.matzpenkalkali.com': 1 };
  var DEFAULT_API = 'https://matzpen-crm.netlify.app';
  var ENDPOINT = '/api/email/initiative-waitlist';
  var FIRST_DELAY = 3000;
  var ROTATE_MS = 4200;

  var TEASERS = [
    { t: 'אולי יש כסף שמחכה לכם?', i: 'coin' },
    { t: 'הזדמנויות כלכליות שכדאי להכיר', i: 'compass' },
    { t: 'העתיד הכלכלי שלכם מתחיל כאן', i: 'sunrise' },
    { t: 'משהו גדול מתקרב...', i: 'spark' }
  ];
  var MSG = {
    email: 'נא להזין כתובת אימייל תקינה.',
    consent: 'כדי להירשם יש לאשר קבלת עדכון במייל.',
    server: 'לא הצלחנו לשמור את ההרשמה כרגע. האימייל שלכם נשאר בשדה, נסו שוב בעוד רגע.',
    stale: 'העמוד לא מעודכן. אפשר לרענן אותו ולנסות שוב.',
    rate: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
    badEmail: 'כתובת האימייל לא נראית תקינה. אפשר לבדוק ולנסות שוב.'
  };

  var reduce = false;
  try { reduce = W.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  /* ---------- storage (always guarded: private mode / blocked storage) ---------- */
  function rd(store, k) { try { return JSON.parse(store.getItem(k) || 'null') || {}; } catch (e) { return {}; } }
  function wr(store, k, v) { try { store.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ls() { try { return W.localStorage; } catch (e) { return null; } }
  function ss() { try { return W.sessionStorage; } catch (e) { return null; } }
  function lget() { var s = ls(); return s ? rd(s, KEY) : {}; }
  function lset(v) { var s = ls(); if (s) wr(s, KEY, v); }
  function sget() { var s = ss(); return s ? rd(s, SKEY) : (W.__lbMem = W.__lbMem || {}); }
  function sset(patch) { var s = ss(); var cur = sget(); for (var k in patch) cur[k] = patch[k]; if (s) wr(s, SKEY, cur); else W.__lbMem = cur; }

  if (/[?&]launch=reset(&|$)/.test(loc.search)) {
    try { ls() && ls().removeItem(KEY); ss() && ss().removeItem(SKEY); ss() && ss().removeItem(CFG); } catch (e) {}
  }

  var saved = lget();
  if (saved.closedUntil && saved.closedUntil > Date.now()) return; // סגור: לא נפתח אוטומטית במשך 7 ימים

  /* ---------- test hooks (never on the production domain) ---------- */
  function cfg() { var s = ss(); return s ? rd(s, CFG) : {}; }
  (function readTestParams() {
    var s = ss(); if (!s) return;
    var c = cfg(), m;
    if (!PROD_HOSTS[loc.hostname]) {
      if ((m = /[?&]lbDemo=(ok|err|verify)(&|$)/.exec(loc.search))) c.demo = m[1];
      if ((loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') && (m = /[?&]lbApi=([^&]+)/.exec(loc.search))) c.api = decodeURIComponent(m[1]);
      wr(s, CFG, c);
    }
  })();
  function apiBase() { var c = cfg(); return (c.api && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1')) ? c.api : DEFAULT_API; }
  function demoMode() { return PROD_HOSTS[loc.hostname] ? null : (cfg().demo || null); }

  /* ---------- small helpers ---------- */
  function $(s, r) { return (r || D).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || D).querySelectorAll(s)); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function track(a) { try { if (typeof W.trackEvent === 'function') W.trackEvent(a, 'launch_banner', 'new_initiative'); } catch (e) {} }
  function visible(el) { return !!(el && el.getClientRects().length && W.getComputedStyle(el).visibility !== 'hidden'); }
  function icon(id) { return '<svg viewBox="0 0 36 36" aria-hidden="true" focusable="false"><use href="#lb-i-' + id + '"/></svg>'; }
  function uiIcon(id, vb) { return '<svg viewBox="' + (vb || '0 0 16 16') + '" aria-hidden="true" focusable="false"><use href="#lb-i-' + id + '"/></svg>'; }

  /* ---------- which presentation fits this screen ---------- */
  // הרוחב הפנוי בצד ימין (שם הכרזה יושבת): המרחק בין קצה הדף לקצה הימני של התוכן הנראה בפועל.
  // נמדד על העמוד עצמו, כי חלק מהעמודים (מחשבונים, מדריכים) רחבים מהאתר הראשי.
  var SKIP = '#cookie-banner,#a11y-btn,#a11y-panel,#legalDisclaimer,#questionBanner,#faqSmartPopup,[aria-modal="true"],[role="dialog"],.fx-overlay,.lb-root';
  function contentRight() {
    var w = docEl.clientWidth, max = 0, nodes = D.querySelectorAll('a,button,input,select,textarea,label,h1,h2,h3,h4,h5,p,li,img,td,th,summary');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i], r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.left < 0 || r.right <= max) continue;
      if (el.closest(SKIP) || el.closest('[hidden],.hidden')) continue;
      var cs = W.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' || parseFloat(cs.opacity) === 0) continue;
      max = Math.min(r.right, w);
    }
    return max;
  }
  function tierFor(w) {
    var coarse = false;
    try { coarse = W.matchMedia('(pointer: coarse)').matches; } catch (e) {}
    if (w < 1100) return 'bar';                // טאבלט ונייד: פס תחתון + חלונית
    if (coarse && w < 1420) return 'bar';      // מכשירי מגע ברוחב בינוני: פס תחתון
    var room = w - contentRight();             // מקום פנוי בצד ימין, מעבר לתוכן
    if (room >= 360) return 'full';            // מגילה מלאה (312px + שוליים) בלי לחפוף תוכן
    if (room >= 94) return 'totem';            // מגילה קטנה (68px)
    if (room >= 30) return 'tab';              // לשונית צד (28px)
    return 'bar';                              // אין מקום בצד: פס תחתון, כדי לא לכסות תוכן
  }

  /* ---------- state ---------- */
  var S = {
    mode: null, view: 'open', panel: false, joined: !!saved.joined, entered: false,
    email: '', consent: false, root: null, els: {}, ctls: [], cleanups: [], uid: 0, lastFocus: null
  };
  var started = false;

  /* ---------- svg sprite ---------- */
  var SPRITE =
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>' +
    '<symbol id="lb-i-star" viewBox="0 0 24 24"><path d="M12 0c.8 6.6 5.4 11.2 12 12-6.6.8-11.2 5.4-12 12-.8-6.6-5.4-11.2-12-12C6.6 11.2 11.2 6.6 12 0z" fill="currentColor"/></symbol>' +
    '<symbol id="lb-i-coin" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="20" r="11"/><circle cx="16" cy="20" r="7.2" stroke-dasharray="2 2.6"/><path d="M16 15.5v9M13.4 17.6h4.2a1.6 1.6 0 0 1 0 3.2h-3.2a1.6 1.6 0 0 0 0 3.2h4.2"/><path d="M29 4v6M26 7h6M5 3.5v3M3.5 5h3"/></symbol>' +
    '<symbol id="lb-i-compass" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="13"/><path d="M18 3.5v3M18 29.5v3M3.5 18h3M29.5 18h3"/><path d="M23.6 12.4l-3.4 7.8-7.8 3.4 3.4-7.8z"/><circle cx="18" cy="18" r="1.2" fill="currentColor"/></symbol>' +
    '<symbol id="lb-i-sunrise" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 27h28M9 27a9 9 0 0 1 18 0"/><path d="M18 8v4M7.5 14.5l2.8 2.8M28.5 14.5l-2.8 2.8M3.5 22h3M29.5 22h3"/><path d="M12 31.5h12"/></symbol>' +
    '<symbol id="lb-i-spark" viewBox="0 0 36 36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5c1 7.5 4.5 11 12 12-7.5 1-11 4.5-12 12-1-7.5-4.5-11-12-12 7.5-1 11-4.5 12-12z"/><path d="M28 4v5M25.5 6.5h5M29 26v4M27 28h4"/></symbol>' +
    '<symbol id="lb-i-pause" viewBox="0 0 12 12"><path d="M3 1.5v9M9 1.5v9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></symbol>' +
    '<symbol id="lb-i-play" viewBox="0 0 12 12"><path d="M3 1.8l7 4.2-7 4.2z" fill="currentColor"/></symbol>' +
    '<symbol id="lb-i-x" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke-width="1.8" stroke-linecap="round" fill="none"/></symbol>' +
    '<symbol id="lb-i-min" viewBox="0 0 16 16"><path d="M3.5 10.5L8 6l4.5 4.5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></symbol>' +
    '</defs></svg>';

  /* ---------- shared content (heading, teasers, form, thanks) ---------- */
  function contentHTML(n) {
    var slides = TEASERS.map(function (x, k) {
      return '<div class="lb-slide' + (k === 0 ? ' on' : '') + '" aria-hidden="' + (k === 0 ? 'false' : 'true') + '">' + icon(x.i) + '<span>' + x.t + '</span></div>';
    }).join('');
    var dots = TEASERS.map(function (x, k) {
      return '<button type="button" class="lb-dot" aria-label="מסר ' + (k + 1) + ' מתוך ' + TEASERS.length + '"' + (k === 0 ? ' aria-current="true"' : '') + '></button>';
    }).join('');
    return '' +
      '<p class="lb-sub"><span>מיזם חדש בשיתוף מצפן כלכלי</span></p>' +
      '<h2 class="lb-h" id="lb-h' + n + '">משהו גדול עומד להתגלות...</h2>' +
      '<p class="lb-p">מיזם שנועד לעזור למשפחות בישראל לגלות הזדמנויות כלכליות, לחסוך בהוצאות ולמצות את מה שמגיע להן.</p>' +
      '<div class="lb-teaser" role="group" aria-label="מסרים מתחלפים"><div class="lb-slides">' + slides + '</div>' +
        '<div class="lb-dots">' + dots + '<button type="button" class="lb-pause" aria-label="השהיית המסרים המתחלפים">' + uiIcon('pause', '0 0 12 12') + '</button></div></div>' +
      '<div class="lb-signup">' +
        '<p class="lb-cta">רוצים להיות הראשונים לשמוע?</p>' +
        '<form class="lb-form" novalidate>' +
          '<div class="lb-field"><label class="lb-sr" for="lb-em' + n + '">כתובת האימייל שלכם</label>' +
          '<input class="lb-in" id="lb-em' + n + '" type="email" name="email" dir="auto" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="כתובת האימייל שלכם" aria-describedby="lb-err' + n + '">' +
          '<input class="lb-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"></div>' +
          '<label class="lb-check"><input type="checkbox" name="consent" id="lb-cn' + n + '"><span>' + CONSENT_TEXT + '</span></label>' +
          '<p class="lb-msg" id="lb-err' + n + '" role="alert"></p>' +
          '<button class="lb-btn" type="submit">עדכנו אותי כשהמיזם יושק</button>' +
          '<p class="lb-fine">הכתובת משמשת רק לעדכון על המיזם. <a href="/privacy">מדיניות פרטיות</a></p>' +
        '</form>' +
      '</div>' +
      '<div class="lb-thanks" hidden>' +
        '<svg class="lb-check-ico" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="25"/><path d="M19 31l8 8 15-17"/></svg>' +
        '<h3></h3><p class="lb-thanks-p" role="status"></p></div>';
  }

  function submitRegistration(email, source, website) {
    var demo = demoMode();
    if (demo) {
      return wait(900).then(function () {
        if (demo === 'ok') return { ok: true, status: 'registered' };
        if (demo === 'verify') return { ok: true, status: 'verification_sent' };
        return { ok: false, msg: MSG.server };
      });
    }
    var ctrl = ('AbortController' in W) ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    return fetch(apiBase() + ENDPOINT, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({
        email: email, consent: true, consent_version: CONSENT_VERSION, consent_text: CONSENT_TEXT,
        page: loc.pathname, source_detail: source, website: website || ''
      })
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        // הצלחה רק כשהשרת אישר: 201/200 עם ok:true
        if ((r.status === 201 || r.status === 200) && j && j.ok === true) return { ok: true, status: j.status === 'verification_sent' ? 'verification_sent' : 'registered' };
        if (r.status === 400 && j && j.error === 'consent_mismatch') return { ok: false, msg: MSG.stale };
        if (r.status === 400) return { ok: false, msg: MSG.badEmail };
        if (r.status === 429) return { ok: false, msg: MSG.rate };
        return { ok: false, msg: MSG.server };
      });
    }).catch(function () { return { ok: false, msg: MSG.server }; })
      .then(function (res) { clearTimeout(timer); return res; });
  }

  /* wires teasers + form + thanks inside one content root; returns a controller */
  function wireContent(root, hooks) {
    var slides = $$('.lb-slide', root), dots = $$('.lb-dot', root), pauseBtn = $('.lb-pause', root);
    var idx = 0, timer = null, paused = reduce, hover = false;
    function show(k) {
      idx = (k + slides.length) % slides.length;
      slides.forEach(function (s, j) { var on = j === idx; s.classList.toggle('on', on); s.setAttribute('aria-hidden', on ? 'false' : 'true'); });
      dots.forEach(function (d, j) { if (j === idx) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current'); });
    }
    function tick() {
      clearTimeout(timer);
      timer = setTimeout(function () { if (paused || hover || D.hidden) { tick(); return; } show(idx + 1); tick(); }, ROTATE_MS);
    }
    function setPaused(p) {
      paused = p;
      pauseBtn.setAttribute('aria-label', p ? 'הפעלת המסרים המתחלפים' : 'השהיית המסרים המתחלפים');
      pauseBtn.innerHTML = uiIcon(p ? 'play' : 'pause', '0 0 12 12');
    }
    dots.forEach(function (d, j) { d.addEventListener('click', function () { show(j); }); });
    pauseBtn.addEventListener('click', function () { setPaused(!paused); });
    var tz = $('.lb-teaser', root);
    tz.addEventListener('mouseenter', function () { hover = true; });
    tz.addEventListener('mouseleave', function () { hover = false; });
    setPaused(paused); tick();

    var form = $('form', root), em = $('input[type=email]', form), cn = $('input[type=checkbox]', form),
        hp = $('input[name=website]', form), msg = $('.lb-msg', form), btn = $('.lb-btn', form), busy = false;
    em.value = S.email; cn.checked = S.consent;
    em.addEventListener('input', function () { S.email = em.value; syncFields(); });
    cn.addEventListener('change', function () { S.consent = cn.checked; syncFields(); });
    function syncFields() { S.ctls.forEach(function (c) { if (c !== ctl) c.pull(); }); }
    function fail(text, el) {
      msg.textContent = text;
      em.setAttribute('aria-invalid', el === em ? 'true' : 'false');
      if (el) el.focus();
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (busy) return;
      msg.textContent = ''; em.setAttribute('aria-invalid', 'false');
      var email = em.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(MSG.email, em);
      if (!cn.checked) return fail(MSG.consent, cn);
      busy = true; btn.disabled = true; btn.textContent = 'שומרים את ההרשמה...';
      submitRegistration(email, hooks.source(), hp.value).then(function (res) {
        busy = false; btn.disabled = false; btn.textContent = 'עדכנו אותי כשהמיזם יושק';
        if (res.ok) { onRegistered(res.status); }
        else { fail(res.msg); }
      });
    });
    function setThanks(kind, fresh) {
      $('.lb-signup', root).hidden = true;
      var t = $('.lb-thanks', root); t.hidden = false; t.classList.toggle('lb-static', !fresh);
      $('h3', t).textContent = kind === 'verify' ? 'כמעט סיימנו' : 'תודה, אתם ברשימה';
      $('.lb-thanks-p', t).textContent = kind === 'verify'
        ? 'שלחנו אליכם מייל אימות. לחצו על הקישור בו כדי להשלים את ההרשמה.'
        : 'נשלח לכם עדכון במייל ברגע שהמיזם ייחשף. אפשר להסיר את ההרשמה בכל עת.';
    }
    var ctl = {
      el: root,
      pull: function () { em.value = S.email; cn.checked = S.consent; },
      thanks: function (kind, fresh) { hooks.morph(function () { setThanks(kind, fresh); }); },
      thanksNow: function (kind) { setThanks(kind, false); },
      destroy: function () { clearTimeout(timer); }
    };
    if (S.joined) setThanks('registered', false);
    return ctl;
  }

  function onRegistered(status) {
    track('signup_success');
    if (status === 'verification_sent') {
      S.ctls.forEach(function (c) { c.thanks('verify', true); });
      return;
    }
    S.joined = true; S.email = '';
    var cur = lget(); cur.joined = Date.now(); lset(cur);
    S.ctls.forEach(function (c) { c.thanks('registered', true); });
  }

  /* ---------- builders ---------- */
  function sparksHTML() {
    var sp = [[8, 70, .9, 3.2, 0], [286, 96, .7, 2.8, .8], [290, 250, 1, 3.6, 1.4], [6, 300, .8, 3, .4], [288, 430, .7, 3.4, 1.1], [150, 8, .6, 2.6, 1.9], [10, 520, .6, 3.8, 2.2], [284, 560, .8, 3.1, .6]];
    return sp.map(function (s) {
      return '<i class="lb-sp" aria-hidden="true" style="--x:' + s[0] + 'px;--y:' + s[1] + 'px;--s:' + s[2] + ';--d:' + s[3] + 's;--dl:' + s[4] + 's">' + uiIcon('star', '0 0 24 24') + '</i>';
    }).join('');
  }

  function buildScroll(overlay) {
    var n = ++S.uid, el = D.createElement('section');
    el.className = 'lb-scroll'; el.setAttribute('data-on', '0');
    if (overlay) { el.setAttribute('data-overlay', '1'); el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'הרשמה לעדכון על המיזם החדש'); }
    else { el.setAttribute('role', 'complementary'); el.setAttribute('aria-labelledby', 'lb-h' + n); }
    el.innerHTML = '<div class="lb-rod" aria-hidden="true"></div><div class="lb-sheet"><div class="lb-body">' +
      '<button type="button" class="lb-min" aria-label="' + (overlay ? 'סגירת החלונית' : 'מזעור ללשונית') + '">' + uiIcon('min') + '</button>' +
      '<button type="button" class="lb-x" aria-label="' + (overlay ? 'סגירת ההודעה לשבעה ימים' : 'סגירת ההודעה') + '">' + uiIcon('x') + '</button>' +
      sparksHTML() + contentHTML(n) + '</div></div><div class="lb-rod" aria-hidden="true"></div>';
    S.root.appendChild(el);
    var ctl = wireContent($('.lb-body', el), { source: function () { return S.mode === 'full' ? 'desktop' : (S.mode === 'totem' ? 'compact' : 'tab'); }, morph: function (fn) { morphHeight($('.lb-sheet', el), fn); } });
    S.ctls.push(ctl);
    $('.lb-min', el).addEventListener('click', function () { if (overlay) collapsePanel(); else minimize(); });
    $('.lb-x', el).addEventListener('click', closeForDays);
    return el;
  }

  function buildTotem() {
    var el = D.createElement('aside');
    el.className = 'lb-totem'; el.setAttribute('data-on', '0'); el.setAttribute('aria-label', 'הודעת השקה: מיזם חדש בשיתוף מצפן כלכלי');
    var icons = TEASERS.map(function (x, k) { return '<svg viewBox="0 0 36 36" class="' + (k === 0 ? 'on' : '') + '" aria-hidden="true" focusable="false"><use href="#lb-i-' + x.i + '"/></svg>'; }).join('');
    el.innerHTML = '<div class="lb-rod" aria-hidden="true"></div><div class="lb-sheet"><div class="lb-totem-in">' +
      '<div class="lb-tt-ctl"><button type="button" class="lb-tt-btn lb-tt-min" aria-label="מזעור ללשונית">' + uiIcon('min') + '</button>' +
      '<button type="button" class="lb-tt-btn lb-tt-x" aria-label="סגירת ההודעה">' + uiIcon('x') + '</button></div>' +
      '<div class="lb-tt-icons" aria-hidden="true">' + icons + '</div>' +
      '<p class="lb-tt-h" aria-hidden="true"><span>משהו</span><span>גדול</span><span>עומד</span><span>להתגלות</span></p>' +
      '<button type="button" class="lb-tt-open" aria-label="משהו גדול עומד להתגלות. פתיחת ההרשמה לעדכון" aria-haspopup="dialog">להרשמה</button>' +
      '</div></div><div class="lb-rod" aria-hidden="true"></div>';
    S.root.appendChild(el);
    var svgs = $$('.lb-tt-icons svg', el), i = 0, t = null;
    function spin() { clearTimeout(t); t = setTimeout(function () { if (!reduce && !D.hidden) { svgs[i].classList.remove('on'); i = (i + 1) % svgs.length; svgs[i].classList.add('on'); } spin(); }, ROTATE_MS); }
    spin();
    S.cleanups.push(function () { clearTimeout(t); });
    $('.lb-tt-open', el).addEventListener('click', openPanel);
    $('.lb-tt-min', el).addEventListener('click', minimize);
    $('.lb-tt-x', el).addEventListener('click', closeForDays);
    return el;
  }

  function buildTab() {
    var el = D.createElement('button');
    el.type = 'button'; el.className = 'lb-tab'; el.setAttribute('data-on', '0'); el.setAttribute('aria-label', 'פתיחת הודעת ההשקה');
    el.innerHTML = uiIcon('spark', '0 0 36 36') + '<span>משהו מתקרב...</span>';
    S.root.appendChild(el);
    el.addEventListener('click', function () {
      if (S.mode === 'full') { S.view = 'open'; sset({ min: false }); apply({ fast: true }); }
      else if (S.mode === 'totem') { openPanel(); }
      else { openPanel(); }
    });
    return el;
  }

  function buildBar() {
    var n = ++S.uid;
    var teasers = TEASERS.map(function (x, k) { return '<div class="lb-slide' + (k === 0 ? ' on' : '') + '" aria-hidden="' + (k === 0 ? 'false' : 'true') + '"><span>' + x.t + '</span></div>'; }).join('');
    var bar = D.createElement('div');
    bar.className = 'lb-bar'; bar.setAttribute('data-on', '0'); bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'הודעת השקה: מיזם חדש בשיתוף מצפן כלכלי');
    bar.innerHTML = '<span class="lb-gem" aria-hidden="true">' + icon('spark') + '</span><div class="lb-bar-teaser">' + teasers + '</div>' +
      '<button type="button" class="lb-open" aria-haspopup="dialog">גלו עוד</button>' +
      '<button type="button" class="lb-bx" aria-label="סגירת ההודעה">' + uiIcon('x') + '</button>';
    var scrim = D.createElement('div'); scrim.className = 'lb-scrim'; scrim.setAttribute('data-on', '0');
    var sheet = D.createElement('div');
    sheet.className = 'lb-sheetm'; sheet.setAttribute('data-on', '0'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'lb-h' + n); sheet.tabIndex = -1;
    sheet.innerHTML = '<div class="lb-grab" aria-hidden="true"></div><div class="lb-body"><button type="button" class="lb-x" aria-label="סגירת החלונית">' + uiIcon('x') + '</button>' + contentHTML(n) + '</div>';
    S.root.appendChild(bar); S.root.appendChild(scrim); S.root.appendChild(sheet);

    // teasers in the bar: pause on hover/focus; static in reduced motion
    var bs = $$('.lb-slide', bar), bi = 0, bt = null, bhover = false;
    function btick() { clearTimeout(bt); bt = setTimeout(function () { if (!reduce && !bhover && !D.hidden) { bs[bi].classList.remove('on'); bs[bi].setAttribute('aria-hidden', 'true'); bi = (bi + 1) % bs.length; bs[bi].classList.add('on'); bs[bi].setAttribute('aria-hidden', 'false'); } btick(); }, 3800); }
    btick();
    S.cleanups.push(function () { clearTimeout(bt); });
    ['mouseenter', 'focusin', 'touchstart'].forEach(function (ev) { bar.addEventListener(ev, function () { bhover = true; }, { passive: true }); });
    ['mouseleave', 'focusout'].forEach(function (ev) { bar.addEventListener(ev, function () { bhover = false; }); });

    var ctl = wireContent($('.lb-body', sheet), { source: function () { return 'mobile'; }, morph: function (fn) { fn(); } });
    S.ctls.push(ctl);
    $('.lb-open', bar).addEventListener('click', openPanel);
    $('.lb-bx', bar).addEventListener('click', closeForDays);
    $('.lb-x', sheet).addEventListener('click', collapsePanel);
    scrim.addEventListener('click', collapsePanel);
    sheet.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button,input:not(.lb-hp),a[href]', sheet).filter(function (x) { return !x.hidden && x.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (D.activeElement === first || D.activeElement === sheet)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && D.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // swipe down on the handle
    var grab = $('.lb-grab', sheet), y0 = null;
    grab.addEventListener('pointerdown', function (e) { y0 = e.clientY; sheet.classList.add('lb-drag'); try { grab.setPointerCapture(e.pointerId); } catch (x) {} });
    grab.addEventListener('pointermove', function (e) { if (y0 === null) return; sheet.style.transform = 'translateY(' + Math.max(0, e.clientY - y0) + 'px)'; });
    function endDrag(e) { if (y0 === null) return; var dy = e.clientY - y0; y0 = null; sheet.classList.remove('lb-drag'); sheet.style.transform = ''; if (dy > 80) collapsePanel(); }
    grab.addEventListener('pointerup', endDrag); grab.addEventListener('pointercancel', endDrag);
    return { bar: bar, scrim: scrim, sheet: sheet };
  }

  /* ---------- animation ---------- */
  function morphHeight(sheet, fn) {
    var a = sheet.offsetHeight; fn(); var b = sheet.offsetHeight;
    if (reduce || !sheet.animate || !a || a === b) return;
    sheet.animate([{ height: a + 'px' }, { height: b + 'px' }], { duration: 600, easing: 'cubic-bezier(.22,.8,.24,1)' });
  }
  function unfurl(box, fast) {
    box.setAttribute('data-on', '1');
    var sheet = $('.lb-sheet', box), rod = $('.lb-rod', box);
    if (reduce || !sheet.animate) return;
    var H = sheet.offsetHeight;
    rod.animate([{ transform: 'translateY(-30px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 500, easing: 'ease-out' });
    sheet.animate([{ height: '0px' }, { height: H + 'px' }], { duration: fast ? 900 : 1500, delay: fast ? 0 : 200, easing: 'cubic-bezier(.22,.8,.24,1)', fill: 'backwards' });
  }
  function collapse(box, done) {
    var sheet = $('.lb-sheet', box);
    if (reduce || !sheet.animate || box.getAttribute('data-on') !== '1') { box.setAttribute('data-on', '0'); if (done) done(); return; }
    var a = sheet.animate([{ height: sheet.offsetHeight + 'px' }, { height: '0px' }], { duration: 650, easing: 'cubic-bezier(.5,0,.2,1)', fill: 'forwards' });
    a.onfinish = function () { box.setAttribute('data-on', '0'); a.cancel(); if (done) done(); };
  }

  /* ---------- state machine ---------- */
  function desired() {
    var scroll = false, totem = false, tab = false, bar = false;
    if (S.mode === 'full') { scroll = S.view === 'open'; tab = S.view === 'min'; }
    else if (S.mode === 'totem') { scroll = S.panel; totem = !S.panel && S.view === 'open'; tab = !S.panel && S.view === 'min'; }
    else if (S.mode === 'tab') { scroll = S.panel; tab = !S.panel; }
    else { bar = true; }
    return { scroll: scroll, totem: totem, tab: tab, bar: bar };
  }
  function setOn(el, on) { if (el) el.setAttribute('data-on', on ? '1' : '0'); }

  function apply(opts) {
    opts = opts || {};
    var d = desired(), E = S.els;
    if (E.scroll) {
      var isOn = E.scroll.getAttribute('data-on') === '1';
      if (d.scroll && !isOn) { opts.instant ? E.scroll.setAttribute('data-on', '1') : unfurl(E.scroll, opts.fast); }
      else if (!d.scroll && isOn) { opts.instant ? E.scroll.setAttribute('data-on', '0') : collapse(E.scroll); }
    }
    var delay = (opts.instant || !E.scroll || E.scroll.getAttribute('data-on') !== '1') ? 0 : 450; // tab/totem appear as the scroll rolls up
    function later(fn) { if (delay) setTimeout(fn, delay); else fn(); }
    if (E.totem) {
      if (opts.unfurlTotem && d.totem) unfurl(E.totem, false);   // כניסה ראשונה: המגילה הקטנה נפרשת
      else later(function () { if (S.root) setOn(E.totem, d.totem && desired().totem); });
    }
    if (E.tab) later(function () { if (S.root) setOn(E.tab, d.tab && desired().tab); });
    if (E.bar) {
      setOn(E.bar, true);
      var open = S.panel;
      setOn(E.scrim, open); setOn(E.sheet, open);
      docEl.classList.toggle('lb-modal', open);
    }
    W.__lbActive = true;
  }

  function minimize() { S.view = 'min'; sset({ min: true }); track('minimize'); apply(); }
  function openPanel() {
    S.lastFocus = D.activeElement; S.panel = true; track('open_panel'); apply({ fast: true });
    setTimeout(function () {
      if (S.mode === 'bar') { S.els.sheet.focus({ preventScroll: true }); updateViewport(); }
      else if (S.els.scroll) { var f = $('.lb-in', S.els.scroll); if (f) f.focus({ preventScroll: true }); }
    }, S.mode === 'bar' ? 350 : 700);
  }
  function collapsePanel() {
    if (!S.panel) return;
    S.panel = false; apply();
    var f = S.lastFocus; S.lastFocus = null;
    // המגילה/הלשונית מופיעות שוב רק אחרי שהחלונית מתקפלת: מחזירים מיקוד אחרי שהן נראות
    setTimeout(function () {
      if (!S.root) return;
      var t = (f && f.focus && D.contains(f) && f.getClientRects().length) ? f : (S.root.querySelector('.lb-tab[data-on="1"]') || S.root.querySelector('.lb-totem[data-on="1"] .lb-tt-open') || S.root.querySelector('.lb-open'));
      if (t) { try { t.focus({ preventScroll: true }); } catch (e) {} }
    }, S.mode === 'bar' ? 60 : 620);
  }
  function closeForDays() {
    track('close');
    var cur = lget(); cur.closedUntil = Date.now() + DAYS7; lset(cur);
    var E = S.els, box = E.scroll && E.scroll.getAttribute('data-on') === '1' ? E.scroll : (E.totem && E.totem.getAttribute('data-on') === '1' ? E.totem : null);
    S.panel = false;
    if (E.sheet) setOn(E.sheet, false);
    if (E.scrim) setOn(E.scrim, false);
    if (E.tab) setOn(E.tab, false);
    if (E.bar) setOn(E.bar, false);
    if (box) collapse(box, destroy); else setTimeout(destroy, E.bar ? 750 : 50);
  }

  /* ---------- page adjustments (bottom bar mode) ---------- */
  var lastScan = 0;
  function scanFixed() {
    lastScan = Date.now();
    var kids = [];
    $$('body > *').forEach(function (a) { kids.push(a); $$(':scope > *', a).forEach(function (b) { kids.push(b); }); });
    kids.forEach(function (el) {
      if (S.root && S.root.contains(el)) return;
      if (el.matches('script,style,link,svg,[aria-modal="true"],[role="dialog"]')) return;
      var cs = W.getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = el.getBoundingClientRect();
      if (!r.height || r.width > W.innerWidth * 0.8) return;
      if (r.bottom > W.innerHeight - 300) el.classList.add('lb-lift-me');
    });
  }
  function updateLift(force) {
    var on = S.mode === 'bar' && S.root && S.els.bar && (force || S.els.bar.getAttribute('data-on') === '1');
    var cb = D.getElementById('cookie-banner'), ch = 0;
    if (cb) { var cs = W.getComputedStyle(cb); if (cs.display !== 'none' && cs.position === 'fixed') ch = cb.offsetHeight; }
    docEl.style.setProperty('--lb-cookie-h', (on ? ch : 0) + 'px');
    if (!on) { docEl.classList.remove('lb-lift'); docEl.style.removeProperty('--lb-lift'); docEl.style.removeProperty('--lb-bar-h'); return; }
    var bh = S.els.bar.offsetHeight;
    docEl.style.setProperty('--lb-bar-h', bh + 'px');
    docEl.style.setProperty('--lb-lift', (bh + ch) + 'px');
    docEl.classList.add('lb-lift');
  }
  function updateViewport() {
    var vv = W.visualViewport; if (!vv || !S.root) return;
    var kb = Math.max(0, W.innerHeight - vv.height - vv.offsetTop);
    S.root.style.setProperty('--lb-kb', kb + 'px');
    S.root.style.setProperty('--lb-vh', Math.max(240, vv.height - 12) + 'px');
    var ed = D.activeElement, editing = ed && /^(INPUT|TEXTAREA|SELECT)$/.test(ed.tagName) && !S.root.contains(ed);
    docEl.classList.toggle('lb-kb', !!(editing && (W.innerHeight - vv.height) > 140));
    if (S.panel && S.mode === 'bar' && S.root.contains(ed) && ed.tagName === 'INPUT') { try { ed.scrollIntoView({ block: 'center' }); } catch (e) {} }
  }

  /* ---------- build / destroy ---------- */
  function buildUI(instant) {
    S.root = D.createElement('div');
    S.root.className = 'lb-root'; S.root.setAttribute('dir', 'rtl'); S.root.setAttribute('lang', 'he');
    if (instant) S.root.classList.add('lb-notrans');
    S.root.innerHTML = SPRITE;
    D.body.appendChild(S.root);
    setTop();
    S.els = {};
    if (S.mode === 'full') { S.els.scroll = buildScroll(false); S.els.tab = buildTab(); }
    else if (S.mode === 'totem') { S.els.totem = buildTotem(); S.els.scroll = buildScroll(true); S.els.tab = buildTab(); }
    else if (S.mode === 'tab') { S.els.scroll = buildScroll(true); S.els.tab = buildTab(); }
    else { var b = buildBar(); S.els.bar = b.bar; S.els.scrim = b.scrim; S.els.sheet = b.sheet; }
  }
  function destroy() {
    W.__lbActive = false;
    S.ctls.forEach(function (c) { c.destroy(); }); S.ctls = [];
    S.cleanups.forEach(function (f) { try { f(); } catch (e) {} }); S.cleanups = [];
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    S.root = null; S.els = {};
    $$('.lb-lift-me').forEach(function (el) { el.classList.remove('lb-lift-me'); });
    docEl.classList.remove('lb-lift', 'lb-kb', 'lb-modal');
    ['--lb-lift', '--lb-bar-h', '--lb-cookie-h', '--lb-top'].forEach(function (p) { docEl.style.removeProperty(p); });
  }
  // top offset: just under a sticky/fixed site header, else a fixed gap
  function setTop() {
    var top = 96, h = D.querySelector('header');
    if (h) { var cs = W.getComputedStyle(h); var r = h.getBoundingClientRect(); if ((cs.position === 'sticky' || cs.position === 'fixed') && r.height) top = Math.round(r.bottom) + 16; else if (r.height && r.top < 4) top = Math.max(top, Math.round(r.bottom + W.scrollY) + 16); }
    docEl.style.setProperty('--lb-top', Math.min(Math.max(top, 64), 150) + 'px');
  }

  function rebuild() {
    var wasPanel = S.panel;
    S.ctls.forEach(function (c) { c.destroy(); }); S.ctls = [];
    S.cleanups.forEach(function (f) { try { f(); } catch (e) {} }); S.cleanups = [];
    if (S.root && S.root.parentNode) S.root.parentNode.removeChild(S.root);
    docEl.classList.remove('lb-lift', 'lb-kb', 'lb-modal');
    S.panel = false;
    S.mode = tierFor(docEl.clientWidth);
    buildUI(true);
    updateLift(true);
    apply({ instant: true });
    afterMount();
    setTimeout(function () { if (S.root) S.root.classList.remove('lb-notrans'); }, 60);
    if (wasPanel) { /* a resize closes an open panel */ }
  }
  function recheck() {
    if (!S.root || S.panel) return;
    var m = tierFor(docEl.clientWidth);
    if (m !== S.mode) rebuild(); else setTop();
  }

  function afterMount() {
    if (S.mode === 'bar') {
      updateLift(); scanFixed();
      setTimeout(function () { if (S.root) { scanFixed(); updateLift(); } }, 1500);
      setTimeout(function () { if (S.root) { scanFixed(); updateLift(); } }, 4000);
    } else { updateLift(); }
  }

  /* ---------- start ---------- */
  var BLOCKERS = '#kc-notice-overlay:not([hidden]),#newsletterPopup:not(.hidden),#exitPopup:not(.hidden),.fx-overlay:not([hidden]),[aria-modal="true"]';
  function blocked() {
    return $$(BLOCKERS).some(function (el) { return (!S.root || !S.root.contains(el)) && visible(el); });
  }

  function loadCss() {
    return new Promise(function (resolve) {
      if (D.getElementById('lb-css')) return resolve(true);
      var done = false, link = D.createElement('link');
      link.id = 'lb-css'; link.rel = 'stylesheet'; link.href = '/static/launch-banner.css';
      function fin(ok) { if (!done) { done = true; resolve(ok); } }
      link.onload = function () { fin(true); }; link.onerror = function () { fin(false); };
      setTimeout(function () { fin(false); }, 10000);
      D.head.appendChild(link);
      if (!D.getElementById('lb-font')) {
        var f = D.createElement('link'); f.id = 'lb-font'; f.rel = 'stylesheet';
        f.href = 'https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@700;900&family=Heebo:wght@400;500;600;700&display=swap';
        D.head.appendChild(f);
      }
    });
  }

  function start() {
    if (started) return; started = true;
    var sess = sget(), first = !sess.unfurled;
    var cssP = loadCss();
    function boot() {
      cssP.then(function (ok) {
        if (!ok) return; // בלי עיצוב לא מציגים כלום
        var cur = lget(); if (cur.closedUntil && cur.closedUntil > Date.now()) return;
        S.mode = tierFor(docEl.clientWidth);
        S.view = sess.min && (S.mode === 'full' || S.mode === 'totem') ? 'min' : 'open';
        buildUI(!first);
        updateLift(true);   // לפני ההצגה: גובה באנר העוגיות ידוע כבר בפריסה הראשונה, בלי קפיצה
        S.entered = true;
        sset({ unfurled: true });
        track('shown');
        if (first) {
          if (S.mode === 'totem') apply({ unfurlTotem: true });
          else apply({});
        } else { apply({ instant: true }); }
        afterMount();
        if (!first) setTimeout(function () { if (S.root) S.root.classList.remove('lb-notrans'); }, 60);
        bindGlobal();
        setTimeout(recheck, 2500);   // הפריסה של העמוד עוד יכולה להתייצב (Tailwind, תמונות)
        W.addEventListener('load', function () { setTimeout(recheck, 400); });
      });
    }
    function waitFree() { if (blocked()) { setTimeout(waitFree, 800); return; } boot(); }
    if (first) setTimeout(waitFree, FIRST_DELAY); else waitFree();
  }

  var bound = false;
  function bindGlobal() {
    if (bound) return; bound = true;
    var rt = null;
    W.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (!S.root) return;
        var m = tierFor(docEl.clientWidth);
        if (m !== S.mode) rebuild(); else { setTop(); updateLift(); }
      }, 150);
    });
    if (W.visualViewport) { W.visualViewport.addEventListener('resize', updateViewport); W.visualViewport.addEventListener('scroll', updateViewport); }
    D.addEventListener('focusin', updateViewport); D.addEventListener('focusout', function () { setTimeout(updateViewport, 100); });
    D.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.panel) collapsePanel(); });
    D.addEventListener('pointerdown', function (e) {
      if (S.panel && S.mode !== 'bar' && S.root && !S.root.contains(e.target)) collapsePanel();
    }, true);
    var cb = D.getElementById('cookie-banner');
    if (cb && W.ResizeObserver) { new W.ResizeObserver(function () { updateLift(); }).observe(cb); }
    W.addEventListener('load', function () { if (S.root && S.mode === 'bar') { scanFixed(); updateLift(); } });
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', start); else start();
})();
