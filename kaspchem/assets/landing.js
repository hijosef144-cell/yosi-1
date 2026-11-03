(function () {
  'use strict';
  var list = document.getElementById('tiles');

  // Clockwise ring of light. Order is derived from the tiles' real on-screen positions (angle around the grid centre),
  // so it stays clockwise whether the grid is 2 columns or 5, and in RTL.
  var timer = null, lastCols = 0;
  function ringOrder(tiles) {
    var boxes = tiles.map(function (el) { var r = el.getBoundingClientRect(); return { el: el, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    var cx = boxes.reduce(function (s, b) { return s + b.x; }, 0) / boxes.length;
    var cy = boxes.reduce(function (s, b) { return s + b.y; }, 0) / boxes.length;
    boxes.forEach(function (b) { b.a = Math.atan2(b.y - cy, b.x - cx); }); // screen y points down → increasing angle is clockwise
    var start = -Math.PI * 0.75; // top-left
    boxes.forEach(function (b) { b.k = (b.a - start + 2 * Math.PI) % (2 * Math.PI); });
    return boxes.sort(function (p, q) { return p.k - q.k; }).map(function (b) { return b.el; });
  }

  function startLight() {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var tiles = [].slice.call(list.querySelectorAll('.tile'));
    if (reduce || !tiles.length) return;
    var order = ringOrder(tiles), i = 0;
    function tick() {
      tiles.forEach(function (t) { t.classList.remove('lit'); });
      order[i % order.length].classList.add('lit');
      i++;
    }
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 1300);
    // Pause when the tab is hidden or the user is interacting with a tile.
    document.addEventListener('visibilitychange', function () { if (document.hidden) clearInterval(timer); else { clearInterval(timer); timer = setInterval(tick, 1300); } });
    list.addEventListener('pointerenter', function () { clearInterval(timer); tiles.forEach(function (t) { t.classList.remove('lit'); }); });
    list.addEventListener('pointerleave', function () { clearInterval(timer); timer = setInterval(tick, 1300); });
    window.addEventListener('resize', function () {
      var cols = getComputedStyle(list).gridTemplateColumns.split(' ').length;
      if (cols !== lastCols) { lastCols = cols; order = ringOrder(tiles); i = 0; }
    });
    lastCols = getComputedStyle(list).gridTemplateColumns.split(' ').length;
  }

  // Tiles are baked into the HTML (no layout shift, works before JS). Live config only supplies optional legal-entity details.
  startLight();
  fetch('/api/kaspchem/config').then(function (r) { return r.ok ? r.json() : null; })
    .then(function (c) {
      if (!c) return;
      // The deep check tile (stage 5): shown only when the config says it is switched on. This browser remembers that (a flag, nothing personal) so the next visit reserves the tile's place before the answer arrives.
      var dpTile = document.getElementById('dp-tile'), dpFeat = document.getElementById('dp-feat'), dpOn = !!(c.settings && c.settings.deep_enabled === true && (c.topics || []).some(function (t) { return t.kind === 'deep'; }));
      if (dpTile && dpFeat) {
        dpTile.hidden = !dpOn; dpFeat.classList.toggle('dp-on', dpOn); document.documentElement.classList.remove('dp-expect');
        try { if (dpOn) localStorage.setItem('kasp:dp', '1'); else localStorage.removeItem('kasp:dp'); } catch (e) {}
      }
      // Legal-entity details are shown only if an admin entered them (nothing is assumed about registration or who receives payments).
      var d = c.settings && c.settings.org_details;
      if (d) ['org-details', 'org-details-foot'].forEach(function (id) { var el = document.getElementById(id); if (el) { el.textContent = d; el.hidden = false; } });
    })
    .catch(function () {});
})();
