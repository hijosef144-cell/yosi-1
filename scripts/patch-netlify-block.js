// Idempotent: the publish directory is the repo root, so internal files would be public. Force them to 404.
const fs = require('fs');
const f = require('path').join(__dirname, '..', 'netlify.toml');
let t = fs.readFileSync(f, 'utf8');
if (t.includes('# ---- internal files')) { console.log('already patched'); process.exit(0); }
const eol = t.includes('\r\n') ? '\r\n' : '\n';
const paths = ['/tests/*', '/scripts/*', '/db/*', '/docs/*', '/node_modules/*', '/netlify/*', '/package.json', '/package-lock.json', '/netlify.toml', '/playwright.config.js',
  '/DEPLOY_INSTRUCTIONS.md', '/FILES_CREATED.md', '/QUICK_START.md', '/README_NETLIFY.md'];
let block = '\n# ---- internal files: never served publicly (publish dir is the repo root) ----\n';
for (const p of paths) block += `[[redirects]]\n  from = "${p}"\n  to = "/404.html"\n  status = 404\n  force = true\n\n`;
t = t.replace(/\s*$/, '') + eol + block.split('\n').join(eol);
fs.writeFileSync(f, t);
console.log('blocked', paths.length, 'paths');
