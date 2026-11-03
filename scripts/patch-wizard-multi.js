// Wizard: multi-select questions + result extras (practical step, official self-service link with verification date, referral).
// Backward compatible: topics without these fields render exactly as before. Idempotent.
const fs = require('fs');
const path = require('path');
const f = path.join(__dirname, '..', 'kaspchem', 'assets', 'wizard.js');
let s = fs.readFileSync(f, 'utf8');
if (s.includes('onToggle')) { console.log('already patched'); process.exit(0); }
function sub(a, b) { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 70)); s = s.replace(a, b); }

// 1. render: multi-select question uses checkboxes + an explicit continue button
sub(`      '<div class="opts" role="radiogroup" aria-labelledby="qt">' +
      q.options.map(function (o) {
        return '<button type="button" class="opt" role="radio" aria-checked="' + (answers[q.id] === o.id) + '" data-q="' + q.id + '" data-o="' + o.id + '"><span class="dot"></span><span>' + esc(o.label) + '</span></button>';
      }).join('') + '</div>' +`,
`      (q.multi ? '<p class="multihint">אפשר לבחור יותר מתשובה אחת</p>' : '') +
      '<div class="opts" role="' + (q.multi ? 'group' : 'radiogroup') + '" aria-labelledby="qt">' +
      q.options.map(function (o) {
        var on = q.multi ? [].concat(answers[q.id] || []).indexOf(o.id) !== -1 : answers[q.id] === o.id;
        return '<button type="button" class="opt' + (q.multi ? ' chk' : '') + '" role="' + (q.multi ? 'checkbox' : 'radio') + '" aria-checked="' + on + '" data-q="' + q.id + '" data-o="' + o.id + '"' + (o.exclusive ? ' data-x="1"' : '') + '><span class="dot"></span><span>' + esc(o.label) + '</span></button>';
      }).join('') + '</div>' +
      (q.multi ? '<div class="multi-go"><button type="button" class="btn" id="mgo"' + ([].concat(answers[q.id] || []).length ? '' : ' disabled') + '>המשך</button></div>' : '') +`);
sub(`    app.querySelector('.opts').addEventListener('click', onPick);`,
`    app.querySelector('.opts').addEventListener('click', q.multi ? onToggle : onPick);
    var go = document.getElementById('mgo'); if (go) go.addEventListener('click', function () { commitMulti(q); });`);

// 2. single-select: compare answers structurally (arrays never occur here, but keep it safe)
sub(`var changed = answers[q] !== o;`, `var changed = JSON.stringify(answers[q]) !== JSON.stringify(o);`);

// 3. multi-select handlers
sub(`  window.addEventListener('popstate'`,
`  // Multi-select: toggling never advances; the explicit "continue" button commits. Exclusive options ("none of these", "not sure") clear the rest.
  function onToggle(ev) {
    var btn = ev.target.closest('.opt'); if (!btn || busy) return;
    var wasOn = btn.getAttribute('aria-checked') === 'true';
    var all = [].slice.call(app.querySelectorAll('.opt'));
    if (btn.dataset.x) all.forEach(function (x) { x.setAttribute('aria-checked', x === btn ? String(!wasOn) : 'false'); });
    else { all.forEach(function (x) { if (x.dataset.x) x.setAttribute('aria-checked', 'false'); }); btn.setAttribute('aria-checked', String(!wasOn)); }
    var any = all.some(function (x) { return x.getAttribute('aria-checked') === 'true'; });
    var go = document.getElementById('mgo'); if (go) go.disabled = !any;
  }

  function commitMulti(q) {
    if (busy) return;
    var picked = [].slice.call(app.querySelectorAll('.opt')).filter(function (x) { return x.getAttribute('aria-checked') === 'true'; }).map(function (x) { return x.dataset.o; });
    if (!picked.length) return;
    busy = true;
    var changed = JSON.stringify(answers[q.id]) !== JSON.stringify(picked);
    answers[q.id] = picked;
    if (order.indexOf(q.id) === -1) order.push(q.id);
    if (changed) { answers = E.pruneAnswers(topic, answers); order = order.filter(function (id) { return answers[id] != null; }); }
    enc = q.encourage || GENERIC_ENC[Math.min(order.length - 1, GENERIC_ENC.length - 1)];
    save();
    history.pushState({ n: order.length }, '');
    step();
  }

  window.addEventListener('popstate'`);

// 4. result: each finding can show a practical step, the official self-service route (with its verification date) and a referral
sub(`<div><b>' + esc(f.title) + '</b><span>' + esc(f.why) + '</span></div></li>'`,
`<div><b>' + esc(f.title) + '</b><span>' + esc(f.why) + '</span>' + findingExtras(f) + '</div></li>'`);
sub(`  function countUp(`,
`  function safeUrl(u) { return /^https:\\/\\//.test(String(u || '')) ? u : null; }
  function heDate(d) { var m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(d || ''); return m ? m[3] + '.' + m[2] + '.' + m[1] : ''; }
  function findingExtras(f) {
    var h = '';
    if (f.step) h += '<span class="fx"><b>צעד מעשי:</b> ' + esc(f.step) + '</span>';
    var url = f.official && safeUrl(f.official.url);
    if (url) h += '<span class="fx"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(f.official.label || 'לבדיקה עצמית באתר הרשמי') + '</a>' + (f.official.checked ? ' <small>(הקישור נבדק ' + esc(heDate(f.official.checked)) + ')</small>' : '') + '</span>';
    if (f.refer) h += '<span class="fx"><b>להמשך טיפול:</b> ' + esc(f.refer) + '</span>';
    return h;
  }

  function countUp(`);
fs.writeFileSync(f, s);

fs.appendFileSync(path.join(__dirname, '..', 'kaspchem', 'assets', 'kaspchem.css'), `
/* ---- multi-select questions and result extras ---- */
.multihint { color: #3e5f63; font-size: .95rem; margin: .2rem 0 0; }
.opt.chk .dot { border-radius: 6px; }
.opt.chk[aria-checked="true"] .dot { border-color: var(--gold-d); background: var(--gold-d) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-6.5' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/80% no-repeat; }
.multi-go { margin: .2rem 0 1rem; }
.multi-go .btn { width: 100%; }
.find .fx { display: block; margin-top: .55rem; font-size: .95rem; color: #d6e6e3; }
.find .fx b { color: #fff; }
.find .fx a { color: var(--gold-l); font-weight: 700; }
.find .fx small { color: #9fc0bc; }
`);
console.log('wizard patched');
