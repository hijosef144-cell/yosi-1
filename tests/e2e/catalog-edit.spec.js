// Catalog admin screens, stage 5b-1 (EDIT: providers and services), in a real browser (the four projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page and the real function code on an in-memory Postgres with invented "[דמו]" data.
// Nothing here touches Neon or any network. Answers of the server that cannot be produced by the demo (busy, timeout, a cut connection, a gateway page) are put in by intercepting the request.
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4183, BASE = 'http://localhost:' + PORT, API = '**/api/kaspchem/admin/catalog/';
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });
test.beforeEach(async () => { await demo.setMode('full'); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading') && !document.querySelector('#ct-log .ct-loading'));
async function open(page, screen, user) {
  const writes = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') { const u = new URL(r.url()); writes.push({ method: r.method(), path: u.pathname.replace('/api/kaspchem/admin', ''), body: r.postData() ? JSON.parse(r.postData()) : null, csrf: r.headers()['x-kaspchem'] }); } });
  await page.goto(BASE + '/admin/kaspchem/?test=' + (user || 'yosi@example.test') + '|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  if (screen) await nav(page, screen);
  return writes;
}
async function nav(page, screen) { await page.locator('.ct-nav button', { hasText: screen }).click(); await ready(page); }
const body = (page) => page.locator('#ct-body');
const dlg = (page) => page.locator('.ce-modal');
const q = async (sql, params) => (await demo.pg.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const submit = (page) => dlg(page).locator('[data-ce=submit]');
async function openProvider(page, id) { await nav(page, 'נותני שירות'); await body(page).locator('button[data-ct=open-provider][data-id="' + id + '"]').click(); await ready(page); }
async function openService(page, id) { await nav(page, 'שירותים'); await body(page).locator('button[data-ct=open-service][data-id="' + id + '"]').click(); await ready(page); }
const bar = (page, a) => page.locator('.ce-bar [data-ce=' + a + ']');
const activate = (p, s) => q("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 1 WHERE professional_id = $1 AND service_id = $2", [p, s]);   // the table's own rule for an active engagement
const deactivate = (p, s) => q("UPDATE provider_services SET activation = 'paused' WHERE professional_id = $1 AND service_id = $2", [p, s]);
const future = (days) => { const d = new Date(Date.now() + days * 86400000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

test('the screens now say "view and edit", and the buttons are on the lists and on the cards', async ({ page }) => {
  await open(page);
  await expect(page.locator('.ct-ro')).toHaveText('צפייה ועריכה');
  await nav(page, 'נותני שירות'); await expect(bar(page, 'new')).toHaveText('נותן שירות חדש');
  await nav(page, 'שירותים'); await expect(bar(page, 'new')).toHaveText('שירות חדש');
  await body(page).locator('button[data-ct=open-service][data-id="1"]').click(); await ready(page);
  await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'הגדרות שירות', 'ביטול רישום האישור המדווח']);
  await openService(page, 3); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'הגדרות שירות', 'רישום דיווח על אישור משפטי']);
  await openService(page, 4); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'יצירת הגדרות וקוד שירות']);   // a service made elsewhere has no code yet
  await expect(body(page)).toContainText('אי אפשר לרשום עבורו דיווח על אישור משפטי');
  await openProvider(page, 11); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'השהיה', 'ארכוב']);
  await openProvider(page, 12); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'שינוי השהיה', 'חידוש', 'ארכוב']);   // paused: no new engagement
  await openProvider(page, 13); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'ביטול ארכוב']);
});

test('new provider: the form checks the name, creates exactly one provider, opens its card, and the audit row has no contact detail', async ({ page }) => {
  const writes = await open(page, 'נותני שירות');
  await bar(page, 'new').click();
  await expect(dlg(page)).toBeVisible(); await expect(dlg(page)).toHaveAttribute('role', 'dialog'); await expect(page.locator('#ce-name')).toBeFocused();
  await submit(page).click();
  await expect(page.locator('[data-field=name] .ce-fe')).toHaveText('חובה להזין שם.'); await expect(page.locator('#ce-name')).toHaveAttribute('aria-invalid', 'true'); expect(writes).toEqual([]);   // nothing was sent
  await page.locator('#ce-name').fill('  [דמו] משרד אלון רוזן  '); await page.locator('#ce-business_name').fill('[דמו] משרד חדש');
  await page.locator('#ce-contact_phone').fill('050-1112233'); await page.locator('#ce-contact_email').fill('NEW-One@Example.Test'); await page.locator('#ce-capacity_open').fill('4');
  await page.locator('#ce-delivery_method').selectOption('manual'); await page.locator('#ce-internal_notes').fill('הערה פנימית חדשה');
  await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/providers', csrf: '1' });
  expect(writes[0].body).toEqual({ name: '[דמו] משרד אלון רוזן', business_name: '[דמו] משרד חדש', contact_phone: '050-1112233', contact_email: 'NEW-One@Example.Test', internal_notes: 'הערה פנימית חדשה', delivery_method: 'manual', capacity_open: 4 });
  await expect(body(page)).toContainText('[דמו] משרד אלון רוזן'); await expect(body(page)).toContainText('זמין'); await expect(body(page)).toContainText('ידני (הצוות מזין)');
  const p = await one("SELECT p.id::text AS id, p.name, pp.contact_phone, pp.contact_email, pp.capacity_open, pp.delivery_method, pp.archived_at, pp.paused_until FROM professionals p JOIN provider_profiles pp ON pp.professional_id = p.id WHERE p.name LIKE '%אלון רוזן%'");
  expect(p).toMatchObject({ name: '[דמו] משרד אלון רוזן', capacity_open: 4, delivery_method: 'manual', archived_at: null, paused_until: null });
  expect(p.contact_email).toBe('new-one@example.test');   // normalised by the server
  const a = await one("SELECT actor, detail::text AS d FROM audit_log WHERE action = 'catalog.provider.create'");
  expect(a.actor).toBe('yosi@example.test'); expect(a.d).not.toMatch(/050|1112233|example\.test|הערה פנימית/);
  await expect(page.locator('#ct-log')).toContainText('יצירת נותן שירות'); await expect(page.locator('#ct-log')).toContainText('yosi@example.test');
  await body(page).locator('button[data-ct=back]').click(); await ready(page); await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('נותני שירות');   // back goes to the list
});

