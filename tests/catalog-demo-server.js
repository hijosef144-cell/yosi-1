'use strict';
// LOCAL DEMO ONLY (never deployed, never connected to Neon): the real admin page and the real function code on an in-memory Postgres (PGlite), with the catalog tables (migration 002) and
// invented data. Everything is labelled "[דמו]". No demo engagement is active, no price is public, and the cost / commission / compensation numbers in the demo are deliberately odd
// (31337.31, 41414.14, 77.77) so the tests can prove they never reach a response or a page.
//   node tests/catalog-demo-server.js                 -> http://localhost:4181/admin/kaspchem/?test=yosi@example.test|admin
//   /__demo/mode?name=full|big|empty|closed|fault     -> reseeds: full (default), big (paging), empty catalog, switch closed, server error on every catalog read
const fs = require('fs');
const path = require('path');
const { start } = require('./dev-server');
const db = require('../netlify/functions/_kaspchem/db');

const ROOT = path.join(__dirname, '..');
const M002 = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '002-provider-catalog.sql'), 'utf8');
const D = (n) => '[דמו] ' + n;

function seedFull() {
  return `
  INSERT INTO services (id, name, topic, description, active) VALUES
    (1, '${D('בדיקת זכאות להחזר מס')}', 'tax-refunds', 'בדיקה של החזרי מס לשכירים (נתוני דמה)', true),
    (2, '${D('ייעוץ משכנתא')}', 'mortgage', 'ליווי בבחירת משכנתא (נתוני דמה)', true),
    (3, '${D('בדיקת תלוש שכר')}', 'payslip-rights', 'בדיקת זכויות בתלוש (נתוני דמה)', true),
    (4, '${D('ייעוץ פנסיוני')}', 'insurance-pension', NULL, false),
    (5, '${D('מיפוי חובות והלוואות')}', 'banking-loans', 'סידור חובות (נתוני דמה)', true),
    (6, '${D('ייעוץ משכנתאות')}', 'mortgage', NULL, false),
    (7, '${D('שירות ללא נותן שירות')}', 'household', NULL, false);
  INSERT INTO service_settings (service_id, code, finding_tags, topics, legal_cleared, legal_cleared_by, legal_cleared_at, legal_note) VALUES
    (1, 'demo-tax-refund', '{refund-check}', '{tax-refunds}', true, 'yosi@example.test', '2026-11-01T09:00:00Z', 'אושר בכתב (דמו)'),
    (2, 'demo-mortgage', '{}', '{mortgage}', true, 'avi@example.test', '2026-11-02T09:00:00Z', NULL),
    (3, 'demo-payslip', '{payslip}', '{payslip-rights}', false, NULL, NULL, NULL),
    (5, 'demo-debts', '{}', '{banking-loans}', true, 'yosi@example.test', '2026-11-03T09:00:00Z', NULL);
  INSERT INTO professionals (id, name, contact, topics) VALUES
    (11, '${D('נותן שירות א׳')}', NULL, '{}'), (12, '${D('נותן שירות ב׳')}', NULL, '{}'), (13, '${D('נותן שירות ג׳')}', NULL, '{}'), (14, '${D('נותן שירות ד׳ (ללא פרופיל)')}', NULL, '{}'), (15, '${D('נותן שירות ה׳')}', NULL, '{}'), (16, '${D('נותן שירות ו׳ (ללא שירותים)')}', NULL, '{}');
  INSERT INTO provider_profiles (professional_id, delivery_method, paused_until, archived_at, capacity_open, business_name, contact_phone, contact_email, internal_notes) VALUES
    (11, 'portal', NULL, NULL, 5, '${D('משרד לדוגמה א׳')}', '050-0000001', 'demo-a@example.test', 'הערה פנימית לדוגמה (נתוני דמה)'),
    (12, 'manual', now() + interval '20 days', NULL, NULL, NULL, '050-0000002', NULL, NULL),
    (13, 'portal', NULL, now() - interval '30 days', 0, '${D('משרד לדוגמה ג׳')}', NULL, NULL, 'הועבר לארכיון (דמו)'),
    (15, 'manual', NULL, NULL, 12, '${D('משרד לדוגמה ה׳')}', '050-0000005', 'demo-e@example.test', NULL),
    (16, 'portal', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  INSERT INTO pricing (id, service_id, professional_id, label, price, cost, commission, notes, approved, approved_by, approved_at, public) VALUES
    (1, 1, 11, '${D('בדיקת החזר מס')}', 1200, 31337.31, 0, 'NOTE-SECRET-DEMO', false, NULL, NULL, false),
    (2, 1, 15, '${D('בדיקת החזר מס, נותן שירות ה׳')}', 1150, 31337.31, 0, 'NOTE-SECRET-DEMO', true, 'yosi@example.test', now(), false);
  INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, pricing_id, external_ref, priority, terms_note, paused_reason, retired_reason, retired_at, updated_by) VALUES
    (11, 1, 'pending', 'negotiating', 'draft', 'fixed', 1, 'DEMO-01', 100, 'שוחחנו בטלפון (דמו)', NULL, NULL, NULL, 'import:yosi@example.test'),
    (11, 2, 'draft', 'contacted', 'not_discussed', 'percent_of_result', NULL, 'DEMO-02', 100, NULL, NULL, NULL, NULL, 'import:yosi@example.test'),
    (12, 3, 'paused', 'contacted', 'not_discussed', 'quote', NULL, 'DEMO-03', 100, NULL, 'ממתין להבהרות מהספק', NULL, NULL, 'avi@example.test'),
    (13, 5, 'retired', 'stopped', 'ended', 'tbd', NULL, 'DEMO-04', 100, NULL, NULL, 'הספק פרש (דמו)', now() - interval '10 days', 'avi@example.test'),
    (15, 1, 'pending', 'negotiating', 'draft', 'fixed', 2, 'DEMO-05', 90, NULL, NULL, NULL, NULL, 'yosi@example.test'),
    (15, 2, 'draft', 'none', 'not_discussed', 'tbd', NULL, 'DEMO-06', 100, NULL, NULL, NULL, NULL, 'yosi@example.test'),
    (15, 5, 'pending', 'contacted', 'draft', 'percent_with_minimum', NULL, 'DEMO-07', 100, NULL, NULL, NULL, NULL, 'yosi@example.test');
  INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, status, basis_missing, source_note, source_date, recorded_by) VALUES
    (11, 1, 'market', 'fixed', 1100, NULL, NULL, NULL, NULL, 'recorded', false, 'אתר הספק (דמו)', '2026-10-20', 'import:yosi@example.test'),
    (11, 1, 'provider_offer', 'fixed', 1000, NULL, NULL, NULL, NULL, 'awaiting_response', false, NULL, NULL, 'yosi@example.test'),
    (11, 2, 'unclassified', 'percent_of_result', NULL, 8, 10, NULL, '8% עד 10% מהחיסכון (דמו)', 'recorded', true, NULL, NULL, 'import:yosi@example.test'),
    (12, 3, 'provider_offer', 'quote', NULL, NULL, NULL, NULL, 'הצעת מחיר לפי מורכבות התלוש (דמו)', 'received', false, NULL, NULL, 'avi@example.test'),
    (15, 1, 'market', 'fixed', 1150, NULL, NULL, NULL, NULL, 'recorded', false, 'פנייה בדוא״ל (דמו)', '2026-10-25', 'yosi@example.test'),
    (15, 1, 'provider_offer', 'fixed', 1050, NULL, NULL, NULL, NULL, 'recorded', false, NULL, NULL, 'yosi@example.test'),
    (15, 5, 'provider_offer', 'percent_with_minimum', NULL, 5, 7, 600, NULL, 'declined', false, NULL, NULL, 'avi@example.test');
  INSERT INTO provider_service_compensation (professional_id, service_id, model, percent_recorded, payer_note, recorded_by) VALUES (11, 1, 'percent', 77.77, 'PAYER-SECRET-DEMO', 'owner@example.test');
  INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, problems, imported_by, created_at) VALUES
    ('csv', repeat('ab', 32), 12, 9, 1, 2, '[{"row":4,"code":"price_not_numeric","field":"price"},{"row":9,"code":"duplicate_engagement"}]', 'yosi@example.test', now() - interval '2 days'),
    ('csv', repeat('cd', 32), 3, 3, 0, 0, '[]', 'avi@example.test', now() - interval '1 days');
  INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES
    ('yosi@example.test', 'catalog.import.apply', 'catalog_import', '1', '{}', now() - interval '2 days'),
    ('yosi@example.test', 'catalog.service.clearance', 'service', '1', '{"fields":["legal_cleared"]}', now() - interval '2 days'),
    ('avi@example.test', 'catalog.import.apply', 'catalog_import', '2', '{}', now() - interval '1 days'),
    ('avi@example.test', 'catalog.provider.update', 'provider', '11', '{"fields":["internal_notes","capacity_open"]}', now() - interval '20 hours'),
    ('yosi@example.test', 'catalog.engagement.update', 'engagement', '11/1', '{"fields":["terms_note"]}', now() - interval '3 hours');
  `;
}
function seedBig() {
  return `
  INSERT INTO services (id, name, topic, active) SELECT g, '${D('שירות')} ' || lpad(g::text, 3, '0'), (ARRAY['tax-refunds','mortgage','housing','insurance-pension'])[1 + g % 4], g % 3 <> 0 FROM generate_series(1, 130) g;
  INSERT INTO professionals (id, name) SELECT g, '${D('נותן שירות')} ' || lpad(g::text, 3, '0') FROM generate_series(1, 130) g;
  INSERT INTO provider_profiles (professional_id, business_name) SELECT g, '${D('עסק')} ' || g FROM generate_series(1, 130) g WHERE g % 2 = 0;
  INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, updated_by) SELECT g, g, (ARRAY['draft','pending','paused'])[1 + g % 3], (ARRAY['none','contacted','negotiating'])[1 + g % 3], 'not_discussed', 'tbd', 'demo' FROM generate_series(1, 130) g;
  INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, updated_by) SELECT g, 1 + (g + 7) % 130, 'draft', 'none', 'not_discussed', 'tbd', 'demo' FROM generate_series(1, 130) g;
  `;
}

