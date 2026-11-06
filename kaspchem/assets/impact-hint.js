/* Runs before the page is painted (tiny, synchronous, no network). If this browser last saw the impact counter at this same width, mark the page
 * so CSS reserves exactly that much height for it; the real answer (impact.js) then fills it in without moving anything. Nothing personal is stored. */
(function () {
  try {
    var h = JSON.parse(localStorage.getItem('kasp:imp') || 'null');
    if (h && h.w === window.innerWidth && h.h > 0 && h.h < 3000) {
      var d = document.documentElement; d.style.setProperty('--imp-h', h.h + 'px'); d.classList.add('imp-expect');
    }
  } catch (e) {}
})();