test('a double click, a double Enter and a double submit send exactly one request', async ({ page }) => {
  const writes = await open(page, 'נותני שירות');
  await page.route(API + 'providers', async (route) => { if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 900)); await route.continue(); });   // keeps the first request in flight
  await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] פעם אחת בלבד');
  await submit(page).dblclick();
  await page.locator('#ce-name').evaluate((el) => { el.form.requestSubmit(); el.form.requestSubmit(); });
  await expect(submit(page)).toHaveText('שומר…'); await expect(submit(page)).toBeDisabled(); await expect(page.locator('#ce-name')).toBeDisabled();
  await expect(dlg(page)).toHaveCount(0, { timeout: 8000 }); await ready(page);
  expect(writes.length).toBe(1);
  expect(Number((await one("SELECT count(*)::int AS n FROM professionals WHERE name = '[דמו] פעם אחת בלבד'")).n)).toBe(1);
});

test('a provider with a similar name: the person is shown the existing one and decides; open it, or create anyway (allow_duplicate is sent only then, and never shown)', async ({ page }) => {
  const writes = await open(page, 'נותני שירות');
  await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] נותן שירות א׳'); await submit(page).click();
  await expect(dlg(page).locator('.ce-warn')).toContainText('נמצאה רשומה דומה'); await expect(dlg(page).locator('.ce-warn')).toContainText('כבר קיים נותן שירות בשם דומה');
  await expect(dlg(page)).toContainText('(מספר 11)'); await expect(dlg(page)).not.toContainText('allow_duplicate');
  expect(writes.length).toBe(1); expect(writes[0].body.allow_duplicate).toBeUndefined();
  expect(Number((await one('SELECT count(*)::int AS n FROM professionals')).n)).toBe(6);   // nothing was created
  await dlg(page).locator('[data-ce=open]').first().click(); await ready(page);
  await expect(dlg(page)).toHaveCount(0); await expect(body(page)).toContainText('פרטי נותן השירות'); await expect(body(page).locator('h2').first()).toContainText('נותן שירות א׳');
  expect(writes.length).toBe(1);
  await nav(page, 'נותני שירות'); await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] נותן שירות א׳'); await submit(page).click();
  await dlg(page).locator('[data-ce=force]').click(); await expect(dlg(page)).toHaveCount(0, { timeout: 8000 }); await ready(page);
  expect(writes.filter((w) => w.body.allow_duplicate === true).length).toBe(1);
  expect(Number((await one('SELECT count(*)::int AS n FROM professionals')).n)).toBe(7);
});

test('edit provider: only the changed fields are sent, each with the value that was seen; "nothing changed" sends nothing; the audit row has field names only', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 11); await bar(page, 'edit').click();
  await expect(page.locator('#ce-name')).toHaveValue('[דמו] נותן שירות א׳'); await expect(page.locator('#ce-contact_phone')).toHaveValue('050-0000001');
  await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toHaveText('לא בוצע שינוי, ולכן אין מה לשמור.'); expect(writes).toEqual([]);
  await page.locator('#ce-contact_phone').fill('052-7654321'); await page.locator('#ce-capacity_open').fill(''); await page.locator('#ce-contact_email').fill('');
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0].method).toBe('PATCH'); expect(writes[0].path).toBe('/catalog/providers/11');
  expect(writes[0].body).toEqual({ changes: { contact_phone: '052-7654321', capacity_open: null, contact_email: null }, expected: { contact_phone: '050-0000001', capacity_open: 5, contact_email: 'demo-a@example.test' } });
  const p = await one('SELECT contact_phone, contact_email, capacity_open, internal_notes, business_name FROM provider_profiles WHERE professional_id = 11');
  expect(p.contact_phone).toMatch(/7654321/); expect(p.contact_email).toBeNull(); expect(p.capacity_open).toBeNull(); expect(p.internal_notes).toBe('הערה פנימית לדוגמה (נתוני דמה)'); expect(p.business_name).toBe('[דמו] משרד לדוגמה א׳');   // the rest is untouched
  const a = await one("SELECT detail::text AS d FROM audit_log WHERE action = 'catalog.provider.update' AND actor = 'yosi@example.test'");
  expect(a.d).toContain('contact_phone'); expect(a.d).not.toMatch(/7654321|example\.test|050/);
  await expect(body(page)).toContainText('0527654321'); await expect(page.locator('#ct-log')).toContainText('עדכון נותן שירות');
});

