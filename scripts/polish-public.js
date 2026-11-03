// UX polish for the public wizard/result: coin-segment progress, discovery burst, finding markers.
const fs = require('fs');
const path = require('path');
const R = (f) => path.join(__dirname, '..', f);
function sub(file, from, to) {
  const s = fs.readFileSync(R(file), 'utf8');
  if (!s.includes(from)) throw new Error(file + ': missing ' + from.slice(0, 70));
  fs.writeFileSync(R(file), s.replace(from, to));
}

// 1. progress: one coin-colored segment per question (still a real, accessible progress indicator)
sub('kaspchem/assets/wizard.js',
  `'<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '" aria-label="התקדמות בשאלון"><i style="width:' + pct + '%"></i></div>' +`,
  `'<div class="progress segs" role="progressbar" aria-valuemin="0" aria-valuemax="' + p.total + '" aria-valuenow="' + p.done + '" aria-label="התקדמות בשאלון">' + segs(p) + '</div>' +`);
sub('kaspchem/assets/wizard.js',
  `app.innerHTML = crumb() + '<div class="progress" aria-hidden="true"><i style="width:100%"></i></div><div style="height:1.2rem"></div>' +`,
  `app.innerHTML = crumb() + '<div class="progress segs" aria-hidden="true">' + segs({ done: E.progress(topic, answers).total, total: E.progress(topic, answers).total }) + '</div><div style="height:1.2rem"></div>' +`);
sub('kaspchem/assets/wizard.js',
  `  function step() {`,
  `  function segs(p) {
    var h = '';
    for (var i = 0; i < p.total; i++) h += '<span class="' + (i < p.done ? 'done' : i === p.done ? 'cur' : '') + '"></span>';
    return h;
  }

  function step() {`);

// 2. discovery burst: gold sparks radiate once from the number
sub('kaspchem/assets/wizard.js',
  `'<div class="head"><div class="big" id="num" aria-hidden="true">' + (reduce ? n : 0) + '</div>' +`,
  `'<div class="head"><div class="burst" aria-hidden="true">' + sparks() + '<div class="big" id="num">' + (reduce ? n : 0) + '</div></div>' +`);
sub('kaspchem/assets/wizard.js',
  `  function segs(p) {`,
  `  function sparks() {
    var h = '';
    for (var i = 0; i < 10; i++) h += '<i style="--a:' + (i * 36) + 'deg;--d:' + (3.2 + (i % 3) * 0.9) + 'rem"></i>';
    return h;
  }

  function segs(p) {`);

// 3. each finding gets a gold coin marker instead of a plain bar only
sub('kaspchem/assets/wizard.js',
  `'<b>' + esc(f.title) + '</b><span>' + esc(f.why) + '</span></li>'`,
  `'<i class="mk" aria-hidden="true"></i><div><b>' + esc(f.title) + '</b><span>' + esc(f.why) + '</span></div></li>'`);
console.log('wizard patched');
