// Idempotent: appends Kaspchem redirects/headers to netlify.toml and bumps Node to 20 (required by @neondatabase/serverless).
const fs = require('fs');
const f = require('path').join(__dirname, '..', 'netlify.toml');
let t = fs.readFileSync(f, 'utf8');
if (t.includes('kaspchem')) { console.log('already patched'); process.exit(0); }
const eol = t.includes('\r\n') ? '\r\n' : '\n';
t = t.replace('NODE_VERSION = "18"', 'NODE_VERSION = "20"');

const csp = (extraScript, extraConnect, extraFrame) =>
  "default-src 'self'; script-src 'self'" + extraScript + "; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'" + extraConnect +
  "; frame-src 'self'" + extraFrame + "; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const block = `
# ---- Kaspchem (added) -------------------------------------------------------
[[redirects]]
  from = "/api/kaspchem/config"
  to = "/.netlify/functions/kaspchem-config"
  status = 200

[[redirects]]
  from = "/api/kaspchem/lead"
  to = "/.netlify/functions/kaspchem-lead"
  status = 200

[[redirects]]
  from = "/api/kaspchem/admin/*"
  to = "/.netlify/functions/kaspchem-admin/:splat"
  status = 200

[[redirects]]
  from = "/kaspchem/check/*"
  to = "/kaspchem/check.html"
  status = 200

[[headers]]
  for = "/kaspchem/*"
  [headers.values]
    Content-Security-Policy = "${csp('', '', '')}"
    Permissions-Policy = "camera=(), microphone=(), geolocation=()"

[[headers]]
  for = "/admin/kaspchem/*"
  [headers.values]
    Content-Security-Policy = "${csp(' https://identity.netlify.com', ' https://identity.netlify.com', ' https://identity.netlify.com')}"
    Cache-Control = "no-store"
    X-Robots-Tag = "noindex, nofollow"

[[headers]]
  for = "/api/kaspchem/*"
  [headers.values]
    Cache-Control = "no-store"
`;
t = t.replace(/\s*$/, '') + eol + block.split('\n').join(eol);
fs.writeFileSync(f, t);
console.log('patched');
