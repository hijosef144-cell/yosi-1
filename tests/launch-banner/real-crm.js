// Runs the REAL CRM app (the `initiative-waitlist` branch of matzpen-crm) on in-memory Postgres, with every mail function
// stubbed, so the website banner can be tested end to end. It can never reach a production database or send a real email:
// the CRM's own test harness removes DATABASE_URL / RESEND_API_KEY, replaces db/database.js with PGlite and blocks the real pg Pool.
//
//   CRM app      http://127.0.0.1:4192   (what the page talks to)
//   control API  http://127.0.0.1:4193   (test-only: state snapshot, reset, seeding, failure injection)
const path = require('path');
const http = require('http');
const CRM = process.env.CRM_WORKTREE || path.resolve(__dirname, '..', '..', '..', 'matzpen-crm-waitlist');
const h = require(path.join(CRM, 'server', 'tests', 'helpers', 'harness.js'));
const { buildTargetClause } = require(path.join(CRM, 'server', 'services', 'campaignSender.js'));
const waitlist = require(path.join(CRM, 'server', 'routes', 'emailInitiativeWaitlist.js'));
const { db, pool, mail } = h;
// The CRM harness allows the origin http://localhost:4180 in CORS (hard-coded). The page under test is served by the static server on
// http://127.0.0.1:4190 (4180 is used by other work on this machine), so rebuild the app with that origin allowed too. Test-only:
// WAITLIST_TEST_ORIGINS is ignored by the CRM when NODE_ENV is 'production'. Mail stubs and the in-memory pool stay in place (module cache).
process.env.WAITLIST_TEST_ORIGINS = 'http://localhost:4180,http://127.0.0.1:4190';
const appPath = require.resolve(path.join(CRM, 'server', 'app.js'));
delete require.cache[appPath];
const app = require(appPath);

const rows = async (sql, p) => (await db.query(sql, p || [])).rows;
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(body)); };

async function state() {
  const hasConsents = (await rows(`SELECT to_regclass('email_consents') AS t`))[0].t !== null;
  const contacts = await rows(`SELECT id, email, status, source, source_detail, name FROM email_contacts ORDER BY id`);
  const lists = await rows(`SELECT cl.contact_id, l.name FROM email_contact_lists cl JOIN email_lists l ON l.id = cl.list_id ORDER BY cl.contact_id, l.name`);
  const tags = await rows(`SELECT ct.contact_id, t.name FROM email_contact_tags ct JOIN email_tags t ON t.id = ct.tag_id ORDER BY ct.contact_id, t.name`);
  const consents = hasConsents ? await rows(`SELECT contact_id, purpose, status, consent_version, consent_text, page, source_detail, consented_at, confirmed_at, confirmation_sent_at, confirmation_error FROM email_consents ORDER BY id`) : [];
  return {
    hasConsents, contacts, lists, tags, consents,
    mail: {
      confirmation: mail.calls.sendToContact.map(c => ({ to: c.contact && c.contact.email, subject: c.subject, bodyText: c.bodyText })),
      verification: mail.calls.sendSimpleEmail.map(c => ({ to: c.to, subject: c.subject })),
      admin: mail.calls.sendAdminNotification.length,
      total: mail.total()
    }
  };
}

(async () => {
  await h.migrateBase();
  await h.applyConsentMigration();
  // the CRM app, exactly as deployed (CORS allows http://localhost:4180 in the harness)
  http.createServer(app).listen(4192, '127.0.0.1');

  http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
    let raw = ''; req.on('data', d => raw += d);
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === '/__health') return json(res, 200, { ok: true });
        if (req.url === '/state') return json(res, 200, await state());
        if (req.url === '/reset') {
          if (!(await rows(`SELECT to_regclass('email_consents') AS t`))[0].t) await h.applyConsentMigration();
          await h.resetData(); pool.failOn = null; return json(res, 200, { ok: true });
        }
        if (req.url === '/seed') { // existing contact with optional lists and status
          const c = (await rows(`INSERT INTO email_contacts (name, email, source, status) VALUES ($1,$2,$3,$4) RETURNING id`, [body.name || null, body.email, body.source || 'form', body.status || 'active']))[0];
          for (const name of body.lists || []) {
            let l = (await rows(`SELECT id FROM email_lists WHERE name = $1`, [name]))[0];
            if (!l) l = (await rows(`INSERT INTO email_lists (name) VALUES ($1) RETURNING id`, [name]))[0];
            await db.query(`INSERT INTO email_contact_lists (contact_id, list_id) VALUES ($1,$2)`, [c.id, l.id]);
          }
          return json(res, 200, { id: c.id });
        }
        if (req.url === '/fail-next-consent-insert') { pool.failOn = { test: /INSERT INTO email_consents/i, message: 'injected failure (test)' }; return json(res, 200, { ok: true }); }
        if (req.url === '/drop-consents') { await db.exec(h.readSql(h.ROLLBACK_FILE)); waitlist._resetTableCache(); return json(res, 200, { ok: true }); }
        if (req.url === '/apply-migration') { await h.applyConsentMigration(); waitlist._resetTableCache(); return json(res, 200, { ok: true }); }
        if (req.url === '/mail-fail') { mail.confirmFail = 'mailer down (stub)'; return json(res, 200, { ok: true }); }
        if (req.url === '/target-count') { // a campaign aimed at the waitlist tag selects exactly these contacts (real buildTargetClause)
          const tag = (await rows(`SELECT id FROM email_tags WHERE name = 'new-initiative-waitlist'`))[0];
          const params = []; const where = buildTargetClause(null, tag ? tag.id : null, params);
          const r = await rows(`SELECT email FROM email_contacts WHERE ${where} ORDER BY id`, params);
          return json(res, 200, { emails: r.map(x => x.email) });
        }
        json(res, 404, { error: 'not found' });
      } catch (e) { json(res, 500, { error: String(e.message || e) }); }
    });
  }).listen(4193, '127.0.0.1', () => console.log('real CRM (in-memory) on 4192, control on 4193'));
})().catch(e => { console.error(e); process.exit(1); });
