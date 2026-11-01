// Replaces the thin promo strip on the main homepage with the Kaspchem entry card (option A), placed right after the hero.
// Everything is scoped under .kc-* so no existing style or script of the main site is touched. Idempotent.
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'index.html');
let s = fs.readFileSync(f, 'utf8');
const NL = s.includes('\r\n') ? '\r\n' : '\n';
s = s.split(NL).join('\n');

const START = '    <!-- כספכם – באנר קידום -->';
const START2 = '    <!-- כספכם – כרטיס כניסה -->';
const END = '    <!-- Services Preview -->';
const a = s.includes(START) ? s.indexOf(START) : s.indexOf(START2);
const b = s.indexOf(END);
if (a < 0 || b < 0 || b < a) throw new Error('markers not found');

const headline = 'כסף, זכויות וחיסכון: מה כדאי לבדוק אצלכם?';
const fontText = encodeURIComponent(headline + 'כספכם');
const card = `    <!-- כספכם – כרטיס כניסה -->
    <section class="kc" aria-labelledby="kc-h">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@900&display=swap&text=${fontText}" media="print" onload="this.media='all'">
      <style>
        .kc { background: #f4f7fb; padding: 28px 0 12px; }
        .kc-card { direction: rtl; background: linear-gradient(155deg, #0e3b41, #0a2a2f); color: #fff; border-radius: 22px; padding: 22px 20px; display: grid; gap: 16px; box-shadow: 0 6px 0 #061d21, 0 18px 32px rgba(6, 29, 33, .22); font-family: 'Heebo', sans-serif; }
        .kc-brand { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
        .kc-brand b { font: 900 1.3rem 'Frank Ruhl Libre', Georgia, serif; color: #f4d27f; }
        .kc-by { display: inline-flex; align-items: center; gap: 8px; font-size: .84rem; color: #b8d3cf; }
        .kc-logo { display: inline-flex; background: #fff; border-radius: 8px; padding: 3px 8px; }
        .kc-logo img { height: 22px; width: auto; display: block; }
        .kc-card h2 { font: 900 clamp(1.55rem, 5.2vw, 2.4rem)/1.2 'Frank Ruhl Libre', Georgia, serif; margin: 10px 0 8px; color: #fff; }
        .kc-card p { margin: 0; color: #cfe3e0; line-height: 1.6; font-size: .98rem; max-width: 36em; }
        .kc-pts { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
        .kc-pts li { display: inline-flex; align-items: center; gap: 7px; font-size: .9rem; font-weight: 500; padding: 6px 12px; border-radius: 999px; background: rgba(255, 255, 255, .08); border: 1px solid rgba(255, 255, 255, .16); }
        .kc-pts li::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #e3b04b; flex: none; }
        .kc-cta { display: flex; align-items: center; justify-content: center; min-height: 50px; padding: 0 26px; border-radius: 14px; background: #e3b04b; color: #0a2a2f; font-weight: 700; font-size: 1.05rem; text-decoration: none; box-shadow: 0 4px 0 #a97a1d; }
        .kc-cta:hover { background: #f4d27f; }
        .kc-cta:focus-visible { outline: 3px solid #fff; outline-offset: 3px; }
        .kc-side { display: grid; gap: 14px; align-content: center; }
        @media (min-width: 900px) { .kc { padding: 40px 0 20px; } .kc-card { grid-template-columns: 1.25fr .75fr; gap: 40px; padding: 36px 44px; align-items: center; } .kc-cta { justify-self: start; } .kc-pts { flex-direction: column; align-items: flex-start; } }
      </style>
      <div class="section-container">
        <div class="kc-card">
          <div class="kc-main">
            <div class="kc-brand">
              <svg width="26" height="26" viewBox="0 0 34 34" aria-hidden="true"><circle cx="15" cy="15" r="11" fill="#e3b04b"/><circle cx="15" cy="15" r="6" fill="none" stroke="#08262b" stroke-width="2.2"/><path d="M23 23l8 8" stroke="#e3b04b" stroke-width="3" stroke-linecap="round"/></svg>
              <b>כספכם</b>
              <span class="kc-by">ארגון חסד בשיתוף <span class="kc-logo"><img src="images/לוגו.svg" alt="מצפן כלכלי" width="80" height="22"></span></span>
            </div>
            <h2 id="kc-h">${headline}</h2>
            <p>כמה שאלות קצרות, ותקבלו תמונה ברורה של מה שכדאי לברר. בלי להשאיר פרטים לפני התוצאה.</p>
          </div>
          <div class="kc-side">
            <ul class="kc-pts"><li>10 תחומים</li><li>כמה שאלות קצרות</li><li>בדיקה ראשונית חינם</li></ul>
            <a class="kc-cta" href="/kaspchem">התחילו בדיקה חינמית</a>
          </div>
        </div>
      </div>
    </section>

`;
s = s.slice(0, a) + card + s.slice(b);
fs.writeFileSync(f, s.split('\n').join(NL));
console.log('home card applied');
