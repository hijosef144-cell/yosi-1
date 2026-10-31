(function () {
  'use strict';
  var E = window.KaspchemEngine;
  var app = document.getElementById('app');
  var main = document.getElementById('main');
  var topicId = (location.pathname.match(/\/kaspchem\/check\/([a-z-]+)/) || [])[1];
  var settings = {}, busy = false, topics = [], topic = null, answers = {}, order = [], enc = '';
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
      document.title = topic.name + ' – בדיקה בכספכם';
      load();
      answers = E.pruneAnswers(topic, answers);
      order = order.filter(function (id) { return answers[id] != null; });
      history.replaceState({ n: order.length }, '');
      step();
    })
    .catch(function () { app.innerHTML = '<h1>לא הצלחנו לטעון את השאלון</h1><p>נסו לרענן את הדף, או <a href="/kaspchem">חזרו לדף הראשי</a>.</p>'; });

  /* ---------- question screen ---------- */
  function crumb() { return '<div class="crumb">' + KaspIcon(topic.icon, 28) + '<span>' + esc(topic.name) + '</span></div>'; }

  function step() {
    busy = false;
    var q = E.nextQuestion(topic, answers);
    if (!q) return result();
    var p = E.progress(topic, answers);
    var pct = Math.round(p.done / p.total * 100);
    var intro = p.done === 0 ? '<p class="help" style="margin-bottom:1rem">' + esc(topic.intro) + '</p>' : '';
    app.innerHTML =
      crumb() +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '" aria-label="התקדמות בשאלון"><i style="width:' + pct + '%"></i></div>' +
      '<div class="pmeta"><span>שאלה ' + (p.done + 1) + ' מתוך ' + p.total + '</span><span class="enc" aria-live="polite">' + esc(enc) + '</span></div>' +
      '<section class="q ' + (reduce ? '' : 'slide-in') + '" aria-labelledby="qt">' + intro +
      '<h1 id="qt">' + esc(q.text) + '</h1>' + (q.help ? '<p class="help">' + esc(q.help) + '</p>' : '') +
      '<div class="opts" role="radiogroup" aria-labelledby="qt">' +
      q.options.map(function (o) {
        return '<button type="button" class="opt" role="radio" aria-checked="' + (answers[q.id] === o.id) + '" data-q="' + q.id + '" data-o="' + o.id + '"><span class="dot"></span><span>' + esc(o.label) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="nav-row">' + (order.length ? '<button type="button" class="btn link" id="back">חזרה לשאלה הקודמת</button>' : '<span></span>') + '</div></section>';
    app.querySelector('.opts').addEventListener('click', onPick);
    var b = document.getElementById('back'); if (b) b.addEventListener('click', function () { history.back(); });
    focusMain();
  }

  function onPick(ev) {
    var btn = ev.target.closest('.opt'); if (!btn || busy) return;
    busy = true; // ignore taps during the short transition so a double-tap can't answer the next question
    var q = btn.dataset.q, o = btn.dataset.o;
    [].forEach.call(app.querySelectorAll('.opt'), function (x) { x.setAttribute('aria-checked', x === btn); });
    var changed = answers[q] !== o;
    answers[q] = o;
    if (order.indexOf(q) === -1) order.push(q);
    if (changed) { answers = E.pruneAnswers(topic, answers); order = order.filter(function (id) { return answers[id] != null; }); }
    var qdef = topic.questions.filter(function (x) { return x.id === q; })[0];
    enc = qdef.encourage || GENERIC_ENC[Math.min(order.length - 1, GENERIC_ENC.length - 1)];
    save();
    history.pushState({ n: order.length }, '');
    setTimeout(step, reduce ? 0 : 180); // brief confirmation of the tap before moving on
  }

  window.addEventListener('popstate', function () {
    if (!topic) return;
    if (order.length) { var last = order.pop(); delete answers[last]; enc = ''; save(); step(); }
  });

  /* ---------- result ---------- */
  var res = null;
  function result() {
    res = E.evaluate(topic, answers);
    enc = '';
    app.innerHTML = crumb() + '<div class="progress" aria-hidden="true"><i style="width:100%"></i></div><div style="height:1.2rem"></div>' +
      '<section class="result" id="result" aria-labelledby="rt"><div class="scan" id="scan"><div class="coin" aria-hidden="true">₪</div><p>מסכמים את התשובות שלכם…</p></div></section>';
    focusMain();
    setTimeout(reveal, reduce ? 0 : 1300);
  }

  function reveal() {
    var box = document.getElementById('result'); if (!box) return;
    var m = topic.messages, n = res.count, html = '';
    if (res.outcome === 'found') {
      html += '<div class="head"><div class="big" id="num" aria-hidden="true">' + (reduce ? n : 0) + '</div>' +
        '<h1 id="rt">' + esc(n === 1 ? 'זיהינו נושא אחד שכדאי לבדוק' : m.found.replace('{n}', n)) + ' ב' + esc(topic.name) + '</h1>' +
        '<p class="sub">אלה נושאים שכדאי לבדוק, לפי התשובות שלכם בלבד. זו אינה זכאות מאומתת ואינה הבטחה לכסף.</p></div>' +
        '<ul class="finds">' + res.findings.map(function (f, i) {
          return '<li class="find" style="animation-delay:' + (reduce ? 0 : 500 + i * 220) + 'ms"><b>' + esc(f.title) + '</b><span>' + esc(f.why) + '</span></li>';
        }).join('') + '</ul>' +
        '<div class="cta-row"><button type="button" class="btn" id="cta">אני רוצה עזרה בבדיקה</button><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
    } else if (res.outcome === 'insufficient') {
      html += '<div class="head"><h1 id="rt">' + esc(m.insufficient) + '</h1><p class="sub">' + esc(m.insufficientBody) + '</p></div>' +
        '<div class="cta-row" style="margin-top:1.6rem"><button type="button" class="btn ghost" id="fix" style="color:#fff">לחזור ולתקן תשובות</button><button type="button" class="btn" id="cta">אשמח לעזרה בהשלמת התמונה</button><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
    } else {
      html += '<div class="head"><h1 id="rt">' + esc(m.none) + '</h1><p class="sub">' + esc(m.noneBody) + '</p></div>' +
        '<div class="cta-row" style="margin-top:1.6rem"><a class="btn" href="/kaspchem">לבדוק תחום אחר</a><button type="button" class="btn link" id="cta">בכל זאת, אשמח שיסתכלו על זה</button><button type="button" class="btn link" id="fix">לחזור ולתקן תשובות</button></div>';
    }
    html += '<p class="note">הבדיקה כללית ומבוססת על התשובות שלכם בלבד. היא אינה ייעוץ מקצועי.</p><div id="lead-slot"></div>';
    box.innerHTML = html;
    if (res.outcome === 'found' && !reduce && n > 0) countUp(document.getElementById('num'), n);
    document.getElementById('rt').setAttribute('tabindex', '-1'); document.getElementById('rt').focus({ preventScroll: true });
    var cta = document.getElementById('cta');
    if (cta && settings.legal_approved !== true) { // launch gate: no contact form until the legal texts are approved
      var closed = document.createElement('p'); closed.className = 'note'; closed.textContent = 'השארת פרטים תיפתח בקרוב. בינתיים אפשר לבדוק תחומים נוספים.'; cta.replaceWith(closed); cta = null;
    }
    if (cta) cta.addEventListener('click', openForm);
    var fix = document.getElementById('fix'); if (fix) fix.addEventListener('click', function () { var last = order.pop(); delete answers[last]; save(); step(); });
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
    var others = topics.filter(function (t) { return t.id !== topic.id; });
    var slot = document.getElementById('lead-slot');
    slot.innerHTML = '<div class="lead done" id="done" tabindex="-1"><div class="tick"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg></div>' +
      '<h2>הפנייה התקבלה, תודה</h2><p>נחזור אליכם בנושא <strong>' + esc(topic.name) + '</strong>. בינתיים, אפשר להמשיך לבדוק תחומים נוספים:</p>' +
      '<div class="more">' + others.map(function (t) { return '<a href="/kaspchem/check/' + t.id + '">' + KaspIcon(t.icon, 26) + '<span>' + esc(t.name) + '</span></a>'; }).join('') + '</div></div>';
    var d = document.getElementById('done'); d.focus({ preventScroll: true }); d.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    var cta = document.getElementById('cta'); if (cta) { cta.hidden = true; }
  }
})();
