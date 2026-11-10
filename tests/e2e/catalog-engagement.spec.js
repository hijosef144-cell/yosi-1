// Catalog admin screens, stage 5b-2a (ENGAGEMENTS: create as PENDING, keep the tracking by hand), in a real browser (the four projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page and the real function code on an in-memory Postgres with invented "[דמו]" data.
// Nothing here touches Neon or any network. What the demo cannot produce (a busy server, a cut connection, a refusal with reasons) is put in by intercepting the request.
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4184, BASE = 'http://localhost:' + PORT, API = '**/api/kaspchem/admin/catalog/';
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });
test.beforeEach(async () => { await demo.setMode('full'); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading') && !document.querySelector('#ct-log .ct-loading'));
async function open(page) {
  const writes = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') { const u = new URL(r.url()); writes.push({ method: r.method(), path: u.pathname.replace('/api/kaspchem/admin', ''), body: r.postData() ? JSON.parse(r.postData()) : null, csrf: r.headers()['x-kaspchem'] }); } });
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  return writes;
}
async function nav(page, screen) { await page.locator('.ct-nav button', { hasText: screen }).click(); await ready(page); }
const body = (page) => page.locator('#ct-body');
const dlg = (page) => page.locator('.ce-modal');
const q = async (sql, params) => (await demo.pg.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const submit = (page) => dlg(page).locator('[data-ce=submit]');
const bar = (page, a) => page.locator('.ce-bar [data-ce=' + a + ']');
async function openProvider(page, id) { await nav(page, 'נותני שירות'); await body(page).locator('button[data-ct=open-provider][data-id="' + id + '"]').click(); await ready(page); }
async function openService(page, id) { await nav(page, 'שירותים'); await body(page).locator('button[data-ct=open-service][data-id="' + id + '"]').click(); await ready(page); }
async function openEngagement(page, p, s) { await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="' + p + '"][data-s="' + s + '"]').click(); await ready(page); }
const eng = (p, s) => one('SELECT activation, contact_state, agreement_state, pricing_model, pricing_id, priority, external_ref, terms_note, updated_by FROM provider_services WHERE professional_id = $1 AND service_id = $2', [p, s]);
const journal = (p, s) => q("SELECT actor, action, detail FROM audit_log WHERE entity = 'engagement' AND entity_id = $1 ORDER BY id", [p + '/' + s]);
const options = (page) => page.locator('#ce-target option');

test('the buttons of the cards: a new engagement from a provider (only an available one: not archived, not paused) and from a service; on an engagement only "update" and, for a draft, "move to pending"; never pause, retire, withdraw, activate or resume', async ({ page }) => {
  await open(page);
  await openProvider(page, 14); await expect(bar(page, 'engage')).toHaveText('התקשרות חדשה');
  await openProvider(page, 13); await expect(bar(page, 'engage')).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('לנותן שירות בארכיון אי אפשר להוסיף התקשרות');
  await openProvider(page, 12); await expect(bar(page, 'engage')).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('נותן שירות מושהה: אי אפשר להוסיף לו התקשרות חדשה עד שיחזור לזמינות');
  await openService(page, 7); await expect(bar(page, 'engage')).toHaveText('התקשרות חדשה');
  const cases = [[11, 2, ['עדכון מעקב', 'העברה למצב ממתין לאישור'], null], [11, 1, ['עדכון מעקב'], null], [12, 3, [], 'ההתקשרות מושהית'], [13, 5, [], 'ההתקשרות הוצאה משימוש']];
  for (const [p, s, buttons, sentence] of cases) {
    await openEngagement(page, p, s); await expect(page.locator('.ce-bar button')).toHaveText(buttons);
    if (sentence) await expect(page.locator('.ce-bar')).toContainText(sentence);
  }
  await q("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 11 AND service_id = 1");
  await openEngagement(page, 11, 1); await expect(page.locator('.ce-bar button')).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('ההתקשרות פעילה'); await expect(page.locator('.ce-bar')).toContainText('אינן זמינות במסך הזה');
  for (const [p, s] of [[11, 1], [11, 2], [12, 3], [13, 5], [15, 1]]) { await openEngagement(page, p, s); expect(await page.locator('#ct-root').innerText()).not.toMatch(/להשהות|השהיית התקשרות|להוציא משימוש|משיכה|הפעלת התקשרות|לחדש/); }
});

test('create from a provider card: pick a service (search narrows the list), an optional sheet id; ONE request, made already pending; the result is PENDING with no contact, no agreement, no price model; both steps are in the journal and shown', async ({ page }) => {
  const writes = await open(page); const pricesBefore = Number((await one('SELECT count(*)::int AS n FROM provider_service_prices')).n);
  await openProvider(page, 16); await bar(page, 'engage').click();
  await expect(dlg(page)).toContainText('ההתקשרות תיווצר במצב'); await expect(dlg(page)).toContainText('ממתין לאישור'); await expect(dlg(page)).toContainText('ההפעלה אינה זמינה בשלב זה'); await expect(page.locator('#ce-q')).toBeFocused();
  await expect(options(page)).toHaveCount(7); await expect(page.locator('#ce-target-c')).toHaveText('7 אפשרויות');
  await submit(page).click(); await expect(page.locator('[data-field=target] .ce-fe')).toHaveText('יש לבחור שירות מהרשימה.'); expect(writes).toEqual([]);
  await page.locator('#ce-q').fill('משכנתא'); await expect(options(page)).toHaveCount(2); await expect(page.locator('#ce-target-c')).toHaveText('2 אפשרויות');
  await page.locator('#ce-q').fill('zzz'); await expect(options(page)).toHaveCount(0); await expect(page.locator('#ce-target-c')).toContainText('לא נמצא');
  await page.locator('#ce-q').fill('ייעוץ משכנתא'); await options(page).filter({ hasText: 'ייעוץ משכנתא' }).first().click(); await page.locator('#ce-external_ref').fill('ZZ-01');
  const chosen = await page.locator('#ce-target').inputValue(); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.map((w) => w.method + ' ' + w.path)).toEqual(['POST /catalog/engagements']);
  expect(writes[0].body).toEqual({ provider_id: 16, service_id: Number(chosen), activation: 'pending', external_ref: 'ZZ-01' }); expect(writes.every((w) => w.csrf === '1')).toBe(true);
  expect(await eng(16, Number(chosen))).toEqual({ activation: 'pending', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', pricing_id: null, priority: 100, external_ref: 'ZZ-01', terms_note: null, updated_by: 'yosi@example.test' });
  await expect(body(page).locator('h2').first()).toContainText('ייעוץ משכנתא'); await expect(body(page)).toContainText('ממתין לאישור'); await expect(page.locator('.ce-bar button')).toHaveText(['עדכון מעקב']);
  const rows = await journal(16, Number(chosen)); expect(rows.map((r) => [r.actor, r.action, r.detail])).toEqual([['yosi@example.test', 'catalog.engagement.create', {}], ['yosi@example.test', 'catalog.engagement.submit', { from: 'draft', to: 'pending' }]]);
  await expect(page.locator('#ct-log')).toContainText('יצירת התקשרות'); await expect(page.locator('#ct-log')).toContainText('שליחת התקשרות לאישור'); await expect(page.locator('#ct-log')).toContainText('מצב: טיוטה ← ממתין לאישור');
  expect(Number((await one('SELECT count(*)::int AS n FROM provider_service_prices')).n)).toBe(pricesBefore);   // no price was touched
  expect((await q("SELECT activation FROM provider_services WHERE activation = 'active'")).length).toBe(0);   // and nothing is active
  await body(page).locator('button[data-ct=back]').click(); await ready(page); await expect(body(page)).toContainText('פרטי נותן השירות');   // back goes to the provider
});

test('create from a service card: pick a provider; providers that already have an engagement for the service and providers that are archived or paused are not offered', async ({ page }) => {
  const writes = await open(page);
  await openService(page, 1); await bar(page, 'engage').click(); await expect(dlg(page)).toContainText('שירות: '); await expect(options(page)).toHaveCount(2);   // 14 and 16; not 11 and 15 (they have it), not 12 (paused), not 13 (archived)
  const texts = await options(page).allInnerTexts(); expect(texts.join('|')).not.toContain('נותן שירות ב׳'); expect(texts.join('|')).not.toContain('מושהה'); expect(texts.join('|')).not.toContain('נותן שירות א׳'); expect(texts.join('|')).not.toContain('נותן שירות ג׳');
  await options(page).filter({ hasText: 'נותן שירות ד׳' }).click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes[0].body).toEqual({ provider_id: 14, service_id: 1, activation: 'pending' }); expect((await eng(14, 1)).activation).toBe('pending');
  await expect(body(page).locator('h2').first()).toContainText('נותן שירות ד׳');
  // a provider that has every service already: the list says so
  await q("INSERT INTO provider_services (professional_id, service_id) SELECT 16, id FROM services");
  await openProvider(page, 16); await bar(page, 'engage').click(); await expect(options(page)).toHaveCount(0); await expect(page.locator('#ce-target-c')).toContainText('אין שירותים שאין להם כבר התקשרות');
});

test('a double click, a double Enter and a double submit make exactly one request and one engagement', async ({ page }) => {
  const writes = await open(page);
  await page.route(API + 'engagements', async (route) => { if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).first().click();
  await submit(page).dblclick(); await page.locator('#ce-q').evaluate((el) => { el.form.requestSubmit(); el.form.requestSubmit(); });
  await expect(submit(page)).toBeDisabled(); await expect(dlg(page)).toHaveCount(0, { timeout: 10000 }); await ready(page);
  expect(writes.map((w) => w.method + ' ' + w.path)).toEqual(['POST /catalog/engagements']);
  expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 16')).n)).toBe(1);
});

test('the creation fails because the server is busy: nothing exists (no draft), the form stays with what was typed, one attempt per click, and the second click works', async ({ page }) => {
  const writes = await open(page); let n = 0;
  await page.route(API + 'engagements', (route) => { if (route.request().method() !== 'POST') return route.continue(); n++; return n === 1 ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy_retry', message: 'SELECT secret' }) }) : route.continue(); });
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).first().click(); await page.locator('#ce-external_ref').fill('ZZ-77'); await submit(page).click();
  await expect(dlg(page).locator('.ce-status')).toContainText('המערכת עסוקה'); await expect(dlg(page).locator('.ce-status')).toContainText('לא נשמר דבר'); await expect(dlg(page)).not.toContainText(/busy_retry|SELECT/);
  await expect(page.locator('#ce-external_ref')).toHaveValue('ZZ-77'); await expect(submit(page)).toBeEnabled(); expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 16')).n)).toBe(0);   // no draft
  await page.waitForTimeout(1600); expect(writes.length).toBe(1);   // nothing was sent again by itself
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(2); const row = await one('SELECT service_id::int AS s, activation FROM provider_services WHERE professional_id = 16'); expect(row.activation).toBe('pending'); expect((await journal(16, row.s)).map((r) => r.action)).toEqual(['catalog.engagement.create', 'catalog.engagement.submit']);
});
test('a draft that already exists (made elsewhere): the card offers the step by hand with its own confirmation; an unknown result gives no retry; the second try by hand works', async ({ page }) => {
  const writes = await open(page); let n = 0;
  await page.route(API + 'engagements/*/*/actions/submit', (route) => { n++; return n === 1 ? route.abort('connectionreset') : route.continue(); });
  await openEngagement(page, 11, 2); await expect(page.locator('.ce-bar button')).toHaveText(['עדכון מעקב', 'העברה למצב ממתין לאישור']);
  await bar(page, 'submit').click(); await expect(dlg(page)).toContainText('זו אינה הפעלה'); expect(writes).toEqual([]);   // opening the dialog sends nothing
  await submit(page).click(); const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('לא ידוע אם ההעברה בוצעה'); await expect(panel.locator('[data-ce=again]')).toHaveCount(0);
  await page.waitForTimeout(1500); expect(writes.length).toBe(1);
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page)).toContainText('טיוטה');
  await bar(page, 'submit').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(2); expect(writes[1].body).toEqual({ expected_activation: 'draft' }); await expect(body(page)).toContainText('ממתין לאישור'); expect((await eng(11, 2)).activation).toBe('pending');
});
test('the creation has an unknown result: nothing is sent again, only a check of the state; a refusal with reasons is shown in words, never as codes', async ({ page }) => {
  const writes = await open(page);
  await page.route(API + 'engagements', (route) => route.request().method() === 'POST' ? route.abort('connectionreset') : route.continue());
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).first().click(); await submit(page).click();
  await expect(dlg(page).locator('.ce-panel')).toContainText('לא ידוע אם נשמר'); await expect(dlg(page).locator('.ce-panel')).toContainText('אל תשלחו שוב'); await page.waitForTimeout(1500); expect(writes.length).toBe(1);
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await page.unroute(API + 'engagements');
  await page.route(API + 'engagements', (route) => route.request().method() === 'POST' ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'transition_refused', message: 'SQLSTATE 23514 password=x', errors: ['not_allowed_from_pending', 'transition_not_allowed:pending->draft', 'some_new_rule'], missing: [], documented_only: false }) }) : route.continue());
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).first().click(); await submit(page).click();
  const status = dlg(page).locator('.ce-status');
  await expect(status).toContainText('המעבר אינו מותר במצב הנוכחי'); await expect(status).toContainText('הפעולה אינה מותרת ממצב ״ממתין לאישור״'); await expect(status).toContainText('המעבר ממצב ״ממתין לאישור״ למצב ״טיוטה״ אינו מותר'); await expect(status).toContainText('אינה עומדת בכלל מובנה');
  await expect(dlg(page)).not.toContainText(/SQLSTATE|password|not_allowed|transition_not_allowed|some_new_rule|transition_refused/);
  expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 16')).n)).toBe(0);
});
test('an engagement that appears meanwhile (another admin) is answered "already exists" with a way to open it; a sheet id that is taken is refused at the field; nothing is created twice', async ({ page }) => {
  const writes = await open(page);
  await openProvider(page, 16); await bar(page, 'engage').click(); await expect(options(page)).toHaveCount(7);
  const target = await options(page).first().getAttribute('value'); await options(page).first().click();
  await q('INSERT INTO provider_services (professional_id, service_id) VALUES (16, $1::bigint)', [target]);   // another admin was faster
  await submit(page).click(); const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('ההתקשרות כבר קיימת'); await expect(panel).toContainText('לא נוצר דבר'); expect(writes.length).toBe(1);
  await panel.locator('[data-ce=open]').click(); await ready(page); await expect(dlg(page)).toHaveCount(0); await expect(body(page)).toContainText('מה חסר כדי שההתקשרות תהיה פעילה'); expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 16')).n)).toBe(1);
  // a taken sheet id
  const before = Number((await one('SELECT count(*)::int AS n FROM provider_services')).n);
  await openProvider(page, 14); await bar(page, 'engage').click(); await options(page).first().click(); await page.locator('#ce-external_ref').fill('DEMO-01'); await submit(page).click();
  await expect(page.locator('[data-field=external_ref] .ce-fe')).toHaveText('המזהה מהגיליון כבר בשימוש.'); await expect(page.locator('#ce-external_ref')).toBeFocused(); await expect(dlg(page)).toBeVisible();
  expect(Number((await one('SELECT count(*)::int AS n FROM provider_services')).n)).toBe(before);
});

