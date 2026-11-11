/* דפי המדריכים: כפתור "הדפסה / שמירה כ-PDF" וכפתור "שליחה לאימייל" (קובץ חיצוני, ללא סקריפט inline) */
(function () {
  'use strict';

  var printButtons = document.querySelectorAll('[data-print]');
  for (var i = 0; i < printButtons.length; i++) {
    printButtons[i].addEventListener('click', function () { window.print(); });
  }

  var emailButtons = document.querySelectorAll('[data-email-guide]');
  if (!emailButtons.length) return;

  var modal = null, lastFocus = null;

  function build() {
    modal = document.createElement('div');
    modal.className = 'kc-modal no-print';
    modal.hidden = true;
    modal.innerHTML =
      '<div class="kc-modal-box" role="dialog" aria-modal="true" aria-labelledby="kc-em-title">' +
      '<button type="button" class="kc-modal-x" data-em-close aria-label="סגירה">✕</button>' +
      '<h2 id="kc-em-title">שליחת המדריך לאימייל</h2>' +
      '<p class="kc-modal-sub">הקובץ יישלח אליכם כקובץ PDF מצורף.</p>' +
      '<form novalidate>' +
      '<label for="kc-em-input">כתובת האימייל שלכם</label>' +
      '<input id="kc-em-input" type="email" inputmode="email" autocomplete="email" dir="ltr" placeholder="you@example.com">' +
      '<div class="kc-hp" aria-hidden="true"><label>אל תמלאו שדה זה<input type="text" tabindex="-1" autocomplete="off" data-em-hp></label></div>' +
      '<div class="kc-modal-consent"><input id="kc-em-consent" type="checkbox"><label for="kc-em-consent">אני מסכים/ה ל<a href="/privacy.html" target="_blank" rel="noopener">מדיניות הפרטיות</a></label></div>' +
      '<div class="kc-modal-err" role="alert" id="kc-em-err"></div>' +
      '<button type="submit" class="kc-btn kc-btn-primary kc-modal-send">שליחה</button>' +
      '<div class="kc-modal-status" role="status" id="kc-em-status"></div>' +
      '</form></div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal || e.target.hasAttribute('data-em-close')) close(); });
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;                                                      // keep focus inside the dialog
      var f = modal.querySelectorAll('button, input:not([tabindex="-1"]), a[href]'), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    modal.querySelector('form').addEventListener('submit', submit);
  }

  function onEsc(e) { if (e.key === 'Escape') close(); }                                // on the document, so it works even when focus is on a disabled button

  function open(slug) {
    if (!modal) build();
    document.addEventListener('keydown', onEsc);
    lastFocus = document.activeElement;
    modal.setAttribute('data-slug', slug);
    modal.hidden = false;
    document.documentElement.classList.add('kc-modal-open');
    msg('kc-em-err', ''); msg('kc-em-status', '');
    var btn = modal.querySelector('.kc-modal-send'); btn.disabled = false; btn.textContent = 'שליחה';
    document.getElementById('kc-em-input').focus();
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.removeEventListener('keydown', onEsc);
    document.documentElement.classList.remove('kc-modal-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function msg(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }

  function submit(e) {
    e.preventDefault();
    var email = document.getElementById('kc-em-input').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { msg('kc-em-err', 'נא להזין כתובת אימייל תקינה'); document.getElementById('kc-em-input').focus(); return; }
    if (!document.getElementById('kc-em-consent').checked) { msg('kc-em-err', 'יש לאשר את מדיניות הפרטיות כדי לשלוח'); return; }
    msg('kc-em-err', ''); msg('kc-em-status', '');
    var btn = modal.querySelector('.kc-modal-send'); btn.disabled = true; btn.textContent = 'שולחים...';
    fetch('/.netlify/functions/send-guide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userEmail: email, slug: modal.getAttribute('data-slug'), consent: true, website: modal.querySelector('[data-em-hp]').value })
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (o) {
        if (o.j && o.j.ok) {
          msg('kc-em-status', o.j.attached === false ? '✅ נשלח קישור למדריך. בדקו את תיבת הדואר (וגם בספאם).' : '✅ נשלח! בדקו את תיבת הדואר (וגם בספאם).');
          btn.textContent = '✓ נשלח';
          setTimeout(close, 3200);
          return;
        }
        throw new Error(o.s === 429 ? 'too_many' : 'fail');
      })
      .catch(function (err) {
        btn.disabled = false; btn.textContent = 'שליחה';
        msg('kc-em-err', err && err.message === 'too_many' ? 'נשלחו יותר מדי בקשות. נסו שוב מאוחר יותר.' : 'אירעה שגיאה בשליחה. נסו שוב, או השתמשו בכפתור ההורדה.');
      });
  }

  for (var j = 0; j < emailButtons.length; j++) {
    emailButtons[j].addEventListener('click', function (e) { open(e.currentTarget.getAttribute('data-email-guide')); });
  }
})();