test('the change log never says "no changes" when it could not look at everything (the 200 newest records, views included)', async ({ page }) => {
  await open(page);
  const views = (id, n) => q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) SELECT 'avi@example.test', 'catalog.provider.view', 'provider', $1, '{}'::jsonb FROM generate_series(1, $2::int)", [String(id), n]);
  await views(14, 210); await openProvider(page, 14);   // never changed, but 210 openings: the page cannot tell, and says so
  await expect(page.locator('#ct-log')).toContainText('לא נמצאו שינויים בין 200 הרישומים האחרונים'); await expect(page.locator('#ct-log')).not.toContainText('אין שינויים רשומים');
  await views(11, 210); await openProvider(page, 11);   // a real change exists (avi, internal notes) but 210 newer openings push it out of the window
  await expect(page.locator('#ct-log')).toContainText('לא נמצאו שינויים בין 200 הרישומים האחרונים'); await expect(page.locator('#ct-log')).not.toContainText('אין שינויים רשומים'); await expect(page.locator('#ct-log')).toContainText('ייתכן שיש שינויים ישנים יותר');
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.provider.update', 'provider', '11', '{\"fields\":[\"capacity_open\"]}')");
  await views(11, 205); await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('yosi@example.test', 'catalog.provider.update', 'provider', '11', '{\"fields\":[\"business_name\"]}')"); await openProvider(page, 11);
  await expect(page.locator('#ct-log')).toContainText('מוצגים רק שינויים מתוך 200 הרישומים האחרונים'); await expect(page.locator('#ct-log')).toContainText('business_name'); await expect(page.locator('#ct-log tbody tr')).toHaveCount(1);
  await openService(page, 1); await expect(page.locator('#ct-log')).toContainText('אישור משפטי של שירות'); await expect(page.locator('#ct-log .ct-logcap')).toHaveCount(0);   // a card whose log fits entirely says nothing extra
});

test('closing a form sends nothing; with typed changes the person is asked first, and can go back to the typed text', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0);   // nothing typed: closes at once
  await expect(bar(page, 'edit')).toBeFocused();   // focus returns to the button that opened it
  await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('טקסט שהוקלד');
  await page.keyboard.press('Escape'); await expect(dlg(page)).toContainText('לסגור בלי לשמור?');
  await dlg(page).locator('[data-ce=keep]').click(); await expect(page.locator('#ce-internal_notes')).toHaveValue('טקסט שהוקלד');
  await dlg(page).locator('[data-ce=cancel]').click(); await dlg(page).locator('[data-ce=discard]').click(); await expect(dlg(page)).toHaveCount(0);
  expect(writes).toEqual([]); expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('הערה פנימית לדוגמה (נתוני דמה)');
  await page.waitForTimeout(1500); expect(writes).toEqual([]);   // no autosave either
});

test('another admin changed the provider meanwhile: nothing is overwritten, the person sees who, what and the current value, and may apply their change knowingly', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('הערה שלי');
  await q("UPDATE provider_profiles SET internal_notes = 'הערה של אבי' WHERE professional_id = 11");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.provider.update', 'provider', '11', '{\"fields\":[\"internal_notes\"]}')");
  await submit(page).click();
  const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('הנתון השתנה מאז שצפיתם בו'); await expect(panel).toContainText('avi@example.test'); await expect(panel).toContainText('הערה של אבי'); await expect(panel).toContainText('הערה שלי'); await expect(panel).toContainText('הערה פנימית לדוגמה (נתוני דמה)');
  await expect(panel).toContainText('לא נשמר דבר');
  expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('הערה של אבי');   // the other admin's value is still there
  expect(writes.length).toBe(1);
  await panel.locator('[data-ce=reapply]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(2); expect(writes[1].body).toEqual({ changes: { internal_notes: 'הערה שלי' }, expected: { internal_notes: 'הערה של אבי' } });
  expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('הערה שלי');
  // and "cancel and refresh" writes nothing
  await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('עוד שינוי');
  await q("UPDATE provider_profiles SET internal_notes = 'שוב אבי' WHERE professional_id = 11"); await submit(page).click();
  await dlg(page).locator('.ce-panel [data-ce=refresh]').click(); await ready(page); await expect(dlg(page)).toHaveCount(0);
  expect(writes.length).toBe(3); expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('שוב אבי'); await expect(body(page)).toContainText('שוב אבי');
});

