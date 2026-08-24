/* =========================================================
   הודעת "מרכז הידע בבנייה" — מוצגת פעם אחת בכל session
   (לא בכל דף בתוך /knowledge/ בנפרד, כדי לא להטריד).
   הסירו את הטעינה של הקובץ הזה כשמרכז הידע יהיה שלם.
   ========================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'kc_notice_dismissed';

  function alreadyDismissed() {
    try { return sessionStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }
  function markDismissed() {
    try { sessionStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
  }

  function inject() {
    if (alreadyDismissed() || document.getElementById('kc-notice-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'kc-notice-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'kc-notice-title');
    overlay.innerHTML =
      '<div id="kc-notice-box">' +
        '<div id="kc-notice-stripe" aria-hidden="true"></div>' +
        '<button id="kc-notice-close" aria-label="סגור הודעה" type="button">✕</button>' +
        '<div id="kc-notice-icon" aria-hidden="true">🚧</div>' +
        '<h2 id="kc-notice-title">מרכז הידע בבנייה</h2>' +
        '<p>אנחנו כרגע מרחיבים את מרכז הידע ומוסיפים מונחים חדשים בהדרגה. חלק מהמידע כאן עדיין חלקי, אז אם לא מצאתם מה שחיפשתם — כתבו לנו ונוסיף.</p>' +
        '<button id="kc-notice-ok" type="button">הבנתי, תודה</button>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      overlay.setAttribute('hidden', '');
      markDismissed();
    }

    document.getElementById('kc-notice-close').addEventListener('click', close);
    document.getElementById('kc-notice-ok').addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
