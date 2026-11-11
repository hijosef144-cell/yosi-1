'use strict';
// G2 PROOF STAGES (isolated Neon branch only): the product's OWN path, end to end, as the application role (kaspchem_app) on the temporary branch.
// Where the atomic-* stages of scripts/kaspchem-g2.js send hand-built batches, these stages call the real admin entry (admin-entry.js -> admin-router.js -> the catalog routes) with synthetic requests, so what is proved
// is what the product does: the owner gate and the switch, create / edit with compare-and-set, the engagement states, the journal, the older routes that are locked while the catalog is open, the import (preview, explicit
// approval, one atomic save) of a file in the structure of the owners' real sheet (INVENTED data), the rule for paused/archived providers inside the save, and real concurrency with two connections.
// Everything runs through the same HTTP guard as the other stages (verified endpoint only, every statement must be one the product's own fence accepts, or an exact shape this stage was approved to send). No mail is sent:
// the alert sender is a recorder. All synthetic data is named g2-<run id>-... and uses @example.test addresses. Nothing here is ever run by itself: the launcher (kaspchem-g2-clipboard.js) names the stage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./kaspchem-g2.js');
const { stage, attempt, errInfo, ACTOR, LOCK5, readContent, sameContent, differingTables, TABLES, COUNTS_SQL, CONTENT_SQL } = G;

// ---- the product, as a caller -------------------------------------------------------------------------------------------------------------------------------------------------------
const ENTRY = '../netlify/functions/_kaspchem/admin-entry.js', ALERT = '../netlify/functions/_kaspchem/ops-alert.js', PRICE_GUARD = '../netlify/functions/_kaspchem/catalog-price-guard.js';
function product(c) {
  const entry = require(ENTRY), opsAlert = require(ALERT), alerts = [];
  opsAlert.setSender(async (m) => { alerts.push(m.subject); });   // a recorder: no mail is ever sent
  process.env.KASPCHEM_ADMIN_EMAILS = ACTOR; delete process.env.KASPCHEM_REQUIRE_ROLE;   // this process only
  const call = async (method, p, body) => {
    const headers = { host: 'localhost', 'content-type': 'application/json' }; if (method !== 'GET') headers['x-kaspchem'] = '1';
    const res = await entry.run(new Request('http://localhost/api/kaspchem/admin' + p, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body === undefined ? {} : body) }), async () => ({ email: ACTOR, roles: ['admin'] }));
    let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, body: json, code: json && (json.error || (json.ok ? 'ok' : null)) };
  };
  return { call, alerts };
}
const LETTERS = 'אבגדהוזחטיכלמנסעפצקרשת';
const word = (c, seed, n) => Array.from(crypto.createHash('sha256').update(c.runId + '/' + seed).digest().subarray(0, n || 8), (b) => LETTERS[b % LETTERS.length]).join('');
const nm = (c, seed) => c.runId + ' ' + word(c, seed + 'a') + ' ' + word(c, seed + 'b');
const phoneOf = (c, seed) => '05' + String(10000000 + (parseInt(crypto.createHash('md5').update(c.runId + '/' + seed).digest('hex').slice(0, 7), 16) % 89999999));
const mailOf = (c, seed) => seed + '-' + crypto.createHash('md5').update(c.runId + seed).digest('hex').slice(0, 6) + '@example.test';
const exp = (c, name, r, status, code) => c.check(name + ' -> ' + status + (code ? ' ' + code : ''), r.status === status && (!code || r.code === code), r.status + ' ' + r.code + ' ' + JSON.stringify(r.body && r.body.message ? { m: 1 } : {}));
const SECRET_KEY = /commission|compensation|payer|(^|_)cost($|_)|password|secret|token|authorization|connection/i;
const keysOf = (v, out) => { out = out || []; if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); } return out; };
const n = async (c, sql, params) => { c.allow(sql); return Number((await c.q(sql, params))[0].n); };   // the statements of a stage are constants it builds itself: each is registered before it is sent
const COUNT = (t) => 'SELECT count(*)::int AS n FROM ' + t;
const A1 = 'SELECT count(*)::int AS n FROM services WHERE active', A2 = "SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active'", A3 = 'SELECT count(*)::int AS n FROM pricing', A4 = 'SELECT count(*)::int AS n FROM provider_service_compensation';
const G2SVC = "SELECT count(*)::int AS n FROM services WHERE name LIKE $1 AND active = false";
const SEQ_ALL = "SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN ('services_id_seq', 'professionals_id_seq', 'audit_log_id_seq', 'catalog_imports_id_seq', 'pricing_id_seq')";

// =====================================================================================================================================================================================
// proof-crud: create, edit, states, journal, locks of the older routes, reads. Through the product's routes.
// =====================================================================================================================================================================================
// the one single (non-read) statement the read routes of the catalog send: the journal line of "someone opened a provider card" (catalog-store.js AUDIT_VIEW, fixed text)
const AUDIT_VIEW_RE = /^INSERT INTO audit_log \(actor, action, entity, entity_id, detail\) VALUES \(\$1, \$2, \$3, \$4, \$5::jsonb\)$/;
stage('proof-crud', { kind: 'write', independent: true, maxRequests: 500, allowSingle: [AUDIT_VIEW_RE], raw: [COUNTS_SQL, CONTENT_SQL, A1, A2, A3, A4, G2SVC, SEQ_ALL, "SELECT count(*)::int AS n FROM audit_log WHERE id > $1::bigint AND (action NOT LIKE 'catalog.%')", 'SELECT coalesce(max(id), 0)::text AS n FROM audit_log'],
  needs: ['atomic-import'], title: 'create, edit and the journal through the product\'s own routes (owner gate, switch, compare-and-set, states, locks of the older routes), as kaspchem_app on the isolated branch',
  plan: ['the catalog switch must be open (private.catalog_enabled = true, set by the branch owner before the run); the overview answers 200',
    'a provider is created (a duplicate of it is refused 409), edited with compare-and-set (a stale edit is refused 409), a service is created (a duplicate is refused), given an internal domain, settings and a legal-clearance REPORT',
    'engagements: created pending, a duplicate refused, "active" refused at creation; paused provider: no new engagement (409 provider_paused); archived provider: no new engagement (409 provider_archived)',
    'activation is refused while the checklist is incomplete (never 200); the older routes that write services and the switch itself are refused (managed_in_catalog / 400), nothing written',
    'reads of every list answer 200 and no answer carries a commission/compensation/cost/payer/password/token key',
    'counts: exactly the planned rows; pricing, settings and import log unchanged; no service and no engagement is active; the only audit rows are catalog.*'],
  async run(c) {
    const P = product(c), call = P.call, before = await readContent(c), n0 = await n(c, COUNT('audit_log')), maxAudit = (await c.q('SELECT coalesce(max(id), 0)::text AS n FROM audit_log'))[0].n;
    const seq0 = Object.fromEntries((await c.q(SEQ_ALL)).map((r) => [r.sequencename, r.last_value === null ? null : Number(r.last_value)]));
    c.note('seq_start', seq0);
    const ov = await call('GET', '/catalog/overview'); if (!exp(c, 'the catalog is open: overview', ov, 200)) { c.note('hint', 'private.catalog_enabled is not true on this branch'); return; }
    const bodies = [ov.body];
    // -- providers
    const pa = { name: nm(c, 'pa'), business_name: nm(c, 'pb'), contact_phone: phoneOf(c, 'pa'), contact_email: mailOf(c, 'pa'), internal_notes: null };
    const pc = await call('POST', '/catalog/providers', pa); if (!exp(c, 'create a provider', pc, 200)) return; const A = pc.body.id;
    exp(c, 'create the same provider again (no allow_duplicate)', await call('POST', '/catalog/providers', pa), 409, 'similar_provider_exists');
    exp(c, 'edit the provider (note) with the value that was read', await call('PATCH', '/catalog/providers/' + A, { changes: { internal_notes: 'g2 note' }, expected: { internal_notes: null } }), 200);
    const stale = await call('PATCH', '/catalog/providers/' + A, { changes: { internal_notes: 'g2 other' }, expected: { internal_notes: null } }); c.check('a STALE edit (the value changed since it was read) is refused 409 and changes nothing', stale.status === 409, stale.status + ' ' + stale.code);
    // -- services
    const sa = { name: nm(c, 'sa'), description: null }, s1 = await call('POST', '/catalog/services', sa); if (!exp(c, 'create a service', s1, 200)) return; const S1 = s1.body.id;
    exp(c, 'create the same service again', await call('POST', '/catalog/services', sa), 409, 'similar_service_exists');
    exp(c, 'edit the service: a description and an INTERNAL domain', await call('PATCH', '/catalog/services/' + S1, { changes: { description: 'g2 desc', topic: 'business' }, expected: { description: null, topic: null } }), 200);
    const card = await call('GET', '/catalog/services/' + S1); bodies.push(card.body); c.check('the service card shows the internal domain and the service is OFF', card.status === 200 && card.body.service.topic === 'business' && card.body.service.active === false, JSON.stringify(card.body && card.body.service && [card.body.service.topic, card.body.service.active]));
    const code = 'g2' + crypto.createHash('md5').update(c.runId).digest('hex').slice(0, 8);
    exp(c, 'service settings (code, one tag)', await call('PUT', '/catalog/services/' + S1 + '/settings', { code, finding_tags: ['g2tag'], topics: [] }), 200);
    exp(c, 'a legal-clearance REPORT (it verifies nothing)', await call('POST', '/catalog/services/' + S1 + '/clearance', { cleared: true, expected_cleared: false, source_kind: 'other', source: 'g2 synthetic report', approved_on: '2026-11-01' }), 200);
    // -- engagements
    exp(c, 'create an engagement as "active" is refused', await call('POST', '/catalog/engagements', { provider_id: A, service_id: S1, activation: 'active' }), 400, 'bad_activation');
    const e1 = await call('POST', '/catalog/engagements', { provider_id: A, service_id: S1, activation: 'pending' }); exp(c, 'create an engagement, submitted (pending)', e1, 200); c.check('and it is PENDING, not active', e1.body && e1.body.activation === 'pending', JSON.stringify(e1.body));
    exp(c, 'the same pair again', await call('POST', '/catalog/engagements', { provider_id: A, service_id: S1 }), 409, 'engagement_exists');
    exp(c, 'edit the engagement tracking (terms note)', await call('PATCH', '/catalog/engagements/' + A + '/' + S1, { changes: { terms_note: 'g2 terms' }, expected: { terms_note: null } }), 200);
    const eg = await call('GET', '/catalog/engagements/' + A + '/' + S1); bodies.push(eg.body); exp(c, 'the engagement card', eg, 200);
    const act = await call('POST', '/catalog/engagements/' + A + '/' + S1 + '/actions/activate', { expected_activation: 'pending', confirm: 'activate', seen: eg.body && eg.body.checklist && eg.body.checklist.seen });
    c.check('ACTIVATION is refused while the checklist is incomplete (no price, no signed agreement): never 200', act.status !== 200 && [403, 409, 422].includes(act.status), act.status + ' ' + act.code);
    // -- the availability of the provider decides who may get a NEW engagement
    const s2 = await call('POST', '/catalog/services', { name: nm(c, 'sb') }), s3 = await call('POST', '/catalog/services', { name: nm(c, 'sc') }); if (!exp(c, 'two more services', s2, 200) || !exp(c, '(the second)', s3, 200)) return; const S2 = s2.body.id, S3 = s3.body.id;
    const until = new Date(Date.now() + 2 * 86400000).toISOString();
    exp(c, 'pause the provider (a reason and a date are required)', await call('POST', '/catalog/providers/' + A + '/pause', { until, reason: 'g2 test pause' }), 200);
    exp(c, 'a PAUSED provider gets no new engagement', await call('POST', '/catalog/engagements', { provider_id: A, service_id: S2, activation: 'pending' }), 409, 'provider_paused');
    exp(c, 'resume the provider', await call('POST', '/catalog/providers/' + A + '/resume', {}), 200);
    exp(c, 'after the resume the engagement can be created', await call('POST', '/catalog/engagements', { provider_id: A, service_id: S2, activation: 'pending' }), 200);
    exp(c, 'archive the provider (no active engagement)', await call('POST', '/catalog/providers/' + A + '/archive', { reason: 'g2 test archive' }), 200);
    exp(c, 'an ARCHIVED provider gets no new engagement', await call('POST', '/catalog/engagements', { provider_id: A, service_id: S3, activation: 'pending' }), 409, 'provider_archived');
    exp(c, 'unarchive the provider', await call('POST', '/catalog/providers/' + A + '/unarchive', {}), 200);
    // -- the older routes while the catalog is open
    const ctr0 = await n(c, COUNT('services'));
    exp(c, 'the OLDER route that creates a service is closed while the catalog is open', await call('POST', '/services', { name: 'g2 old route', topic: 'g2', description: '' }), 409, 'managed_in_catalog');
    const sw = await call('PUT', '/settings', { key: 'private.catalog_enabled', value: false }); c.check('the catalog switch cannot be changed through the general settings route (refused 400)', sw.status === 400, sw.status + ' ' + sw.code);
    exp(c, 'and the catalog is still open', await call('GET', '/catalog/overview'), 200);
    c.check('nothing was written by the refused calls (services count unchanged)', (await n(c, COUNT('services'))) === ctr0, 'a service appeared');
    // -- reads: every list answers, no secret key anywhere
    for (const [label, p] of [['providers', '/catalog/providers'], ['services', '/catalog/services'], ['engagements', '/catalog/engagements'], ['prices', '/catalog/prices'], ['imports', '/catalog/imports'], ['history of the provider', '/catalog/history?entity=provider&entity_id=' + A], ['similar services', '/catalog/similar/services'], ['the provider card', '/catalog/providers/' + A]]) { const r = await call('GET', p); exp(c, 'read: ' + label, r, 200); bodies.push(r.body); }
    const bad = Array.from(new Set(keysOf(bodies).filter((k) => SECRET_KEY.test(k)))); c.check('no answer carries a commission / compensation / cost / payer / password / token key', bad.length === 0, bad.join(','));
    // -- the books
    const after = await readContent(c), g2 = c.runId + '%';
    c.check('exactly the planned rows: services +3, professionals +1, provider_profiles +1, provider_services +2, service_settings +1', after.services.rows - before.services.rows === 3 && after.professionals.rows - before.professionals.rows === 1 && after.provider_profiles.rows - before.provider_profiles.rows === 1 && after.provider_services.rows - before.provider_services.rows === 2 && after.service_settings.rows - before.service_settings.rows === 1, JSON.stringify(TABLES.map((t) => [t, after[t].rows - before[t].rows])));
    c.check('pricing, settings and the import log are exactly as before (no price, no switch, no import)', ['pricing', 'settings', 'catalog_imports'].every((t) => after[t].rows === before[t].rows && after[t].md5 === before[t].md5), differingTables(before, after).join(','));
    c.check('every service of this run is OFF and no engagement is active', (await n(c, G2SVC, [g2])) === 3 + 0 && (await n(c, A2)) === 0, 'something is active');
    c.check('every NEW audit row of this stage is a catalog.* row', (await n(c, "SELECT count(*)::int AS n FROM audit_log WHERE id > $1::bigint AND (action NOT LIKE 'catalog.%')", [maxAudit])) === 0, 'a row that is not catalog.*');
    c.check('the audit holds more rows than before (every write left its line)', (await n(c, COUNT('audit_log'))) > n0, 'no audit');
    c.check('no mail was sent: only the recorder saw alerts (activation/retire/import ones)', Array.isArray(P.alerts), 'recorder missing'); c.note('alerts_recorded', P.alerts.length);
    c.note('created', { provider: A, services: [S1, S2, S3] });
  } });

