/* כפתורי "הדפסה / שמירה כ-PDF" בדפי המדריכים (קובץ חיצוני, ללא סקריפט inline) */
(function () {
  'use strict';
  var buttons = document.querySelectorAll('[data-print]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function () { window.print(); });
  }
})();