test('tracking: only the changed fields are sent with what was seen; the note stays out of the journal; the journal and the page say what moved, in words; "no change" and a bad priority send nothing', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 11, 2); await bar(page, 'edit').click();
  await expect(dlg(page)).toContainText('אין בכך הפעלה'); await expect(page.locator('#ce-contact_state')).toHaveValue('contacted'); await expect(page.locator('#ce-agreement_state')).toHaveValue('not_discussed'); await expect(page.locator('#ce-priority')).toHaveValue('100'); await expect(page.locator('#ce-contact_state option')).toHaveText(['אין קשר', 'נוצר קשר', 'במשא ומתן', 'שיתוף פעולה פעיל', 'הופסק']);
  await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toHaveText('לא בוצע שינוי, ולכן אין מה לשמור.'); expect(writes).toEqual([]);
  for (const bad of ['-1', 'abc', '10001', '1.5', '']) { await page.locator('#ce-priority').evaluate((el, v) => { el.value = v; }, bad); await submit(page).click(); await expect(page.locator('[data-field=priority] .ce-fe')).toHaveText('העדיפות חייבת להיות מספר שלם בין 0 ל־10000.'); }
  expect(writes).toEqual([]);
  await page.locator('#ce-contact_state').selectOption('negotiating'); await page.locator('#ce-priority').fill('90'); await page.locator('#ce-terms_note').fill('שוחחנו ביום ראשון, ההערה הזו נשארת בכרטיס'); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'PATCH', path: '/catalog/engagements/11/2' });
  expect(writes[0].body).toEqual({ changes: { contact_state: 'negotiating', terms_note: 'שוחחנו ביום ראשון, ההערה הזו נשארת בכרטיס', priority: 90 }, expected: { contact_state: 'contacted', terms_note: null, priority: 100 } });
  expect(await eng(11, 2)).toMatchObject({ activation: 'draft', contact_state: 'negotiating', agreement_state: 'not_discussed', priority: 90, terms_note: 'שוחחנו ביום ראשון, ההערה הזו נשארת בכרטיס', updated_by: 'yosi@example.test' });
  const last = (await journal(11, 2)).pop(); expect(last.action).toBe('catalog.engagement.update'); expect(last.detail.to).toEqual({ contact_state: 'negotiating', priority: 90 }); expect(last.detail.from).toEqual({ contact_state: 'contacted', priority: 100 }); expect(JSON.stringify(last)).not.toContain('שוחחנו ביום ראשון');
  await expect(page.locator('#ct-log')).toContainText('מצב קשר: נוצר קשר ← במשא ומתן'); await expect(page.locator('#ct-log')).toContainText('עדיפות: 100 ← 90'); await expect(page.locator('#ct-log')).not.toContainText('שוחחנו ביום ראשון');
  await expect(body(page)).toContainText('שוחחנו ביום ראשון');   // the card shows the note
});

