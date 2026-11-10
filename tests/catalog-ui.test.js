'use strict';
// Catalog admin screens, stage 5a (READ ONLY). These tests run the real catalog.js (in a sandbox, without a browser) on the REAL answers of the real catalog API over the local demo data (PGlite, invented
// data, no network). The browser behaviour (filters, paging, keyboard, phone width, screenshots) is covered by tests/e2e/catalog-readonly.spec.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'admin', 'kaspchem', 'catalog.js'), 'utf8');
const norm = (s) => s.split('\r\n').join('\n');   // the admin files may carry Windows line endings
const ADMIN = norm(fs.readFileSync(path.join(ROOT, 'admin', 'kaspchem', 'admin.js'), 'utf8'));
const INDEX = norm(fs.readFileSync(path.join(ROOT, 'admin', 'kaspchem', 'index.html'), 'utf8'));
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '');   // the code without its header comment (which says, in words, that commissions are not shown)
const sandbox = { window: {}, console };
vm.createContext(sandbox); vm.runInContext(SRC, sandbox);
const C = sandbox.window.KaspchemCatalog, T = C._t;
const topicName = (t) => ({ 'tax-refunds': 'מסים והחזרים', mortgage: 'משכנתאות' }[t] || t || '');
const SECRETS = ['31337', '41414', '77.77', 'PAYER-SECRET', 'NOTE-SECRET'];

// ---- the real answers of the real API over the demo data -------------------------------------------------------------------------------------------------------------------------
let demo, base, A = {};
const get = async (p) => { const r = await fetch(base + '/api/kaspchem/admin' + p, { headers: { 'x-test-user': 'yosi@example.test|admin' } }); return { status: r.status, body: await r.json() }; };
test.before(async () => {
  const { startDemo } = require('./catalog-demo-server');
  demo = await startDemo(0); base = 'http://127.0.0.1:' + demo.server.address().port;
  for (const [k, p] of Object.entries({ overview: '/catalog/overview', providers: '/catalog/providers', provider11: '/catalog/providers/11', provider14: '/catalog/providers/14', provider16: '/catalog/providers/16', services: '/catalog/services', service1: '/catalog/services/1', service7: '/catalog/services/7',
    engagements: '/catalog/engagements?limit=200', eng11_1: '/catalog/engagements/11/1', eng15_1: '/catalog/engagements/15/1', eng12_3: '/catalog/engagements/12/3', eng13_5: '/catalog/engagements/13/5', imports: '/catalog/imports', history: '/catalog/history' })) {
    const r = await get(p); assert.equal(r.status, 200, p + ' answered ' + r.status); A[k] = r.body;
  }
});
test.after(async () => { if (demo) { demo.server.close(); await demo.pg.close(); } });