test('provider states: pause needs a future date and a reason, resume, archive needs a reason and is refused with an active engagement, unarchive', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 11); await bar(page, 'pause').click();
  await expect(page.locator('#ce-until')).toHaveAttribute('min', future(1)); await expect(dlg(page)).toContainText('אפשר לחדש בכל רגע');
  await submit(page).click(); await expect(page.locator('[data-field=until] .ce-fe')).toHaveText('יש לבחור תאריך עתידי.');
  await page.locator('#ce-until').fill(future(10)); await submit(page).click(); await expect(page.locator('[data-field=reason] .ce-fe')).toHaveText('חובה לכתוב סיבה.'); expect(writes).toEqual([]);
  await page.locator('#ce-reason').fill('חופשה'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0].path).toBe('/catalog/providers/11/pause'); expect(Object.keys(writes[0].body).sort()).toEqual(['reason', 'until']);
  await expect(body(page).locator('h2').first()).toContainText('מושהה'); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'שינוי השהיה', 'חידוש', 'ארכוב']);
  expect(await one("SELECT paused_until > now() AS p FROM provider_profiles WHERE professional_id = 11")).toEqual({ p: true });
  await bar(page, 'resume').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await expect(body(page).locator('h2').first()).toContainText('זמין'); expect((await one('SELECT paused_until FROM provider_profiles WHERE professional_id = 11')).paused_until).toBeNull();
  // archive: an active engagement blocks it
  await activate(11, 1);
  await bar(page, 'archive').click(); await expect(dlg(page)).toContainText('לא נמחק דבר'); await submit(page).click(); await expect(page.locator('[data-field=reason] .ce-fe')).toHaveText('חובה לכתוב סיבה.');
  await page.locator('#ce-reason').fill('פרש'); await submit(page).click();
  await expect(dlg(page).locator('.ce-status')).toContainText('יש לנותן השירות או לשירות התקשרות פעילה'); await expect(dlg(page)).toBeVisible();
  expect((await one('SELECT archived_at FROM provider_profiles WHERE professional_id = 11')).archived_at).toBeNull();
  await deactivate(11, 1);
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await expect(body(page).locator('h2').first()).toContainText('בארכיון'); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'ביטול ארכוב']);
  await bar(page, 'unarchive').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page).locator('h2').first()).toContainText('זמין');
  const acts = (await q("SELECT action FROM audit_log WHERE action LIKE 'catalog.provider.%' AND action <> 'catalog.provider.view' AND actor = 'yosi@example.test' ORDER BY id")).map((r) => r.action);
  expect(acts).toEqual(['catalog.provider.pause', 'catalog.provider.resume', 'catalog.provider.archive', 'catalog.provider.unarchive']);
});

test('new service: created INACTIVE, with its code svc-<number> made automatically, no legal clearance, nothing public', async ({ page }) => {
  const writes = await open(page, 'שירותים');
  await bar(page, 'new').click(); await expect(dlg(page)).toContainText('השירות נוצר כבוי'); await expect(page.locator('#ce-active')).toHaveCount(0);   // there is no way to create it active
  await page.locator('#ce-name').fill('[דמו] שירות חדש לבדיקה'); await page.locator('#ce-topic').selectOption('housing'); await page.locator('#ce-description').fill('תיאור קצר');
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.map((w) => w.method + ' ' + w.path.replace(/\d+/, 'N'))).toEqual(['POST /catalog/services', 'PUT /catalog/services/N/settings']);
  expect(writes[0].body).toEqual({ name: '[דמו] שירות חדש לבדיקה', topic: 'housing', description: 'תיאור קצר' });
  const s = await one("SELECT s.id::text AS id, s.active, s.topic, ss.code, ss.legal_cleared, ss.finding_tags, ss.topics FROM services s JOIN service_settings ss ON ss.service_id = s.id WHERE s.name = '[דמו] שירות חדש לבדיקה'");
  expect(s.active).toBe(false); expect(s.code).toBe('svc-' + s.id); expect(s.legal_cleared).toBe(false); expect(s.finding_tags).toEqual([]); expect(writes[1].body).toEqual({ code: 'svc-' + s.id, finding_tags: [], topics: [] });
  await expect(body(page).locator('h2').first()).toContainText('כבוי'); await expect(body(page)).toContainText('svc-' + s.id); await expect(body(page)).toContainText('לא דווח אישור'); await expect(body(page)).toContainText('הצעה לציבור חסומה בשלב זה');
  expect((await one('SELECT count(*)::int AS n FROM provider_services WHERE service_id = $1::bigint', [s.id])).n).toBe(0);   // no engagement was made
  expect((await one('SELECT count(*)::int AS n FROM pricing WHERE service_id = $1::bigint', [s.id])).n).toBe(0);
});

test('a service with a similar name: shown first, open it or create anyway; the service is never made twice', async ({ page }) => {
  const writes = await open(page, 'שירותים');
  await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] ייעוץ משכנתא'); await submit(page).click();
  await expect(dlg(page).locator('.ce-warn')).toContainText('נמצאה רשומה דומה'); await expect(dlg(page)).toContainText('ייעוץ משכנתא'); await expect(dlg(page)).not.toContainText('allow_duplicate');
  expect(Number((await one('SELECT count(*)::int AS n FROM services')).n)).toBe(7);
  await dlg(page).locator('[data-ce=keep]').click(); await expect(page.locator('#ce-name')).toHaveValue('[דמו] ייעוץ משכנתא');
  await submit(page).click(); await dlg(page).locator('[data-ce=force]').click(); await expect(dlg(page)).toHaveCount(0, { timeout: 8000 }); await ready(page);
  expect(Number((await one("SELECT count(*)::int AS n FROM services WHERE name = '[דמו] ייעוץ משכנתא'")).n)).toBe(2);
  expect(writes.filter((w) => w.path === '/catalog/services').length).toBe(3);   // refused, refused, created: each one was a click of the person
});

