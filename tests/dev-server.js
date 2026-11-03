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
const FUNCS = { config: 'kaspchem-config', lead: 'kaspchem-lead', impact: 'kaspchem-impact' };

// TEST-ONLY: opts.degradeDeep serves the deep route WITHOUT its `requires`, so the check runs (reduced) against the ten published topics. Production code never does this.
let DEEP_REQUIRES = null;
async function start(port, opts) {
  { const route = require('../netlify/functions/_kaspchem/content').routes.topics.find((t) => t.kind === 'deep');
    if (route) { if (DEEP_REQUIRES === null) DEEP_REQUIRES = route.requires || []; route.requires = (opts && opts.degradeDeep) || process.env.DEEP_TEST_DEGRADE === '1' ? [] : DEEP_REQUIRES; } }
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(path.join(ROOT, 'db', 'kaspchem-schema.sql'), 'utf8'));
  await pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('public.legal_approved', 'true', 'test') ON CONFLICT DO NOTHING");
  db.setDriver(async (t, p) => (await pg.query(t, p)).rows);
  if (process.env.TOPICS_FILE) { require('../netlify/functions/_kaspchem/content').setSeed(JSON.parse(fs.readFileSync(process.env.TOPICS_FILE, 'utf8'))); }
  process.env.KASPCHEM_HASH_SALT = 'test-salt';
  if (process.env.PORT) { process.env.KASPCHEM_RATE_MAX = '1000'; process.env.KASPCHEM_RATE_GLOBAL = '100000'; } // e2e shares one IP and creates many test leads (the global flood cap would refuse them); backend tests (port 0) keep the real limits
  process.env.KASPCHEM_ADMIN_EMAILS = 'yosi@example.test,avi@example.test';

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let p = decodeURIComponent(url.pathname);
      // TEST ONLY (this file is never deployed): put the impact tables and settings into an exact known state, so browser tests can start from
      // "the owner's state" without any other route. Body: { outcomes: [{request_id, kind, amount, completed_on?}] (legacy data), referenceAt, baseline: {kind, amount, family_count} (or a list of them)|null, cutoff: 'YYYY-MM-DD'|null, flag: true|false|null, approval: bool }
      if (p === '/__test/impact-seed' && req.method === 'POST') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        await pg.exec("DELETE FROM outcomes; DELETE FROM settings WHERE key IN ('public.counter_enabled','private.impact_baseline_cutoff','private.impact_baseline_approval','private.impact_reference_at')");
        for (const r of [].concat(b.baseline || [])) await pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, family_count, evidence_note, entered_by) VALUES ('baseline', $1, $2, 'documented', $3, 'test', 'test')", [r.kind || 'located_funds', r.amount, r.family_count]);
        const put = (k, v) => pg.query("INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, 'test')", [k, JSON.stringify(v)]);
        if (b.cutoff) await put('private.impact_baseline_cutoff', b.cutoff);
        if (typeof b.flag === 'boolean') await put('public.counter_enabled', b.flag);
        for (const o of b.outcomes || []) await pg.query("INSERT INTO outcomes (source, kind, amount, amount_basis, request_id, completed_on, evidence_note, entered_by) VALUES ('system', $1, $2, 'documented', $3, COALESCE($4::date, CURRENT_DATE), 'test', 'test')", [o.kind, o.amount, o.request_id, o.completed_on || null]);
        if (b.referenceAt) await put('private.impact_reference_at', b.referenceAt);
        if (b.approval) await put('private.impact_baseline_approval', { at: '2026-11-03T10:00:00.000Z', by: 'test', fp: 'test', rows: 1 });
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
      }
      const m = p.match(/^\/api\/kaspchem\/(config|lead|impact|admin)(\/.*)?$/);
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
