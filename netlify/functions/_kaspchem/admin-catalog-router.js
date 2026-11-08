'use strict';
// Catalog server, routes (stage 4a: READ ONLY). Mounted by admin-router.js for every path that starts with /catalog; everything else is handled exactly as before.
// Order for every catalog request: the caller was authenticated and allow-listed by admin-entry.js (unchanged) → owner role and the switch `private.catalog_enabled` (catalog-guards.js)
// → routing. While the switch is closed the answer is the same for every path and method, so nothing is revealed about which routes exist.
// This file has GET routes only. There is no route for any other method (a POST, PUT, PATCH or DELETE is "not found"), so no request can change the catalog, activate anything or save an import.
const { json, HttpError, logError } = require('./http');
const guards = require('./catalog-guards');
const store = require('./catalog-store');

const MAX_ID = 9007199254740991;
const idOf = (s) => { const n = Number(s); if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ID) throw new HttpError(400, 'bad_id'); return n; };
const ACTIVATION = ['draft', 'pending', 'active', 'paused', 'retired'];
const MODELS = ['fixed', 'percent_of_result', 'percent_with_minimum', 'variable', 'quote', 'tbd'];
const PROVIDER_STATES = ['available', 'paused', 'archived'];

// Query strings are checked against a list of allowed names; an unknown name or a bad value is a 400, never ignored silently.
function readQuery(raw, spec) {
  const out = { limit: 100, offset: 0 };
  const q = raw || {};
  for (const k of Object.keys(q)) if (!(k in spec) && k !== 'limit' && k !== 'offset') throw new HttpError(400, 'bad_query');
  const intIn = (v, min, max) => { if (!/^\d{1,9}$/.test(String(v))) throw new HttpError(400, 'bad_query'); const n = Number(v); if (n < min || n > max) throw new HttpError(400, 'bad_query'); return n; };
  if (q.limit !== undefined) out.limit = intIn(q.limit, 1, 200);
  if (q.offset !== undefined) out.offset = intIn(q.offset, 0, 1000000);
  for (const [k, kind] of Object.entries(spec)) {
    if (q[k] === undefined || q[k] === '') continue;
    const v = String(q[k]);
    if (kind === 'text') { if (v.length > 80) throw new HttpError(400, 'bad_query'); out[k] = v; }
    else if (kind === 'id') out[k] = intIn(v, 1, MAX_ID);
    else if (kind === 'bool') { if (v !== 'true' && v !== 'false') throw new HttpError(400, 'bad_query'); out[k] = v === 'true'; }
    else if (Array.isArray(kind)) { if (!kind.includes(v)) throw new HttpError(400, 'bad_query'); out[k] = v; }
  }
  return out;
}

// The route table is exported so the tests can drive every route with every kind of caller. `sample` is a real path of the route.
const ROUTES = [
  { name: 'overview', re: /^\/catalog\/overview$/, sample: '/catalog/overview', query: {}, run: () => store.overview() },
  { name: 'services.list', re: /^\/catalog\/services$/, sample: '/catalog/services', query: { q: 'text', topic: 'text', active: 'bool' }, run: (c) => store.listServices(c.q) },
  { name: 'services.get', re: /^\/catalog\/services\/(\d+)$/, sample: '/catalog/services/1', query: {}, run: (c, id) => store.getService(idOf(id)) },
  { name: 'providers.list', re: /^\/catalog\/providers$/, sample: '/catalog/providers', query: { q: 'text', state: PROVIDER_STATES }, run: (c) => store.listProviders(c.q) },
  { name: 'providers.get', re: /^\/catalog\/providers\/(\d+)$/, sample: '/catalog/providers/1', query: {}, run: (c, id) => store.getProvider(idOf(id), c.me.email) },
  { name: 'engagements.list', re: /^\/catalog\/engagements$/, sample: '/catalog/engagements', query: { provider_id: 'id', service_id: 'id', activation: ACTIVATION, pricing_model: MODELS }, run: (c) => store.listEngagements(c.q) },
  { name: 'engagements.get', re: /^\/catalog\/engagements\/(\d+)\/(\d+)$/, sample: '/catalog/engagements/1/1', query: {}, run: (c, p, s) => store.getEngagement(idOf(p), idOf(s)) },
  { name: 'imports.list', re: /^\/catalog\/imports$/, sample: '/catalog/imports', query: {}, run: (c) => store.listImports(c.q) },
  { name: 'similar.services', re: /^\/catalog\/similar\/services$/, sample: '/catalog/similar/services', query: {}, run: () => store.similarServices() },
];

const isCatalogPath = (path) => path === '/catalog' || path.startsWith('/catalog/');

async function handle(event, me, path) {
  await guards.gate(me);                                                   // owner + switch, before anything else, for every method and path
  if (event.httpMethod !== 'GET') throw new HttpError(404, 'not_found');   // 4a has no write route of any kind
  const clean = path.replace(/\/$/, '');
  for (const r of ROUTES) {
    const hit = r.re.exec(clean);
    if (!hit) continue;
    const q = readQuery(event.queryStringParameters, r.query);
    const out = await r.run({ me, q }, ...hit.slice(1));
    try { guards.assertNoSecrets(out); } catch (e) { logError('catalog.response', e); throw new HttpError(500, 'server_error'); }
    return json(200, Object.assign({ ok: true }, out));
  }
  throw new HttpError(404, 'not_found');
}

module.exports = { handle, isCatalogPath, ROUTES, readQuery };