// =====================================================================================================================================================================================
// proof-twin: the file in the structure of the owners' real sheet (INVENTED data) through the product's import: preview, explicit approval (phones confirmed row by row), ONE atomic save.
// =====================================================================================================================================================================================
const db = require('../netlify/functions/_kaspchem/db.js'), W = require('../netlify/functions/_kaspchem/catalog-writes.js'), store = require('../netlify/functions/_kaspchem/catalog-store.js'), Imp = require('../netlify/functions/_kaspchem/catalog/import.js');
const F = require('../tests/fixtures/catalog-demo.js');
const TWIN_FILE = () => fs.readFileSync(path.join(G.ROOT, 'tests', 'fixtures', 'catalog-sheet-structure-twin.csv'), 'utf8');
const TW = { svc: "SELECT count(*)::int AS n FROM services WHERE name LIKE '[דמו] %'", svcOn: "SELECT count(*)::int AS n FROM services WHERE name LIKE '[דמו] %' AND active", prov: "SELECT count(*)::int AS n FROM professionals WHERE name LIKE '[דמו] %'",
  eng: "SELECT count(*)::int AS n FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id WHERE p.name LIKE '[דמו] %'",
  engBad: "SELECT count(*)::int AS n FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id WHERE p.name LIKE '[דמו] %' AND (ps.activation <> 'pending' OR ps.agreement_state NOT IN ('not_discussed', 'draft') OR ps.contact_state NOT IN ('none', 'contacted', 'negotiating') OR ps.pricing_id IS NOT NULL OR ps.pricing_model = 'fixed')",
  lay: "SELECT count(*)::int AS n FROM provider_service_prices l JOIN professionals p ON p.id = l.professional_id WHERE p.name LIKE '[דמו] %'", layBad: "SELECT count(*)::int AS n FROM provider_service_prices l JOIN professionals p ON p.id = l.professional_id WHERE p.name LIKE '[דמו] %' AND (l.status <> 'recorded' OR l.kind NOT IN ('market', 'unclassified'))",
  market: "SELECT count(*)::int AS n FROM provider_service_prices l JOIN professionals p ON p.id = l.professional_id WHERE p.name LIKE '[דמו] %' AND l.kind = 'market'",
  topics: "SELECT coalesce(jsonb_object_agg(topic, n), '{}'::jsonb)::text AS j FROM (SELECT coalesce(topic, '') AS topic, count(*)::int AS n FROM services WHERE name LIKE '[דמו] %' GROUP BY topic) t",
  phones: "SELECT coalesce(string_agg(pp.contact_phone, ',' ORDER BY pp.contact_phone), '') AS j FROM provider_profiles pp JOIN professionals p ON p.id = pp.professional_id WHERE p.name LIKE '[דמו] %'",
  newest: 'SELECT source, rows_total, rows_created, rows_updated, rows_skipped, problems::text AS problems, imported_by FROM catalog_imports ORDER BY id DESC LIMIT 1',
  logs: "SELECT coalesce(string_agg(t, ' '), '') AS j FROM (SELECT detail::text AS t FROM audit_log UNION ALL SELECT c::text FROM catalog_imports c) x" };
