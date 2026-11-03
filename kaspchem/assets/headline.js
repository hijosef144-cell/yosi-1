/*
 * Home headline, typed one sentence after another. The h1 keeps plain text for no-JS, search engines and screen readers (one stable
 * sr-only copy of every enabled sentence); the typed layer is aria-hidden. Sentence 3 needs a real number and stays OFF unless the impact
 * counter (impact.js) reports a measured integer n >= 1 through KaspHeadline.impact(n) / setThird(n). Nothing in this file contains a count.
 * Since the counter became two plain totals there is no honest "currently saving" number, so impact.js always reports null and sentence 3 stays off;
 * the hook stays so that a future, properly defined number can switch it on.
 *
 * Timing: the h1 is always painted at once with sentence 1 (the same text as without JS). Typing starts 300 ms after load, as before. If the page
 * carries impact.js, typing waits for its answer but never longer than 700 ms after load; an answer that comes later is ignored, so sentence 3
 * never appears mid-animation and the reserved height never changes while typing.
 */
(function () {
  'use strict';
  var h = document.getElementById('h');
  if (!h) return;
  var S1 = 'אתם משלמים יותר מדי...', S2 = 'המשכנתא? הביטוח?הבנק?';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var third = null, started = false, finished = false, timer = null, vis, txt, meas;
  var minPassed = false, capPassed = false, settled = false;
  function expectsImpact() { return !!document.querySelector('script[src*="/kaspchem/assets/impact.js"]'); }
  // Start (or, with reduced motion, close the window for sentence 3) once the minimum time has passed and impact.js answered or the cap ran out.
  function maybeRun() {
    if (started || !minPassed) return;
    if (settled || capPassed || !expectsImpact()) { if (reduce) started = true; else run(); }
  }

  function thirdSentence(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 1 || Math.floor(n) !== n) return null;
    return n === 1 ? 'ברגע זה יש אדם אחד שנעזר בנו וחוסך ומרוויח' : 'ברגע זה יש ' + n.toLocaleString('he-IL') + ' אנשים שנעזרים בנו וחוסכים ומרוויחים';
  }
  function sentences() { return third ? [S1, S2, third] : [S1, S2]; }

  function build() {
    var all = sentences();
    h.textContent = '';
    var sr = document.createElement('span'); sr.className = 'sr'; sr.textContent = all.join(' ');
    h.appendChild(sr);
    if (reduce) { // no motion: every enabled sentence is simply shown
      h.classList.add('tw', 'tw-static');
      all.forEach(function (s) { var l = document.createElement('span'); l.className = 'tw-line'; l.setAttribute('aria-hidden', 'true'); l.textContent = s; h.appendChild(l); });
      return;
    }
    h.classList.add('tw');
    meas = document.createElement('span'); meas.className = 'tw-meas'; meas.setAttribute('aria-hidden', 'true'); h.appendChild(meas);
    vis = document.createElement('span'); vis.className = 'tw-vis'; vis.setAttribute('aria-hidden', 'true');
    txt = document.createElement('span'); txt.className = 'tw-t';
    var cur = document.createElement('span'); cur.className = 'tw-cur'; cur.textContent = '_';
    vis.appendChild(txt); vis.appendChild(cur); h.appendChild(vis);
    measure();
  }

  // Reserve the height of the tallest sentence at the current width, so typing never moves the page.
  function measure() {
    if (!meas) return;
    var max = 0;
    sentences().forEach(function (s) { meas.textContent = s; max = Math.max(max, meas.offsetHeight); });
    meas.textContent = '';
    h.style.minHeight = max + 'px';
  }

  function finish(text) {
    finished = true; clearTimeout(timer);
    if (txt) txt.textContent = text;
    h.classList.add('tw-done');
  }

  function run() {
    if (reduce || started) return;
    started = true;
    var seq = sentences();
    seq = third ? seq : [S1, S2, S1]; // without sentence 3 the page rests on sentence 1 (the same text the no-JS page shows)
    var rest = seq[seq.length - 1], si = 0, ci = 0, typing = true, chars = [];
    function stop() { ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (e) { window.removeEventListener(e, onUser, true); }); document.removeEventListener('visibilitychange', onHide); }
    function onUser() { stop(); finish(rest); }
    function onHide() { if (document.hidden) { stop(); finish(rest); } }
    ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (e) { window.addEventListener(e, onUser, { capture: true, passive: true }); });
    document.addEventListener('visibilitychange', onHide);
    function tick() {
      if (finished) return;
      if (typing) {
        if (ci === 0) chars = Array.from(seq[si]);
        ci++; txt.textContent = chars.slice(0, ci).join('');
        if (ci >= chars.length) {
          if (si === seq.length - 1) { stop(); finish(rest); return; }
          typing = false; timer = setTimeout(tick, 1100); return;
        }
        timer = setTimeout(tick, 38);
      } else {
        ci--; txt.textContent = chars.slice(0, Math.max(ci, 0)).join('');
        if (ci <= 0) { typing = true; si++; ci = 0; timer = setTimeout(tick, 220); return; }
        timer = setTimeout(tick, 14);
      }
    }
    timer = setTimeout(tick, 120);
  }

  build();
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(measure, 150); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  setTimeout(function () { minPassed = true; maybeRun(); }, 300); // a late KaspHeadline.setThird(n) is accepted until the animation starts
  setTimeout(function () { capPassed = true; maybeRun(); }, 700);   // the longest we wait for the impact answer

  window.KaspHeadline = {
    thirdSentence: thirdSentence,
    // Allowed only before the animation starts; a non-integer or n < 1 keeps sentence 3 off.
    setThird: function (n) { var s = thirdSentence(n); if (!s || started) return false; third = s; build(); return true; },
    // Called once by impact.js with a number (always null at present: see the note at the top). Never throws, never blocks.
    impact: function (n) { if (settled) return; settled = true; if (n != null) this.setThird(n); maybeRun(); }
  };
})();