test('"signed" is a report: the person is asked first; going back sends nothing; confirming saves it, and the engagement stays what it was (pending, not active)', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await expect(body(page)).toContainText('ממתין לאישור'); await bar(page, 'edit').click();
  await page.locator('#ce-agreement_state').selectOption('signed'); await submit(page).click();
  const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('רישום ״חתום״ הוא דיווח שלכם'); await expect(panel).toContainText('המערכת אינה מאמתת שההסכם נחתם'); await expect(panel).toContainText('ההפעלה אינה זמינה בשלב זה'); expect(writes).toEqual([]);
  await panel.locator('[data-ce=keep]').click(); await expect(page.locator('#ce-agreement_state')).toHaveValue('signed'); expect(writes).toEqual([]);
  await submit(page).click(); await dlg(page).locator('.ce-panel [data-ce=go]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0].body).toEqual({ changes: { agreement_state: 'signed' }, expected: { agreement_state: 'draft' } });
  expect(await eng(15, 1)).toMatchObject({ activation: 'pending', agreement_state: 'signed' }); await expect(body(page)).toContainText('חתום'); await expect(page.locator('#ct-log')).toContainText('מצב הסכם: טיוטת הסכם ← חתום');
  await expect(body(page)).toContainText('חסרים'); expect((await q("SELECT activation FROM provider_services WHERE activation = 'active'")).length).toBe(0);
});