const approvalsOf = (p, noConfirm) => { const rows = {}; for (const r of p.rows) { if (['skipped', 'problem', 'unchanged'].includes(r.status)) continue; rows[r.rowNumber] = { apply: true, accept: [], acceptManual: [], confirmed: noConfirm ? [] : r.needsConfirmation, decisions: (r.decisions || []).length ? { service: { use: 'new' } } : undefined }; } return { rows }; };
stage('proof-twin', { kind: 'write', independent: true, maxRequests: 300, allowSingle: [AUDIT_VIEW_RE], raw: [COUNTS_SQL, CONTENT_SQL, A1, A2, A3, SEQ_ALL].concat(Object.values(TW)),
  needs: ['atomic-import'], title: 'THE structure twin of the real sheet (22 services, 3 providers, 21 engagements, 21 reported prices, invented data) through the product\'s import: preview, explicit approval, ONE atomic save, then everything stays inactive',
  plan: ['the twin file (tests/fixtures/catalog-sheet-structure-twin.csv, invented data) is previewed: 22 new rows, 5 placeholder rows skipped, 0 problems, 1 question (the two mortgage refinancing services stay apart), 15 phones that lost their zero',
    'the list of corrections is printed as row numbers and codes only (no contact detail, no name)',
    'approving without confirming the 15 phones is refused 422 and writes NOTHING; then the explicit approval (each phone row confirmed, the pair kept apart) is saved in ONE atomic batch',
    'exactly 3 providers (+3 profiles), 22 services, 21 engagements, 21 reported prices, 1 import-log row, 1 audit row; pricing, settings and service settings unchanged',
    'every service OFF, every engagement pending, none signed/active/priced, every price only "recorded" (market or unclassified), the internal domains stored as ids, the confirmed phones with their zero',
    'the audit and the import log hold no cell of the file; the same save again is refused 409; a new preview finds nothing new'],
  async run(c) {
    const P = product(c), call = P.call, csv = TWIN_FILE(), before = await readContent(c);
    const pv = await call('POST', '/catalog/imports/preview', { csv }); if (!exp(c, 'preview of the twin file', pv, 200)) return; const p = pv.body.preview;
    c.check('PREVIEW: 22 new rows, 5 placeholders skipped, 0 problems, no file problem, no warning', JSON.stringify(p.summary) === JSON.stringify({ rows_total: 27, new: 22, changed: 0, unchanged: 0, skipped: 5, problem: 0 }) && p.fileProblems.length === 0 && p.warnings.length === 0, JSON.stringify([p.summary, p.fileProblems, p.warnings]));
    c.check('one question (the two mortgage refinancing services) and the one column that is not read is named', p.decisionsNeeded === 1 && p.unknownColumns.length === 1, JSON.stringify([p.decisionsNeeded, p.unknownColumns.map((u) => u.text)]));
    const list = Imp.correctionList(p), byCode = {}; list.forEach((x) => x.codes.forEach((k) => { byCode[k] = (byCode[k] || 0) + 1; }));
    c.check('CORRECTIONS NEEDED (row numbers and codes only): 15 rows, each with a phone to confirm, one of them also with the question', list.length === 15 && byCode['confirm:phone_restored'] === 15 && byCode['decision:similar_service'] === 1 && !/[0-9]{7,}|@|[א-ת]/.test(JSON.stringify(list)), JSON.stringify(byCode));
    c.note('corrections_needed', { rows: list.length, codes: byCode, row_numbers: list.map((x) => x.row) });
    const bad = await call('POST', '/catalog/imports/apply', { csv, previewId: p.previewId, approvals: approvalsOf(p, true) });
    c.check('approving WITHOUT confirming the phones is refused 422 rows_refused', bad.status === 422 && bad.code === 'rows_refused', bad.status + ' ' + bad.code);
    const mid = await readContent(c); c.check('and the refused save wrote NOTHING (every readable table has the same count and content hash)', sameContent(before, mid), 'different: ' + differingTables(before, mid).join(','));
    const seq0 = Object.fromEntries((await c.q(SEQ_ALL)).map((r) => [r.sequencename, r.last_value === null ? null : Number(r.last_value)]));
    const ap = await call('POST', '/catalog/imports/apply', { csv, previewId: p.previewId, approvals: approvalsOf(p) });
    if (!c.check('THE SAVE (the explicit approval, the phones confirmed row by row): 200 applied', ap.status === 200 && ap.body && ap.body.applied === true, ap.status + ' ' + ap.code + ' ' + JSON.stringify(ap.body && ap.body.codes))) return;
    c.check('the plan was exactly: 22 services, 3 providers, 21 engagements, 21 price layers', JSON.stringify(Object.fromEntries(Object.entries(ap.body.operations).sort())) === JSON.stringify({ create_engagement: 21, create_layer: 21, create_provider: 3, create_service: 22 }), JSON.stringify(ap.body.operations));
    const after = await readContent(c), d = Object.fromEntries(TABLES.map((t) => [t, after[t].rows - before[t].rows]));
    c.check('STORED: 3 providers, 3 profiles, 22 services, 21 engagements, 21 reported prices, 1 import log, 1 audit row', d.professionals === 3 && d.provider_profiles === 3 && d.services === 22 && d.provider_services === 21 && d.provider_service_prices === 21 && d.catalog_imports === 1 && d.audit_log === 1, JSON.stringify(d));
    c.check('pricing, settings and service settings unchanged (no price, no switch, no setting)', ['pricing', 'settings', 'service_settings'].every((t) => after[t].rows === before[t].rows && after[t].md5 === before[t].md5), differingTables(before, after).join(','));
    c.check('read back by name: 3 providers, 22 services, 21 engagements, 21 prices', (await n(c, TW.prov)) === 3 && (await n(c, TW.svc)) === 22 && (await n(c, TW.eng)) === 21 && (await n(c, TW.lay)) === 21, 'the twin rows are not as expected');
    c.check('EVERYTHING STAYS INACTIVE: no service is on; every engagement is pending (none signed, none active, none priced); no active engagement anywhere', (await n(c, TW.svcOn)) === 0 && (await n(c, TW.engBad)) === 0 && (await n(c, A2)) === 0 && (await n(c, A1)) === 0, 'something is on');
    c.check('every price is only REPORTED: status recorded, kind market (3) or unclassified (18); the approved-price table is untouched', (await n(c, TW.layBad)) === 0 && (await n(c, TW.market)) === 3 && (await n(c, A3)) === 0, 'a price is not as reported');
    const tp = JSON.parse((await c.q(TW.topics))[0].j); c.note('topics_of_the_twin', tp);
    c.check('the domains are ids: the two internal ones (2 + 3 services) and system topics; none is text or empty', tp.business === 2 && tp['savings-investments'] === 3 && Object.keys(tp).every((k) => k && !/[א-ת]/.test(k)) && Object.values(tp).reduce((a, b) => a + b, 0) === 22, JSON.stringify(tp));
    c.check('the three phones were completed ONLY after the explicit confirmation, and one is untouched (it had its zero)', (await c.q(TW.phones))[0].j === '0500000101,0500000202,0500000303', 'phones differ from the confirmed ones');
    const j = (await c.q(TW.newest))[0]; c.check('THE IMPORT LOG: csv, 22 rows created, 0 updated, no problem, the synthetic actor', j.source === 'csv' && Number(j.rows_created) === 22 && Number(j.rows_updated) === 0 && j.problems === '[]' && j.imported_by === ACTOR, JSON.stringify([j.source, j.rows_created, j.rows_updated, j.problems]));
    const logs = (await c.q(TW.logs))[0].j; c.check('PRIVACY: neither the audit nor the import log holds a name, phone, e-mail or sheet id of the file', !['0500000101', '500000101', 'twin-a@', 'twin-b@', 'אביגיל', 'בנימין', 'גילי', 'TW-01', 'מחזור משכנתא'].some((x) => logs.includes(x)), 'a cell of the file is in a log');
    const seq1 = Object.fromEntries((await c.q(SEQ_ALL)).map((r) => [r.sequencename, r.last_value === null ? null : Number(r.last_value)])); c.note('sequences', { before: seq0, after: seq1 });
    const again = await call('POST', '/catalog/imports/apply', { csv, previewId: p.previewId, approvals: approvalsOf(p) }); c.check('the SAME save again is refused 409 (stale)', again.status === 409, again.status + ' ' + again.code);
    const dbl = await readContent(c); c.check('NOTHING DOUBLED: every readable table is as right after the save', sameContent(after, dbl), differingTables(after, dbl).join(','));
    const p2 = await call('POST', '/catalog/imports/preview', { csv }); c.check('a new preview of the same file finds nothing new: 22 unchanged', p2.status === 200 && p2.body.preview.summary.new === 0 && p2.body.preview.summary.unchanged === 22, JSON.stringify(p2.body && p2.body.preview && p2.body.preview.summary));
  } });

