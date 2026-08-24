/* =========================================================
   ווידג'ט נגישות משותף — מצפן כלכלי
   חולץ מ-index.html (ללא שינוי בהתנהגות) כדי שגם דפי /knowledge/
   ישתמשו באותו רכיב. לטעינה בכל דף:
   <link rel="stylesheet" href="/static/a11y-widget.css">
   <script src="/static/a11y-widget.js" defer></script>
   ========================================================= */
(function () {
  'use strict';

  var MARKUP =
    '<button id="a11y-btn" aria-label="פתח תפריט נגישות" aria-expanded="false" aria-controls="a11y-panel" title="נגישות (ניתן לגרור)">♿</button>' +
    '<div id="a11y-panel" role="dialog" aria-label="תפריט נגישות" aria-modal="false" hidden>' +
      '<h3>הגדרות נגישות</h3>' +
      '<div class="a11y-group">' +
        '<div class="a11y-group-label">גודל גופן</div>' +
        '<div class="a11y-row">' +
          '<button class="a11y-btn-item" onclick="window.a11yFontSize(-1)" aria-label="הקטן גופן">A−</button>' +
          '<button class="a11y-btn-item" onclick="window.a11yFontSize(0)" aria-label="איפוס גופן" style="font-size:11px;">איפוס</button>' +
          '<button class="a11y-btn-item" onclick="window.a11yFontSize(1)" aria-label="הגדל גופן" style="font-size:16px;">A+</button>' +
        '</div>' +
      '</div>' +
      '<div class="a11y-group">' +
        '<div class="a11y-group-label">תצוגה</div>' +
        '<button id="a11y-contrast-btn" class="a11y-btn-full" onclick="window.a11yContrast()" aria-pressed="false">ניגודיות גבוהה</button>' +
      '</div>' +
      '<div class="a11y-group">' +
        '<div class="a11y-group-label">קישורים</div>' +
        '<button id="a11y-links-btn" class="a11y-btn-full" onclick="window.a11yLinks()" aria-pressed="false">הדגש קישורים</button>' +
      '</div>' +
      '<div class="a11y-group">' +
        '<div class="a11y-group-label">תנועה</div>' +
        '<button id="a11y-anim-btn" class="a11y-btn-full" onclick="window.a11yAnim()" aria-pressed="false">עצור אנימציות</button>' +
      '</div>' +
      '<button class="a11y-reset" onclick="window.a11yReset()">איפוס הכל</button>' +
    '</div>';

  function inject() {
    if (document.getElementById('a11y-btn')) return; // כבר הוזרק (הגנה מפני טעינה כפולה)
    var wrap = document.createElement('div');
    wrap.innerHTML = MARKUP;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    initState();
    initDrag();
  }

  /* ===== לוגיקת מצב (גודל גופן / ניגודיות / קישורים / אנימציות) ===== */
  function initState() {
    var state = { font: 0, contrast: false, links: false, anim: false };

    function save() {
      try { localStorage.setItem('a11y_v1', JSON.stringify(state)); } catch(e){}
    }
    function load() {
      try {
        var s = JSON.parse(localStorage.getItem('a11y_v1') || 'null');
        if (s) { state = s; applyAll(); }
      } catch(e){}
    }
    function applyFont() {
      document.documentElement.style.fontSize = state.font === 0 ? '' : (100 + state.font * 10) + '%';
    }
    function applyContrast() {
      document.body.classList.toggle('a11y-high-contrast', state.contrast);
      var btn = document.getElementById('a11y-contrast-btn');
      if (btn) { btn.classList.toggle('active', state.contrast); btn.setAttribute('aria-pressed', state.contrast); }
    }
    function applyLinks() {
      document.body.classList.toggle('a11y-underline-links', state.links);
      var btn = document.getElementById('a11y-links-btn');
      if (btn) { btn.classList.toggle('active', state.links); btn.setAttribute('aria-pressed', state.links); }
    }
    function applyAnim() {
      document.body.classList.toggle('a11y-no-animations', state.anim);
      var btn = document.getElementById('a11y-anim-btn');
      if (btn) { btn.classList.toggle('active', state.anim); btn.setAttribute('aria-pressed', state.anim); }
    }
    function applyAll() { applyFont(); applyContrast(); applyLinks(); applyAnim(); }

    window.toggleA11yPanel = function() {
      var panel = document.getElementById('a11y-panel');
      var btn   = document.getElementById('a11y-btn');
      if (!panel) return;
      var open = panel.hasAttribute('hidden');
      if (open) { panel.removeAttribute('hidden'); } else { panel.setAttribute('hidden', ''); }
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    window.a11yFontSize = function(dir) {
      state.font = dir === 0 ? 0 : Math.max(-3, Math.min(5, state.font + dir));
      applyFont(); save();
    };
    window.a11yContrast = function() { state.contrast = !state.contrast; applyContrast(); save(); };
    window.a11yLinks    = function() { state.links    = !state.links;    applyLinks();    save(); };
    window.a11yAnim     = function() { state.anim     = !state.anim;     applyAnim();     save(); };
    window.a11yReset    = function() {
      state = { font:0, contrast:false, links:false, anim:false };
      applyAll(); save();
    };

    /* סגירה בלחיצה מחוץ לפאנל */
    document.addEventListener('click', function(e) {
      var panel = document.getElementById('a11y-panel');
      var btn   = document.getElementById('a11y-btn');
      if (!panel || panel.hasAttribute('hidden')) return;
      if (!panel.contains(e.target) && !btn.contains(e.target)) {
        panel.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', 'false');
      }
    });

    /* סגירה ב-Escape */
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        var panel = document.getElementById('a11y-panel');
        var btn   = document.getElementById('a11y-btn');
        if (panel && !panel.hasAttribute('hidden')) {
          panel.setAttribute('hidden', '');
          btn.setAttribute('aria-expanded', 'false');
          btn.focus();
        }
      }
    });

    load();
  }

  /* ===== גרירת כפתור נגישות ===== */
  function initDrag() {
    var btn   = document.getElementById('a11y-btn');
    var panel = document.getElementById('a11y-panel');
    if (!btn) return;

    var THRESHOLD = 6; // px — מרחק מינימלי להכרה בגרירה
    var dragging  = false;
    var moved     = false;
    var startCX, startCY, startBtnL, startBtnT;

    /* --- מיקום פאנל יחסית לכפתור --- */
    function positionPanel() {
      if (!panel || panel.hasAttribute('hidden')) return;
      var bRect = btn.getBoundingClientRect();
      var pW = panel.offsetWidth  || 230;
      var pH = panel.offsetHeight || 290;
      var gap = 10;

      // ברירת מחדל: פאנל מעל הכפתור, מיושר לצד ימין שלו
      var pL = bRect.right - pW;
      var pT = bRect.top - pH - gap;

      // אם יוצא מהמסך למעלה — שים מתחת
      if (pT < 8) pT = bRect.bottom + gap;
      // גבולות ימין/שמאל
      pL = Math.max(8, Math.min(window.innerWidth - pW - 8, pL));
      // גבול תחתון
      if (pT + pH > window.innerHeight - 8) pT = window.innerHeight - pH - 8;

      panel.style.left   = pL + 'px';
      panel.style.top    = pT + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
    }

    /* --- שמירה/טעינה של מיקום --- */
    function savePos(l, t) {
      try { localStorage.setItem('a11y_pos', JSON.stringify({l:l, t:t})); } catch(e){}
    }
    function initPos() {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem('a11y_pos') || 'null'); } catch(e){}
      var rect = btn.getBoundingClientRect();
      var l = saved ? saved.l : rect.left;
      var t = saved ? saved.t : rect.top;
      // ווידוא שבגבולות
      l = Math.max(0, Math.min(window.innerWidth  - btn.offsetWidth,  l));
      t = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, t));
      btn.style.left   = l + 'px';
      btn.style.top    = t + 'px';
      btn.style.right  = 'auto';
      btn.style.bottom = 'auto';
    }

    /* --- אירועי עכבר --- */
    btn.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      var rect = btn.getBoundingClientRect();
      startCX = e.clientX; startCY = e.clientY;
      startBtnL = rect.left; startBtnT = rect.top;
      dragging = true; moved = false;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup',   onMouseUp);
    });

    function onMouseMove(e) {
      if (!dragging) return;
      var dx = e.clientX - startCX;
      var dy = e.clientY - startCY;
      if (!moved && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        moved = true;
        btn.classList.add('dragging');
      }
      if (moved) moveBtn(startBtnL + dx, startBtnT + dy);
    }

    function onMouseUp(e) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
      btn.classList.remove('dragging');
      if (moved) {
        var r = btn.getBoundingClientRect();
        savePos(r.left, r.top);
      } else {
        window.toggleA11yPanel();
      }
      dragging = false;
    }

    /* --- אירועי מגע --- */
    btn.addEventListener('touchstart', function(e) {
      var t = e.touches[0];
      var rect = btn.getBoundingClientRect();
      startCX = t.clientX; startCY = t.clientY;
      startBtnL = rect.left; startBtnT = rect.top;
      dragging = true; moved = false;
      document.addEventListener('touchmove', onTouchMove, {passive:false});
      document.addEventListener('touchend',  onTouchEnd);
    }, {passive:true});

    function onTouchMove(e) {
      if (!dragging) return;
      var t = e.touches[0];
      var dx = t.clientX - startCX;
      var dy = t.clientY - startCY;
      if (!moved && (Math.abs(dx) > THRESHOLD || Math.abs(dy) > THRESHOLD)) {
        moved = true;
        btn.classList.add('dragging');
      }
      if (moved) { moveBtn(startBtnL + dx, startBtnT + dy); e.preventDefault(); }
    }

    function onTouchEnd() {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend',  onTouchEnd);
      btn.classList.remove('dragging');
      if (moved) {
        var r = btn.getBoundingClientRect();
        savePos(r.left, r.top);
      } else {
        window.toggleA11yPanel();
      }
      dragging = false;
    }

    /* --- הזזת הכפתור --- */
    function moveBtn(l, t) {
      var bw = btn.offsetWidth, bh = btn.offsetHeight;
      l = Math.max(0, Math.min(window.innerWidth  - bw, l));
      t = Math.max(0, Math.min(window.innerHeight - bh, t));
      btn.style.left   = l + 'px';
      btn.style.top    = t + 'px';
      btn.style.right  = 'auto';
      btn.style.bottom = 'auto';
      positionPanel();
    }

    /* עדכון פאנל בכל פתיחה */
    var origToggle = window.toggleA11yPanel;
    window.toggleA11yPanel = function() {
      origToggle();
      positionPanel();
    };

    initPos();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
