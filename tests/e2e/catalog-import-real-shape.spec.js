// The import screen with a file in the STRUCTURE of the owners' real sheet (tests/fixtures/catalog-sheet-real-shape.csv: invented data, the same 24 headers, title rows above the header, placeholder rows,
// phones as numbers without the zero, shekel and percent formats, a sheet topic the system does not have) and with providers that are paused or archived. Local demo server, in-memory database, no network.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4189, BASE = 'http://localhost:' + PORT, SHEET = path.join(__dirname, '..', 'fixtures', 'catalog-sheet-real-shape.csv');
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading'));
async function open(page) {
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  await page.locator('.ct-nav button', { hasText: 'ייבוא מהגיליון' }).click(); await ready(page);
}
const dlg = (page) => page.locator('.ce-modal');
const q = async (sql) => (await demo.pg.query(sql)).rows;
const n = async (sql) => Number((await q(sql))[0].n);
const rowEl = (page, r) => page.locator('.cip-row[data-row="' + r + '"]');
const shot = async (page, ti, name) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: 'tests/shots/' + ti.project.name + '-realshape-' + name + '.png', fullPage: true }); };
async function load(page, file) { await page.locator('#cip-file').setInputFiles(file); await page.locator('[data-cip=preview]').click(); await expect(page.locator('.cip-row').first()).toBeVisible(); }

test('THE REAL SHEET STRUCTURE: read without a problem, the two internal domains keep their domain (nothing to warn about), the phones that lost their zero need an explicit look, similar names are questions; after the approvals the save creates exactly that, all switched off', async ({ page }, ti) => {
  test.setTimeout(180000);
  await demo.setMode('empty'); await open(page); await load(page, SHEET); await shot(page, ti, 'preview');
  const counts = page.locator('.cip-counts'); await expect(counts).toContainText('חדשה 15'); await expect(counts).toContainText('דולגה 7'); await expect(counts).toContainText('החלטות נדרשות 2'); await expect(counts).toContainText('בעיה 0');
  await expect(page.locator('.cip-review')).toContainText('הערות תמחור');   // the one column that is not read is named
  for (const r of [5, 6, 7, 11]) await expect(rowEl(page, r)).not.toContainText('תחום בגיליון');   // the two internal domains (עסקים, חיסכון והשקעות) are known to the catalog: no warning, the service keeps its domain
  await expect(rowEl(page, 9)).toContainText('הוחזר האפס'); await expect(rowEl(page, 9).locator('[data-cipconfirm]')).toHaveCount(1); await expect(rowEl(page, 5).locator('[data-cipconfirm]')).toHaveCount(0);
  await expect(rowEl(page, 5)).toContainText('פרטי'); await expect(rowEl(page, 5)).toContainText('הערך נשמר כפי שהוא');   // a type in the business column is said, not hidden
  await expect(rowEl(page, 19)).toContainText('אין נותן שירות בשורה'); for (const r of [20, 21, 22, 23, 24, 25, 26]) await expect(rowEl(page, r)).toContainText('דולגה');
  // nothing is approved for the person; approve every row by hand, answer the two questions, look at the phones
  for (let r = 5; r <= 19; r++) { await rowEl(page, r).locator('[data-cipapply]').check(); for (const box of await rowEl(page, r).locator('[data-cipconfirm]').all()) await box.check(); }
  for (const r of [15, 17]) await rowEl(page, r).locator('input[data-use=new]').check();
  await expect(page.locator('.cip-bottom')).toContainText('15 שורות מאושרות'); await expect(page.locator('.cip-bottom')).toContainText('3 נותני שירות חדשים'); await expect(page.locator('.cip-bottom')).toContainText('14 התקשרויות חדשות'); await expect(page.locator('.cip-bottom')).not.toContainText(/הופעל/);
  await page.locator('[data-cip=review]').click(); await expect(dlg(page)).toContainText('אישור הייבוא'); await dlg(page).locator('#ce-ack').check(); await dlg(page).locator('#ce-confirmbox').fill('import'); await dlg(page).locator('[data-ce=submit]').click();
  await expect(page.locator('.cip-done')).toContainText('הייבוא נשמר'); await shot(page, ti, 'done');
  expect([await n('SELECT count(*)::int AS n FROM services'), await n('SELECT count(*)::int AS n FROM professionals'), await n('SELECT count(*)::int AS n FROM provider_services'), await n('SELECT count(*)::int AS n FROM provider_service_prices')]).toEqual([15, 3, 14, 14]);
  expect(await n("SELECT count(*)::int AS n FROM provider_services WHERE activation = 'active' OR agreement_state IN ('signed','ended') OR contact_state IN ('active','stopped')")).toBe(0); expect(await n('SELECT count(*)::int AS n FROM services WHERE active')).toBe(0);
  expect(await n('SELECT count(*)::int AS n FROM pricing')).toBe(0); expect(await n('SELECT count(*)::int AS n FROM provider_service_compensation')).toBe(0);
  expect((await q('SELECT topic FROM services WHERE topic IS NOT NULL')).every((r) => /^[a-z-]+$/.test(r.topic))).toBe(true);   // a topic is an id of the system, never Hebrew text
  expect(await n('SELECT count(*)::int AS n FROM services WHERE topic IS NULL')).toBe(0); expect(await n("SELECT count(*)::int AS n FROM services WHERE topic IN ('business', 'savings-investments')")).toBe(3);   // the internal domains are stored as their ids, and nothing is left without a domain
  await page.locator('[data-cipgo=providers]').click(); await ready(page); await expect(page.locator('#ct-body')).toContainText('[דמו] מורשה ראשון'); await expect(page.locator('#ct-body')).toContainText('[דמו] משרד שלישי'); await shot(page, ti, 'providers-after');
});