test('edit service: the "active" mark is labelled internal only; a service tied to a public price cannot be renamed; only changed fields are sent', async ({ page }) => {
  const writes = await open(page);
  await openService(page, 6); await bar(page, 'edit').click();
  await expect(dlg(page)).toContainText('שירות פעיל (פנימי)'); await expect(dlg(page)).toContainText('אינו משפיע על האתר הציבורי ולא על תהליכי ההפניה'); await expect(page.locator('#ce-active')).not.toBeChecked();
  await page.locator('#ce-description').fill('תיאור חדש'); await page.locator('#ce-active').check(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes[0].body).toEqual({ changes: { description: 'תיאור חדש', active: true }, expected: { description: null, active: false } });
  expect(await one('SELECT description, active FROM services WHERE id = 6')).toEqual({ description: 'תיאור חדש', active: true });
  await expect(body(page).locator('h2').first()).toContainText('פעיל');
  // the name of a service with a public price is protected by the server; the person is told why, in words
  await q('UPDATE pricing SET public = true, approved = true WHERE id = 2');
  await openService(page, 1); await bar(page, 'edit').click(); await page.locator('#ce-name').fill('[דמו] שם חדש'); await submit(page).click();
  await expect(dlg(page).locator('.ce-status')).toContainText('יש מחיר שמוצג באתר'); expect((await one('SELECT name FROM services WHERE id = 1')).name).toBe('[דמו] בדיקת זכאות להחזר מס');
  await page.locator('#ce-name').fill('[דמו] בדיקת זכאות להחזר מס'); await page.locator('#ce-description').fill('רק תיאור'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);   // the description alone is allowed
  expect((await one('SELECT description FROM services WHERE id = 1')).description).toBe('רק תיאור');
});

test('service settings: tags and questionnaire topics; the code is shown and cannot be changed; a bad tag is refused before anything is sent', async ({ page }) => {
  const writes = await open(page);
  await openService(page, 3); await bar(page, 'settings').click();
  await expect(dlg(page)).toContainText('demo-payslip'); await expect(dlg(page)).toContainText('נקבע פעם אחת ואינו משתנה'); await expect(page.locator('#ce-code')).toHaveCount(0);
  await expect(page.locator('#ce-finding_tags')).toHaveValue('payslip'); await expect(dlg(page).locator('input[data-group=topics]:checked')).toHaveCount(1);
  await page.locator('#ce-finding_tags').fill('payslip, bad tag!'); await submit(page).click(); await expect(page.locator('[data-field=finding_tags] .ce-fe')).toContainText('התגים אינם תקינים'); expect(writes).toEqual([]);
  await page.locator('#ce-finding_tags').fill('Payslip, new-tag,  second-tag , new-tag'); await dlg(page).locator('input[data-group=topics][value=mortgage]').check(); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0].method).toBe('PUT'); expect(writes[0].body.code).toBeUndefined();
  expect(writes[0].body).toEqual({ finding_tags: ['payslip', 'new-tag', 'second-tag'], topics: ['mortgage', 'payslip-rights'], expected: { finding_tags: ['payslip'], topics: ['payslip-rights'] } });
  const s = await one('SELECT code, finding_tags, topics FROM service_settings WHERE service_id = 3');
  expect(s.code).toBe('demo-payslip'); expect(s.finding_tags).toEqual(['payslip', 'new-tag', 'second-tag']); expect(s.topics.sort()).toEqual(['mortgage', 'payslip-rights']);
});

