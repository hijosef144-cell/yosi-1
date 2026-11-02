(function () {
  'use strict';
  var E = window.KaspchemEngine;
  var app = document.getElementById('app');
  var main = document.getElementById('main');
  var topicId = (location.pathname.match(/\/kaspchem\/check\/([a-z-]+)/) || [])[1];
  var settings = {}, busy = false, topics = [], topic = null, answers = {}, order = [], enc = '', goingBack = false;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var STORE = 'kaspchem:' + topicId;
  var GENERIC_ENC = ['מצוין, ממשיכים.', 'עוד קצת ואנחנו שם.', 'כמעט סיימנו.'];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify({ a: answers, o: order })); } catch (e) {} }
  function load() { try { var d = JSON.parse(sessionStorage.getItem(STORE) || 'null'); if (d && d.a) { answers = d.a; order = d.o || []; } } catch (e) {} }
  function focusMain() { main.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); }

  /* ---------- data ---------- */
  function fetchJson(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
  fetchJson('/api/kaspchem/config').catch(function () { return fetchJson('/kaspchem/content/topics.json'); })
    .then(function (c) {
      topics = c.topics; settings = c.settings || {};
      topic = topics.filter(function (t) { return t.id === topicId; })[0];
      if (!topic) { app.innerHTML = '<h1>התחום לא נמצא</h1><p><a href="/kaspchem">חזרה לכל התחומים</a></p>'; return; }
      document.title = topic.kind === 'router' ? topic.name + ' – כספכם' : topic.name + ' – בדיקה בכספכם';
      load();
      answers = E.pruneAnswers(topic, answers);
      Object.keys(answers).forEach(function (k) { var qd = topic.questions.filter(function (x) { return x.id === k; })[0]; if (!qd || !!qd.multi !== Array.isArray(answers[k]) || [].concat(answers[k]).some(function (id) { return !qd.options.some(function (o) { return o.id === id; }); })) delete answers[k]; }); // stale shape or a removed option after a questionnaire edit
      answers = E.pruneAnswers(topic, answers); // an answer dropped above may have been what made a later question visible
      order = order.filter(function (id) { return answers[id] != null; });
      history.replaceState({ n: order.length }, '');
      step();
    })
    .catch(function () { app.innerHTML = '<h1>לא הצלחנו לטעון את השאלון</h1><p>נסו לרענן את הדף, או <a href="/kaspchem">חזרו לדף הראשי</a>.</p>'; });

  /* ---------- question screen ---------- */
  function crumb() { return '<div class="crumb">' + KaspIcon(topic.icon, 28) + '<span>' + esc(topic.name) + '</span><span class="kp-mini" aria-hidden="true">' + KaspProgress.miniHtml() + '</span></div>'; }

  function sparks() {
    var h = '';
    for (var i = 0; i < 10; i++) h += '<i style="--a:' + (i * 36) + 'deg;--d:' + (3.2 + (i % 3) * 0.9) + 'rem"></i>';
    return h;
  }

  function segs(p) {
    var h = '';
    for (var i = 0; i < p.total; i++) h += '<span class="' + (i < p.done ? 'done' : i === p.done ? 'cur' : '') + '"></span>';
    return h;
  }

  function step() {
    busy = false;
    var q = E.nextQuestion(topic, answers);
    if (!q) return result();
    var p = E.progress(topic, answers);
    var pct = Math.round(p.done / p.total * 100);
    var intro = p.done === 0 ? '<p class="help" style="margin-bottom:1rem">' + esc(topic.intro) + '</p>' : '';
    app.innerHTML =
      crumb() +
      '<div class="progress segs" role="progressbar" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '" aria-label="התקדמות בשאלון">' + segs(p) + '</div>' +
      '<div class="pmeta"><span>שאלה ' + (p.done + 1) + ' מתוך ' + p.total + '</span><span class="enc" aria-live="polite">' + esc(enc) + '</span></div>' +
      '<section class="q ' + (reduce ? '' : 'slide-in') + '" aria-labelledby="qt">' + intro +
      '<h1 id="qt">' + esc(q.text) + '</h1>' + (q.help ? '<p class="help">' + esc(q.help) + '</p>' : '') +
      (q.multi ? '<p class="multihint">אפשר לבחור יותר מתשובה אחת</p>' : '') +
      '<div class="opts" role="' + (q.multi ? 'group' : 'radiogroup') + '" aria-labelledby="qt">' +
      q.options.map(function (o) {
        var on = q.multi ? [].concat(answers[q.id] || []).indexOf(o.id) !== -1 : answers[q.id] === o.id;
        return '<button type="button" class="opt' + (q.multi ? ' chk' : '') + '" role="' + (q.multi ? 'checkbox' : 'radio') + '" aria-checked="' + on + '" data-q="' + q.id + '" data-o="' + o.id + '"' + (o.exclusive ? ' data-x="1"' : '') + '><span class="dot"></span><span>' + esc(o.label) + '</span></button>';
      }).join('') + '</div>' +
      (q.multi ? '<div class="multi-go"><button type="button" class="btn" id="mgo"' + ([].concat(answers[q.id] || []).length ? '' : ' disabled') + '>המשך</button></div>' : '') +
      (order.length ? '<div class="nav-row"><button type="button" class="btn link" id="back">חזרה לשאלה הקודמת</button></div>' : '') + '</section>';
    app.querySelector('.opts').addEventListener('click', q.multi ? onToggle : onPick);
    var go = document.getElementById('mgo'); if (go) go.addEventListener('click', function () { commitMulti(q); });
    var b = document.getElementById('back'); if (b) b.addEventListener('click', function () { history.back(); });
    KaspProgress.set(p.done / p.total, { back: goingBack }); goingBack = false;
    focusMain();
  }

  function onPick(ev) {
    var btn = ev.target.closest('.opt'); if (!btn || busy) return;
    busy = true; // ignore taps during the short transition so a double-tap can't answer the next question
    var q = btn.dataset.q, o = btn.dataset.o;
    [].forEach.call(app.querySelectorAll('.opt'), function (x) { x.setAttribute('aria-checked', x === btn); });
    var changed = JSON.stringify(answers[q]) !== JSON.stringify(o);
    answers[q] = o;
    if (order.indexOf(q) === -1) order.push(q);
    if (changed) { answers = E.pruneAnswers(topic, answers); order = order.filter(function (id) { return answers[id] != null; }); }
    var qdef = topic.questions.filter(function (x) { return x.id === q; })[0];
    enc = qdef.encourage || GENERIC_ENC[Math.min(order.length - 1, GENERIC_ENC.length - 1)];
    save();
    history.pushState({ n: order.length }, '');
    setTimeout(step, reduce ? 0 : 180); // brief confirmation of the tap before moving on
  }

  // Multi-select: toggling never advances; the explicit "continue" button commits. Exclusive options ("none of these", "not sure") clear the rest.
  function onToggle(ev) {
    var btn = ev.target.closest('.opt'); if (!btn || busy) return;
    var wasOn = btn.getAttribute('aria-checked') === 'true';
    var all = [].slice.call(app.querySelectorAll('.opt'));
    if (btn.dataset.x) all.forEach(function (x) { x.setAttribute('aria-checked', x === btn ? String(!wasOn) : 'false'); });
    else { all.forEach(function (x) { if (x.dataset.x) x.setAttribute('aria-checked', 'false'); }); btn.setAttribute('aria-checked', String(!wasOn)); }
    var any = all.some(function (x) { return x.getAttribute('aria-checked') === 'true'; });
    var go = document.getElementById('mgo'); if (go) go.disabled = !any;
  }

  function commitMulti(q) {
    if (busy) return;
    var picked = [].slice.call(app.querySelectorAll('.opt')).filter(function (x) { return x.getAttribute('aria-checked') === 'true'; }).map(function (x) { return x.dataset.o; });
    if (!picked.length) return;
    busy = true;
    var changed = JSON.stringify(answers[q.id]) !== JSON.stringify(picked);
    answers[q.id] = picked;
    if (order.indexOf(q.id) === -1) order.push(q.id);
    if (changed) { answers = E.pruneAnswers(topic, answers); order = order.filter(function (id) { return answers[id] != null; }); }
    enc = q.encourage || GENERIC_ENC[Math.min(order.length - 1, GENERIC_ENC.length - 1)];
    save();
    history.pushState({ n: order.length }, '');
    step();
  }

  window.addEventListener('popstate', function () {
    if (!topic) return;
    if (order.length) { var last = order.pop(); delete answers[last]; enc = ''; save(); goingBack = true; step(); }
  });

  /* ---------- result ---------- */
  var res = null;
  var PRELIM = '<p class="prelim">תוצאות ראשוניות בלבד</p>'; // the only caveat on the result screen; the lead form's consent text and the legal pages are unchanged
  function result() {
    res = E.evaluate(topic, answers);
    enc = '';
    app.innerHTML = crumb() + '<div class="progress segs" aria-hidden="true">' + segs({ done: E.progress(topic, answers).total, total: E.progress(topic, answers).total }) + '</div><div style="height:1.2rem"></div>' +
      '<section class="result" id="result" aria-labelledby="rt"><div class="scan" id="scan"><div class="ring" aria-hidden="true"></div><p>מסכמים את התשובות שלכם…</p></div></section>';
    KaspProgress.set(1);
    focusMain();
    setTimeout(reveal, reduce ? 0 : 1300);
  }

  function reveal() {
    var box = document.getElementById('result'); if (!box) return;
    var m = topic.messages, n = res.cardCount != null ? res.cardCount : res.count, html = '';
    if (res.outcome === 'found' && topic.kind === 'router') {
      html += routerFound(res.cards || [], n, m);
    } else if (res.outcome === 'found') {
      html += '<div class="head"><div class="big" id="num">' + (reduce ? n : 0) + '</div><div class="bigcap">נושאים שכדאי לברר</div><div class="goldline" aria-hidden="true"></div>' +
        '<h1 id="rt">' + esc(n === 1 ? 'זיהינו נושא אחד שכדאי לבדוק' : m.found.replace('{n}', n)) + ' ב' + esc(topic.name) + '</h1>' +
        PRELIM + '</div>' +
        '<ul class="finds">' + (res.cards || res.findings).map(function (f, i) {
          var body = f.parts
            ? '<span>' + esc(f.intro || '') + '</span>' + f.parts.map(function (p) { return '<span class="fx part"><b>' + esc(p.section || p.title) + '</b> ' + esc(p.why) + (p.step ? ' ' + esc(p.step) : '') + '</span>'; }).join('') + findingExtras({ step: f.step, official: f.official, refer: f.refer })
            : '<span>' + esc(f.why) + '</span>' + findingExtras(f);
          return '<li class="find" style="animation-delay:' + (reduce ? 0 : 500 + i * 220) + 'ms"><i class="mk" aria-hidden="true"></i><div><b>' + esc(f.title) + '</b>' + body + '</div></li>';
        }).join('') + '</ul>' +
        '<div class="cta-row"><button type="button" class="btn" id="cta">אני רוצה עזרה בבדיקה</button><p class="reassure">הבדיקה הראשונית חינמית, והשארת פרטים אינה התחייבות.</p><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
    } else if (res.outcome === 'insufficient') {
      html += '<div class="head"><h1 id="rt">' + esc(m.insufficient) + '</h1><p class="sub">' + esc(m.insufficientBody) + '</p>' + PRELIM + '</div>' +
        '<div class="cta-row" style="margin-top:1.6rem"><button type="button" class="btn ghost" id="fix" style="color:#fff">לחזור ולתקן תשובות</button><button type="button" class="btn" id="cta">אשמח לעזרה בהשלמת התמונה</button><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
    } else {
      html += '<div class="head"><h1 id="rt">' + esc(m.none) + '</h1><p class="sub">' + esc(m.noneBody) + '</p>' + PRELIM + '</div>' +
        '<div class="cta-row" style="margin-top:1.6rem"><a class="btn" href="/kaspchem">לבדוק תחום אחר</a><button type="button" class="btn link" id="cta">בכל זאת, אשמח שיסתכלו על זה</button><button type="button" class="btn link" id="fix">לחזור ולתקן תשובות</button></div>';
    }
    html += '<div id="lead-slot"></div>';
    box.innerHTML = html;
    if (res.outcome === 'found' && n > 0) box.classList.add('found');
    if (res.outcome === 'found' && !reduce && n > 0 && document.getElementById('num')) countUp(document.getElementById('num'), n);
    document.getElementById('rt').setAttribute('tabindex', '-1'); document.getElementById('rt').focus({ preventScroll: true });
    var cta = document.getElementById('cta');
    if (cta && settings.legal_approved !== true) { // launch gate: no contact form until the legal texts are approved
      var closed = document.createElement('p'); closed.className = 'note'; closed.textContent = 'השארת פרטים תיפתח בקרוב. בינתיים אפשר לבדוק תחומים נוספים.'; cta.replaceWith(closed); cta = null;
    }
    if (cta) cta.addEventListener('click', openForm);
    var fix = document.getElementById('fix'); if (fix) fix.addEventListener('click', function () { var last = order.pop(); delete answers[last]; save(); goingBack = true; step(); });
  }

  /* ---- the quick check (kind "router"): a personal heading + ONE sentence, then one card per recommended topic that links to that topic's own check ---- */
  function topicById(id) { return topics.filter(function (t) { return t.id === id && t.kind !== 'router'; })[0] || null; }
  function routerFound(cards, n, m) {
    var items = cards.map(function (c) { var t = topicById(c.topic || c.group); return { card: c, topic: t, name: t ? t.name : c.title }; });
    var names = items.slice(0, 3).map(function (x) { return 'ב' + x.name; });
    var list = names.length === 1 ? names[0] : names.length === 2 ? names[0] + ' ו' + names[1] : names[0] + ', ' + names[1] + ' ו' + names[2];
    var rest = n - names.length;
    var sentence = 'לפי התשובות שלכם, כדאי להתחיל ' + list + (rest > 0 ? ', ויש עוד ' + (rest === 1 ? 'תחום אחד' : rest + ' תחומים') + ' ברשימה' : '') + '.';
    return '<div class="head"><div class="goldline" aria-hidden="true"></div>' +
      '<h1 id="rt">' + esc(n === 1 ? 'זיהינו תחום אחד שכדאי להתחיל בו' : m.found.replace('{n}', n)) + '</h1>' +
      '<p class="qk-sentence">' + esc(sentence) + '</p>' + PRELIM + '</div>' +
      '<ul class="finds">' + items.map(function (x, i) {
        var c = x.card, parts = c.parts || [c];
        return '<li class="find" style="animation-delay:' + (reduce ? 0 : 400 + i * 180) + 'ms"><i class="mk" aria-hidden="true"></i><div><b>' + esc(c.title) + '</b>' +
          '<ul class="qk-reasons">' + parts.map(function (p) { return '<li>' + esc(p.why) + '</li>'; }).join('') + '</ul>' +
          (x.topic ? '<a class="btn qk-go" href="/kaspchem/check/' + esc(x.topic.id) + '">לבדיקה מלאה: ' + esc(x.topic.name) + '</a>' : '') + '</div></li>';
      }).join('') + '</ul>' +
      '<div class="cta-row"><button type="button" class="btn" id="cta">אני רוצה עזרה בבדיקה</button><p class="reassure">הבדיקה הראשונית חינמית, והשארת פרטים אינה התחייבות.</p><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
  }

  function safeUrl(u) { return /^https:\/\//.test(String(u || '')) ? u : null; }
  function heDate(d) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; }
  function findingExtras(f) {
    var h = '';
    if (f.step) h += '<span class="fx"><b>צעד מעשי:</b> ' + esc(f.step) + '</span>';
    var url = f.official && safeUrl(f.official.url);
    if (url) h += '<span class="fx"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(f.official.label || 'לבדיקה עצמית באתר הרשמי') + '</a>' + (f.official.checked ? ' <small>(הקישור נבדק ' + esc(heDate(f.official.checked)) + ')</small>' : '') + '</span>';
    if (f.refer) h += '<details class="fx fxd"><summary>להמשך טיפול ועלויות</summary>' + esc(f.refer) + '</details>';
    return h;
  }

  function countUp(el, n) {
    var t0 = performance.now(), dur = 700;
    (function f(t) { var k = Math.min(1, (t - t0) / dur); el.textContent = Math.round(n * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(f); })(t0);
  }

  /* ---------- lead form (opens inside the result screen) ---------- */
  function openForm() {
    var slot = document.getElementById('lead-slot');
    if (slot.firstChild) { slot.querySelector('input').focus(); return; }
    slot.innerHTML =
      '<form class="lead" id="lead" novalidate aria-labelledby="lt"><h2 id="lt">נחזור אליכם בנושא הבדיקה</h2>' +
      '<p style="margin:0;color:#3e5f63">שם וטלפון בלבד. דוא״ל הוא רשות.</p>' +
      '<div class="field"><label for="f-name">שם מלא</label><input id="f-name" name="name" type="text" autocomplete="name" required aria-describedby="e-name"><p class="err" id="e-name"></p></div>' +
      '<div class="field"><label for="f-phone">טלפון</label><input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" style="text-align:right" required aria-describedby="e-phone"><p class="err" id="e-phone"></p></div>' +
      '<div class="field"><label for="f-email">דוא״ל <small>(רשות)</small></label><input id="f-email" name="email" type="email" autocomplete="email" dir="ltr" style="text-align:right" aria-describedby="e-email"><p class="err" id="e-email"></p></div>' +
      '<div class="hp" aria-hidden="true"><label>אל תמלאו שדה זה<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<label class="check"><input type="checkbox" id="c-contact" aria-describedby="e-consent"><span>אני מאשר/ת שיחזרו אליי בנושא הבדיקה, ושהפרטים שלי יישמרו לצורך כך, בהתאם ל<a href="/kaspchem/privacy.html" target="_blank" rel="noopener">מדיניות הפרטיות</a>.</span></label>' +
      '<p class="err" id="e-consent"></p>' +
      '<label class="check"><input type="checkbox" id="c-mkt"><span>אני מסכים/ה לקבל מכספכם ומצפן כלכלי תוכן ועדכונים שיווקיים. אפשר לבטל בכל עת.</span></label>' +
      '<div id="form-err" role="alert"></div>' +
      '<button class="btn" type="submit" id="send">שליחה</button></form>';
    document.getElementById('cta').setAttribute('aria-expanded', 'true');
    document.getElementById('lead').addEventListener('submit', submit);
    // Clear a field's error as soon as the user fixes it.
    [['f-name', 'e-name'], ['f-phone', 'e-phone'], ['f-email', 'e-email'], ['c-contact', 'e-consent']].forEach(function (p) {
      var el = document.getElementById(p[0]);
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', function () { setErr(p[1], '', el); });
    });
    document.getElementById('f-name').focus();
    slot.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }

  function setErr(id, msg, input) { document.getElementById(id).textContent = msg || ''; if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false'); }

  function submit(ev) {
    ev.preventDefault();
    var f = ev.target, name = f.name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
    var ok = true, first = null;
    function bad(id, msg, input) { setErr(id, msg, input); if (msg) { ok = false; if (!first) first = input; } }
    bad('e-name', name.length < 2 ? 'נא להזין שם' : '', f.name);
    bad('e-phone', !/^(\+?972|0)[\s-]?[2-9][\d\s-]{6,10}$/.test(phone) ? 'נא להזין מספר טלפון תקין, למשל 050-1234567' : '', f.phone);
    bad('e-email', email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? 'כתובת הדוא״ל אינה תקינה' : '', f.email);
    var cc = document.getElementById('c-contact');
    bad('e-consent', !cc.checked ? 'כדי שנוכל לחזור אליכם, יש לאשר את תיבת הסימון' : '', cc);
    if (!ok) { first.focus(); return; }
    var btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'שולחים…';
    document.getElementById('form-err').innerHTML = '';
    fetch('/api/kaspchem/lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic.id, answers: answers, name: name, phone: phone, email: email, website: f.website.value, consentContact: true, consentMarketing: document.getElementById('c-mkt').checked })
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        if (o.j.ok) return thanks();
        throw new Error(o.j.message || 'לא הצלחנו לקלוט את הפנייה. נסו שוב.');
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = 'שליחה';
        var msg = (e && e.message && /[֐-׿]/.test(e.message)) ? e.message : 'לא הצלחנו לקלוט את הפנייה. בדקו את החיבור ונסו שוב.';
        document.getElementById('form-err').innerHTML = '<div class="formerr">' + esc(msg) + '</div>';
      });
  }

  function thanks() {
    try { sessionStorage.removeItem(STORE); } catch (e) {}
    var others = topics.filter(function (t) { return t.id !== topic.id && t.kind !== 'router'; }); // the quick check is not offered as "another topic"
    var slot = document.getElementById('lead-slot');
    slot.innerHTML = '<div class="lead done" id="done" tabindex="-1"><div class="tick"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg></div>' +
      '<h2>הפנייה התקבלה, תודה</h2><p>נחזור אליכם בנושא <strong>' + esc(topic.name) + '</strong>. בינתיים, אפשר להמשיך לבדוק תחומים נוספים:</p>' +
      '<div class="more">' + others.map(function (t) { return '<a href="/kaspchem/check/' + t.id + '">' + KaspIcon(t.icon, 26) + '<span>' + esc(t.name) + '</span></a>'; }).join('') + '</div></div>';
    var d = document.getElementById('done'); d.focus({ preventScroll: true }); d.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    var cta = document.getElementById('cta'); if (cta) { cta.hidden = true; }
  }
})();