test('every screen draws from the real API answers of the demo catalog (no exception, every record shown, the demo labels visible)', () => {
  const out = {
    overview: T.overviewHtml(A.overview), providers: T.providersTable(A.providers, false), provider11: T.providerHtml(A.provider11), provider14: T.providerHtml(A.provider14), provider16: T.providerHtml(A.provider16),
    services: T.servicesTable(A.services, false, topicName), service1: T.serviceHtml(A.service1, topicName), service7: T.serviceHtml(A.service7, topicName),
    engagements: T.engagementsTable(A.engagements.engagements, false, A.engagements.total, false, 0), eng11_1: T.engagementHtml(A.eng11_1), eng15_1: T.engagementHtml(A.eng15_1), eng12_3: T.engagementHtml(A.eng12_3), eng13_5: T.engagementHtml(A.eng13_5),
    imports: T.importsTable(A.imports), history: T.historyTable(A.history, false)
  };
  for (const [k, html] of Object.entries(out)) assert.equal(typeof html, 'string', k);
  assert.equal((out.providers.match(/data-ct="open-provider"/g) || []).length, 6, 'all six providers');
  assert.equal((out.services.match(/data-ct="open-service"/g) || []).length, 7, 'all seven services');
  assert.equal((out.engagements.match(/data-ct="open-eng"/g) || []).length, 7, 'all seven engagements');
  assert.match(out.overview, /שירותים \(4 פעילים/); assert.match(out.provider11, /\[דמו\] נותן שירות א׳/); assert.match(out.imports, /CSV/); assert.match(out.history, /החלת ייבוא/);
  assert.match(out.service1, /אישור מדווח/); assert.match(out.service1, /הצעה לציבור חסומה/);
  assert.match(out.provider14, /לא הוזן/, 'a provider with no profile shows "not entered", not an empty cell or "null"');
  assert.doesNotMatch(Object.values(out).join('\n'), /\bnull\b|\bundefined\b|NaN/);
});

test('the four kinds of price are kept apart: market, documented, approved, public; an approved price is never shown as public', () => {
  const sec = (d) => T.priceSection(d);
  const titles = (h) => [...h.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  const empty = sec({ price_layers: { market: null, provider_offer: null, unclassified: null }, approved_price: null });
  assert.deepEqual(titles(empty), ['מחיר שוק', 'מחיר מתועד', 'מחיר מאושר', 'מחיר ציבורי']);
  assert.match(empty, /לא תועד מחיר שוק/); assert.match(empty, /אין מחיר מקושר/); assert.match(empty, /לא מוצג לציבור/);
  const unapproved = T.engagementHtml(A.eng11_1);
  assert.match(unapproved, /מקושר, לא אושר/); assert.match(unapproved, /עדיין לא אושר, ולכן אינו נחשב מחיר מאושר/); assert.doesNotMatch(unapproved, /מוצג באתר/); assert.match(unapproved, /1,100\s*₪/); assert.match(unapproved, /1,000\s*₪/); assert.match(unapproved, /1,200\s*₪/);
  assert.match(unapproved, /ממתין לתשובה/, 'the provider offer still waits for the provider');
  const internal = T.engagementHtml(A.eng15_1);
  assert.match(internal, /<span class="ct-pill ct-ok">מאושר<\/span>/); assert.match(internal, /מאושר לשימוש פנימי בלבד, לא מוצג לציבור/); assert.doesNotMatch(internal, /מוצג באתר/);
  const pub = sec(Object.assign({}, A.eng15_1, { approved_price: Object.assign({}, A.eng15_1.approved_price, { public: true }) }));
  assert.equal((pub.match(/מוצג באתר/g) || []).length, 1, 'only the fourth card says "shown on the site"');
  assert.match(pub.split('ct-price-public')[1], /מוצג באתר/);
  assert.ok(pub.indexOf('מחיר מאושר') < pub.indexOf('מחיר ציבורי'));
});

test('a price is written the way the model says it: fixed, a percentage or a range of percentages, a percentage with a minimum, variable, a quote, not set', () => {
  assert.match(T.priceText({ model: 'fixed', amount: 1200 }), /^1,200\s*₪$/);
  assert.match(T.priceText({ model: 'fixed', amount: 99.5 }), /^99\.5\d?\s*₪$/);
  assert.equal(T.priceText({ model: 'percent_of_result', percent_low: 8, percent_high: 10 }), '8–10% מהתוצאה');
  assert.equal(T.priceText({ model: 'percent_of_result', percent_low: 8, percent_high: 8 }), '8% מהתוצאה');
  assert.equal(T.priceText({ model: 'percent_of_result', percent_low: 10, percent_high: null }), '10% מהתוצאה');
  assert.match(T.priceText({ model: 'percent_with_minimum', percent_low: 5, percent_high: 7, minimum_amount: 600 }), /^5–7% מהתוצאה, לא פחות מ־600\s*₪$/);
  assert.equal(T.priceText({ model: 'variable' }), 'משתנה לפי מורכבות'); assert.equal(T.priceText({ model: 'quote' }), 'הצעת מחיר לכל מקרה'); assert.equal(T.priceText({ model: 'tbd' }), 'טרם נקבע'); assert.equal(T.priceText(null), '');
  const declined = T.layerBody({ model: 'percent_with_minimum', percent_low: 5, percent_high: 7, minimum_amount: 600, status: 'declined', basis_missing: true });
  assert.match(declined, /ct-bad">נדחה/); assert.match(declined, /חסר בסיס לחישוב/);
  assert.doesNotMatch(T.layerBody({ model: 'fixed', amount: 5, status: 'recorded' }), /ct-pill/, 'a plain recorded price carries no status pill');
});

test('the checklist says what is missing, marks what is not blocking, and says activation is not available on these screens', () => {
  const html = T.engagementHtml(A.eng11_1);
  assert.match(html, /חסרים 3 תנאים/); assert.equal((html.match(/class="ct-ck ok"/g) || []).length, 3); assert.equal((html.match(/class="ct-ck no"/g) || []).length, 4);
  assert.match(html, /לא חוסם בשלב זה/); assert.match(html, /נאכף בבסיס הנתונים/); assert.match(html, /נאכף בשרת/);
  const ok = T.checklistHtml({ items: [{ key: 'a', label: 'הסכם חתום', ok: true, blocking: true, enforced: 'database' }], missing: [], can_activate: true, documented_only: false });
  assert.match(ok, /ההפעלה עצמה אינה זמינה במסכים האלה/);
  const doc = T.checklistHtml({ items: [], missing: ['x'], can_activate: false, documented_only: true });
  assert.match(doc, /אפשר לתעד, אבל אי אפשר להפעיל/); assert.match(doc, /חסר 1 תנאי|חסרים 1 תנאי/);
});

test('the states: empty catalog, nothing found, closed, no permission, server error, no connection, not found; a retry button only where trying again can help', () => {
  assert.match(T.overviewHtml({ services: { total: 0, active: 0, not_cleared: 0 }, providers: { total: 0, paused: 0, archived: 0 }, engagements: { total: 0, by_activation: {}, by_pricing_model: {} }, last_import: null }), /הקטלוג ריק/);
  assert.match(T.providersTable({ providers: [], total: 0, limit: 50, offset: 0 }, false), /אין נותני שירות/); assert.match(T.providersTable({ providers: [], total: 0, limit: 50, offset: 0 }, true), /לא נמצאו נותני שירות/);
  assert.match(T.servicesTable({ services: [], total: 0, limit: 50, offset: 0 }, true, topicName), /לא נמצאו שירותים/); assert.match(T.engagementsTable([], true, 0, false, 0), /לא נמצאו התקשרויות/);
  assert.match(T.importsTable({ imports: [], total: 0, limit: 20, offset: 0 }), /עדיין לא בוצע ייבוא/); assert.match(T.historyTable({ history: [], total: 0, limit: 50, offset: 0 }, false), /אין רישומים/);
  const e = (status, message) => Object.assign(new Error(message || 'x'), { status });
  assert.equal(T.classify(e(403, 'catalog_disabled')), 'closed'); assert.equal(T.classify(e(403, 'forbidden')), 'forbidden'); assert.equal(T.classify(e(401, 'unauthenticated')), 'auth'); assert.equal(T.classify(e(404, 'not_found')), 'notfound');
  assert.equal(T.classify(e(503, 'catalog_unavailable')), 'unavailable'); assert.equal(T.classify(e(500, 'server_error')), 'server'); assert.equal(T.classify(new TypeError('Failed to fetch')), 'network'); assert.equal(T.classify(undefined), 'network');
  const retry = (k) => /data-ct="retry"/.test(T.errorHtml(k));
  assert.deepEqual(['closed', 'unavailable', 'network', 'server'].map(retry), [true, true, true, true]); assert.deepEqual(['forbidden', 'notfound'].map(retry), [false, false]);
  assert.match(T.errorHtml('closed'), /הקטלוג כבוי/); assert.match(T.errorHtml('forbidden'), /אין הרשאה/); assert.match(T.errorHtml('server'), /לא נשמר ולא שונה דבר/); assert.match(T.errorHtml('notfound'), /data-ct="back"/);
  assert.match(T.errorHtml('closed'), /role="alert"/);
});

test('text that comes from the data is always escaped, in every screen', () => {
  const evil = '<img src=x onerror=alert(1)>', quote = '"><script>alert(2)</script>';
  const prov = { id: 1, name: evil, business_name: quote, delivery_method: 'portal', state: 'available', engagements: 1, engagements_active: 0 };
  const svc = { id: 1, name: evil, topic: quote, active: true, legal_cleared: false, engagements: 0, engagements_active: 0, code: quote };
  const eng = { provider_id: 1, provider_name: evil, service_id: 1, service_name: quote, activation: evil, contact_state: quote, agreement_state: evil, pricing_model: quote, price_linked: false, price_layers: [] };
  const all = [
    T.providersTable({ providers: [prov], total: 1, limit: 50, offset: 0 }, false), T.servicesTable({ services: [svc], total: 1, limit: 50, offset: 0 }, false, (t) => t), T.engagementsTable([eng], false, 1, false, 0),
    T.providerHtml({ provider: { id: 1, name: evil, business_name: quote, contact_phone: quote, contact_email: evil, delivery_method: evil, state: evil, internal_notes: quote }, engagements: [{ service_id: 1, service_name: evil, activation: quote, contact_state: evil, agreement_state: quote, pricing_model: evil }] }),
    T.serviceHtml({ service: { id: 1, name: evil, topic: quote, description: evil, active: true }, settings: { code: quote, finding_tags: [evil], topics: [quote], legal_cleared: true, legal_cleared_by: evil, legal_note: quote }, engagements: [{ provider_id: 1, provider_name: evil, activation: quote }], similar_services: [{ id: 2, name: evil, score: 0.9 }] }, (t) => t),
    T.engagementHtml({ engagement: { provider_id: 1, provider_name: evil, service_id: 1, service_name: quote, activation: evil, contact_state: quote, agreement_state: evil, pricing_model: quote, external_ref: quote, terms_note: evil, paused_reason: quote, updated_by: evil }, price_layers: { market: { model: 'fixed', amount: 1, source_note: evil, terms_text: quote, status: evil }, provider_offer: null, unclassified: null }, approved_price: { label: evil, price: 1, approved: true, public: false }, checklist: { items: [{ label: evil, ok: false, blocking: true, enforced: quote }], missing: [1] } }),
    T.importsTable({ imports: [{ source: evil, rows_total: 1, rows_created: 1, rows_updated: 0, rows_skipped: 0, problems: [{ row: 1, code: evil, field: quote }], imported_by: quote, file_sha256: evil, created_at: '2026-11-01T00:00:00Z' }], total: 1, limit: 20, offset: 0 }),
    T.historyTable({ history: [{ actor: evil, action: quote, entity: evil, entity_id: quote, detail: { fields: [evil] }, created_at: '2026-11-01T00:00:00Z' }], total: 1, limit: 50, offset: 0 }, false)
  ].join('\n');
  assert.doesNotMatch(all, /<img|<script/i, 'no tag from the data survives (the text itself is shown, with its angle brackets escaped)');
  assert.doesNotMatch(all, /="><script|"><img/i, 'a quote in the data never closes an attribute');
  assert.match(all, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('there is nothing to click that does nothing: every button is one of the nine navigation / filter / paging / retry actions; no form saves, no input submits', () => {
  const ALLOWED = ['nav', 'back', 'retry', 'open-provider', 'open-service', 'open-eng', 'eng-filter', 'clear', 'page'];
  const htmls = [T.overviewHtml(A.overview), T.providersTable(A.providers, false), T.providerHtml(A.provider11), T.servicesTable(A.services, false, topicName), T.serviceHtml(A.service1, topicName), T.engagementsTable(A.engagements.engagements, false, 7, true, 0),
    T.engagementHtml(A.eng11_1), T.importsTable(A.imports), T.historyTable(A.history, false), ...['closed', 'forbidden', 'unavailable', 'network', 'notfound', 'server'].map(T.errorHtml)];
  let buttons = 0;
  for (const h of htmls) for (const m of h.matchAll(/<button\b[^>]*>/g)) { buttons++; const a = /data-ct="([a-z-]+)"/.exec(m[0]); assert.ok(a && ALLOWED.includes(a[1]), 'a button without a known action: ' + m[0]); assert.match(m[0], /type="button"/, 'a button never submits: ' + m[0]); }
  assert.ok(buttons > 20, 'the screens do have navigation buttons');
  assert.doesNotMatch(htmls.join('\n'), /<form\b|type="submit"|<a\b[^>]*href|contenteditable|<textarea|<input\b/i, 'no data entry anywhere in the rendered screens');
  // the shell and the filter bars written in catalog.js itself: only the filter fields, the clear button and the navigation
  assert.deepEqual([...SRC.matchAll(/data-ct="([a-z-]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), [...ALLOWED].sort());
  assert.deepEqual([...SRC.matchAll(/<input\b[^>]*type="([a-z]+)"/g)].map((m) => m[1]), ['search', 'search', 'search'], 'the only inputs are the three search boxes');
  assert.doesNotMatch(SRC, /type="submit"|<textarea|type="checkbox"|type="radio"|type="number"|contenteditable/);
  const tags = CODE.match(/<button\b[^>]*>/g) || [];
  assert.ok(tags.length >= 14, 'the buttons in the source were found (' + tags.length + ')');
  for (const t of tags) { assert.match(t, /type="button"/, 'every button in the source is type=button: ' + t); assert.match(t, /data-ct="[a-z-]+"/, 'every button in the source has one of the known actions: ' + t); }
});

test('the file can only READ: one request helper, GET only; no fetch of its own; no write method anywhere; nothing about commissions, compensation, costs or secrets', () => {
  assert.deepEqual([...SRC.matchAll(/ctx\.api\(([^)]*)\)/g)].map((m) => m[1]), ["'GET', path"], 'one place talks to the server and it says GET');
  assert.doesNotMatch(SRC, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  assert.doesNotMatch(SRC, /'(POST|PUT|PATCH|DELETE)'|"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(CODE, /commission|compensation|payer|\bcost\b|password|secret|token|localStorage|sessionStorage|document\.cookie|innerHTML\s*\+?=\s*[a-z]+\.(name|label)/i);
  assert.doesNotMatch(SRC, /\beval\(|new Function|document\.write|insertAdjacentHTML|\son[a-z]+=/);
  const paths = [...SRC.matchAll(/get\('(\/catalog\/[^']*)'/g)].map((m) => m[1]).concat([...SRC.matchAll(/load\('(\/catalog\/[^']*)'/g)].map((m) => m[1]));
  assert.ok(paths.length >= 8 && paths.every((p) => p.startsWith('/catalog/')), 'every path is a catalog path: ' + paths.join(' '));
});

test('what the screens are given by the real API contains no secret, and what they draw contains none either', () => {
  const raw = JSON.stringify(A), drawn = [T.overviewHtml(A.overview), T.providerHtml(A.provider11), T.serviceHtml(A.service1, topicName), T.engagementHtml(A.eng11_1), T.engagementHtml(A.eng15_1), T.historyTable(A.history, false)].join('\n');
  for (const s of SECRETS) { assert.ok(!raw.includes(s), 'the API sent ' + s); assert.ok(!drawn.includes(s), 'the screen drew ' + s); }
});

test('the admin page is wired with a small focused change: one more tab, one more dispatch entry, one hand-over function; the existing tabs, the login and the api helper are unchanged', () => {
  assert.match(ADMIN, /\['pros', 'בעלי מקצוע'\], \['catalog', 'קטלוג ספקים'\], \['settings', 'הגדרות'\]/);
  const tabs = /var TABS = (\[\[.*?\]\]);/.exec(ADMIN)[1];
  assert.deepEqual([...tabs.matchAll(/\['([a-z]+)'/g)].map((m) => m[1]), ['dash', 'requests', 'impact', 'forms', 'services', 'pricing', 'pros', 'catalog', 'settings', 'audit']);
  assert.match(ADMIN, /pros: pros, catalog: catalog, settings: settings, audit: audit \}\)\[t\]\(\);/);
  const handOver = /function catalog\(\) \{[\s\S]*?\n  \}\n/.exec(ADMIN)[0];
  assert.match(handOver, /window\.KaspchemCatalog\.open\(\{ api: api, view: view, fail: fail,/); assert.doesNotMatch(handOver, /api\('(POST|PUT|PATCH|DELETE)'/);
  // the login, the CSRF header for writes and the error handling of the existing tabs are exactly what they were
  assert.match(ADMIN, /if \(method !== 'GET'\) h\['X-Kaspchem'\] = '1'; \/\/ CSRF guard checked by the server/); assert.match(ADMIN, /if \(e\.status === 401\) return gate\(/); assert.match(ADMIN, /function boot\(\) \{/);
  assert.ok(INDEX.indexOf('/admin/kaspchem/catalog.css') > INDEX.indexOf('/admin/kaspchem/admin.css')); assert.ok(INDEX.indexOf('/admin/kaspchem/catalog.js') < INDEX.indexOf('/admin/kaspchem/admin.js'), 'the catalog module loads before admin.js');
  assert.doesNotMatch(INDEX, /<script>[^<]|onclick=/, 'no inline script (the page policy allows scripts from the site only)');
});

// ---- the server side: what opening a screen does to the data, and who may read ---------------------------------------------------------------------------------------------------------
const db = require('../netlify/functions/_kaspchem/db');
const router = require('../netlify/functions/_kaspchem/admin-catalog-router.js');
const YOSI = 'yosi@example.test|admin';
// Puts a recorder between the code and the in-memory database (every statement that reaches it is kept); returns the list.
function record() {
  const rec = [];
  db.setDriver(async (t, p) => { rec.push({ t, p, tx: false }); return (await demo.pg.query(t, p)).rows; });
  db.setTransactionDriver(async (stmts, o) => {
    await demo.pg.exec('BEGIN ISOLATION LEVEL ' + (o.isolationLevel === 'RepeatableRead' ? 'REPEATABLE READ' : 'READ COMMITTED') + (o.readOnly ? ' READ ONLY' : ''));
    try { const out = []; for (const s of stmts) { rec.push({ t: s.text, p: s.params, tx: true, readOnly: o.readOnly === true }); out.push((await demo.pg.query(s.text, s.params)).rows); } await demo.pg.exec('COMMIT'); return out; }
    catch (e) { await demo.pg.exec('ROLLBACK').catch(() => {}); throw e; }
  });
  return rec;
}
const TABLES = ['services', 'service_settings', 'professionals', 'provider_profiles', 'pricing', 'provider_services', 'provider_service_prices', 'provider_service_compensation', 'catalog_imports', 'settings', 'treatment_requests', 'applicants', 'outcomes', 'revenues'];
async function fingerprint() { const out = {}; for (const t of TABLES) out[t] = (await demo.pg.query("SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM " + t + ' x')).rows[0]; return out; }
const call = async (method, p, who, extra) => { const r = await fetch(base + '/api/kaspchem/admin' + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, who ? { 'x-test-user': who } : {}, method !== 'GET' ? { 'x-kaspchem': '1' } : {}, extra || {}), body: method === 'GET' ? undefined : '{}' }); let body = null; try { body = await r.json(); } catch (e) { /* not json */ } return { status: r.status, body }; };
const GET_PATHS = ['/catalog/overview', '/catalog/services', '/catalog/services/1', '/catalog/providers', '/catalog/providers/11', '/catalog/engagements', '/catalog/engagements/11/1', '/catalog/imports', '/catalog/history', '/catalog/similar/services'];

test('opening every screen and every provider card changes NO catalog data; the audit row of a provider card is the only write, and it holds no contact detail', async () => {
  const rec = record(), before = await fingerprint(), auditBefore = Number((await demo.pg.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n);
  for (const p of GET_PATHS) assert.equal((await call('GET', p, YOSI)).status, 200, p);
  for (const id of [11, 12, 13, 14, 15, 16]) assert.equal((await call('GET', '/catalog/providers/' + id, YOSI)).status, 200, 'provider ' + id);
  for (const [p, s] of [[11, 1], [11, 2], [12, 3], [13, 5], [15, 1], [15, 2], [15, 5]]) assert.equal((await call('GET', '/catalog/engagements/' + p + '/' + s, YOSI)).status, 200);
  for (let s = 1; s <= 7; s++) assert.equal((await call('GET', '/catalog/services/' + s, YOSI)).status, 200);
  assert.equal((await call('GET', '/catalog/providers/9999', YOSI)).status, 404, 'a card that does not exist is not found, and leaves no audit row');
  assert.deepEqual(await fingerprint(), before, 'every table (catalog, pricing, settings, requests, applicants) has exactly the rows it had');
  // every statement: a read, except the audit rows of the six provider cards
  const writes = rec.filter((r) => !/^\s*(select|with)\b/i.test(r.t));
  const CARDS = 7;   // provider 11 once among the ten sample routes, and the six cards opened one by one
  assert.equal(writes.length, CARDS, 'seven provider cards opened, seven writes, and not one other');
  for (const w of writes) { assert.match(w.t, /^INSERT INTO audit_log \(actor, action, entity, entity_id, detail\) VALUES/); assert.equal(w.tx, false); assert.deepEqual([w.p[0], w.p[1], w.p[2], w.p[4]], ['yosi@example.test', 'catalog.provider.view', 'provider', '{}']); assert.match(w.p[3], /^\d+$/); }
  assert.ok(rec.filter((r) => r.tx).every((r) => r.readOnly), 'every multi-statement read ran in a READ ONLY transaction (the database itself refuses a write there)');
  const log = (await demo.pg.query('SELECT actor, action, entity, entity_id, detail::text AS d FROM audit_log ORDER BY id')).rows;
  assert.equal(log.length, auditBefore + CARDS); const fresh = log.slice(auditBefore); assert.ok(fresh.every((r) => r.action === 'catalog.provider.view' && r.entity === 'provider' && r.d === '{}'));
  // nothing personal anywhere in the whole log (older rows included): no phone, e-mail, note, business name or provider name
  const text = JSON.stringify(log), personal = (await demo.pg.query("SELECT v FROM (SELECT contact_phone AS v FROM provider_profiles UNION ALL SELECT contact_email FROM provider_profiles UNION ALL SELECT internal_notes FROM provider_profiles UNION ALL SELECT business_name FROM provider_profiles UNION ALL SELECT name FROM professionals) q WHERE v IS NOT NULL AND char_length(v) >= 4")).rows.map((r) => r.v);
  assert.ok(personal.length >= 9, 'the demo has personal-looking values to look for (' + personal.length + ')');
  for (const v of personal) assert.ok(!text.includes(v), 'the audit log holds: ' + v);
  assert.doesNotMatch(text, /050-\d{3}/, 'no phone number');
});

test('the lists and the other cards write nothing at all (no audit row, no statement that is not a read)', async () => {
  const rec = record(), before = Number((await demo.pg.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n);
  for (const p of GET_PATHS.filter((x) => !/providers\/\d/.test(x))) await call('GET', p, YOSI);
  assert.deepEqual(rec.filter((r) => !/^\s*(select|with)\b/i.test(r.t)), []);
  assert.equal(Number((await demo.pg.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n), before);
});

test('WHO MAY READ, on the real server code (the same entry point the site uses): not signed in 401, signed in but not on the owners list 403, no data touched for either; the closed switch hides even the routes', async () => {
  const rec = record(); const all = GET_PATHS.map((p) => ['GET', p, null]).concat(router.WRITE_ROUTES.map((r) => [r.method, r.sample.path, null]));
  for (const [m, p] of all) { const r = await call(m, p, null); assert.deepEqual([r.status, r.body && r.body.error], [401, 'unauthenticated'], 'no identity ' + m + ' ' + p); }
  for (const [m, p] of all) { const r = await call(m, p, 'stranger@example.test|admin'); assert.deepEqual([r.status, r.body && r.body.error], [403, 'forbidden'], 'stranger ' + m + ' ' + p); }
  for (const [m, p] of all) { const r = await call(m, p, 'yosi@example.test|admin', { 'x-test-user': 'YOSI@EXAMPLE.TEST.evil|admin' }); assert.equal(r.status, 403, 'a look-alike address is not an owner ' + p); }
  assert.equal(rec.length, 0, 'not one statement reached the database for any of these ' + all.length * 3 + ' attempts');
  // the owners list is the only door: with the role requirement on (KASPCHEM_REQUIRE_ROLE=1) a listed address without the admin role is refused too
  process.env.KASPCHEM_REQUIRE_ROLE = '1';
  try {
    for (const p of GET_PATHS) { const r = await call('GET', p, 'yosi@example.test|'); assert.deepEqual([r.status, r.body && r.body.error], [403, 'forbidden'], 'listed but no admin role ' + p); }
    assert.equal(rec.length, 0, 'and still nothing was read');
    assert.equal((await call('GET', '/catalog/overview', 'avi@example.test|admin')).status, 200, 'the second owner, with the role, reads');
  } finally { delete process.env.KASPCHEM_REQUIRE_ROLE; }
  // the switch closed: an owner gets the one "catalog_disabled" answer for every route; a stranger still gets "forbidden", never a hint about the switch
  await demo.pg.exec("DELETE FROM settings WHERE key = 'private.catalog_enabled'");
  try {
    for (const p of GET_PATHS) { const r = await call('GET', p, YOSI); assert.deepEqual([r.status, r.body.error], [403, 'catalog_disabled'], p); assert.equal((await call('GET', p, 'stranger@example.test|admin')).body.error, 'forbidden'); }
  } finally { await demo.pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('private.catalog_enabled', 'true'::jsonb, 'demo')"); }
  assert.equal((await call('GET', '/catalog/overview', YOSI)).status, 200);
});

test('the OWNER role inside the catalog gate: a caller that carries any other role is refused before a single statement is sent, for every read and every write route', async () => {
  // In production the sign-in layer gives an administrator no role field at all (every address on the owners list is an owner), so this is a second lock, not the first. It is tested directly.
  const rec = record();
  for (const role of ['ops', 'admin', 'viewer', '']) {
    for (const r of router.ROUTES) await assert.rejects(() => router.handle({ httpMethod: 'GET', queryStringParameters: {} }, { email: 'x@example.test', role }, r.sample), (e) => e.status === 403 && e.code === 'forbidden', role + ' ' + r.sample);
    for (const r of router.WRITE_ROUTES) await assert.rejects(() => router.handle({ httpMethod: r.method, queryStringParameters: {}, body: '{}', headers: {} }, { email: 'x@example.test', role }, r.sample.path), (e) => e.status === 403 && e.code === 'forbidden', role + ' ' + r.method + ' ' + r.sample.path);
  }
  await assert.rejects(() => router.handle({ httpMethod: 'GET', queryStringParameters: {} }, null, '/catalog/overview'), (e) => e.status === 401);
  assert.equal(rec.length, 0, 'nothing was read for any of them');
});

test('the demo data cannot be mistaken for real approvals: nothing is active, every name says [דמו], no price is public, and the one internally approved price belongs to an engagement that is only waiting', async () => {
  const q = async (s) => (await demo.pg.query(s)).rows;
  assert.deepEqual(await q("SELECT activation, count(*)::int AS n FROM provider_services GROUP BY activation ORDER BY activation"), [{ activation: 'draft', n: 2 }, { activation: 'paused', n: 1 }, { activation: 'pending', n: 3 }, { activation: 'retired', n: 1 }]);
  assert.deepEqual(await q("SELECT 1 FROM provider_services WHERE activation = 'active' OR contact_state = 'active' OR agreement_state = 'signed'"), [], 'no active engagement, no active collaboration, no signed agreement');
  for (const [t, c] of [['services', 'name'], ['professionals', 'name'], ['pricing', 'label']]) assert.deepEqual(await q("SELECT " + c + " FROM " + t + " WHERE " + c + " NOT LIKE '[דמו]%'"), [], t + ' names are all marked');
  assert.deepEqual(await q("SELECT business_name FROM provider_profiles WHERE business_name IS NOT NULL AND business_name NOT LIKE '[דמו]%'"), []);
  assert.deepEqual(await q('SELECT 1 FROM pricing WHERE public'), [], 'no public price in the demo');
  assert.deepEqual(await q("SELECT p.id, ps.activation FROM pricing p JOIN provider_services ps ON ps.pricing_id = p.id WHERE p.approved"), [{ id: 2, activation: 'pending' }], 'the approved price is linked to a pending engagement');
  // what the screens say about it
  const list = T.engagementsTable(A.engagements.engagements, false, 7, false, 0), labelOf = T.labels.ACTIVATION;
  for (const e of A.engagements.engagements) assert.ok(list.includes('<span class="ct-pill ct-' + ({ draft: 'muted', pending: 'warn', paused: 'warn', retired: 'muted' }[e.activation]) + '">' + labelOf[e.activation] + '</span>'), 'the row says ' + e.activation);
  assert.doesNotMatch(list, /ct-ok">פעיל<|>מאושר</, 'no row says active or approved');
  const internal = T.engagementHtml(A.eng15_1);
  assert.equal(A.eng15_1.approved_price.approved, true); assert.equal(A.eng15_1.approved_price.public, false);
  assert.match(internal.split('ct-price-public')[1], /מאושר לשימוש פנימי בלבד, לא מוצג לציבור/); assert.doesNotMatch(internal.split('ct-price-public')[1], /₪|מוצג באתר/, 'the public card shows no price at all');
  assert.match(internal, /ממתין לאישור/);
});
