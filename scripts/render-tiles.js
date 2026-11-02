// Bakes the ten topic tiles into kaspchem/index.html (between markers) from topics.json + icons.js.
// Why: tiles injected by JS after a fetch caused layout shift (CLS 0.2-0.4) and left the page empty without JS.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const R = (f) => path.join(__dirname, '..', f);

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(R('kaspchem/assets/icons.js'), 'utf8'), ctx);
// The quick check (kind "router") is not one of the ten topic tiles: it has its own featured tile (class qk-tile, outside #tiles) written by hand in index.html.
const topics = JSON.parse(fs.readFileSync(R('kaspchem/content/topics.json'), 'utf8')).topics.filter((t) => t.kind !== 'router');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const html = topics.map((t) =>
  `        <li><a class="tile" href="/kaspchem/check/${t.id}"><span class="face">${ctx.window.KaspIcon(t.icon)}</span><h3>${esc(t.name)}</h3><p>${esc(t.tagline)}</p></a></li>`).join('\n');

const f = R('kaspchem/index.html');
let s = fs.readFileSync(f, 'utf8');
const a = '<!--tiles:start-->', b = '<!--tiles:end-->';
if (!s.includes(a)) s = s.replace('<ul class="tiles" id="tiles" aria-labelledby="pick"></ul>', `<ul class="tiles" id="tiles" aria-labelledby="pick">\n${a}\n${b}\n      </ul>`);
const i = s.indexOf(a), j = s.indexOf(b);
if (i < 0 || j < 0) throw new Error('markers/tiles list not found');
s = s.slice(0, i + a.length) + '\n' + html + '\n        ' + s.slice(j);
fs.writeFileSync(f, s);
console.log('tiles rendered:', topics.length);
