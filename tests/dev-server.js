'use strict';
// Local/test server: static files + Netlify-style rewrites + the real function handlers on an in-memory Postgres (PGlite).
// Test-only identity: header "x-test-user: email|role1,role2" is turned into context.clientContext.user HERE, never in production code.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const db = require('../netlify/functions/_kaspchem/db');

const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const FUNCS = { config: 'kaspchem-config', lead: 'kaspchem-lead' };

async function start(port) {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8'));
  await pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', 'true', 'test') ON CONFLICT DO NOTHING");
  db.setDriver(async (t, p) => (await pg.query(t, p)).rows);
  process.env.KASPCHEM_HASH_SALT = 'test-salt';
  if (process.env.PORT) process.env.KASPCHEM_RATE_MAX = '1000'; // e2e shares one IP; backend tests (port 0) keep the real limit
  process.env.KASPCHEM_ADMIN_EMAILS = 'yosi@example.test,avi@example.test';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(url.pathname);
      const m = p.match(/^\/api\/kaspchem\/(config|lead|admin)(\/.*)?$/);
      if (m) {
        const chunks = []; for await (const c of req) chunks.push(c);
        const user = req.headers['x-test-user'];
        const [email, roles] = user ? user.split('|') : [];
        const event = {
          httpMethod: req.method, path: p, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
          queryStringParameters: Object.fromEntries(url.searchParams), isBase64Encoded: false
        };
        const context = { clientContext: user ? { user: { email, app_metadata: { roles: roles ? roles.split(',') : [] } } } : {} };
        if (m[1] === 'admin') {
          const r = new Request('http://' + req.headers.host + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : event.body });
          const out = await require('../netlify/functions/_kaspchem/admin-entry.js').run(r, async () => (user ? { email, roles: roles ? roles.split(',') : [] } : null));
          res.writeHead(out.status, Object.fromEntries(out.headers)); return res.end(await out.text());
        }
        const out = await require('../netlify/functions/' + FUNCS[m[1]]).handler(event, context);
        res.writeHead(out.statusCode, out.headers); return res.end(out.body);
      }
      if (/^\/kaspchem\/check\/[a-z-]+\/?$/.test(p)) p = '/kaspchem/check.html';
      else if (p === '/kaspchem' || p === '/kaspchem/') p = '/kaspchem/index.html';
      else if (p === '/admin/kaspchem' || p === '/admin/kaspchem/') p = '/admin/kaspchem/index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { console.error(e); res.writeHead(500); res.end('error'); }
  });
  await new Promise((r) => server.listen(port, r));
  return { server, pg };
}

module.exports = { start };
if (require.main === module) start(Number(process.env.PORT) || 4173).then(() => console.log('kaspchem dev server on', process.env.PORT || 4173));