test('another admin changed the engagement meanwhile: nothing is overwritten, the states are shown in words, and the person applies their own change on top only on purpose', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 11, 2); await bar(page, 'edit').click(); await page.locator('#ce-contact_state').selectOption('negotiating'); await page.locator('#ce-terms_note').fill('שלי');
  await q("UPDATE provider_services SET contact_state = 'stopped', terms_note = 'של אבי' WHERE professional_id = 11 AND service_id = 2");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.engagement.update', 'engagement', '11/2', '{\"fields\":[\"contact_state\"]}')");
  await submit(page).click(); const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('הנתון השתנה מאז שצפיתם בו'); await expect(panel).toContainText('avi@example.test'); await expect(panel).toContainText('מצב קשר'); await expect(panel).toContainText('נוצר קשר'); await expect(panel).toContainText('הופסק'); await expect(panel).toContainText('במשא ומתן'); await expect(panel).not.toContainText(/contacted|stopped|negotiating/);
  await expect(panel).toContainText('לא נשמר דבר'); expect(writes.length).toBe(1); expect((await eng(11, 2)).contact_state).toBe('stopped');
  await panel.locator('[data-ce=reapply]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(2); expect(writes[1].body).toEqual({ changes: { contact_state: 'negotiating', terms_note: 'שלי' }, expected: { contact_state: 'stopped', terms_note: 'של אבי' } });
  expect(await eng(11, 2)).toMatchObject({ contact_state: 'negotiating', terms_note: 'שלי' });
});

