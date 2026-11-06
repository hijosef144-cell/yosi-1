/*
 * The deep check: its question screens and its result screen. Loaded on demand by wizard.js (only for /kaspchem/check/deep, and only when the check is switched on),
 * so no other page pays for it. The flow itself is the shared wizard (answers, back/forward, resume); the questions, facts, gates and three-valued
 * evaluation are the shared engine (engine.js: buildDeep / deepNext / evaluateDeep). Every class here starts with dp-.
 *
 * Wording rule: nothing on these screens says that anything is granted or owed. Results are "worth checking", ordered by likelihood, and "initial results only".
 */
(function () {
  'use strict';
  var C = null, E = null, esc = null, reduce = false;
  var shown = { profile: 0, topics: 0 }; // the segments never shrink while the visitor moves forward through branching questions
  var lastCount = null, res = null;
  var CAP = 4; // cards shown first in each tier; the rest are on the page, behind an expander (nothing is dropped)

  function msgs() { return C.topic().messages || {}; }
  function M(k, d) { return msgs()[k] || d; }
  function topicName(id) { var t = C.topics().filter(function (x) { return x.id === id; })[0]; return t ? t.name : ''; }
  function phaseLabels() { var p = C.topic().phases; return p && p.length === 3 ? p : [{ id: 'profile', label: 'פרופיל' }, { id: 'topics', label: 'תחומים' }, { id: 'summary', label: 'סיכום' }]; }
  function pct(x) { return Math.round(Math.max(0, Math.min(1, x)) * 100); }
  function frac(p) { return p.total ? p.done / p.total : 1; }

  function init(ctx) { C = ctx; E = ctx.E; esc = ctx.esc; reduce = ctx.reduce; }

  /* ------------------------------------------------------------------ question screen ------------------------------------------------------------------ */

  function phaseStrip(cur) {
    var ph = phaseLabels(), idx = ph.map(function (p) { return p.id; }).indexOf(cur);
    return '<ol class="dp-phases" aria-label="שלבי הבדיקה">' + ph.map(function (p, i) {
      return '<li class="dp-ph' + (i < idx ? ' dp-ph-done' : i === idx ? ' dp-ph-cur' : '') + '"' + (i === idx ? ' aria-current="step"' : '') + '><span class="dp-ph-n" aria-hidden="true">' + (i + 1) + '</span>' + esc(p.label) + '</li>';
    }).join('') + '</ol>';
  }
  function bar(p, summary) {
    var overall = overallOf(p, summary);
    return '<div class="progress segs dp-segs" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct(overall) + '" aria-valuetext="' + pct(overall) + ' אחוז מהבדיקה" aria-label="התקדמות בבדיקה" data-frac="' + overall.toFixed(3) + '">' +
      '<span class="dp-seg"><i style="--w:' + pct(shown.profile) + '%"></i></span><span class="dp-seg"><i style="--w:' + pct(shown.topics) + '%"></i></span><span class="dp-seg"><i style="--w:' + (summary ? 100 : 0) + '%"></i></span></div>';
  }
  function overallOf(p, summary) {
    if (summary) return 1;
    var hasP = p.phases.profile.total > 0, wP = hasP ? 0.2 : 0, wT = hasP ? 0.75 : 0.95;
    return Math.min(1, wP * shown.profile + wT * shown.topics);
  }

  // The running line: how many topics are already certain enough to be worth checking, from the answers so far. No amounts, no promise.
  function runningLine(answers) {
    var n = E.evaluateDeep(C.cfg(), answers).counts.highCards;
    if (n === 0) return { n: 0, text: M('runningNone', 'עוד לא זיהינו נושא לבדיקה') };
    return { n: n, text: n === 1 ? M('runningOne', 'כרגע נושא אחד שכדאי לבדוק') : M('running', 'כרגע {n} נושאים שכדאי לבדוק').replace('{n}', n) };
  }

  function groupsOf(q) {
    var order = [], map = {}, rest = [];
    q.options.forEach(function (o) { if (o.group) { if (!map[o.group]) { map[o.group] = []; order.push(o.group); } map[o.group].push(o); } else rest.push(o); });
    return { order: order, map: map, rest: rest };
  }
  function optHtml(q, o, answers, n) {
    var on = q.multi ? [].concat(answers[q.id] || []).indexOf(o.id) !== -1 : answers[q.id] === o.id, hid = 'dh-' + n;
    return '<button type="button" class="opt' + (q.multi ? ' chk' : '') + (o.pna ? ' dp-pna' : '') + '" role="' + (q.multi ? 'checkbox' : 'radio') + '" aria-checked="' + on + '" data-q="' + esc(q.id) + '" data-o="' + esc(o.id) + '"' + (o.exclusive ? ' data-x="1"' : '') + (o.hint ? ' aria-describedby="' + hid + '"' : '') + '><span class="dot"></span><span class="dp-lbl">' + esc(o.label) + (o.hint ? '<small class="dp-hint" id="' + hid + '" aria-hidden="true">' + esc(o.hint) + '</small>' : '') + '</span></button>';
  }
  function optionsHtml(q, answers) {
    var g = groupsOf(q), n = 0, h = '';
    g.order.forEach(function (name, gi) {
      h += '<div class="dp-group" role="group" aria-labelledby="dg-' + gi + '"><p class="dp-gl" id="dg-' + gi + '">' + esc(name) + '</p>' + g.map[name].map(function (o) { return optHtml(q, o, answers, n++); }).join('') + '</div>';
    });
    return h + g.rest.map(function (o) { return optHtml(q, o, answers, n++); }).join('');
  }
  // The option a visitor means by "skip": "prefer not to answer" when the question has it, otherwise its "don't know" option.
  function skipOption(q) {
    var pna = q.options.filter(function (o) { return o.pna; })[0];
    return pna || q.options.filter(function (o) { return o.unknown; })[0] || null;
  }

  function step() {
    var cfg = C.cfg(), answers = C.answers(), order = C.order(), app = C.app;
    var q = E.deepNext(cfg, answers);
    if (!q) return result();
    var p = E.deepProgress(cfg, answers), back = C.goingBack();
    if (back) { shown.profile = frac(p.phases.profile); shown.topics = frac(p.phases.topics); }
    else { shown.profile = Math.max(shown.profile, frac(p.phases.profile)); shown.topics = Math.max(shown.topics, frac(p.phases.topics)); }
    var run = runningLine(answers), bump = lastCount !== null && run.n !== lastCount && !reduce;
    lastCount = run.n;
    var skip = skipOption(q), first = p.done === 0;
    var where = q.phase === 'profile' ? 'שאלות על המצב שלכם' : 'תחום: ' + topicName(q.topicId);
    var top = C.topic();
    app.innerHTML =
      C.crumb() + phaseStrip(q.phase) + bar(p, false) +
      '<div class="pmeta"><span class="dp-where">' + esc(where) + '</span><span class="dp-qn">שאלה ' + (p.done + 1) + '</span></div>' +
      '<p class="dp-count' + (bump ? ' dp-bump' : '') + '" id="dp-count" role="status" aria-live="polite" data-n="' + run.n + '">' + esc(run.text) + '</p>' +
      '<section class="q dp-q ' + (reduce ? '' : 'slide-in') + '" aria-labelledby="qt">' + (first ? '<p class="help" style="margin-bottom:1rem">' + esc(top.intro) + '</p>' : '') +
      (q.subject && q.subject !== 'me' ? '<p class="dp-subj dp-subj-q"><span class="dp-chip">' + esc(M('subjectLine', 'עבור: {s}').replace('{s}', (((cfg.subjects || {})[q.subject] || {}).label) || q.subject)) + '</span></p>' : '') + '<h1 id="qt">' + esc(q.text) + '</h1>' + (q.help ? '<p class="help">' + esc(q.help) + '</p>' : '') +
      (q.sensitive ? '<p class="dp-why" id="dp-why"><b>למה שואלים?</b> ' + esc(q.sensitiveWhy || '') + ' ' + esc(M('sensitiveNote', 'אפשר לבחור ״מעדיפ/ה לא לענות״ ונמשיך. אז נציין בתוצאה שחסר מידע.')) + '</p>' : '') +
      (q.multi ? '<p class="multihint">אפשר לבחור יותר מתשובה אחת</p>' : '') +
      '<div class="opts dp-opts" role="' + (q.multi ? 'group' : 'radiogroup') + '" aria-labelledby="qt"' + (q.sensitive ? ' aria-describedby="dp-why"' : '') + '>' + optionsHtml(q, answers) + '</div>' +
      (q.multi ? '<div class="multi-go"><button type="button" class="btn" id="mgo"' + ([].concat(answers[q.id] || []).length ? '' : ' disabled') + '>המשך</button></div>' : '') +
      '<div class="nav-row dp-nav">' + (order.length ? '<button type="button" class="btn link" id="back">חזרה לשאלה הקודמת</button>' : '<span></span>') +
      (skip ? '<button type="button" class="btn link dp-skip" id="dp-skip" data-o="' + esc(skip.id) + '">דילוג על השאלה</button>' : '') + '</div></section>';
    app.querySelector('.opts').addEventListener('click', q.multi ? C.onToggle : C.onPick);
    var go = document.getElementById('mgo'); if (go) go.addEventListener('click', function () { C.commitMulti(q); });
    var b = document.getElementById('back'); if (b) b.addEventListener('click', function () { C.back(); });
    var sk = document.getElementById('dp-skip');
    if (sk) sk.addEventListener('click', function () { // skipping IS answering with the "not known / prefer not to answer" option
      var btn = app.querySelector('.opt[data-o="' + sk.dataset.o + '"]'); if (!btn) return;
      btn.click();
      if (q.multi) { var g2 = document.getElementById('mgo'); if (g2 && !g2.disabled) g2.click(); }
    });
    var ps = { profile: shown.profile, topics: shown.topics };
    window.KaspProgress.set(overallOf(p, false), { back: back });
    C.focusMain();
    return ps;
  }

  /* ------------------------------------------------------------------ result ------------------------------------------------------------------ */

  function safeUrl(u) { return /^https:\/\//.test(String(u || '')) ? u : null; }
  function heDate(d) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; }

  // The three parts of a right: what it is (the finding's reason), how it works (its practical step), who can help (official link + referral text).
  function help(f) {
    var h = '', url = f.official && safeUrl(f.official.url);
    if (url) h += '<p class="dp-link"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(f.official.label || 'לבדיקה עצמית באתר הרשמי') + '</a>' + (f.official.checked ? ' <small>(הקישור נבדק ' + esc(heDate(f.official.checked)) + ')</small>' : '') + '</p>';
    if (f.refer) h += '<p>' + esc(f.refer) + '</p>';
    return h;
  }
  function partsHtml(c, tier) {
    var items = c.parts || [c], get = [], how = [];
    items.forEach(function (f) {
      var label = c.parts ? '<b>' + esc(f.section || f.title) + '</b> ' : '';
      if (f.why) get.push('<p>' + label + esc(f.why) + '</p>');
      if (f.step) how.push('<p>' + label + esc(f.step) + '</p>');
    });
    var helpH = help(c.parts ? { official: c.official || items[0].official, refer: c.refer || items[0].refer } : c);
    var P = function (k, d) { return M(k, d); };
    if (tier === 'missing') { // no claim about the visitor: only how to find out
      var more = (how.join('') + (helpH ? '<div class="dp-help">' + helpH + '</div>' : ''));
      return more ? '<details class="dp-part dp-det"><summary>איך לברר</summary>' + more + '</details>' : '';
    }
    return (get.length ? '<div class="dp-part"><h3 class="dp-pt">' + esc(P('partGet', 'מה כדאי לבדוק')) + '</h3>' + get.join('') + '</div>' : '') +
      (how.length ? '<details class="dp-part dp-det"><summary>' + esc(P('partHow', 'איך זה עובד')) + '</summary>' + how.join('') + '</details>' : '') +
      (helpH ? '<details class="dp-part dp-det"><summary>' + esc(P('partHelp', 'מי יכול לעזור')) + '</summary><div class="dp-help">' + helpH + '</div></details>' : '');
  }
  function missingLine(c, given) {
    var items = c ? (c.parts || [c]) : [], seen = {}, list = given || [];
    if (!given) { list = []; items.forEach(function (f) { (f.missing || []).forEach(function (m) { if (!seen[m.id]) { seen[m.id] = true; list.push(m); } }); }); }
    return '<ul class="dp-miss">' + list.map(function (m) {
      return '<li><span class="dp-mq">' + esc(M('missingLine', 'חסר מידע:')) + ' ' + esc(m.text) + '</span> <button type="button" class="btn link dp-fill" data-ask="' + esc(m.ask || m.id) + '">' + esc(M('completeAnswer', 'להשלמת התשובה')) + '</button></li>';
    }).join('') + '</ul>';
  }
  // Several rights that wait for the same unanswered question are shown as ONE item: the question, a button to answer it, and the list of what depends on it.
  function groupHtml(g, i) {
    // ONE calm card per missing answer: what is missing (one sentence), a neutral line that it touches several areas, and the action. No list of rights.
    var m = g.missing[0] || {};
    return '<li class="find dp-card dp-card-missing dp-group-card" style="animation-delay:' + (reduce ? 0 : 300 + i * 140) + 'ms"><i class="mk" aria-hidden="true"></i><div><b>' + esc(M('missingGroupTitle', 'חסרה תשובה אחת, והיא משפיעה על כמה תחומים בבדיקה')) + '</b>' +
      '<p class="dp-mq dp-mq-one">' + esc(M('missingLine', 'חסר מידע:')) + ' ' + esc(m.text || '') + '</p>' +
      '<p class="dp-note">' + esc(M('missingGroupNote', 'תשובה זו משפיעה על כמה תחומים בבדיקה.')) + '</p>' +
      '<button type="button" class="btn dp-fill dp-fill-main" data-ask="' + esc(m.ask || m.id || '') + '">' + esc(M('completeAnswer', 'להשלמת התשובה')) + '</button></div></li>';
  }
  function itemHtml(it, i, tier) { return it.folded ? groupHtml(it, i) : cardHtml(it.card || it, i, tier); }
  // Whom a finding is about. Always named when the finding comes from a per-person rule; for another person the card also says that it is about that person, not about the respondent.
  function subjectHtml(c) {
    if (!c.subject || !c.subjectLabel) return '';
    var meta = ((C.cfg() || {}).subjects || {})[c.subject] || {};
    var chip = '<p class="dp-subj"><span class="dp-chip">' + esc(M('subjectLine', 'עבור: {s}').replace('{s}', c.subjectLabel)) + '</span></p>';
    return chip + (c.subject !== 'me' ? '<p class="dp-subjnote">' + esc(M('subjectNote', 'ההתאמה נבדקה לפי התשובות שלכם על {to}, ולא לפי מצבכם.').replace('{to}', meta.to || c.subjectLabel)) + '</p>' : '');
  }
  function cardHtml(c, i, tier) {
    var title = c.parts ? c.title : c.title;
    var weak = tier === 'low' ? (c.parts ? c.parts[0] : c).weakNote : '';
    return '<li class="find dp-card dp-card-' + tier + (c.subject ? ' dp-card-for' : '') + '" style="animation-delay:' + (reduce ? 0 : 300 + i * 140) + 'ms"><i class="mk" aria-hidden="true"></i><div><b>' + esc(title) + '</b>' + subjectHtml(c) +
      (tier === 'missing' ? missingLine(c) : '') + (weak ? '<p class="dp-weak">' + esc(weak) + '</p>' : '') + partsHtml(c, tier) + '</div></li>';
  }
  function tierHtml(tier, cards, title, sub) {
    if (!cards.length) return '';
    var top = cards.slice(0, CAP), more = cards.slice(CAP), id = 'dp-' + tier;
    var body = '<ul class="finds dp-top">' + top.map(function (c, i) { return itemHtml(c, i, tier); }).join('') + '</ul>' +
      (more.length ? '<ul class="finds dp-rest" id="' + id + '-more" hidden>' + more.map(function (c, i) { return itemHtml(c, i, tier); }).join('') + '</ul>' +
        '<div class="dp-tog-row"><button type="button" class="btn dp-tog" id="' + id + '-tog" aria-expanded="false" aria-controls="' + id + '-more" data-n="' + more.length + '">הצגת כל הנושאים (' + more.length + ')</button></div>' : '');
    if (tier === 'low') { // collapsed by default
      return '<details class="dp-tier dp-low" id="dp-low"><summary class="dp-tier-h"><span class="dp-tt">' + esc(title) + '</span> <span class="dp-n">(' + cards.length + ')</span></summary><p class="dp-tier-sub">' + esc(sub) + '</p>' + body + '</details>';
    }
    return '<section class="dp-tier dp-' + tier + '" id="dp-sec-' + tier + '" aria-labelledby="' + id + '-h"><div class="dp-tier-h"><h2 class="dp-tt" id="' + id + '-h">' + esc(title) + '</h2> <span class="dp-n" aria-label="' + cards.length + ' פריטים">(' + cards.length + ')</span></div><p class="dp-tier-sub">' + esc(sub) + '</p>' + body + '</section>';
  }

  function result() {
    var cfg = C.cfg(), answers = C.answers(), p = E.deepProgress(cfg, answers);
    if (E.deepNext(cfg, answers)) return step(); // never a result from answers that are not complete for this flow
    shown.profile = 1; shown.topics = 1;
    res = E.evaluateDeep(cfg, answers);
    C.app.innerHTML = C.crumb() + phaseStrip('summary') + bar(p, true) + '<div style="height:1.2rem"></div>' +
      '<section class="result dp-result" id="result" aria-labelledby="rt"><div class="scan" id="scan"><div class="ring" aria-hidden="true"></div><p>מסכמים את התשובות שלכם…</p></div></section>';
    window.KaspProgress.set(1);
    C.focusMain();
    setTimeout(reveal, reduce ? 0 : 1000);
  }

  function reveal() {
    var box = document.getElementById('result'); if (!box) return;
    var hi = res.highCards, mi = res.missingItems, lo = res.lowCards, n = hi.length, html = '';
    // The page heading is neutral; the tier names are the section titles. The count (or the reason for no result) is the line under the heading.
    var sub = n ? (n === 1 ? M('foundOne', 'נושא אחד בסבירות גבוהה שכדאי לבדוק') : M('found', '{n} נושאים בסבירות גבוהה שכדאי לבדוק').replace('{n}', n))
      : mi.length ? M('insufficient', 'חסר לנו מידע כדי להצביע על הזדמנות לבדיקה') + '. ' + M('insufficientBody', '') : M('none', 'לא עלה נושא מיוחד לבדיקה כרגע') + '. ' + M('noneBody', '');
    html += '<div class="head"><div class="goldline" aria-hidden="true"></div><h1 id="rt">' + esc(M('resultTitle', 'תוצאות הבדיקה המעמיקה')) + '</h1>' +
      '<p class="sub dp-resultsub">' + esc(sub) + '</p><p class="prelim">תוצאות ראשוניות בלבד</p></div>';
    html += tierHtml('high', hi, M('highTitle', 'סבירות גבוהה'), M('highSub', ''));
    html += tierHtml('missing', mi, M('missingTitle', 'חסר מידע — כדאי להשלים בדיקה'), M('missingSub', ''));
    html += tierHtml('low', lo, M('lowTitle', 'סבירות נמוכה'), M('lowSub', ''));
    html += '<div class="cta-row dp-cta">' +
      (!n ? '<button type="button" class="btn link" id="fix">לחזור ולתקן תשובות</button>' : '') + '<a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';
    box.innerHTML = html;
    if (n) box.classList.add('found');
    var rt = document.getElementById('rt'); rt.setAttribute('tabindex', '-1'); rt.focus({ preventScroll: true });
    C.wireFix(function () { C.fixLast(); });
    [].forEach.call(box.querySelectorAll('.dp-tog'), function (tog) {
      tog.addEventListener('click', function () {
        var more = document.getElementById(tog.getAttribute('aria-controls')), open = tog.getAttribute('aria-expanded') === 'true';
        more.hidden = open; tog.setAttribute('aria-expanded', String(!open));
        tog.textContent = open ? 'הצגת כל הנושאים (' + tog.dataset.n + ')' : 'הצגת פחות';
      });
    });
    [].forEach.call(box.querySelectorAll('.dp-fill'), function (b) { b.addEventListener('click', function () { C.goTo(b.dataset.ask); }); });
  }

  window.KaspDeep = { init: init, step: step, result: result };
})();