// =====================================================================================================================================================================================
// proof-r12: a paused or archived provider gets no new engagement from an import, in the preview, in the approval and INSIDE the INSERT of the save (a batch that skips the planner is stopped by the database).
// =====================================================================================================================================================================================
const demoRow = (c, seed, over) => Object.assign({}, F.ROWS.fixed, { domain: 'g2', service: nm(c, seed + 's'), description: 'g2 ' + word(c, seed + 'd'), provider: nm(c, seed + 'p'), business: word(c, seed + 'b') + ' ' + word(c, seed + 'c'), phone: phoneOf(c, seed), email: mailOf(c, seed), externalId: 'G2-' + crypto.createHash('md5').update(c.runId + seed).digest('hex').slice(0, 6), notes: 'g2' }, over || {});
const SEL_PROV = "SELECT count(*)::int AS n FROM provider_services WHERE professional_id = $1::bigint";
stage('proof-r12', { kind: 'write', independent: true, maxRequests: 300, allowSingle: [AUDIT_VIEW_RE], raw: [COUNTS_SQL, CONTENT_SQL, SEL_PROV, store.FINGERPRINT_SQL],
  needs: ['atomic-import'], title: 'a PAUSED or ARCHIVED provider gets no new engagement from an import: refused in the preview, in the approval, and by the database inside the save',
  plan: ['a provider and a service are created through the routes; the provider is paused; a one-row file names that provider with a NEW service: the preview marks the row a problem (provider_unavailable) and approving it is refused 422',
    'a hand-built import batch that SKIPS the planner (an engagement for that provider, with the fingerprint of the data right now) is stopped by the INSERT\'s own guard: nothing is written (not the audit row, not the import log)',
    'the same for an ARCHIVED provider',
    'control: after the resume the very same batch is saved, so the guard is the only difference'],
  async run(c) {
    const P = product(c), call = P.call, imp = (rows) => F.csv(rows);
    const pa = { name: nm(c, 'xa'), business_name: nm(c, 'xb'), contact_phone: phoneOf(c, 'xa'), contact_email: mailOf(c, 'xa') }, pc = await call('POST', '/catalog/providers', pa); if (!exp(c, 'create a provider', pc, 200)) return; const R = pc.body.id;
    const sv = await call('POST', '/catalog/services', { name: nm(c, 'xs') }); if (!exp(c, 'create a service', sv, 200)) return; const S = sv.body.id;
    const file = imp([demoRow(c, 'x1', { provider: pa.name, business: pa.business_name, phone: pa.contact_phone, email: pa.contact_email })]);
    const batchFor = async () => { const snap = await store.readSnapshot(), op = { op: 'create_engagement', provider: { id: String(R) }, service: { id: String(S) }, set: { activation: 'draft', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', external_ref: null, terms_note: null }, updated_by: 'import:' + ACTOR, source_row: 2 };
      return W.importBatch([op], new Map(), { expect: snap.fingerprint, actor: ACTOR, fileSha256: 'a'.repeat(64), summary: { create_engagement: 1 }, rowsApplied: [2], log: { source: 'csv', file_sha256: 'a'.repeat(64), rows_total: 1, rows_created: 1, rows_updated: 0, rows_skipped: 0, problems: [], imported_by: ACTOR } }); };
    for (const how of ['paused', 'archived']) {
      const ok = how === 'paused' ? await call('POST', '/catalog/providers/' + R + '/pause', { until: new Date(Date.now() + 2 * 86400000).toISOString(), reason: 'g2 r12 pause' }) : await call('POST', '/catalog/providers/' + R + '/archive', { reason: 'g2 r12 archive' });
      if (!exp(c, how + ': the provider is made ' + how, ok, 200)) return;
      const base = await readContent(c), pv = await call('POST', '/catalog/imports/preview', { csv: file }); if (!exp(c, how + ': preview', pv, 200)) return; const row = pv.body.preview.rows.find((r) => r.rowNumber === 2);
      c.check(how + ': the row is a PROBLEM (provider_unavailable), with no engagement and no layer in its record', row && row.status === 'problem' && row.problems[0].code === 'provider_unavailable' && row.engagement === null, JSON.stringify(row && [row.status, row.problems]));
      const ap = await call('POST', '/catalog/imports/apply', { csv: file, previewId: pv.body.preview.previewId, approvals: { rows: { 2: { apply: true, accept: [], acceptManual: [], confirmed: [] } } } });
      c.check(how + ': approving the row is refused 422 rows_refused', ap.status === 422 && ap.code === 'rows_refused', ap.status + ' ' + ap.code);
      const batch = await batchFor(), r = await attempt(() => db.writeTransaction(batch, { profile: 'import' })), info = r.ok ? null : errInfo(r.error);
      if (r.ok) { c.check(how + ': a batch that skips the planner is stopped by the database', false, 'IT WAS SAVED: the INSERT guard did not stop it'); return; }
      c.check(how + ': the database refuses it: P0001, mapped 409 (no row: the INSERT\'s own guard)', info.code === 'P0001' && W.mapError(r.error).status === 409, JSON.stringify([info, W.mapError(r.error).status]));
      const now = await readContent(c); c.check(how + ': NOTHING was written (not the engagement, not the audit row, not the import log)', sameContent(base, now) && (await c.q(SEL_PROV, [String(R)]))[0].n === 0, 'different: ' + differingTables(base, now).join(','));
      if (how === 'paused') exp(c, 'resume the provider', await call('POST', '/catalog/providers/' + R + '/resume', {}), 200); else exp(c, 'unarchive the provider', await call('POST', '/catalog/providers/' + R + '/unarchive', {}), 200);
    }
    const ctl = await batchFor(), cr = await attempt(() => db.writeTransaction(ctl, { profile: 'import' }));
    c.check('CONTROL: with the provider available the very same batch is saved (the guard was the only difference)', cr.ok && (await c.q(SEL_PROV, [String(R)]))[0].n === 1, cr.ok ? 'engagement missing' : JSON.stringify(errInfo(cr.error)));
    c.note('created', { provider: R, service: S });
  } });

// =====================================================================================================================================================================================
// proof-concurrency: two real connections. compare-and-set on one row, import against import, a table lock held against a single write, reads during the lock.
// =====================================================================================================================================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOTES_SQL = 'SELECT internal_notes AS j FROM provider_profiles WHERE professional_id = $1::bigint';
const T_IMPORT = db.timeoutStatements('import').map((s) => s.text), SLEEP_4 = 'SELECT pg_sleep(4)';
stage('proof-concurrency', { kind: 'write', independent: true, maxRequests: 400, allowSingle: [AUDIT_VIEW_RE], raw: [COUNTS_SQL, CONTENT_SQL, LOCK5, SLEEP_4, NOTES_SQL].concat(T_IMPORT, [TW.svc, SEL_PROV]),
  needs: ['atomic-import'], title: 'REAL concurrency (two connections): compare-and-set on one row, import against import, a table lock held against a single write, reads during the lock',
  plan: ['compare-and-set: two edits of the same row sent at the same moment with the same expected value: exactly one is saved (200), the other is refused 409',
    'import against import: two different one-row files previewed BEFORE either is saved, then both saved at the same moment: exactly one is saved, the other is refused 409 (stale / busy), nothing doubled',
    'the lock: one connection takes the five-table lock of an import and holds it for 4 s; during that time a READ answers at once, a single WRITE waits its 1.5 s lock timeout and is refused 409 busy_retry; afterwards the very same write succeeds',
    'every part is separate: a part that cannot be carried out is reported by name and does not stop the others'],
  async run(c) {
    const P = product(c), call = P.call;
    const sub = async (label, fn) => { try { await fn(); } catch (e) { c.check(label + ': the part ran to its end', false, 'stopped by ' + (e && e.message ? String(e.message).slice(0, 160) : JSON.stringify(errInfo(e)))); } };
    const pa = { name: nm(c, 'ca'), business_name: nm(c, 'cb'), contact_phone: phoneOf(c, 'ca'), contact_email: mailOf(c, 'ca') }, pc = await call('POST', '/catalog/providers', pa); if (!exp(c, 'setup: a provider', pc, 200)) return; const X = pc.body.id;
    await sub('COMPARE-AND-SET', async () => {
      const edit = (txt) => call('PATCH', '/catalog/providers/' + X, { changes: { internal_notes: txt }, expected: { internal_notes: null } });
      const rs = await Promise.all([edit('g2 first'), edit('g2 second')]), st = rs.map((r) => r.status).sort();
      c.check('CAS: two edits at the same moment with the same expected value: exactly one 200 and one 409', JSON.stringify(st) === '[200,409]', JSON.stringify(rs.map((r) => [r.status, r.code])));
      const row = (await c.q(NOTES_SQL, [String(X)]))[0].j; c.check('CAS: the row holds exactly the value of the one that won', ['g2 first', 'g2 second'].includes(row) && rs.find((r) => r.status === 200) !== undefined, String(row));
    });
    await sub('IMPORT AGAINST IMPORT', async () => {
      const f1 = F.csv([demoRow(c, 'i1')]), f2 = F.csv([demoRow(c, 'i2')]);
      const p1 = await call('POST', '/catalog/imports/preview', { csv: f1 }), p2 = await call('POST', '/catalog/imports/preview', { csv: f2 });
      if (!c.check('IMPORT: both previews are made before either is saved (both new)', p1.status === 200 && p2.status === 200 && p1.body.preview.rows.concat(p2.body.preview.rows).filter((r) => r.status === 'new').length === 2, p1.status + ' ' + p2.status)) return;
      const ap = (csv, p) => call('POST', '/catalog/imports/apply', { csv, previewId: p.body.preview.previewId, approvals: approvalsOf(p.body.preview) }), base = await readContent(c);
      const rs = await Promise.all([ap(f1, p1), ap(f2, p2)]), st = rs.map((r) => r.status).sort();
      c.check('IMPORT: both sent at the same moment: exactly one is saved (200), the other is refused 409', JSON.stringify(st) === '[200,409]' && ['preview_stale', 'busy_retry', 'conflict'].includes((rs.find((r) => r.status === 409) || {}).code), JSON.stringify(rs.map((r) => [r.status, r.code])));
      const after = await readContent(c); c.check('IMPORT: exactly ONE service and ONE import log row were added (nothing doubled, nothing half-saved)', after.services.rows - base.services.rows === 1 && after.catalog_imports.rows - base.catalog_imports.rows === 1 && after.professionals.rows - base.professionals.rows === 1, JSON.stringify(TABLES.map((t) => [t, after[t].rows - base[t].rows])));
      c.note('import_race', rs.map((r) => r.status + ' ' + r.code));
    });
    await sub('THE LOCK', async () => {
      const cur = (await c.q(NOTES_SQL, [String(X)]))[0].j;
      const t0 = Date.now(), hold = attempt(() => c.tx(T_IMPORT.concat([LOCK5, SLEEP_4]), { readOnly: false, isolationLevel: 'ReadCommitted' }));   // not awaited: the lock is held for about 4 s
      await sleep(700);
      const r0 = Date.now(), rd = await call('GET', '/catalog/providers?limit=5'), rms = Date.now() - r0;
      c.check('LOCK: a READ during the lock is answered at once (200, under 2.5 s)', rd.status === 200 && rms < 2500, rd.status + ' in ' + rms + ' ms'); c.note('read_during_lock_ms', rms);
      const w0 = Date.now(), wr = await call('PATCH', '/catalog/providers/' + X, { changes: { internal_notes: 'g2 during the lock' }, expected: { internal_notes: cur } }), wms = Date.now() - w0;
      c.check('LOCK: a single WRITE during the lock waits its lock timeout (about 1.5 s) and is refused 409 busy_retry', wr.status === 409 && wr.code === 'busy_retry' && wms >= 1200 && wms < 3600, wr.status + ' ' + wr.code + ' in ' + wms + ' ms'); c.note('write_during_lock_ms', wms);
      const hr = await hold; c.check('LOCK: the lock holder finished normally after about 4 s (nothing was kept, nothing broke)', hr.ok && Date.now() - t0 >= 3800, hr.ok ? (Date.now() - t0) + ' ms' : JSON.stringify(errInfo(hr.error)));
      const cur2 = (await c.q(NOTES_SQL, [String(X)]))[0].j, after = await call('PATCH', '/catalog/providers/' + X, { changes: { internal_notes: 'g2 after the lock' }, expected: { internal_notes: cur2 } }); exp(c, 'LOCK: after it the very same write succeeds (no lock was left behind)', after, 200);
    });
    c.note('created', { provider: X });
  } });

// =====================================================================================================================================================================================
// proof-race: THE KNOWN RACE between an activation and an edit of the price it depends on (documented as a blocker of any real activation). It is made DETERMINISTIC, not left to luck: a row lock on the price (taken by a
// third connection for 4 s) makes the older price edit wait; while it waits, the activation is sent and completes; then the lock is released and the edit continues. Both are the product's own routes and statements.
// What the product's rules say: the edit may not touch a price linked to an ACTIVE engagement (checked inside its UPDATE), and the activation checks the price is approved and fits (checked inside its UPDATE). What the
// experiment shows is whether those two checks, each made against the data as it was when ITS statement began, can both pass. The outcome is RECORDED (a violation is a finding, not a failure of the experiment).
// It needs private.catalog_activation_enabled = true on this branch (set by the branch owner before the run); it activates ONE synthetic g2 engagement on the isolated branch, nothing else.
// =====================================================================================================================================================================================
const exact = (t) => ({ test: (x) => x === t });
const priceGuard = require(PRICE_GUARD);
const PRICE_INSERT = 'INSERT INTO pricing (service_id, professional_id, label, price, cost, commission, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id';
const PRICE_APPROVE = 'UPDATE pricing SET approved = true, approved_by = $1, approved_at = now(), public = $2 WHERE id = $3 AND price IS NOT NULL RETURNING id';
const PRICE_PATCH = 'UPDATE pricing SET service_id=$1, professional_id=$2, label=$3, price=$4, cost=$5, commission=$6, notes=$7, approved=false, approved_by=NULL, approved_at=NULL, public=false WHERE id=$8 AND NOT ' + priceGuard.ACTIVE_LINK + ' RETURNING id';
const OLD_AUDIT = 'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)';
const HOLD_PRICE = "SELECT pg_sleep(4) FROM (SELECT 1 FROM pricing WHERE label LIKE 'g2-%' FOR UPDATE) x";
const STATE_Q = 'SELECT ps.activation, pr.approved, pr.price::text AS price, pr.public FROM provider_services ps LEFT JOIN pricing pr ON pr.id = ps.pricing_id WHERE ps.professional_id = $1::bigint AND ps.service_id = $2::bigint';
stage('proof-race', { kind: 'write', independent: true, maxRequests: 200, allowSingle: [AUDIT_VIEW_RE, exact(OLD_AUDIT), exact(PRICE_INSERT), exact(PRICE_APPROVE), exact(PRICE_PATCH)], raw: [COUNTS_SQL, CONTENT_SQL, HOLD_PRICE, STATE_Q, A2],
  needs: ['atomic-import'], title: 'THE KNOWN RACE (activation against an edit of its price) made deterministic with a row lock on two connections; the outcome is recorded',
  plan: ['one synthetic provider, service (settings + a legal-clearance REPORT), engagement (pending), and a price made and approved through the OLDER routes, linked to the engagement, agreement signed and collaboration active (reports of the owner)',
    'the checklist must be complete and the activation switch open; then: a third connection holds a row lock on the price for 4 s; the older price edit is sent and WAITS; the activation is sent meanwhile and completes; the lock is released and the edit continues',
    'recorded: the answers of both, and whether the engagement ended ACTIVE with a price that is no longer approved (the race the database does not close yet)',
    'afterwards, in plain order, the older edit of that price is refused 409 (price_linked_to_active_engagement): the guard works when the order is plain'],
  async run(c) {
    const P = product(c), call = P.call, label = c.runId + ' price';
    const pc = await call('POST', '/catalog/providers', { name: nm(c, 'ra'), business_name: nm(c, 'rb'), contact_phone: phoneOf(c, 'ra'), contact_email: mailOf(c, 'ra') }); if (!exp(c, 'setup: a provider', pc, 200)) return; const R = pc.body.id;
    const sv = await call('POST', '/catalog/services', { name: nm(c, 'rs') }); if (!exp(c, 'setup: a service', sv, 200)) return; const S = sv.body.id;
    if (!exp(c, 'setup: service settings', await call('PUT', '/catalog/services/' + S + '/settings', { code: 'g2' + crypto.createHash('md5').update(c.runId + 'r').digest('hex').slice(0, 8), finding_tags: ['g2tag'], topics: [] }), 200)) return;
    if (!exp(c, 'setup: legal-clearance report', await call('POST', '/catalog/services/' + S + '/clearance', { cleared: true, expected_cleared: false, source_kind: 'other', source: 'g2 synthetic report', approved_on: '2026-11-01' }), 200)) return;
    if (!exp(c, 'setup: engagement (pending)', await call('POST', '/catalog/engagements', { provider_id: R, service_id: S, activation: 'pending' }), 200)) return;
    const pr = await call('POST', '/pricing', { service_id: S, professional_id: null, label, price: 1000, cost: 0, commission: 0, notes: null }); if (!exp(c, 'setup: a price through the OLDER route', pr, 200)) return; const PID = pr.body.id;
    if (!exp(c, 'setup: the price is approved (not public)', await call('POST', '/pricing/' + PID + '/approve', { public: false }), 200)) return;
    if (!exp(c, 'setup: the price is linked to the engagement', await call('POST', '/catalog/engagements/' + R + '/' + S + '/link-price', { pricing_id: PID, expected_pricing_id: null }), 200)) return;
    if (!exp(c, 'setup: the owner reports the agreement signed and the collaboration active', await call('PATCH', '/catalog/engagements/' + R + '/' + S, { changes: { contact_state: 'active', agreement_state: 'signed' }, expected: { contact_state: 'none', agreement_state: 'not_discussed' } }), 200)) return;
    const card = await call('GET', '/catalog/engagements/' + R + '/' + S), ck = card.body && card.body.checklist;
    if (!c.check('setup: the checklist is complete (can_activate)', card.status === 200 && ck && ck.can_activate === true, JSON.stringify(ck && { can: ck.can_activate, missing: ck.missing }))) return;
    // -- the race
    const hold = attempt(() => c.tx([HOLD_PRICE], { readOnly: false, isolationLevel: 'ReadCommitted' })); await sleep(700);
    const edit = { service_id: S, professional_id: null, label, price: 1500, cost: 0, commission: 0, notes: null }, t0 = Date.now();
    const pB = call('PATCH', '/pricing/' + PID, edit); await sleep(800);
    const rA = await call('POST', '/catalog/engagements/' + R + '/' + S + '/actions/activate', { expected_activation: 'pending', confirm: 'activate', seen: ck.seen }), aMs = Date.now() - t0;
    const rB = await pB, bMs = Date.now() - t0, hr = await hold;
    c.check('the experiment ran as designed: the lock holder finished normally', hr.ok, hr.ok ? '' : JSON.stringify(errInfo(hr.error)));
    c.check('the activation was NOT held up by the price edit that was waiting (it answered 200 while the edit was still waiting)', rA.status === 200 && aMs < bMs, JSON.stringify({ a: [rA.status, rA.code, aMs], b: [rB.status, rB.code, bMs] }));
    const st = (await c.q(STATE_Q, [String(R), String(S)]))[0], violated = !!st && st.activation === 'active' && st.approved === false;
    c.note('race', { activation_answer: [rA.status, rA.code], price_edit_answer: [rB.status, rB.code], engagement: st && st.activation, price_approved: st && st.approved, price_amount: st && st.price });
    c.note('race_violation', violated);
    c.check('RACE OUTCOME RECORDED (' + (violated ? 'VIOLATION: the engagement is ACTIVE and its price is no longer approved: the two checks each passed on the data as of the start of their own statement' : 'no violation: the guard held') + ')', !!st, 'the state could not be read');
    const again = await call('PATCH', '/pricing/' + PID, edit); c.check('in PLAIN order the older edit of a price linked to an ACTIVE engagement is refused 409 price_linked_to_active_engagement (the guard itself works)', again.status === 409 && again.code === 'price_linked_to_active_engagement', again.status + ' ' + again.code);
    c.note('created', { provider: R, service: S, price: PID });
  } });

// =====================================================================================================================================================================================
// THE STAGES OF MIGRATION 003 (the price race guard). They need the two triggers on the branch (the migration was applied by the branch owner before the run). The older race stage above showed the VIOLATION without the
// triggers; these show that with them (1) the activation and the price edit are ordered by the row lock in BOTH orders and at most one succeeds, (2) a price edit that harms an active engagement is refused by the database
// even when the application's own check is skipped, (3) the application role cannot switch the guard off, (4) locks, timeouts and a deadlock behave, and (5) the window of OPENING the catalog switch is closed.
// =====================================================================================================================================================================================
const TRIGGERS_Q = "SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('kc_pricing_guard', 'kc_engagement_price_guard') AND tgenabled = 'O' AND NOT tgisinternal";
const STATE_BY_LABEL = 'SELECT ps.activation, pr.approved, pr.price::text AS price FROM provider_services ps LEFT JOIN pricing pr ON pr.id = ps.pricing_id WHERE ps.professional_id = $1::bigint AND ps.service_id = $2::bigint';
const ACT_AUDITS = "SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.engagement.activate' AND entity_id = $1";
const IDLE_Q = "SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%')::int AS idle_tx, (SELECT count(*) FROM pg_locks WHERE NOT granted)::int AS waiting";
// Seeing the order of two requests on the SERVER: another connection reads pg_stat_activity (the same role sees its own sessions) and looks for a request that is waiting for a lock. waitFor waits until one is seen, and stops
// as soon as the request has answered (then it was not held up at all). The order of two requests is then the order of the lock queue, not a guess of timing.
const WAITING = (like) => "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock' AND query LIKE '" + like + "'";
const WAIT_ACT = WAITING('%UPDATE provider_services SET activation%'), WAIT_EDIT = WAITING('%UPDATE pricing SET service_id%'), WAIT_OLDWRITE = WAITING('%UPDATE services s SET%');
async function waitFor(c, sql, ms, pending) {
  let done = false; pending.then(() => { done = true; }, () => { done = true; });
  const end = Date.now() + ms;
  while (!done) { if ((await n(c, sql)) >= 1) return true; if (Date.now() > end) return false; await sleep(120); }
  return false;
}
// The lock holders of the race stage name ONE row, by id (a pattern matched the rows of earlier rounds and earlier runs, and "SELECT pg_sleep(n) FROM (... FOR UPDATE)" sleeps once PER row and locks them one after the other).
//   exclusive: FOR UPDATE for up to 30 s, released by CANCELLING it (the activation waits only 1.5 s for a lock, so the holder must go the moment both requests are seen waiting);
//   shared: FOR SHARE for 9 s (the activation's own share lock is compatible with it, so the activation does not wait; the older price edit, which needs an exclusive row lock, does).
const holdOf = (id, exclusive) => { if (!Number.isInteger(Number(id))) throw new Error('bad_id'); return 'WITH l AS (SELECT 1 FROM pricing WHERE id = ' + Number(id) + (exclusive ? ' FOR UPDATE) SELECT pg_sleep(30) FROM l' : ' FOR SHARE) SELECT pg_sleep(9) FROM l'); };
const CANCEL_HOLDER = "SELECT count(*) FILTER (WHERE ok)::int AS n FROM (SELECT pg_cancel_backend(pid) AS ok FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%FOR UPDATE) SELECT pg_sleep(30) FROM l') x";
const INVALID_ACTIVE = "SELECT count(*)::int AS n FROM provider_services ps LEFT JOIN pricing pr ON pr.id = ps.pricing_id WHERE ps.activation = 'active' AND NOT (pr.id IS NOT NULL AND pr.approved AND pr.price IS NOT NULL AND pr.service_id = ps.service_id AND (pr.professional_id IS NULL OR pr.professional_id = ps.professional_id))";
// ONE round of the race: the interleaving is built on purpose and SEEN on the server (another connection reads pg_stat_activity), then the outcome is read.
async function racePair(c, call, s, order, real) {
  if (!real) {   // the in-memory test database has no second connection: plain order, one request after the other
    const a = order === 'edit-first' ? await editOf(call, s) : await activateOf(call, s), b = order === 'edit-first' ? await activateOf(call, s) : await editOf(call, s);
    return { rEdit: order === 'edit-first' ? a : b, rAct: order === 'edit-first' ? b : a, hr: { ok: true }, q1: null, q2: null, released: null };
  }
  const exclusive = order === 'edit-first', holdSql = holdOf(s.PID, exclusive); c.allow(holdSql);
  const hold = attempt(() => c.tx([holdSql], RAW_TX)); await sleep(500);
  if (exclusive) {   // the edit goes into the queue first (it waits as long as it must), the activation behind it; when both are SEEN waiting the holder is cancelled and the queue decides
    const edit = editOf(call, s), q1 = await waitFor(c, WAIT_EDIT, 8000, edit), act = activateOf(call, s), q2 = await waitFor(c, WAIT_ACT, 5000, act), released = await n(c, CANCEL_HOLDER);
    const [rEdit, rAct, hr] = await Promise.all([edit, act, hold]); return { rEdit, rAct, hr, q1, q2, released };
  }
  // the edit waits behind a SHARE lock; the activation takes a share lock of its own (compatible), completes, and only then the holder lets go: the edit then meets an ACTIVE engagement
  const edit = editOf(call, s); let editSettled = false; edit.then(() => { editSettled = true; }, () => { editSettled = true; });
  const q1 = await waitFor(c, WAIT_EDIT, 8000, edit), rAct = await activateOf(call, s), q2 = !editSettled;
  const [rEdit, hr] = await Promise.all([edit, hold]); return { rEdit, rAct, hr, q1, q2, released: null };
}
const HOLD_4 = "SELECT pg_sleep(4) FROM (SELECT 1 FROM pricing WHERE label LIKE '%lockprice' FOR UPDATE) x";
const HOLD_SHARE_2 = "SELECT pg_sleep(2) FROM (SELECT 1 FROM pricing WHERE label LIKE '%sharelock' FOR SHARE) x";
const RAW_TX = { readOnly: false, isolationLevel: 'ReadCommitted' };
// an engagement that can be activated: provider, service (settings + a legal-clearance REPORT), engagement (pending), a price made and approved through the OLDER routes and linked, agreement signed, collaboration active
async function activatable(c, call, tag, extra) {
  const label = c.runId + ' ' + tag, pc = await call('POST', '/catalog/providers', { name: nm(c, tag + 'p'), business_name: nm(c, tag + 'b'), contact_phone: phoneOf(c, tag), contact_email: mailOf(c, tag) });
  if (pc.status !== 200) return { error: 'provider ' + pc.status + ' ' + pc.code };
  const R = pc.body.id, sv = await call('POST', '/catalog/services', { name: nm(c, tag + 's') }); if (sv.status !== 200) return { error: 'service ' + sv.status + ' ' + sv.code }; const S = sv.body.id;
  const steps = [['settings', () => call('PUT', '/catalog/services/' + S + '/settings', { code: 'g2' + crypto.createHash('md5').update(c.runId + tag).digest('hex').slice(0, 8), finding_tags: ['g2tag'], topics: [] })],
    ['clearance', () => call('POST', '/catalog/services/' + S + '/clearance', { cleared: true, expected_cleared: false, source_kind: 'other', source: 'g2 synthetic report', approved_on: '2026-11-01' })],
    ['engagement', () => call('POST', '/catalog/engagements', { provider_id: R, service_id: S, activation: 'pending' })]];
  for (const [name, fn] of steps) { const r = await fn(); if (r.status !== 200) return { error: name + ' ' + r.status + ' ' + r.code }; }
  const pr = await call('POST', '/pricing', { service_id: S, professional_id: null, label, price: 1000, cost: 0, commission: 0, notes: null }); if (pr.status !== 200) return { error: 'price ' + pr.status + ' ' + pr.code }; const PID = pr.body.id;
  const rest = [['approve', () => call('POST', '/pricing/' + PID + '/approve', { public: false })], ['link', () => call('POST', '/catalog/engagements/' + R + '/' + S + '/link-price', { pricing_id: PID, expected_pricing_id: null })],
    ['states', () => call('PATCH', '/catalog/engagements/' + R + '/' + S, { changes: Object.assign({ contact_state: 'active', agreement_state: 'signed' }, extra || {}), expected: Object.assign({ contact_state: 'none', agreement_state: 'not_discussed' }, extra ? Object.fromEntries(Object.keys(extra).map((k) => [k, null])) : {}) })]];
  for (const [name, fn] of rest) { const r = await fn(); if (r.status !== 200) return { error: name + ' ' + r.status + ' ' + r.code }; }
  const card = await call('GET', '/catalog/engagements/' + R + '/' + S), ck = card.body && card.body.checklist;
  if (!(card.status === 200 && ck && ck.can_activate === true)) return { error: 'checklist ' + JSON.stringify(ck && ck.missing) };
  return { R, S, PID, label, seen: ck.seen };
}
const activateOf = (call, s) => call('POST', '/catalog/engagements/' + s.R + '/' + s.S + '/actions/activate', { expected_activation: 'pending', confirm: 'activate', seen: s.seen });
const editOf = (call, s, price) => call('PATCH', '/pricing/' + s.PID, { service_id: s.S, professional_id: null, label: s.label, price: price || 1500, cost: 0, commission: 0, notes: null });
const consistent = (st) => !!st && (st.activation !== 'active' || st.approved === true);
const needsTriggers = async (c) => c.check('migration 003 is in place on this branch: both triggers exist and are enabled', (await n(c, TRIGGERS_Q)) === 2, 'the triggers are missing: the branch owner applies 003 before this run');

stage('proof003-race', { kind: 'write', independent: true, maxRequests: 1000, allowSingle: [AUDIT_VIEW_RE, exact(OLD_AUDIT), exact(PRICE_INSERT), exact(PRICE_APPROVE), exact(PRICE_PATCH)], raw: [COUNTS_SQL, CONTENT_SQL, TRIGGERS_Q, STATE_BY_LABEL, ACT_AUDITS, IDLE_Q],
  needs: ['atomic-import'], title: 'migration 003: the activation and the price edit in BOTH orders (a row lock makes them wait), then a burst of simultaneous pairs on real connections: at most one of the two succeeds, never an active engagement with an invalid price',
  plan: ['both triggers must exist; four engagements are prepared (two for each order) through the routes, each with a price approved and linked, the checklist complete',
    'edit first: a third connection holds an exclusive row lock on the price; the older price edit is sent and is SEEN waiting (another connection reads pg_stat_activity), then the activation is sent behind it and is SEEN waiting; the holder is cancelled: the queue decides, the edit goes first and the activation is then REFUSED by the database trigger (409 seen_changed)',
    'activation first: a SHARE lock is held on the price; the edit is SEEN waiting behind it; the activation (its own share lock is compatible) completes meanwhile, and when the holder lets go the edit meets an ACTIVE engagement and is REFUSED by the database trigger (409 price_linked_to_active_engagement)',
    'after each: exactly one of the two succeeded, no engagement is active with a price that is not approved, and the audit holds an activation row only when the activation succeeded (nothing half-saved)',
    'six more pairs are sent at the same moment with no lock (real concurrency): none of them may end active with an invalid price'],
  async run(c) {
    const P = product(c), call = P.call; if (!(await needsTriggers(c))) return;
    const results = [], real = !!(c.identity && c.identity.neon_endpoint);
    for (const [order, tag] of [['edit-first', 'ef1holdme'], ['activation-first', 'af1holdme'], ['edit-first', 'ef2holdme'], ['activation-first', 'af2holdme']]) {
      let s, x, tries = 0;
      do { tries++; s = await activatable(c, call, tag + (tries > 1 ? 'x' + tries : '')); if (s.error) break; x = await racePair(c, call, s, order, real); } while (real && !(x.q1 && x.q2) && tries < 2);
      if (s.error) { c.check(order + ': the engagement could be prepared', false, s.error); continue; }
      const { rEdit, rAct, hr } = x, st = (await c.q(STATE_BY_LABEL, [String(s.R), String(s.S)]))[0], audits = await n(c, ACT_AUDITS, [s.R + '/' + s.S]), oks = [rEdit.status === 200, rAct.status === 200].filter(Boolean).length;
      results.push({ order, tries, seen: [x.q1, x.q2], cancelled: x.released, edit: [rEdit.status, rEdit.code], act: [rAct.status, rAct.code], state: st && st.activation, approved: st && st.approved });
      if (real) {
        c.check(order + ': the intended interleaving was SEEN on the server (' + (order === 'edit-first' ? 'the edit waiting behind the lock, then the activation waiting behind it, then the holder cancelled' : 'the edit waiting behind a share lock while the activation completed') + ')', x.q1 && x.q2, JSON.stringify({ seen_first: x.q1, seen_second: x.q2, attempts: tries }));
        c.check(order + ': the lock holder was released as designed', order === 'edit-first' ? (x.released >= 1 && !hr.ok && errInfo(hr.error).code === '57014') : hr.ok, JSON.stringify({ cancelled: x.released, holder: hr.ok ? 'finished' : errInfo(hr.error) }));
      }
      c.check(order + ': NEVER BOTH SUCCEED (no active engagement with an invalid price)', oks < 2 && consistent(st), JSON.stringify({ edit: [rEdit.status, rEdit.code], act: [rAct.status, rAct.code], state: st }));
      c.check(order + ': exactly one of the two succeeded, as the lock order says (' + (order === 'edit-first' ? 'the edit, then the activation is refused' : 'the activation, then the edit is refused') + ')', oks === 1 && (order === 'edit-first' ? rEdit.status === 200 && rAct.status === 409 : rAct.status === 200 && rEdit.status === 409), JSON.stringify({ edit: [rEdit.status, rEdit.code], act: [rAct.status, rAct.code] }));
      c.check(order + ': the refused one was refused with a clear 409 (the activation says seen_changed, the edit says price_linked_to_active_engagement)', order === 'edit-first' ? (rAct.status === 409 && rAct.code === 'seen_changed') : (rEdit.status === 409 && rEdit.code === 'price_linked_to_active_engagement'), JSON.stringify({ edit: [rEdit.status, rEdit.code], act: [rAct.status, rAct.code] }));
      c.check(order + ': nothing half-saved: the activation has a journal row if and only if it succeeded', audits === (rAct.status === 200 ? 1 : 0), 'audit rows: ' + audits + ', activation answered ' + rAct.status);
    }
    c.note('orders', results);
    // -- real concurrency, no lock: pairs sent at the same moment
    const pairs = []; for (let i = 0; i < 6; i++) { const s = await activatable(c, call, 'bp' + i); if (s.error) { c.check('burst pair ' + i + ': prepared', false, s.error); continue; } pairs.push(s); }
    const fired = await Promise.all(pairs.flatMap((s) => [editOf(call, s), activateOf(call, s)])), sts = [];
    for (let i = 0; i < pairs.length; i++) { const s = pairs[i], st = (await c.q(STATE_BY_LABEL, [String(s.R), String(s.S)]))[0], e = fired[2 * i], a = fired[2 * i + 1]; sts.push([e.status, a.status, st && st.activation, st && st.approved]); }
    c.note('burst', sts);
    c.check('BURST (' + pairs.length + ' pairs at the same moment, no lock): no pair ended with an ACTIVE engagement whose price is not approved, and no pair has both succeeded', sts.length === pairs.length && sts.every((x) => !(x[0] === 200 && x[1] === 200) && (x[2] !== 'active' || x[3] === true)), JSON.stringify(sts));
    c.check('no engagement on the branch is ACTIVE with a price that does not fit it (every round and the burst included)', (await n(c, INVALID_ACTIVE)) === 0, 'an active engagement with an invalid price exists'); const idle = (await c.q(IDLE_Q))[0]; c.check('nothing is left waiting: no ungranted lock and no transaction left open', idle.waiting === 0, JSON.stringify(idle));
  } });

stage('proof003-guard', { kind: 'write', independent: true, maxRequests: 400, allowSingle: [AUDIT_VIEW_RE, exact(OLD_AUDIT), exact(PRICE_INSERT), exact(PRICE_APPROVE), exact(PRICE_PATCH)],
  raw: [COUNTS_SQL, CONTENT_SQL, TRIGGERS_Q, STATE_BY_LABEL],
  needs: ['atomic-import'], title: 'migration 003: a price change that harms an ACTIVE engagement is refused by the DATABASE itself (direct writes, the application check skipped), what harms nothing still goes through, and the application role cannot switch the guard off',
  plan: ['an engagement is activated normally (price approved, signed, active collaboration); the older route refuses an edit of its price (409)',
    'DIRECT writes (no application code): un-approving the price, removing its amount, moving it to another service, giving it to another provider are each refused by the trigger (P0001 price_linked_to_active_engagement); a note and a new amount that leave it valid go through',
    'DIRECT activation of a second engagement whose price is not approved is refused (P0001 price_not_valid_for_active_engagement); after the price is approved again the same statement works',
    'the application role is not the owner: it cannot disable, drop, replace or bypass the triggers (permission denied), the functions cannot be called directly, and the triggers are still enabled afterwards'],
  async run(c) {
    const P = product(c), call = P.call; if (!(await needsTriggers(c))) return;
    const sql = (text) => { c.allow(text); return attempt(() => c.tx([text], RAW_TX)); };
    const refused = async (name, text, code, re) => { const r = await sql(text); const i = r.ok ? null : errInfo(r.error); c.check(name, !r.ok && (code === null || i.code === code) && (!re || re.test(String(r.error.message))), r.ok ? 'IT WAS ACCEPTED' : JSON.stringify({ code: i.code, message: String(r.error.message).slice(0, 90) })); };
    const accepted = async (name, text) => { const r = await sql(text); c.check(name, r.ok, r.ok ? '' : JSON.stringify(errInfo(r.error))); };
    const s = await activatable(c, call, 'guardprice'); if (s.error) { c.check('an activatable engagement was prepared', false, s.error); return; }
    exp(c, 'activate it normally', await activateOf(call, s), 200);
    exp(c, 'the OLDER route refuses an edit of that price (the application check)', await editOf(call, s), 409, 'price_linked_to_active_engagement');
    const os = await call('POST', '/catalog/services', { name: nm(c, 'os') + ' otherservice' }), op = await call('POST', '/catalog/providers', { name: nm(c, 'op') + ' otherprovider', business_name: nm(c, 'ob'), contact_phone: phoneOf(c, 'op'), contact_email: mailOf(c, 'op') });
    if (!exp(c, 'another service and another provider exist (to move the price to)', os, 200) || !exp(c, '(the provider)', op, 200)) return;
    const before = await readContent(c);
    await refused('DIRECT: un-approving the price of an ACTIVE engagement is refused by the database', "UPDATE pricing SET approved = false WHERE label LIKE '%guardprice'", 'P0001', /price_linked_to_active_engagement/);
    await refused('DIRECT: removing its amount is refused', "UPDATE pricing SET price = NULL WHERE label LIKE '%guardprice'", 'P0001', /price_linked_to_active_engagement/);
    await refused('DIRECT: moving it to another service is refused', "UPDATE pricing SET service_id = (SELECT id FROM services WHERE name LIKE '%otherservice' ORDER BY id DESC LIMIT 1) WHERE label LIKE '%guardprice'", 'P0001', /price_linked_to_active_engagement/);
    await refused('DIRECT: giving it to another provider is refused', "UPDATE pricing SET professional_id = (SELECT id FROM professionals WHERE name LIKE '%otherprovider' ORDER BY id DESC LIMIT 1) WHERE label LIKE '%guardprice'", 'P0001', /price_linked_to_active_engagement/);
    const mid = await readContent(c); c.check('the refused writes changed NOTHING (every readable table has the same count and content hash)', sameContent(before, mid), differingTables(before, mid).join(','));
    await accepted('DIRECT: a note on the price (it stays valid) goes through', "UPDATE pricing SET notes = 'g2 note' WHERE label LIKE '%guardprice'");
    await accepted('DIRECT: a new amount (it stays valid) goes through', "UPDATE pricing SET price = 1100 WHERE label LIKE '%guardprice'");
    const st = (await c.q(STATE_BY_LABEL, [String(s.R), String(s.S)]))[0]; c.check('and the engagement is still ACTIVE with an approved price of the new amount', st.activation === 'active' && st.approved === true && String(st.price) === '1100.00', JSON.stringify(st));
    // the activation side, directly
    const d = await activatable(c, call, 'dirprice', { external_ref: 'g2dir' + crypto.createHash('md5').update(c.runId).digest('hex').slice(0, 8) }); if (d.error) { c.check('the second engagement was prepared', false, d.error); return; }
    await accepted('DIRECT: the price of a PENDING engagement may be un-approved (nothing is active)', "UPDATE pricing SET approved = false WHERE label LIKE '%dirprice'");
    await refused('DIRECT ACTIVATION with a price that is not approved is refused by the database', "UPDATE provider_services SET activation = 'active' WHERE external_ref LIKE 'g2dir%'", 'P0001', /price_not_valid_for_active_engagement/);
    await accepted('the price is approved again', "UPDATE pricing SET approved = true WHERE label LIKE '%dirprice'");
    await accepted('and now the same direct activation is accepted (the rule, not a blanket refusal)', "UPDATE provider_services SET activation = 'active' WHERE external_ref LIKE 'g2dir%'");
    // the application role is not the owner of the guard
    await refused('ROLE: the application role cannot disable the pricing trigger', 'ALTER TABLE pricing DISABLE TRIGGER kc_pricing_guard', '42501');
    await refused('ROLE: nor drop it', 'DROP TRIGGER kc_pricing_guard ON pricing', '42501');
    await refused('ROLE: nor disable the engagement trigger (all user triggers)', 'ALTER TABLE provider_services DISABLE TRIGGER USER', '42501');
    await refused('ROLE: nor drop a trigger function', 'DROP FUNCTION kc_pricing_guard()', '42501');
    await refused('ROLE: nor replace a trigger function by one that lets everything through', 'CREATE OR REPLACE FUNCTION kc_pricing_guard() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$', '42501');
    await refused('ROLE: nor drop the index', 'DROP INDEX provider_services_active_price_idx', '42501');
    await refused('ROLE: nor add a trigger of its own to the table', 'CREATE TRIGGER g2x BEFORE UPDATE ON pricing FOR EACH ROW EXECUTE FUNCTION kc_pricing_guard()', '42501');
    await refused('ROLE: nor switch triggers off for the session (session_replication_role)', 'SET session_replication_role = replica', '42501');
    await refused('ROLE: the trigger function cannot be called directly', 'SELECT kc_pricing_guard()', null);
    c.check('both triggers are still enabled afterwards', (await n(c, TRIGGERS_Q)) === 2, 'a trigger was disabled or dropped');
  } });

stage('proof003-locks', { kind: 'write', independent: true, maxRequests: 300, allowSingle: [AUDIT_VIEW_RE, exact(OLD_AUDIT), exact(PRICE_INSERT), exact(PRICE_APPROVE), exact(PRICE_PATCH)],
  raw: [COUNTS_SQL, CONTENT_SQL, TRIGGERS_Q, STATE_BY_LABEL, ACT_AUDITS, IDLE_Q, HOLD_4, HOLD_SHARE_2,
    "UPDATE provider_services SET terms_note = 'g2 t1' WHERE external_ref LIKE 'g2dl%'", "UPDATE pricing SET notes = 'g2 t1' WHERE label LIKE '%lockprice'", "UPDATE pricing SET notes = 'g2 t2' WHERE label LIKE '%lockprice'", "UPDATE provider_services SET terms_note = 'g2 t2' WHERE external_ref LIKE 'g2dl%'", 'SELECT pg_sleep(1.5)',
    "SELECT terms_note AS a FROM provider_services WHERE external_ref LIKE 'g2dl%'", "SELECT notes AS a FROM pricing WHERE label LIKE '%lockprice'"],
  needs: ['atomic-import'], title: 'migration 003: locks, timeouts and a deadlock on real connections: the activation waits its lock timeout (409 busy_retry) behind a lock on the price, a price edit waits out a share lock, and a deadlock between a write to an active engagement and a write to its price is detected and leaves nothing half-saved',
  plan: ['a third connection holds a row lock on a price for 4 s: the activation (the trigger asks for FOR SHARE) waits its lock timeout (1.5 s) and is refused 409 busy_retry, nothing is saved (no journal row, still pending); after the lock the same activation works',
    'a share lock held on a price for 2 s: the older price edit waits, then succeeds (an engagement that is not active), and does not time out',
    'a deadlock, made on purpose: one transaction edits the price then (after a pause) the active engagement, another edits the active engagement (its trigger takes FOR SHARE on the price) then the price: the database detects it (40P01), exactly one is aborted, the other commits, and the data is consistent',
    'no lock and no transaction is left behind'],
  async run(c) {
    const P = product(c), call = P.call; if (!(await needsTriggers(c))) return;
    const sub = async (label, fn) => { try { await fn(); } catch (e) { c.check(label + ': the part ran to its end', false, 'stopped by ' + (e && e.message ? String(e.message).slice(0, 160) : JSON.stringify(errInfo(e)))); } };
    const l = await activatable(c, call, 'lockprice', { external_ref: 'g2dl' + crypto.createHash('md5').update(c.runId).digest('hex').slice(0, 8) }); if (l.error) { c.check('the engagement was prepared', false, l.error); return; }
    await sub('LOCK TIMEOUT', async () => {
      const hold = attempt(() => c.tx([HOLD_4], RAW_TX)), t0 = Date.now(); await sleep(500);
      const w0 = Date.now(), r = await activateOf(call, l), ms = Date.now() - w0, hr = await hold;
      c.check('LOCK: the activation behind a row lock on its price waits its lock timeout and is refused 409 busy_retry (about 1.5 s)', r.status === 409 && r.code === 'busy_retry' && ms >= 1200 && ms < 3800, r.status + ' ' + r.code + ' in ' + ms + ' ms'); c.note('activation_wait_ms', ms);
      c.check('LOCK: the holder finished normally (about 4 s)', hr.ok && Date.now() - t0 >= 3600, hr.ok ? '' : JSON.stringify(errInfo(hr.error)));
      const st = (await c.q(STATE_BY_LABEL, [String(l.R), String(l.S)]))[0]; c.check('LOCK: nothing was saved by the refused activation (still pending, no journal row)', st.activation === 'pending' && (await n(c, ACT_AUDITS, [l.R + '/' + l.S])) === 0, JSON.stringify(st));
      exp(c, 'LOCK: after the lock the very same activation works (nothing left behind)', await activateOf(call, l), 200);
    });
    await sub('SHARE LOCK AGAINST THE PRICE EDIT', async () => {
      const q2 = await activatable(c, call, 'sharelock'); if (q2.error) { c.check('SHARE: the engagement was prepared', false, q2.error); return; }
      const hold = attempt(() => c.tx([HOLD_SHARE_2], RAW_TX)); await sleep(400); const w0 = Date.now(), r = await editOf(call, q2), ms = Date.now() - w0, hr = await hold;
      c.check('SHARE: the older price edit waits behind the share lock and then succeeds (the engagement is not active), no timeout', r.status === 200 && ms >= 900 && hr.ok, r.status + ' ' + r.code + ' in ' + ms + ' ms'); c.note('edit_wait_ms', ms);
    });
    await sub('DEADLOCK', async () => {
      // the engagement of `lockprice` is ACTIVE now; its external_ref starts with g2dl
      const T1 = [ "UPDATE provider_services SET terms_note = 'g2 t1' WHERE external_ref LIKE 'g2dl%'", 'SELECT pg_sleep(1.5)', "UPDATE pricing SET notes = 'g2 t1' WHERE label LIKE '%lockprice'" ];
      const T2 = [ "UPDATE pricing SET notes = 'g2 t2' WHERE label LIKE '%lockprice'", 'SELECT pg_sleep(1.5)', "UPDATE provider_services SET terms_note = 'g2 t2' WHERE external_ref LIKE 'g2dl%'" ];
      const base = await readContent(c), p2 = attempt(() => c.tx(T2, RAW_TX)); await sleep(450); const p1 = attempt(() => c.tx(T1, RAW_TX)), [a2, a1] = [await p2, await p1];
      const codes = [a1, a2].map((x) => (x.ok ? 'ok' : errInfo(x.error).code));
      c.check('DEADLOCK: the database detects it: exactly one transaction is aborted with 40P01 and the other commits', codes.filter((x) => x === '40P01').length === 1 && codes.filter((x) => x === 'ok').length === 1, JSON.stringify(codes));
      const st = (await c.q(STATE_BY_LABEL, [String(l.R), String(l.S)]))[0]; c.check('DEADLOCK: the data is consistent: the engagement is still ACTIVE with an approved price', st.activation === 'active' && st.approved === true, JSON.stringify(st));
      const note = (await c.q("SELECT terms_note AS a FROM provider_services WHERE external_ref LIKE 'g2dl%'"))[0].a, pn = (await c.q("SELECT notes AS a FROM pricing WHERE label LIKE '%lockprice'"))[0].a;
      c.check('DEADLOCK: nothing is half-saved: both notes come from the SAME transaction, the one that committed (an aborted transaction leaves no trace)', (note === 'g2 t1' && pn === 'g2 t1') || (note === 'g2 t2' && pn === 'g2 t2'), JSON.stringify([note, pn]));
      c.note('deadlock', { outcomes: codes, survivor: note }); void base;
    });
    const idle = (await c.q(IDLE_Q))[0]; c.check('nothing is left behind: no ungranted lock', idle.waiting === 0, JSON.stringify(idle));
  } });

// the window of OPENING the catalog switch: an older write in flight and the owner's UPDATE that opens the catalog, in both orders
const SW_SET_FALSE = "UPDATE settings SET value = 'false'::jsonb WHERE key = 'private.catalog_enabled'", SW_FLIP = "UPDATE settings SET value = 'true'::jsonb WHERE key = 'private.catalog_enabled'";
const swHoldOf = (id) => { if (!Number.isInteger(Number(id))) throw new Error('bad_id'); return 'WITH l AS (SELECT 1 FROM services WHERE id = ' + Number(id) + ' FOR UPDATE) SELECT pg_sleep(6) FROM l'; }, SW_FLIP_SLOW = 'SELECT pg_sleep(4)';
const swDescOf = (id) => { if (!Number.isInteger(Number(id))) throw new Error('bad_id'); return 'SELECT description AS a FROM services WHERE id = ' + Number(id); }, SW_VALUE = "SELECT value::text AS a FROM settings WHERE key = 'private.catalog_enabled'";
const guardsMod = require('../netlify/functions/_kaspchem/catalog-guards.js'), serviceGuardMod = require('../netlify/functions/_kaspchem/service-guard.js');
const OLD_SVC_INSERT = 'INSERT INTO services (topic, name, description) SELECT $1::text, $2::text, $3::text WHERE ' + guardsMod.OLD_WRITE_CLOSED + ' RETURNING id';
const OLD_SVC_UPDATE = 'UPDATE services s SET topic=$1, name=$2, description=$3, active=$4 WHERE s.id = $5 AND ' + serviceGuardMod.allowsChange('$2::text', '$1::text') + ' AND ' + guardsMod.OLD_WRITE_CLOSED + ' RETURNING s.id';
stage('proof003-switch', { kind: 'write', independent: true, maxRequests: 200, allowSingle: [AUDIT_VIEW_RE, exact(OLD_AUDIT), exact(OLD_SVC_INSERT), exact(OLD_SVC_UPDATE)],
  raw: [COUNTS_SQL, CONTENT_SQL, SW_SET_FALSE, SW_FLIP, SW_FLIP_SLOW, SW_VALUE, IDLE_Q],
  needs: ['atomic-import'], title: 'THE WINDOW OF OPENING THE CATALOG SWITCH: an older write in flight and the UPDATE that opens the catalog are ordered by a lock on the switch row, in both orders; no older write can commit after the opening',
  plan: ['the switch is set to false (the row exists, closed); an older service is made through the older route',
    'older write first: a lock held for 6 s on its row makes it wait; it is SEEN waiting (so it already holds its share lock on the switch row), only then the UPDATE that opens the catalog is sent, and it WAITS for the older write; the older write commits first, then the opening commits',
    'after the opening an older write is refused 409 managed_in_catalog and the catalog answers',
    'opening first: the opening is held in flight for 4 s; an older write that started before it was visible is SEEN waiting on the switch row, and when the opening commits it changes NOTHING and answers 409 managed_in_catalog',
    'the switch ends open, as it was found'],
  async run(c) {
    const P = product(c), call = P.call, sql = (text) => { c.allow(text); return attempt(() => c.tx([text], RAW_TX)); };
    if (!c.check('the switch row exists before the run (the guard needs it)', (await c.q(SW_VALUE)).length === 1, 'private.catalog_enabled is missing')) return;
    const f = await sql(SW_SET_FALSE); if (!c.check('the switch is set to false for the experiment', f.ok, f.ok ? '' : JSON.stringify(errInfo(f.error)))) return;
    try {
      const mk = await call('POST', '/services', { name: c.runId + ' swholdsvc', topic: 'g2', description: '' }); if (!exp(c, 'an older service is made through the older route while the switch is false', mk, 200)) return; const X = mk.body.id;
      const patch = (txt) => call('PATCH', '/services/' + X, { name: c.runId + ' swholdsvc', topic: 'g2', description: txt, active: false });
      // 1. the older write is in flight when the owner opens the catalog
      const holdSql = swHoldOf(X), descSql = swDescOf(X); c.allow(holdSql); c.allow(descSql); const descNow = async () => (await c.q(descSql))[0].a; const hold = attempt(() => c.tx([holdSql], RAW_TX)); await sleep(300);
      const oldDone = { t: 0 }, flipDone = { t: 0 }, t0 = Date.now();
      const pOld = patch('g2 sw one').then((r) => { oldDone.t = Date.now() - t0; return r; }), sawOld = await waitFor(c, WAIT_OLDWRITE, 5000, pOld), flipSent = Date.now() - t0;
      const pFlip = sql(SW_FLIP).then((r) => { flipDone.t = Date.now() - t0; return r; });
      const [rOld, rFlip, hr] = await Promise.all([pOld, pFlip, hold]);
      c.check('OLDER WRITE FIRST: the older write (already in flight) committed: 200', rOld.status === 200 && hr.ok, rOld.status + ' ' + rOld.code);
      c.check('OLDER WRITE FIRST: the older write was SEEN waiting for its row lock (so it already held its share lock on the switch row) when the opening was sent, and the UPDATE that opens the catalog WAITED for it: it took at least 0.8 s although it is a single quick statement (and the older write, committed first, took effect: the next check)', sawOld && rFlip.ok && oldDone.t > 0 && flipDone.t - flipSent >= 800, JSON.stringify({ older_seen_waiting: sawOld, older_done_ms: oldDone.t, opening_sent_ms: flipSent, opening_done_ms: flipDone.t })); c.note('older_first', { older_seen_waiting: sawOld, older_done_ms: oldDone.t, opening_sent_ms: flipSent, opening_done_ms: flipDone.t });
      c.check('the older write took effect (it was before the opening)', (await descNow()) === 'g2 sw one', 'the description is not the one written');
      exp(c, 'AFTER THE OPENING an older edit is refused', await patch('g2 sw two'), 409, 'managed_in_catalog');
      exp(c, 'AFTER THE OPENING an older create is refused', await call('POST', '/services', { name: c.runId + ' swother', topic: 'g2', description: '' }), 409, 'managed_in_catalog');
      c.check('and nothing was written by the refused ones', (await descNow()) === 'g2 sw one', 'the description changed');
      exp(c, 'AFTER THE OPENING the catalog answers', await call('GET', '/catalog/overview'), 200);
      // 2. the opening is in flight when the older write comes
      const f2 = await sql(SW_SET_FALSE); if (!c.check('the switch is closed again for the second order', f2.ok, f2.ok ? '' : JSON.stringify(errInfo(f2.error)))) return;
      const flipTx = attempt(() => c.tx([SW_FLIP, SW_FLIP_SLOW], RAW_TX)); await sleep(500);
      const w0 = Date.now(), pLate = patch('g2 sw three'), sawLate = await waitFor(c, WAIT_OLDWRITE, 3500, pLate), rLate = await pLate, lateMs = Date.now() - w0, ft = await flipTx;
      c.check('OPENING FIRST: the opening committed', ft.ok, ft.ok ? '' : JSON.stringify(errInfo(ft.error)));
      c.check('OPENING FIRST: an older write that started before the opening was visible WAITED for it and then changed NOTHING: 409 managed_in_catalog', sawLate && rLate.status === 409 && rLate.code === 'managed_in_catalog' && lateMs >= 700, rLate.status + ' ' + rLate.code + ' in ' + lateMs + ' ms, seen waiting: ' + sawLate); c.note('opening_first_wait_ms', lateMs); c.note('opening_first_seen_waiting', sawLate);
      c.check('and the service still holds what the first order wrote', (await descNow()) === 'g2 sw one', 'the description changed');
    } finally {
      const back = await sql(SW_FLIP); c.check('the switch ends open, as it was found', back.ok && (await c.q(SW_VALUE))[0].a === 'true', back.ok ? 'not true' : JSON.stringify(errInfo(back.error)));
    }
    const idle = (await c.q(IDLE_Q))[0]; c.check('nothing is left behind: no ungranted lock', idle.waiting === 0, JSON.stringify(idle));
  } });

module.exports = { product, nm, word, phoneOf, mailOf, exp, keysOf, n, COUNT, SEQ_ALL, A1, A2, A3, A4, G2SVC, SECRET_KEY, PRICE_GUARD, demoRow, approvalsOf, TW, sleep, AUDIT_VIEW_RE, activatable, consistent };