test('legal clearance is a REPORT, never automatic: report, cancel, report again, cancel again; every event stays in the journal and in the history table; the source and the day are kept; the signed-in admin is the reporter', async ({ page }) => {
  const writes = await open(page), posts = () => writes.filter((w) => w.path.endsWith('/clearance')), journal = () => q("SELECT actor, detail FROM audit_log WHERE action = 'catalog.service.clearance' AND entity_id = '3' ORDER BY id");
  await openService(page, 3); await expect(body(page)).toContainText('לא דווח אישור'); await expect(page.locator('#ct-clr')).toContainText('לא דווח אישור משפטי על השירות הזה');
  await bar(page, 'clearance').click(); await expect(dlg(page)).toContainText('רישום של דיווח'); await expect(dlg(page)).toContainText('לא בקשת אישור'); await expect(dlg(page)).toContainText('ואינה מאמתת שהאישור התקבל'); await expect(dlg(page)).toContainText('לא ביומן');
  await expect(page.locator('#ce-confirm')).not.toBeChecked(); await submit(page).click(); await expect(page.locator('[data-field=confirm] .ce-fe')).toHaveText('יש לסמן שהאישור התקבל.'); expect(writes).toEqual([]);
  // a contact detail is refused in words, and nothing is written
  await page.locator('#ce-source').fill('התקשרו 0501234567'); await page.locator('#ce-confirm').check(); await submit(page).click();
  await expect(page.locator('[data-field=source] .ce-fe')).toContainText('אי אפשר לכלול במקור מספר טלפון'); await expect(page.locator('#ce-source')).toBeFocused(); expect((await journal()).length).toBe(0); expect((await one('SELECT legal_cleared FROM service_settings WHERE service_id = 3')).legal_cleared).toBe(false);
  // 1. the first report
  await page.locator('#ce-source_kind').selectOption('written_opinion'); await page.locator('#ce-source').fill('מכתב עו״ד כהן מיום 05.11.2026'); await page.locator('#ce-approved_on').fill('2026-11-05'); await page.locator('#ce-note').fill('להפניה בלבד'); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  const note1 = 'מקור: חוות דעת משפטית בכתב — מכתב עו״ד כהן מיום 05.11.2026 · תאריך האישור: 05.11.2026 · הערה: להפניה בלבד';
  expect(posts().pop().body).toEqual({ cleared: true, expected_cleared: false, source_kind: 'written_opinion', source: 'מכתב עו״ד כהן מיום 05.11.2026', approved_on: '2026-11-05', note: note1 });
  expect(await one('SELECT legal_cleared, legal_cleared_by, legal_note FROM service_settings WHERE service_id = 3')).toMatchObject({ legal_cleared: true, legal_cleared_by: 'yosi@example.test', legal_note: note1 });
  await expect(body(page)).toContainText('אישור מדווח'); await expect(body(page)).toContainText('דווח על ידי'); await expect(body(page)).toContainText('yosi@example.test'); await expect(body(page)).toContainText('המערכת אינה מאמתת את האישור'); await expect(body(page)).toContainText('מכתב עו״ד כהן');
  await expect(bar(page, 'clearance')).toHaveText('ביטול רישום האישור המדווח'); await expect(page.locator('#ct-clr tbody tr')).toHaveCount(1);
  await expect(page.locator('#ct-clr')).toContainText('חוות דעת משפטית בכתב — מכתב עו״ד כהן מיום 05.11.2026'); await expect(page.locator('#ct-clr')).toContainText('תאריך האישור');
  // 2. the cancellation: a reason is needed; an active engagement blocks it and leaves no event
  await activate(12, 3);
  await bar(page, 'clearance').click(); await expect(dlg(page)).toContainText('ההיסטוריה נשמרת ביומן ואינה נמחקת'); await submit(page).click(); await expect(page.locator('[data-field=reason] .ce-fe')).toHaveText('חובה לכתוב סיבה.');
  await page.locator('#ce-reason').fill('נמצא פגם'); await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toContainText('יש לנותן השירות או לשירות התקשרות פעילה');
  expect((await one('SELECT legal_cleared FROM service_settings WHERE service_id = 3')).legal_cleared).toBe(true); expect((await journal()).length).toBe(1);
  await deactivate(12, 3); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(posts().pop().body).toEqual({ cleared: false, expected_cleared: true, reason: 'נמצא פגם', note: 'ביטול הרישום: נמצא פגם' });
  await expect(body(page)).toContainText('לא דווח אישור'); expect(await one('SELECT legal_cleared, legal_cleared_by, legal_note FROM service_settings WHERE service_id = 3')).toEqual({ legal_cleared: false, legal_cleared_by: null, legal_note: 'ביטול הרישום: נמצא פגם' });
  await expect(page.locator('#ct-clr tbody tr')).toHaveCount(2);
  // 3. reported again (another source), 4. cancelled again
  await bar(page, 'clearance').click(); await page.locator('#ce-source_kind').selectOption('email'); await page.locator('#ce-source').fill('אישור בדוא״ל מהיועץ'); await page.locator('#ce-approved_on').fill('2026-11-09'); await page.locator('#ce-confirm').check(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect((await one('SELECT legal_note FROM service_settings WHERE service_id = 3')).legal_note).toBe('מקור: אישור בדוא״ל — אישור בדוא״ל מהיועץ · תאריך האישור: 09.11.2026');   // the row is only the current report
  await bar(page, 'clearance').click(); await page.locator('#ce-reason').fill('הושהה לבקשת היועץ'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  // the journal holds all four events, each as it was given, and the first one was not touched by the later ones
  const rows = await journal();
  expect(rows.map((r) => [r.actor, r.detail])).toEqual([
    ['yosi@example.test', { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'written_opinion', source: 'מכתב עו״ד כהן מיום 05.11.2026', approved_on: '2026-11-05' }],
    ['yosi@example.test', { cleared: false, was_cleared: true, reason: 'נמצא פגם' }],
    ['yosi@example.test', { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'email', source: 'אישור בדוא״ל מהיועץ', approved_on: '2026-11-09' }],
    ['yosi@example.test', { cleared: false, was_cleared: true, reason: 'הושהה לבקשת היועץ' }]]);
  expect(JSON.stringify(rows)).not.toContain('להפניה בלבד');   // the remark stays in the card, not in the journal
  await expect(page.locator('#ct-clr tbody tr')).toHaveCount(4);
  for (const t of ['חוות דעת משפטית בכתב — מכתב עו״ד כהן מיום 05.11.2026', 'אישור בדוא״ל — אישור בדוא״ל מהיועץ', 'נמצא פגם', 'הושהה לבקשת היועץ', 'הרישום בוטל']) await expect(page.locator('#ct-clr')).toContainText(t);
  await expect(page.locator('#ct-log')).toContainText('אישור מדווח נרשם'); await expect(page.locator('#ct-log')).toContainText('אישור בוטל');
});

test('a service that has no settings yet: the person creates the code with one click; nothing is created by opening the card', async ({ page }) => {
  const writes = await open(page);
  await openService(page, 4); expect(writes).toEqual([]); expect(Number((await one('SELECT count(*)::int AS n FROM service_settings WHERE service_id = 4')).n)).toBe(0);
  await bar(page, 'mksettings').click(); await expect(dlg(page)).toContainText('svc-4'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect((await one('SELECT code FROM service_settings WHERE service_id = 4')).code).toBe('svc-4'); await expect(body(page)).toContainText('svc-4'); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'הגדרות שירות', 'רישום דיווח על אישור משפטי']);
});

test('the service is made but its code fails: the person is told exactly what exists, the form never comes back, nothing is created twice', async ({ page }) => {
  const writes = await open(page, 'שירותים');
  let n = 0; await page.route(API + 'services/*/settings', async (route) => { n++; if (n === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'write_timeout' }) }); return route.continue(); });
  await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] שירות עם תקלה בקוד'); await submit(page).click();
  const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('השירות נוצר'); await expect(panel).toContainText('הקוד שלו עדיין לא נקבע'); await expect(panel).toContainText('בוטלה'); await expect(dlg(page).locator('.ce-fields')).toBeHidden();
  expect(writes.map((w) => w.method + ' ' + w.path.replace(/\d+/, 'N'))).toEqual(['POST /catalog/services', 'PUT /catalog/services/N/settings']);
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await ready(page);   // closing goes to the card of the service that was made
  await expect(body(page).locator('h2').first()).toContainText('שירות עם תקלה בקוד'); await expect(page.locator('.ce-bar button')).toHaveText(['עריכת פרטים', 'התקשרות חדשה', 'יצירת הגדרות וקוד שירות']);
  expect(Number((await one("SELECT count(*)::int AS n FROM services WHERE name = '[דמו] שירות עם תקלה בקוד'")).n)).toBe(1);
  await bar(page, 'mksettings').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page)).toContainText('svc-');
  expect(Number((await one('SELECT count(*)::int AS n FROM service_settings')).n)).toBe(5);
});