test('R12 ON THE SCREEN: a provider that is paused or archived gets no new engagement; the row is a problem in words, cannot be approved, and the rows of available providers still save', async ({ page }, ti) => {
  test.setTimeout(120000);
  await demo.setMode('full'); await open(page);
  const header = '"תחום","השירות המדויק","שם הספק","עסק / ארגון","מזהה שירות"';
  const csv = [header, '"מסים והחזרים","[דמו] בדיקת קרן השתלמות","[דמו] נותן שירות ג׳","[דמו] משרד לדוגמה ג׳","UN-1"', '"מסים והחזרים","[דמו] ליווי הגשת ערר ארנונה","[דמו] נותן שירות ב׳","","UN-2"', '"מסים והחזרים","[דמו] ייעוץ ירושה וצוואות","[דמו] נותן שירות ה׳","[דמו] משרד לדוגמה ה׳","UN-3"'].join('\r\n') + '\r\n';
  const before = { eng: await n('SELECT count(*)::int AS n FROM provider_services'), svc: await n('SELECT count(*)::int AS n FROM services') };
  await page.locator('#cip-file').setInputFiles({ name: 'unavailable.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await page.locator('[data-cip=preview]').click(); await expect(page.locator('.cip-row').first()).toBeVisible(); await shot(page, ti, 'unavailable-preview');
  await expect(rowEl(page, 2)).toContainText('מושהה או בארכיון'); await expect(rowEl(page, 3)).toContainText('מושהה או בארכיון'); await expect(rowEl(page, 2).locator('[data-cipapply]')).toHaveCount(0); await expect(rowEl(page, 3).locator('[data-cipapply]')).toHaveCount(0);
  await expect(rowEl(page, 4)).toContainText('חדשה'); await expect(rowEl(page, 4).locator('[data-cipapply]')).toHaveCount(1); await expect(page.locator('.cip-counts')).toContainText('בעיה 2');
  await rowEl(page, 4).locator('[data-cipapply]').check(); await page.locator('[data-cip=review]').click(); await dlg(page).locator('#ce-ack').check(); await dlg(page).locator('#ce-confirmbox').fill('import'); await dlg(page).locator('[data-ce=submit]').click();
  await expect(page.locator('.cip-done')).toContainText('הייבוא נשמר');
  expect(await n('SELECT count(*)::int AS n FROM provider_services')).toBe(before.eng + 1); expect(await n('SELECT count(*)::int AS n FROM services')).toBe(before.svc + 1);
  expect(await n("SELECT count(*)::int AS n FROM provider_services WHERE external_ref IN ('UN-1','UN-2')")).toBe(0); expect(await n("SELECT count(*)::int AS n FROM services WHERE name IN ('[דמו] בדיקת קרן השתלמות', '[דמו] ליווי הגשת ערר ארנונה')")).toBe(0);
  await shot(page, ti, 'unavailable-done');
});

test('THE SAMPLE SHEETS of the demo: the two files of the tests can be downloaded from the demo server (and only those two names), to be loaded on the import screen', async ({ request }) => {
  const ok = await request.get(BASE + '/__demo/sample/real-shape.csv'); expect(ok.status()).toBe(200); expect(ok.headers()['content-type']).toContain('text/csv'); expect(ok.headers()['content-disposition']).toContain('catalog-sheet-real-shape.csv'); expect(await ok.text()).toBe(fs.readFileSync(SHEET, 'utf8'));
  expect((await request.get(BASE + '/__demo/sample/demo.csv')).status()).toBe(200);
  for (const bad of ['..%2F..%2Fpackage.json', '%2e%2e%2fpackage.json', 'x.csv', '']) expect((await request.get(BASE + '/__demo/sample/' + bad)).status(), bad).toBe(404);
});

test('A DOMAIN NOBODY HAS is said on the row (the service is made without a domain, never with the text), while an internal domain of the catalog is not a problem', async ({ page }) => {
  test.setTimeout(120000);
  await demo.setMode('empty'); await open(page);
  const csv = '"תחום","השירות המדויק","שם הספק","עסק / ארגון","מזהה שירות"\r\n"תחום שאינו קיים","[דמו] שירות לבדיקת תחום","[דמו] ספק בדיקה","פרטי","UD-1"\r\n"עסקים","[דמו] שירות עסקי פנימי","[דמו] ספק בדיקה","פרטי","UD-2"\r\n';
  await page.locator('#cip-file').setInputFiles({ name: 'domains.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await page.locator('[data-cip=preview]').click(); await expect(page.locator('.cip-row').first()).toBeVisible();
  await expect(rowEl(page, 2)).toContainText('תחום בגיליון: ״תחום שאינו קיים״'); await expect(rowEl(page, 2)).toContainText('השירות ייווצר בלי תחום'); await expect(rowEl(page, 3)).not.toContainText('תחום בגיליון');
});
