/*
 * Progress visuals for the question flow: a ring that fills and a coin jar that fills with coins. They show PROGRESS THROUGH THE CHECK only:
 * no amounts, no currency, never a promise of money. Pure SVG + CSS (transform/opacity), no libraries. Everything is aria-hidden; the real
 * accessible progress stays in the existing progressbar. Large versions sit beside the question on wide screens (#kp-ring / #kp-jar);
 * a compact pair is placed in the question header on narrow screens (miniHtml).
 * set(fraction) takes 0..1. By default the shown fraction never goes down (branching can add questions); pass {back:true} when the
 * user steps back.
 */
(function () {
  'use strict';
  var C = 2 * Math.PI * 52, COINS = 20, last = 0, NS = 'http://www.w3.org/2000/svg';

  function defs() {
    if (document.getElementById('kp-defs')) return;
    var d = document.createElementNS(NS, 'svg'); d.id = 'kp-defs'; d.setAttribute('width', '0'); d.setAttribute('height', '0'); d.setAttribute('aria-hidden', 'true'); d.setAttribute('focusable', 'false'); d.style.position = 'absolute';
    d.innerHTML = '<defs><linearGradient id="kp-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2aa79b"/><stop offset="1" stop-color="#e3b04b"/></linearGradient>' +
      '<radialGradient id="kp-coin" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff1c2"/><stop offset=".55" stop-color="#e3b04b"/><stop offset="1" stop-color="#b98417"/></radialGradient></defs>';
    document.body.appendChild(d);
  }

  function ringHtml(f, mini) {
    return '<svg class="kp-ring' + (mini ? ' mini-ring' : '') + '" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
      '<circle cx="60" cy="60" r="52" fill="none" stroke="#d3e4e2" stroke-width="10"/>' +
      '<circle class="kp-fg" cx="60" cy="60" r="52" fill="none" stroke="url(#kp-grad)" stroke-width="10" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="' + C.toFixed(1) + '" style="stroke-dashoffset:' + (C * (1 - f)).toFixed(1) + 'px"/>' +
      (mini ? '' : '<text class="kp-pct" x="60" y="70" text-anchor="middle">' + Math.round(f * 100) + '%</text>') + '</svg>';
  }

  function jarHtml(f, mini) {
    var n = Math.round(f * COINS), coins = '', i = 0, row = 0;
    for (row = 0; row < 8 && i < COINS; row++) {
      var xs = row % 2 === 0 ? [38, 60, 82] : [49, 71], y = 140 - row * 11;
      xs.forEach(function (x) {
        if (i >= COINS) return;
        coins += '<g transform="translate(' + x + ' ' + y + ')"><g class="kp-c' + (i < n ? ' on' : '') + '"><ellipse rx="13" ry="5" fill="url(#kp-coin)" stroke="#b98417" stroke-width="1.2"/><ellipse rx="7.5" ry="2.5" fill="none" stroke="#b98417" stroke-width=".9" opacity=".55"/></g></g>';
        i++;
      });
    }
    return '<svg class="kp-jar' + (mini ? ' mini-jar' : '') + '" viewBox="0 0 120 160" aria-hidden="true" focusable="false" data-coins="' + n + '">' +
      '<path d="M22 44Q22 38 28 38H92Q98 38 98 44V140Q98 152 86 152H34Q22 152 22 140Z" fill="rgba(255,255,255,.55)" stroke="#8fb0ad" stroke-width="3"/>' +
      '<path d="M30 52V128" stroke="#fff" stroke-opacity=".75" stroke-width="4" stroke-linecap="round" fill="none"/>' +
      '<g>' + coins + '</g>' +
      '<rect x="17" y="20" width="86" height="18" rx="6" fill="#8a5d0c"/><rect x="46" y="26" width="28" height="5" rx="2.5" fill="#4d3306"/></svg>';
  }

  function miniHtml() { return ringHtml(last, true) + jarHtml(last, true); }

  function applyRing(el, f) {
    var fg = el.querySelector('.kp-fg'); if (fg) fg.style.strokeDashoffset = (C * (1 - f)).toFixed(1) + 'px';
    var t = el.querySelector('.kp-pct'); if (t) t.textContent = Math.round(f * 100) + '%';
    el.setAttribute('data-frac', f.toFixed(2));
  }
  function applyJar(el, f) {
    var n = Math.round(f * COINS), k = 0;
    [].forEach.call(el.querySelectorAll('.kp-c'), function (c, i) {
      var on = i < n, was = c.classList.contains('on');
      c.style.transitionDelay = on && !was ? (k++ * 60) + 'ms' : '0ms';
      c.classList.toggle('on', on);
    });
    el.setAttribute('data-coins', String(n));
  }

  function set(f, opts) {
    f = Math.max(0, Math.min(1, Number(f) || 0));
    if (!(opts && opts.back)) f = Math.max(f, last);
    last = f;
    // two frames: freshly inserted elements first paint their previous state, so the change animates
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      [].forEach.call(document.querySelectorAll('.kp-ring'), function (el) { applyRing(el, f); });
      [].forEach.call(document.querySelectorAll('.kp-jar'), function (el) { applyJar(el, f); });
    }); });
  }

  function init() {
    defs();
    var r = document.getElementById('kp-ring'), j = document.getElementById('kp-jar');
    if (r) r.innerHTML = ringHtml(0, false) + '<p class="cap">התקדמות בבדיקה</p>';
    if (j) j.innerHTML = jarHtml(0, false) + '<p class="cap">המטבעות מסמלים התקדמות בבדיקה בלבד</p>';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.KaspProgress = { set: set, miniHtml: miniHtml, COINS: COINS };
})();