test('everything sent from the engagement screens is one of the three allowed requests with the anti-forgery header; no action other than "submit"; no other engagement changes state; no price, import or activation', async ({ page }) => {
  const writes = await open(page); const activations = () => q('SELECT professional_id, service_id, activation FROM provider_services ORDER BY 1, 2');
  const before = await activations();
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).first().click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await bar(page, 'edit').click(); await page.locator('#ce-contact_state').selectOption('contacted'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await openEngagement(page, 11, 2); await bar(page, 'submit').click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  const allowed = [/^POST \/catalog\/engagements$/, /^PATCH \/catalog\/engagements\/\d+\/\d+$/, /^POST \/catalog\/engagements\/\d+\/\d+\/actions\/submit$/];
  expect(writes.length).toBe(3); for (const w of writes) { expect(allowed.some((re) => re.test(w.method + ' ' + w.path))).toBe(true); expect(w.csrf).toBe('1'); }
  expect(writes.map((w) => w.method + ' ' + w.path)).not.toEqual(expect.arrayContaining([expect.stringMatching(/pause|retire|withdraw|activate|resume|prices|imports/)]));
  const after = await activations(), was = Object.fromEntries(before.map((a) => [a.professional_id + '/' + a.service_id, a.activation]));
  const changed = after.filter((a) => was[a.professional_id + '/' + a.service_id] !== a.activation).map((a) => a.professional_id + '/' + a.service_id);
  expect(changed.sort()).toEqual(['11/2', '16/' + (await one('SELECT service_id::text AS s FROM provider_services WHERE professional_id = 16')).s].sort());   // only the two that became pending
  expect((await q("SELECT activation FROM provider_services WHERE activation IN ('active', 'paused', 'retired') AND NOT (professional_id IN (12, 13))")).length).toBe(0);
});

