/*
 * Impact counter on the home page. Reads the public aggregate (/api/kaspchem/impact) and fills the section that is baked into the page as
 * hidden. Without JavaScript, when the counter is switched off, when the answer is empty or when anything fails, the section simply stays hidden:
 * no zeros, no placeholder. Nothing in this file contains a figure; every number comes from the endpoint.
 *
 * It also tells the headline (headline.js) once whether a real "active now" number arrived, so sentence 3 can be typed. See KaspHeadline.impact().
 */
(function () {
  'use strict';
  var sec = document.getElementById('impact');
  var done = false;
  function settle(n) { if (done) return; done = true; try { if (window.KaspHeadline && window.KaspHeadline.impact) window.KaspHeadline.impact(n); } catch (e) {} }
  if (!sec || !window.fetch) { settle(null); return; }

  var KINDS = ['ongoing_saving', 'one_time_refund', 'located_funds'];
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var num = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0; };

  function valid(d) {
    if (!d || d.ok !== true || d.enabled !== true || !d.amounts || !num(d.families_helped) || Math.floor(d.families_helped) !== d.families_helped) return false;
    if (!KINDS.every(function (k) { return num(d.amounts[k]); })) return false;
    if (isNaN(Date.parse(d.as_of))) return false;
    return d.families_helped > 0 || KINDS.some(function (k) { return d.amounts[k] > 0; }); // never present an empty counter as a claim
  }
  // Exact amounts: whole shekels have no decimals; any agorot are shown in full (never rounded).
  function fmt(v, dec) { return v.toLocaleString('he-IL', { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
  var shekel = function (v, dec) { return fmt(v, dec) + ' ₪'; };
  var decimals = function (v) { return Math.round(v * 100) % 100 === 0 ? 0 : 2; };

  // A number is two stacked copies: .imp-fin is the real text (read once by screen readers, fixes the width), .imp-v is the animated decoration.
  function put(box, finalText) {
    box.querySelector('.imp-fin').textContent = finalText;
    box.querySelector('.imp-v').textContent = finalText;
  }
  function countUp(box, value, dec, render) {
    var el = box.querySelector('.imp-v'), t0 = null, dur = 1400;
    function f(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = render(k >= 1 ? value : Math.round(value * e * Math.pow(10, dec)) / Math.pow(10, dec));
      if (k < 1) requestAnimationFrame(f);
    }
    el.textContent = render(0);
    requestAnimationFrame(f);
  }

  function render(d) {
    var jobs = [];
    var fam = document.getElementById('imp-fam');
    if (d.families_helped > 0) {
      var n = d.families_helped, box = fam.querySelector('.imp-num');
      var r = function (v) { return fmt(v, 0); };
      put(box, r(n));
      fam.querySelector('.imp-cap').textContent = n === 1 ? 'משפחה נעזרה' : 'משפחות נעזרו';
      fam.hidden = false;
      jobs.push({ box: box, run: function () { countUp(box, n, 0, r); } });
    } else fam.hidden = true;

    KINDS.forEach(function (k) {
      var li = sec.querySelector('[data-kind="' + k + '"]'), v = d.amounts[k];
      if (!li) return;
      if (!(v > 0)) { li.hidden = true; return; }
      var dec = decimals(v), r = function (x) { return shekel(x, dec); };
      put(li.querySelector('.imp-amt'), r(v));
      li.hidden = false;
      var amt = li.querySelector('.imp-amt');
      jobs.push({ box: amt, run: function () { countUp(amt, v, dec, r); } });
    });

    var when = new Date(d.as_of), upd = document.getElementById('imp-upd');
    var hhmm = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).format(when);
    upd.textContent = 'מתעדכן אחת לשעה. נכון ל־' + hhmm;
    upd.setAttribute('data-as-of', d.as_of);

    sec.hidden = false;
    if (reduce || !jobs.length) return; // no motion: the final figures are already in place
    // Each figure counts up when it itself scrolls into view (so a tall section on a phone never animates out of sight).
    if (!('IntersectionObserver' in window)) { jobs.forEach(function (j) { j.run(); }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); jobs.filter(function (j) { return j.box === e.target; }).forEach(function (j) { j.run(); }); } });
    }, { threshold: 0.6 });
    jobs.forEach(function (j) { io.observe(j.box); });
  }

  var ctl = window.AbortController ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); settle(null); }, 4000);
  fetch('/api/kaspchem/impact', { headers: { Accept: 'application/json' }, credentials: 'same-origin', signal: ctl ? ctl.signal : undefined })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      clearTimeout(timer);
      if (!valid(d)) { settle(null); return; }
      settle(d.active_now);   // the headline decides for itself whether this is a usable integer >= 1
      render(d);
    })
    .catch(function () { clearTimeout(timer); settle(null); });
})();