test('"unknown whether it was saved" (a cut connection, a gateway page, result_unknown): no resend, no retry, only a check of the state', async ({ page }) => {
  for (const mode of ['abort', 'gateway', 'unknown']) {
    const writes = await open(page);
    await page.route(API + 'providers/11', (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      if (mode === 'abort') return route.abort('connectionreset');
      if (mode === 'gateway') return route.fulfill({ status: 504, contentType: 'text/html', body: '<html><body>Gateway Timeout SELECT secret FROM x</body></html>' });
      return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'result_unknown', message: 'password=hunter2 at host db.internal' }) });
    });
    await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('אולי נשמר ' + mode); await submit(page).click();
    const panel = dlg(page).locator('.ce-panel');
    await expect(panel).toContainText('לא ידוע אם נשמר'); await expect(panel).toContainText('אל תשלחו שוב'); await expect(dlg(page).locator('.ce-fields')).toBeHidden(); await expect(dlg(page).locator('[data-ce=submit]')).toBeHidden();
    await expect(dlg(page)).not.toContainText(/hunter2|SELECT|db\.internal|Gateway|result_unknown/);
    await page.waitForTimeout(1600); expect(writes.length).toBe(1);   // nothing was sent again by itself
    await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await ready(page);   // closing refreshes what is saved
    await expect(body(page)).toContainText('פרטי נותן השירות'); expect(writes.length).toBe(1);
    await page.unroute(API + 'providers/11'); await page.goto('about:blank');
  }
});

test('a busy server (nothing saved): the typed text stays, the person decides whether to try again, one click is one request', async ({ page }) => {
  const writes = await open(page);
  let n = 0; await page.route(API + 'providers/11', (route) => { if (route.request().method() !== 'PATCH') return route.continue(); n++; return n === 1 ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy_retry' }) }) : route.continue(); });
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('הערה אחרי עומס'); await submit(page).click();
  await expect(dlg(page).locator('.ce-status')).toContainText('המערכת עסוקה'); await expect(dlg(page).locator('.ce-status')).toContainText('לא נשמר דבר'); await expect(page.locator('#ce-internal_notes')).toHaveValue('הערה אחרי עומס'); await expect(submit(page)).toBeEnabled();
  await page.waitForTimeout(1600); expect(writes.length).toBe(1);
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect(writes.length).toBe(2); expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('הערה אחרי עומס');
});

test('the catalog is switched off while a form is open: nothing is saved and the person is told', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('לא תישמר');
  await q("UPDATE settings SET value = 'false'::jsonb WHERE key = 'private.catalog_enabled'");
  await submit(page).click(); await expect(dlg(page).locator('.ce-panel')).toContainText('הקטלוג כבוי כרגע, ולכן לא נשמר דבר'); expect(writes.length).toBe(1);
  expect((await one('SELECT internal_notes AS n FROM provider_profiles WHERE professional_id = 11')).n).toBe('הערה פנימית לדוגמה (נתוני דמה)');
  await dlg(page).locator('[data-ce=refresh]').click(); await expect(body(page)).toContainText('הקטלוג כבוי');
});

test('an expired sign-in during a save sends the person to the sign-in screen, nothing else', async ({ page }) => {
  await open(page);
  await page.route(API + 'providers/11', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthenticated' }) }) : route.continue());
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('x'); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await expect(page.locator('#lf')).toBeVisible();
});

test('the words of the server are never shown: a validation answer with a technical sentence is replaced by plain Hebrew', async ({ page }) => {
  await open(page);
  await page.route(API + 'providers/11', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_phone', message: 'SQLSTATE 22P02 password=hunter2 /var/task/index.js' }) }) : route.continue());
  await openProvider(page, 11); await bar(page, 'edit').click(); await page.locator('#ce-contact_phone').fill('123'); await submit(page).click();
  await expect(page.locator('[data-field=contact_phone] .ce-fe')).toHaveText('מספר הטלפון אינו תקין.'); await expect(page.locator('#ce-contact_phone')).toBeFocused();
  expect(await page.locator('body').innerText()).not.toMatch(/SQLSTATE|hunter2|var\/task|bad_phone/);
  await page.unroute(API + 'providers/11');
  await page.route(API + 'providers/11', (route) => route.request().method() === 'PATCH' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'some_new_code', message: 'internal detail' }) }) : route.continue());
  await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toHaveText('הפעולה לא הושלמה. לא נשמר דבר.'); expect(await page.locator('body').innerText()).not.toMatch(/some_new_code|internal detail/);
});