test('typed text is shown as text, never as markup (the other admin\'s value in the conflict table, the note on the card); the dialog is accessible and fits the screen', async ({ page }) => {
  await open(page);
  await openEngagement(page, 11, 2); await bar(page, 'edit').click(); await page.locator('#ce-terms_note').fill('שלי');
  await q('UPDATE provider_services SET terms_note = $1 WHERE professional_id = 11 AND service_id = 2', ['<script>window.__xss=1</script><img src=x onerror="window.__xss=2">']);
  await submit(page).click(); await expect(dlg(page).locator('.ce-panel')).toContainText('<script>window.__xss=1</script>'); expect(await page.evaluate(() => window.__xss)).toBeUndefined(); await expect(dlg(page).locator('.ce-panel img, .ce-panel script')).toHaveCount(0);
  await dlg(page).locator('.ce-panel [data-ce=refresh]').click(); await ready(page); await expect(body(page)).toContainText('<script>window.__xss=1</script>'); await expect(body(page).locator('img, script')).toHaveCount(0); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  // the creation dialog: labelled, focus kept inside, fits the screen, big enough buttons
  await openProvider(page, 16); await bar(page, 'engage').click();
  await expect(dlg(page)).toHaveAttribute('aria-modal', 'true'); await expect(page.locator('label[for=ce-target]')).toBeVisible(); await expect(page.locator('#ce-target')).toHaveAttribute('aria-describedby', /ce-target-c/); await expect(page.locator('#ce-target-c')).toHaveAttribute('aria-live', 'polite');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  const m = await page.evaluate(() => { const f = document.querySelector('.ce-form').getBoundingClientRect(); return { right: f.right, left: f.left, w: innerWidth, h: innerHeight, bottom: f.bottom, sw: document.documentElement.scrollWidth }; });
  expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(m.w + 1); expect(m.bottom).toBeLessThanOrEqual(m.h + 1); expect(m.sw).toBeLessThanOrEqual(m.w);
  for (const b of await dlg(page).locator('button').all()) { const box = await b.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(40); }
});

