// Catalog admin screens, stage 5a (READ ONLY), in a real browser (desktop and phone projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page and the real function code on an in-memory Postgres with invented "[דמו]" data. Nothing here touches Neon or any network.
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4182, BASE = 'http://localhost:' + PORT;
const SECRETS = ['31337', '41414', '77.77', 'PAYER-SECRET', 'NOTE-SECRET'];
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });
test.beforeEach(async () => { await demo.setMode('full'); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading'));
async function open(page, screen) {
  const calls = []; page.on('request', (r) => { if (r.url().includes('/api/')) { const u = new URL(r.url()); calls.push(r.method() + ' ' + u.pathname + u.search); } });
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  if (screen) await nav(page, screen);
  return calls;
}
async function nav(page, screen) { await page.locator('.ct-nav button', { hasText: screen }).click(); await ready(page); }
const rows = (page) => page.locator('#ct-res tbody tr');
const body = (page) => page.locator('#ct-body');

test('every request is a GET to the admin API: the screens never send, save or change anything', async ({ page }) => {
  const calls = await open(page);
  for (const s of ['נותני שירות', 'שירותים', 'התקשרויות', 'היסטוריית ייבוא', 'יומן שינויים', 'סקירה']) await nav(page, s);
  await nav(page, 'נותני שירות'); await page.locator('button[data-ct=open-provider][data-id="11"]').click(); await ready(page);
  await page.locator('button[data-ct=open-eng]').first().click(); await ready(page);
  await page.locator('button[data-ct=open-service]').first().click(); await ready(page);
  expect(calls.length).toBeGreaterThan(8);
  expect(calls.filter((c) => !c.startsWith('GET '))).toEqual([]);
  expect(calls.filter((c) => !/^GET \/api\/kaspchem\/admin\/(me|questionnaires|stats|catalog\/)/.test(c))).toEqual([]);
  expect(calls.some((c) => c.includes('/catalog/engagements?') && c.includes('limit=200'))).toBe(true);
});

test('overview: the counts of the demo catalog, and a link from a state to its list', async ({ page }) => {
  await open(page);
  await expect(body(page)).toContainText('שירותים (4 פעילים, 4 ללא אישור מדווח)'); await expect(body(page)).toContainText('נותני שירות (1 מושהים, 1 בארכיון)');
  await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('סקירה');
  await body(page).locator('button[data-act=pending]').click(); await ready(page);
  await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('התקשרויות');
  await expect(rows(page)).toHaveCount(3); await expect(page.locator('#ct-ac')).toHaveValue('pending');
});

test('providers: search, state filter, clear, detail, a provider without services, a provider without a profile, back keeps the filter', async ({ page }) => {
  await open(page, 'נותני שירות');
  await expect(rows(page)).toHaveCount(6); await expect(page.locator('#ct-count')).toHaveText('6 נותני שירות');
  await page.locator('#ct-q').fill('ה׳'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('נותן שירות ה׳');
  await page.locator('#ct-q').fill('משרד לדוגמה ג'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('בארכיון');
  await page.locator('#ct-q').fill('zzz-nothing'); await expect(body(page)).toContainText('לא נמצאו נותני שירות');
  await body(page).locator('button[data-ct=clear]').click(); await ready(page); await expect(rows(page)).toHaveCount(6); await expect(body(page).locator('.ct-clear')).toBeHidden();
  await page.locator('#ct-st').selectOption('paused'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('מושהה'); await expect(body(page).locator('.ct-clear')).toBeVisible();
  await body(page).locator('button[data-ct=open-provider]').click(); await ready(page);
  await expect(body(page)).toContainText('נותן שירות ב׳'); await expect(body(page)).toContainText('050-0000002'); await expect(body(page)).toContainText('בדיקת תלוש שכר');
  await body(page).locator('button[data-ct=back]').click(); await ready(page);
  await expect(page.locator('#ct-st')).toHaveValue('paused'); await expect(rows(page)).toHaveCount(1);
  await body(page).locator('button[data-ct=clear]').click(); await ready(page);
  await body(page).locator('button[data-ct=open-provider][data-id="16"]').click(); await ready(page); await expect(body(page)).toContainText('אין שירותים משויכים עדיין');
  await body(page).locator('button[data-ct=back]').click(); await ready(page);
  await body(page).locator('button[data-ct=open-provider][data-id="14"]').click(); await ready(page);
  await expect(body(page).locator('.ct-unset').first()).toHaveText('לא הוזן'); await expect(body(page)).toContainText('דרך פורטל');
  await expect(body(page)).not.toContainText(/null|undefined/);
});

test('opening a provider card records exactly one audit row (who and which provider, no contact detail): the one write the server does for a read, by design', async ({ page }) => {
  await open(page, 'נותני שירות');
  const before = Number((await demo.pg.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.provider.view'")).rows[0].n);
  await body(page).locator('button[data-ct=open-provider][data-id="11"]').click(); await ready(page);
  const after = (await demo.pg.query("SELECT detail::text AS d, actor FROM audit_log WHERE action = 'catalog.provider.view'")).rows;
  expect(after.length).toBe(before + 1); expect(after[0].d).toBe('{}'); expect(after[0].d + after[0].actor).not.toMatch(/050-|demo-a@/);
  await nav(page, 'נותני שירות'); await expect(rows(page)).toHaveCount(6);   // the list itself writes nothing
  expect(Number((await demo.pg.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.provider.view'")).rows[0].n)).toBe(before + 1);
});

test('services: topic and state filters, detail with the clearance and the providers, a service without providers', async ({ page }) => {
  await open(page, 'שירותים');
  await expect(rows(page)).toHaveCount(7);
  await page.locator('#ct-tp').selectOption('mortgage'); await expect(rows(page)).toHaveCount(2);
  await page.locator('#ct-ac').selectOption('true'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('ייעוץ משכנתא');
  await body(page).locator('button[data-ct=clear]').click(); await ready(page); await expect(rows(page)).toHaveCount(7);
  await page.locator('#ct-q').fill('החזר מס'); await expect(rows(page)).toHaveCount(1);
  await body(page).locator('button[data-ct=open-service]').click(); await ready(page);
  await expect(body(page)).toContainText('מסים והחזרים'); await expect(body(page)).toContainText('הצעה לציבור חסומה בשלב זה'); await expect(body(page)).toContainText('אישור מדווח');
  await expect(body(page).locator('.panel').filter({ hasText: 'נותני שירות משויכים' }).locator('tbody tr')).toHaveCount(2); await expect(page.locator('#ct-log')).toContainText('אישור משפטי של שירות');   // the providers of the service (the change log under the card has its own table)
  await body(page).locator('button[data-ct=back]').click(); await ready(page); await body(page).locator('button[data-ct=clear]').click(); await ready(page);
  await page.locator('#ct-q').fill('ללא נותן שירות'); await expect(rows(page)).toHaveCount(1); await body(page).locator('button[data-ct=open-service]').click(); await ready(page);
  await expect(body(page)).toContainText('אין נותני שירות לשירות הזה עדיין');
  // two services with a near-identical name point at each other
  await nav(page, 'שירותים'); await expect(page.locator('#ct-q')).toHaveValue('ללא נותן שירות');   // the filter of a screen is remembered while the tab is open
  await page.locator('#ct-q').fill('משכנתאות'); await expect(rows(page).first()).toContainText('ייעוץ משכנתאות'); await expect(rows(page)).toHaveCount(1); await body(page).locator('button[data-ct=open-service]').click(); await ready(page);
  await expect(body(page)).toContainText('שירותים בשם דומה');
});

test('engagements: the server filters by state, the page filters by text, contact and agreement; detail shows the checklist and the four kinds of price', async ({ page }) => {
  await open(page, 'התקשרויות');
  await expect(rows(page)).toHaveCount(7);
  await page.locator('#ct-ac').selectOption('pending'); await expect(rows(page)).toHaveCount(3);
  await page.locator('#ct-ct').selectOption('negotiating'); await expect(rows(page)).toHaveCount(2); await expect(page.locator('#ct-count')).toHaveText('2 התקשרויות מתוך 3');
  await page.locator('#ct-q').fill('נותן שירות ה'); await expect(rows(page)).toHaveCount(1);
  await body(page).locator('button[data-ct=clear]').click(); await ready(page); await expect(rows(page)).toHaveCount(7);
  await page.locator('#ct-md').selectOption('fixed'); await expect(rows(page)).toHaveCount(2); await page.locator('#ct-ag').selectOption('draft'); await expect(rows(page)).toHaveCount(2);
  await page.locator('#ct-ag').selectOption('signed'); await expect(body(page)).toContainText('לא נמצאו התקשרויות');
  await body(page).locator('button[data-ct=clear]').click(); await ready(page);
  await body(page).locator('button[data-ct=open-eng][data-p="11"][data-s="1"]').click(); await ready(page);
  await expect(body(page).locator('.ct-price h3')).toHaveText(['מחיר שוק', 'מחיר מתועד', 'מחיר מאושר', 'מחיר ציבורי']);
  await expect(body(page).locator('.ct-price-approved')).toContainText('מקושר, לא אושר'); await expect(body(page).locator('.ct-price-public')).toContainText('לא מוצג לציבור'); await expect(body(page).locator('.ct-price-market')).toContainText('1,100');
  await expect(body(page).locator('.ct-price-doc')).toContainText('ממתין לתשובה'); await expect(body(page)).toContainText('חסרים 3 תנאים'); await expect(body(page).locator('.ct-ck.no')).toHaveCount(4); await expect(body(page).locator('.ct-ck.ok')).toHaveCount(3);
  await body(page).locator('button[data-ct=open-provider]').click(); await ready(page); await expect(body(page)).toContainText('פרטי נותן השירות');
  await body(page).locator('button[data-ct=back]').click(); await ready(page);
  await body(page).locator('button[data-ct=open-service]').click(); await ready(page); await expect(body(page)).toContainText('פרטי השירות');
  await body(page).locator('button[data-ct=back]').click(); await ready(page); await body(page).locator('button[data-ct=back]').click(); await ready(page);
  await expect(rows(page)).toHaveCount(7);
  await body(page).locator('button[data-ct=open-eng][data-p="15"][data-s="1"]').click(); await ready(page);
  await expect(body(page).locator('.ct-price-approved')).toContainText('מאושר'); await expect(body(page).locator('.ct-price-public')).toContainText('מאושר לשימוש פנימי בלבד'); await expect(body(page).locator('.ct-price-public')).not.toContainText('מוצג באתר');
  await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="12"][data-s="3"]').click(); await ready(page);
  await expect(body(page)).toContainText('ממתין להבהרות מהספק'); await expect(body(page).locator('.ct-price-doc')).toContainText('הצעת מחיר לפי מורכבות');
  await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="13"][data-s="5"]').click(); await ready(page);
  await expect(body(page)).toContainText('הוצא משימוש'); await expect(body(page)).toContainText('הספק פרש'); await expect(body(page).locator('.ct-price-doc')).toContainText('לא תועד מחיר');
});

test('a public price is shown only in the fourth card (the demo has none, so the answer is changed in the test)', async ({ page }) => {
  await page.route('**/api/kaspchem/admin/catalog/engagements/15/1', async (route) => { const res = await route.fetch(); const j = await res.json(); j.approved_price.public = true; await route.fulfill({ response: res, json: j }); });
  await open(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="15"][data-s="1"]').click(); await ready(page);
  await expect(body(page).locator('.ct-price-public')).toContainText('מוצג באתר'); await expect(body(page).locator('.ct-price-approved')).not.toContainText('מוצג באתר'); await expect(body(page).locator('.ct-price-market')).not.toContainText('מוצג באתר');
});

test('import history and change log', async ({ page }) => {
  await open(page, 'היסטוריית ייבוא');
  await expect(body(page).locator('tbody tr')).toHaveCount(2); await expect(body(page)).toContainText('2 בעיות'); await body(page).locator('details summary').first().click();
  await expect(body(page)).toContainText('המחיר אינו מספר'); await expect(body(page)).toContainText('התקשרות כפולה בקובץ');
  await nav(page, 'יומן שינויים'); await expect(rows(page)).toHaveCount(5);
  await page.locator('#ct-en').selectOption('provider'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('עדכון נותן שירות');
  await page.locator('#ct-en').selectOption('catalog_import'); await expect(rows(page)).toHaveCount(2);
});

test('paging: fifty to a page from the server for providers and services, and from the loaded list for engagements', async ({ page }) => {
  await demo.setMode('big');
  await open(page, 'נותני שירות');
  await expect(rows(page)).toHaveCount(50); await expect(body(page).locator('.ct-pager')).toContainText('1–50 מתוך 130'); await expect(body(page).locator('button[data-d="-1"]')).toHaveCount(0);
  await body(page).locator('button[data-d="1"]').click(); await ready(page); await expect(body(page).locator('.ct-pager')).toContainText('51–100 מתוך 130'); await expect(rows(page).first()).toContainText('נותן שירות 051');
  await body(page).locator('button[data-d="1"]').click(); await ready(page); await expect(rows(page)).toHaveCount(30); await expect(body(page).locator('button[data-d="1"]')).toHaveCount(0);
  await nav(page, 'התקשרויות'); await expect(rows(page)).toHaveCount(50); await expect(body(page).locator('.ct-pager')).toContainText('1–50 מתוך 260');
  await page.locator('#ct-q').fill('נותן שירות 130'); await expect(rows(page)).toHaveCount(2); await expect(body(page).locator('.ct-pager')).toHaveCount(0);
});

test('states: an empty catalog, a closed catalog, a server error with a retry that works, no permission, no connection, an expired session', async ({ page }) => {
  await demo.setMode('empty'); await open(page); await expect(body(page)).toContainText('הקטלוג ריק');
  for (const [s, t] of [['נותני שירות', 'אין נותני שירות'], ['שירותים', 'אין שירותים'], ['התקשרויות', 'אין התקשרויות'], ['היסטוריית ייבוא', 'עדיין לא בוצע ייבוא'], ['יומן שינויים', 'אין רישומים']]) { await nav(page, s); await expect(body(page)).toContainText(t); }
  await demo.setMode('closed'); await open(page); await expect(body(page)).toContainText('הקטלוג כבוי'); await expect(body(page)).toContainText('לא מוצגים כאן נתונים'); await expect(body(page).locator('.ct-nav, .stat, table')).toHaveCount(0);
  await demo.setMode('full'); await body(page).locator('button[data-ct=retry]').click(); await ready(page); await expect(body(page)).toContainText('שירותים (4 פעילים');
  await demo.setMode('fault'); await nav(page, 'נותני שירות'); await expect(body(page)).toContainText('אירעה שגיאה בשרת'); await expect(body(page)).toContainText('לא נשמר ולא שונה דבר');
  await demo.setMode('full'); await body(page).locator('button[data-ct=retry]').click(); await ready(page); await expect(rows(page)).toHaveCount(6);
  await page.route('**/api/kaspchem/admin/catalog/services?*', (r) => r.fulfill({ status: 403, contentType: 'application/json', body: '{"ok":false,"error":"forbidden"}' }));
  await nav(page, 'שירותים'); await expect(body(page)).toContainText('אין הרשאה'); await expect(body(page).locator('button[data-ct=retry]')).toHaveCount(0); await page.unroute('**/api/kaspchem/admin/catalog/services?*');
  await page.route('**/api/kaspchem/admin/catalog/imports**', (r) => r.abort());
  await nav(page, 'היסטוריית ייבוא'); await expect(body(page)).toContainText('אין חיבור לשרת'); await page.unroute('**/api/kaspchem/admin/catalog/imports**');
  await page.route('**/api/kaspchem/admin/catalog/history**', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"unauthenticated"}' }));
  await page.locator('.ct-nav button', { hasText: 'יומן שינויים' }).click();   // (not nav(): after the login screen takes over there is no catalog left to wait for)
  await expect(page.locator('#view')).toContainText('פג תוקף ההתחברות'); await expect(page.locator('#ct-root')).toHaveCount(0);
});

test('a stranger who is not on the administrators list never reaches the catalog (the existing login screen answers)', async ({ page }) => {
  await page.goto(BASE + '/admin/kaspchem/?test=stranger@example.test|admin');
  await expect(page.locator('#view')).toContainText('אין לחשבון הזה הרשאת מנהל'); await expect(page.locator('#ct-root')).toHaveCount(0);
  expect((await page.request.get(BASE + '/api/kaspchem/admin/catalog/overview', { headers: { 'x-test-user': 'stranger@example.test|admin' } })).status()).toBe(403);
  expect((await page.request.get(BASE + '/api/kaspchem/admin/catalog/overview')).status()).toBe(401);
});

test('no cost, commission, compensation or note secret reaches any answer or any screen', async ({ page }) => {
  const answers = []; page.on('response', async (r) => { if (r.url().includes('/catalog/')) answers.push(await r.text().catch(() => '')); });
  await open(page);
  for (const s of ['נותני שירות', 'שירותים', 'התקשרויות', 'היסטוריית ייבוא', 'יומן שינויים']) await nav(page, s);
  for (const [p, sv] of [['11', '1'], ['15', '1'], ['12', '3']]) { await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="' + p + '"][data-s="' + sv + '"]').click(); await ready(page); }
  await page.locator('button[data-ct=open-provider]').click(); await ready(page);
  const dom = await page.locator('#view').innerHTML();
  expect(answers.length).toBeGreaterThan(8);
  for (const s of SECRETS) { expect(answers.join('')).not.toContain(s); expect(dom).not.toContain(s); }
  expect(answers.join('')).not.toMatch(/"(commission|compensation|cost|payer_note)/i);
});

test('data is shown as text, never run: a provider named like an HTML tag', async ({ page }) => {
  await demo.pg.query("INSERT INTO professionals (name) VALUES ($1)", ['<img src=x onerror="window.__xss=1"> & "q"']);
  await open(page, 'נותני שירות');
  await expect(body(page)).toContainText('<img src=x onerror="window.__xss=1"> & "q"');
  expect(await page.locator('#ct-root img').count()).toBe(0); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('no screen scrolls sideways, at either width', async ({ page }) => {
  await open(page);
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const seen = [];
  for (const s of ['סקירה', 'נותני שירות', 'שירותים', 'התקשרויות', 'היסטוריית ייבוא', 'יומן שינויים']) { await nav(page, s); seen.push([s, await wide()]); }
  await nav(page, 'נותני שירות'); await body(page).locator('button[data-ct=open-provider][data-id="11"]').click(); await ready(page); seen.push(['provider', await wide()]);
  await nav(page, 'שירותים'); await body(page).locator('button[data-ct=open-service]').first().click(); await ready(page); seen.push(['service', await wide()]);
  await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="11"][data-s="1"]').click(); await ready(page); seen.push(['engagement', await wide()]);
  for (const [s, w] of seen) expect(w, s + ' is ' + w + 'px wider than the window').toBeLessThanOrEqual(1);
});

test('keyboard: the screens are reachable with Tab, Enter opens a record, the heading takes focus, Escape is not needed', async ({ page }) => {
  await open(page, 'נותני שירות');
  const link = body(page).locator('button[data-ct=open-provider]').first(); await link.focus(); await expect(link).toBeFocused(); await page.keyboard.press('Enter'); await ready(page);
  await expect(page.locator('#ct-h')).toBeFocused(); await expect(page.locator('#ct-h')).toContainText('נותן שירות');
  await page.locator('button[data-ct=back]').focus(); await page.keyboard.press('Enter'); await ready(page); await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('נותני שירות');
});

test('the existing tabs are untouched and the catalog tab can be left and entered again', async ({ page }) => {
  await open(page);
  await page.locator('#tabs button[data-t=services]').click(); await expect(page.locator('#view h1')).toHaveText('קטלוג שירותים'); await expect(page.locator('#view table.tbl tbody tr')).toHaveCount(7); await expect(page.locator('#view #sf')).toBeVisible();   // the old tab still has its own add form
  await page.locator('#tabs button[data-t=pricing]').click(); await expect(page.locator('#view h1')).toHaveText('תמחור');
  await page.locator('#tabs button[data-t=pros]').click(); await expect(page.locator('#view h1')).toHaveText('בעלי מקצוע');
  await page.locator('#tabs button[data-t=catalog]').click(); await ready(page); await expect(page.locator('#ct-root h1')).toHaveText('קטלוג ספקים'); await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('סקירה');
  await expect(page.locator('#ct-root .ct-ro')).toHaveText('צפייה ועריכה'); await expect(page.locator('#ct-root form:not(.ct-filters), #ct-root input[type=submit], #ct-root textarea')).toHaveCount(0);
});

test('smoke of the older admin screens: all nine open in order, each with its own heading and without a JavaScript error; the catalog tab sits between "pros" and "settings"', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  expect(await page.locator('#tabs button').evaluateAll((bs) => bs.map((b) => b.dataset.t))).toEqual(['dash', 'requests', 'impact', 'forms', 'services', 'pricing', 'pros', 'catalog', 'settings', 'audit', 'out']);
  for (const [key, heading] of [['dash', 'סקירה'], ['requests', 'בקשות טיפול'], ['impact', 'השפעה'], ['forms', 'עריכת שאלונים'], ['services', 'קטלוג שירותים'], ['pricing', 'תמחור'], ['pros', 'בעלי מקצוע'], ['settings', 'הגדרות'], ['audit', 'יומן שינויים']]) {
    await page.locator('#tabs button[data-t=' + key + ']').click();
    await expect(page.locator('#view h1').first(), key).toHaveText(heading); await expect(page.locator('#tabs button[aria-current=page]')).toHaveAttribute('data-t', key);
    await expect(page.locator('#view')).not.toContainText(/undefined|\[object|NaN/);
    if (key === 'settings') await expect(page.locator('#view #dp-panel')).toBeVisible();   // the settings screen still has its readiness panel
  }
  expect(errors).toEqual([]);
});

test('the older services and providers screens: while the catalog is open a change is refused with a clear notice that points at the catalog and nothing is saved; with the catalog closed they work exactly as before', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const n = async (t) => Number((await demo.pg.query('SELECT count(*)::int AS n FROM ' + t)).rows[0].n);
  const flags = async () => JSON.stringify((await demo.pg.query('SELECT id, name, topic, active FROM services ORDER BY id')).rows);
  await open(page);   // the demo opens with the catalog switch open
  const services0 = await n('services'), pros0 = await n('professionals'), flags0 = await flags(), audit0 = await n('audit_log');
  await page.locator('#tabs button[data-t=services]').click(); await expect(page.locator('#view h1')).toHaveText('קטלוג שירותים');
  await page.locator('#sn').fill('שירות מהלשונית הישנה'); await page.locator('#sf button').click();
  await expect(page.locator('#mic')).toBeVisible(); await expect(page.locator('#mic')).toContainText('העריכה כאן הועברה לקטלוג הספקים'); await expect(page.locator('#mic')).toContainText('לא נשמר דבר'); await expect(page.locator('#mic')).toHaveAttribute('role', 'alert');
  expect(await n('services')).toBe(services0);
  await page.locator('#view button[data-a]').first().click(); await expect(page.locator('#mic')).toBeVisible(); expect(await flags()).toBe(flags0);   // the switch-off / switch-on button of a service is refused as well
  expect(await page.locator('#mic').count(), 'one notice, not a pile of them').toBe(1);
  await page.locator('#tabs button[data-t=pros]').click(); await page.locator('#pn').fill('ספק מהלשונית הישנה'); await page.locator('#pf button').click();
  await expect(page.locator('#mic')).toContainText('העריכה כאן הועברה לקטלוג הספקים'); expect(await n('professionals')).toBe(pros0);
  expect(await n('audit_log'), 'a refused change leaves no audit row of a change (only the provider cards opened would)').toBe(audit0);
  await page.locator('#mic-go').click(); await ready(page); await expect(page.locator('#ct-root h1')).toHaveText('קטלוג ספקים'); await expect(page.locator('#tabs button[aria-current=page]')).toHaveAttribute('data-t', 'catalog');
  await expect(page.locator('#mic')).toHaveCount(0);
  // the neighbours still work with the catalog open: the price list and the request list open
  await page.locator('#tabs button[data-t=pricing]').click(); await expect(page.locator('#view h1')).toHaveText('תמחור'); await page.locator('#tabs button[data-t=requests]').click(); await expect(page.locator('#view h1')).toHaveText('בקשות טיפול');
  // the catalog closed: the same screens do what they always did, with no notice
  await demo.setMode('closed'); await open(page);
  await page.locator('#tabs button[data-t=services]').click(); await expect(page.locator('#view h1')).toHaveText('קטלוג שירותים');
  const s1 = await n('services'); await page.locator('#sn').fill('שירות מהלשונית הישנה'); await page.locator('#sf button').click();
  await expect.poll(() => n('services')).toBe(s1 + 1); await expect(page.locator('#view')).toContainText('שירות מהלשונית הישנה'); await expect(page.locator('#mic')).toHaveCount(0);
  await page.locator('#tabs button[data-t=pros]').click(); const p1 = await n('professionals'); await page.locator('#pn').fill('ספק מהלשונית הישנה'); await page.locator('#pf button').click();
  await expect.poll(() => n('professionals')).toBe(p1 + 1); await expect(page.locator('#mic')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the top menu: every tab can be reached and clicked at every window width (none slides under the logo or the user name), and the catalog tab is one of them', async ({ page }) => {
  await open(page);
  for (const w of [360, 390, 768, 1000, 1100, 1200, 1280, 1366, 1440, 1536, 1920]) {
    await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(60);
    const hidden = await page.evaluate(() => [...document.querySelectorAll('#tabs button')].map((b) => {
      const strip = document.getElementById('tabs'), scrolls = strip.scrollWidth > strip.clientWidth + 1;   // a phone-width strip scrolls by design; then only a tab that cannot be scrolled to would be a problem
      if (scrolls) { b.scrollIntoView({ inline: 'center', block: 'nearest' }); }
      const r = b.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === b || b.contains(top) ? null : b.dataset.t + ' (covered by ' + (top && (top.className || top.tagName)) + ')';
    }).filter(Boolean));
    expect(hidden, 'at ' + w + 'px').toEqual([]);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#tabs button[data-t=catalog]').click(); await ready(page); await expect(page.locator('#ct-root h1')).toHaveText('קטלוג ספקים');
});

test('no JavaScript error, no clipped text, no sideways scroll (not even inside a block) on any screen, at any width', async ({ page }) => {
  const problems = []; let listen = true;
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (listen && (m.type() === 'error' || m.type() === 'warning') && !(m.location().url || '').includes('fonts.g')) problems.push('console ' + m.type() + ': ' + m.text().slice(0, 160)); });   // (the tests never reach the font servers, on purpose)
  page.on('requestfailed', (r) => { if (listen && !r.url().includes('fonts.g')) problems.push('request failed: ' + r.url()); });
  page.on('response', (r) => { if (listen && r.url().includes('/api/') && r.status() >= 400) problems.push('answer ' + r.status() + ': ' + r.url()); });
  const look = (name) => page.evaluate((n) => {
    const bad = [];
    for (const el of document.querySelectorAll('#ct-root *')) {
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]') || el.closest('.sr') || el.classList.contains('sr')) continue;
      const over = el.scrollWidth - el.clientWidth, scrolls = ['auto', 'scroll'].includes(cs.overflowX);
      if (el.clientWidth > 0 && over > 1 && !scrolls) bad.push(n + ': clipped ' + el.tagName + '.' + el.className + ' by ' + over + 'px "' + el.textContent.trim().slice(0, 30) + '"');
      if (scrolls && over > 1) bad.push(n + ': sideways scroll inside ' + el.tagName + '.' + el.className + ' by ' + over + 'px');
      if (cs.textOverflow === 'ellipsis') bad.push(n + ': ellipsis on ' + el.className);
      const r = el.getBoundingClientRect(); if (el.clientWidth > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) bad.push(n + ': outside the window ' + el.tagName + '.' + el.className);
    }
    if (document.documentElement.scrollWidth - window.innerWidth > 1) bad.push(n + ': the page scrolls sideways');
    const t = document.querySelector('#ct-root').innerText; if (/undefined|\bnull\b|NaN|\[object/.test(t)) bad.push(n + ': a raw value on the screen');
    return bad;
  }, name);
  await open(page); problems.push(...await look('overview'));
  for (const s of ['נותני שירות', 'שירותים', 'התקשרויות', 'היסטוריית ייבוא', 'יומן שינויים']) { await nav(page, s); problems.push(...await look(s)); }
  for (const [screen, sel, name] of [['נותני שירות', 'button[data-ct=open-provider][data-id="11"]', 'provider card'], ['נותני שירות', 'button[data-ct=open-provider][data-id="14"]', 'provider card without a profile'], ['שירותים', 'button[data-ct=open-service][data-id="1"]', 'service card'],
    ['התקשרויות', 'button[data-ct=open-eng][data-p="11"][data-s="1"]', 'engagement, price not approved'], ['התקשרויות', 'button[data-ct=open-eng][data-p="12"][data-s="3"]', 'engagement, paused'], ['התקשרויות', 'button[data-ct=open-eng][data-p="15"][data-s="5"]', 'engagement, percentage with a minimum']]) {
    await nav(page, screen); await body(page).locator(sel).click(); await ready(page); problems.push(...await look(name));
  }
  for (const w of [701, 768, 900, 1024, 1280]) { await page.setViewportSize({ width: w, height: 900 }); for (const s of ['התקשרויות', 'שירותים', 'נותני שירות']) { await nav(page, s); problems.push(...await look(s + ' at ' + w + 'px')); } }   // the widths between a phone and a desktop
  await demo.setMode('empty'); await open(page); problems.push(...await look('empty catalog'));
  listen = false;   // the closed catalog answers 403 on purpose
  await demo.setMode('closed'); await open(page); problems.push(...await look('closed catalog'));
  expect(problems).toEqual([]);
});