async function reset(pg, mode) {
  await pg.exec("TRUNCATE provider_service_prices, provider_service_compensation, provider_services, service_settings, provider_profiles, catalog_imports, pricing, professionals, services, audit_log RESTART IDENTITY CASCADE; DELETE FROM settings WHERE key LIKE 'private.catalog_%'");
  if (mode === 'full') await pg.exec(seedFull());
  if (mode === 'big') await pg.exec(seedBig());
  if (mode !== 'closed') await pg.exec("INSERT INTO settings (key, value, updated_by) VALUES ('private.catalog_enabled', 'true'::jsonb, 'demo')");
  await pg.exec("SELECT setval(pg_get_serial_sequence('services', 'id'), 1000); SELECT setval(pg_get_serial_sequence('professionals', 'id'), 1000)");
}

async function startDemo(port) {
  const { server, pg } = await start(port);
  await pg.exec(M002);
  let mode = 'full', chain = Promise.resolve();
  const queue = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };   // one PGlite connection: one statement or transaction at a time
  db.setDriver((t, p) => queue(async () => {
    if (mode === 'fault' && /FROM (services|professionals|provider_services|catalog_imports|audit_log)\b/.test(t) && !/FROM settings/.test(t)) throw new Error('simulated database failure (demo)');
    return (await pg.query(t, p)).rows;
  }));
  db.setTransactionDriver((stmts, o) => queue(async () => {
    if (mode === 'fault') throw new Error('simulated database failure (demo)');
    await pg.exec('BEGIN ISOLATION LEVEL ' + (o.isolationLevel === 'RepeatableRead' ? 'REPEATABLE READ' : 'READ COMMITTED') + (o.readOnly ? ' READ ONLY' : ''));
    try { const out = []; for (const s of stmts) out.push((await pg.query(s.text, s.params)).rows); await pg.exec('COMMIT'); return out; }
    catch (e) { await pg.exec('ROLLBACK').catch(() => {}); throw e; }
  }));
  await reset(pg, 'full');
  const original = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__demo/mode') {
      const name = url.searchParams.get('name') || 'full';
      if (!['full', 'big', 'empty', 'closed', 'fault'].includes(name)) { res.writeHead(400); return res.end('bad mode'); }
      await queue(async () => { mode = name; await reset(pg, name === 'fault' ? 'full' : name); });
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mode }));
    }
    original.forEach((l) => l.call(server, req, res));
  });
  return { server, pg, setMode: (m) => queue(async () => { mode = m; await reset(pg, m === 'fault' ? 'full' : m); }) };
}

module.exports = { startDemo };
if (require.main === module) startDemo(Number(process.env.PORT) || 4181).then(() => console.log('catalog demo server (local, in-memory, invented data): http://localhost:' + (process.env.PORT || 4181) + '/admin/kaspchem/?test=yosi@example.test|admin'));