test('stale data: a provider archived or paused after the list was loaded is refused by the server in words, nothing is created, and another choice can be made', async ({ page }) => {
  const writes = await open(page);
  await openService(page, 1); await bar(page, 'engage').click(); await expect(options(page)).toHaveCount(2);   // 14 and 16
  await q('INSERT INTO provider_profiles (professional_id, archived_at) VALUES (14, now()) ON CONFLICT (professional_id) DO UPDATE SET archived_at = now()');
  await options(page).filter({ hasText: 'נותן שירות ד׳' }).click(); await submit(page).click();
  await expect(dlg(page).locator('.ce-status')).toContainText('נותן השירות בארכיון'); await expect(dlg(page)).toBeVisible(); expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 14')).n)).toBe(0);
  await q("UPDATE provider_profiles SET archived_at = NULL, paused_until = now() + interval '5 days' WHERE professional_id = 14");
  await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toContainText('נותן השירות מושהה'); await expect(dlg(page).locator('.ce-status')).toContainText('עד שיחזור לזמינות');
  expect(writes.length).toBe(2); expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 14')).n)).toBe(0); expect((await q("SELECT 1 FROM audit_log WHERE action LIKE 'catalog.engagement.%' AND entity_id LIKE '14/%'")).length).toBe(0);
  await options(page).filter({ hasText: 'נותן שירות ו׳' }).click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect((await eng(16, 1)).activation).toBe('pending');
});

test('a service that is switched off or lacks its settings: a PENDING engagement is allowed, and the card says the service is not ready for activation (a marker, not an activation)', async ({ page }) => {
  await open(page);
  await openProvider(page, 16); await bar(page, 'engage').click(); await options(page).filter({ hasText: 'ייעוץ פנסיוני' }).click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await expect(body(page)).toContainText('השירות אינו מוכן להפעלה'); await expect(body(page)).toContainText('אין לשירות הגדרות (קוד שירות)'); await expect(body(page)).toContainText('ההפעלה אינה זמינה במסכים האלה');
  expect((await eng(16, 4)).activation).toBe('pending'); expect(await one('SELECT active FROM services WHERE id = 4')).toEqual({ active: false });   // switched off, still pending, nothing switched on
  await q("INSERT INTO service_settings (service_id, code) VALUES (7, 'svc-7')");   // settings without a tag or a topic
  await openProvider(page, 14); await bar(page, 'engage').click(); await options(page).filter({ hasText: 'שירות ללא נותן שירות' }).click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await expect(body(page)).toContainText('השירות אינו מוכן להפעלה'); await expect(body(page)).toContainText('אין תגי ממצאים או תחומי שאלון להתאמה'); await expect(body(page)).not.toContainText('אין לשירות הגדרות');
  await openProvider(page, 14); await bar(page, 'engage').click(); await options(page).filter({ hasText: 'בדיקת זכאות להחזר מס' }).click(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);   // a service that is set up
  await expect(body(page)).not.toContainText('השירות אינו מוכן להפעלה'); expect((await q("SELECT activation FROM provider_services WHERE activation = 'active'")).length).toBe(0);
});

test('the same pair created three times at the same moment: one becomes PENDING, the others are told it exists, and the journal has one pair of rows', async ({ page }) => {
  await open(page);
  const out = await page.evaluate(async () => { const go = () => fetch('/api/kaspchem/admin/catalog/engagements', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Kaspchem': '1', 'x-test-user': 'yosi@example.test|admin' }, body: JSON.stringify({ provider_id: 16, service_id: 2, activation: 'pending' }) }).then(async (r) => [r.status, (await r.json()).error || 'ok']); return Promise.all([go(), go(), go()]); });
  expect(out.map((x) => x.join(':')).sort()).toEqual(['200:ok', '409:engagement_exists', '409:engagement_exists']);
  expect(Number((await one('SELECT count(*)::int AS n FROM provider_services WHERE professional_id = 16')).n)).toBe(1); expect((await eng(16, 2)).activation).toBe('pending'); expect((await journal(16, 2)).map((r) => r.action)).toEqual(['catalog.engagement.create', 'catalog.engagement.submit']);
});
