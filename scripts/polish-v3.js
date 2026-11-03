// v3 = restrained v2 + one brief, subtle gold moment, only when at least one topic worth checking was identified.
// No scattering coins/sparks, no cue that money was actually found. Warmer, curiosity-building copy; honest "first check" framing.
const fs = require('fs');
const path = require('path');
const R = (f) => path.join(__dirname, '..', f);
function sub(file, from, to) {
  const s = fs.readFileSync(R(file), 'utf8');
  if (!s.includes(from)) throw new Error(file + ': missing ' + from.slice(0, 70));
  fs.writeFileSync(R(file), s.replace(from, to));
}
const W = 'kaspchem/assets/wizard.js';

// copy: positive + curious, then the honest qualifier
sub(W,
  `'<p class="sub">אלה נושאים שכדאי לבדוק, לפי התשובות שלכם בלבד. זו אינה זכאות מאומתת ואינה הבטחה לכסף.</p></div>' +`,
  `'<p class="sub">יש כאן נקודות התחלה ברורות, וכדאי לברר בכל אחת מהן מה המצב בפועל. זו בדיקה ראשונית לפי התשובות שלכם בלבד, ולא זכאות מאומתת או הבטחה לכסף.</p></div>' +`);
// the gold hairline under the number (drawn once) — only in the "found" branch
sub(W,
  `<div class="bigcap">נושאים לבדיקה, לא סכום שנמצא</div>' +`,
  `<div class="bigcap">נושאים לבדיקה, לא סכום שנמצא</div><div class="goldline" aria-hidden="true"></div>' +`);
// conversion: reassurance right under the main button (true: first check is free; leaving details is not a commitment)
sub(W,
  `<button type="button" class="btn" id="cta">אני רוצה עזרה בבדיקה</button><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';`,
  `<button type="button" class="btn" id="cta">אני רוצה עזרה בבדיקה</button><p class="reassure">הבדיקה הראשונית חינמית, והשארת פרטים אינה התחייבות.</p><a class="btn link" href="/kaspchem">לבדוק תחום אחר</a></div>';`);
// mark the card so CSS can run the one-time gold moment
sub(W,
  `    if (res.outcome === 'found' && !reduce && n > 0) countUp(document.getElementById('num'), n);`,
  `    if (res.outcome === 'found' && n > 0) box.classList.add('found');\n    if (res.outcome === 'found' && !reduce && n > 0) countUp(document.getElementById('num'), n);`);

fs.appendFileSync(R('kaspchem/assets/kaspchem.css'), `
/* ---- v3: one brief gold moment, only when a topic worth checking was identified ---- */
.goldline { height: 2px; width: 0; margin: .9rem auto 0; border-radius: 2px; background: linear-gradient(90deg, transparent, var(--gold-l), transparent); }
.result.found .goldline { animation: drawline .9s cubic-bezier(.3,.7,.2,1) .15s forwards; }
@keyframes drawline { to { width: min(14rem, 60%); } }
.result.found { animation: goldedge 1.8s ease-out .1s 1; }
@keyframes goldedge { 0% { box-shadow: 0 10px 0 #061d21, 0 26px 40px rgba(6,29,33,.35), 0 0 0 0 rgba(244,210,127,0); } 35% { box-shadow: 0 10px 0 #061d21, 0 26px 40px rgba(6,29,33,.35), 0 0 34px 2px rgba(244,210,127,.28); } 100% { box-shadow: 0 10px 0 #061d21, 0 26px 40px rgba(6,29,33,.35), 0 0 0 0 rgba(244,210,127,0); } }
.reassure { margin: .1rem 0 0; font-size: .92rem; color: #b8d3cf; text-align: center; }
@media (prefers-reduced-motion: reduce) { .result.found, .result.found .goldline { animation: none; } .goldline { width: min(14rem, 60%); } }
`);
console.log('v3 applied');