test('text typed by the owners is shown as text, never as markup (names, notes, a value written by the other admin, in the conflict table)', async ({ page }) => {
  const writes = await open(page, 'נותני שירות');
  const evil = '<img src=x onerror="window.__xss=1"><b>x</b>';
  await bar(page, 'new').click(); await page.locator('#ce-name').fill('[דמו] משרד ' + evil); await page.locator('#ce-internal_notes').fill(evil); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined(); await expect(body(page).locator('img, b')).toHaveCount(0);   // the server also removes the angle brackets
  await bar(page, 'edit').click(); await page.locator('#ce-internal_notes').fill('שלי');
  const markup = '<script>window.__xss=2</script><img src=x onerror="window.__xss=3">'; await q('UPDATE provider_profiles SET internal_notes = $1 WHERE internal_notes IS NOT NULL AND professional_id > 1000', [markup]);   // written by another admin, around the server checks
  await submit(page).click(); await expect(dlg(page).locator('.ce-panel')).toContainText('<script>window.__xss=2</script>'); expect(await page.evaluate(() => window.__xss)).toBeUndefined(); await expect(dlg(page).locator('.ce-panel img, .ce-panel script')).toHaveCount(0);
  expect(writes.length).toBe(2);
});

test('everything sent in a long session is one of the seven allowed requests, with the anti-forgery header, and never an engagement, a price, an import, an activation or a delete', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 14); await bar(page, 'edit').click(); await page.locator('#ce-business_name').fill('עסק'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await bar(page, 'pause').click(); await page.locator('#ce-until').fill(future(5)); await page.locator('#ce-reason').fill('א'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await bar(page, 'resume').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await openService(page, 5); await bar(page, 'edit').click(); await page.locator('#ce-description').fill('ב'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await bar(page, 'settings').click(); await page.locator('#ce-finding_tags').fill('abc'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(5);
  const allowed = [/^POST \/catalog\/providers$/, /^PATCH \/catalog\/providers\/\d+$/, /^POST \/catalog\/providers\/\d+\/(pause|resume|archive|unarchive)$/, /^POST \/catalog\/services$/, /^PATCH \/catalog\/services\/\d+$/, /^PUT \/catalog\/services\/\d+\/settings$/, /^POST \/catalog\/services\/\d+\/clearance$/];
  for (const w of writes) { expect(allowed.some((re) => re.test(w.method + ' ' + w.path))).toBe(true); expect(w.csrf).toBe('1'); }
  expect(writes.map((w) => w.method)).not.toContain('DELETE');
  expect(Number((await one("SELECT count(*)::int AS n FROM audit_log WHERE (action LIKE 'catalog.engagement.%' OR action LIKE 'catalog.price.%' OR action LIKE 'catalog.import.%') AND created_at > now() - interval '1 minute'")).n)).toBe(0);
});

test('the dialog is accessible and fits the screen: focus stays inside, labels and errors are linked, no sideways scroll, big enough buttons', async ({ page }) => {
  await open(page); await openProvider(page, 11); await bar(page, 'edit').click();
  await expect(dlg(page)).toHaveAttribute('aria-modal', 'true'); await expect(dlg(page)).toHaveAttribute('aria-labelledby', 'ce-title'); await expect(page.locator('#ce-title')).toHaveText('עריכת נותן שירות');
  for (const id of ['name', 'business_name', 'contact_phone', 'contact_email', 'capacity_open', 'delivery_method', 'internal_notes']) { await expect(page.locator('label[for=ce-' + id + ']')).toBeVisible(); }
  await expect(page.locator('#ce-contact_phone')).toHaveAttribute('aria-describedby', /ce-contact_phone-h.*ce-contact_phone-e|ce-contact_phone-e/);
  await page.locator('#ce-name').focus(); await page.keyboard.press('Shift+Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);   // Shift+Tab from the first field wraps inside the dialog
  for (let i = 0; i < 14; i++) await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  const m = await page.evaluate(() => { const f = document.querySelector('.ce-form').getBoundingClientRect(); return { right: f.right, left: f.left, w: innerWidth, h: innerHeight, bottom: f.bottom, sw: document.documentElement.scrollWidth }; });
  expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(m.w + 1); expect(m.bottom).toBeLessThanOrEqual(m.h + 1); expect(m.sw).toBeLessThanOrEqual(m.w);
  for (const b of await dlg(page).locator('button').all()) { const box = await b.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(40); }
});
