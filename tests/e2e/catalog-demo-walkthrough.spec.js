// THE DEMONSTRATION (stages 5b-1 to 5c), as one walk through the screens on the local demo server (tests/catalog-demo-server.js: the real admin page and the real function code on an in-memory Postgres, invented "[דמו]"
// data) and a demo sheet in the format of the owners' sheet (tests/fixtures/catalog-sheet-demo.csv). It shows, and checks, the five things that were asked for:
//   1. the registry of providers   2. the services and the engagements   3. the prices and their states of approval   4. loading the CSV of the sheet   5. the data after the import, in the demo environment
// Screenshots are written to tests/shots/<project>-demo-NN-name.png. Nothing here touches Neon, the production site or any network; the real sheet is not imported.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4188, BASE = 'http://localhost:' + PORT, DEMO_CSV = path.join(__dirname, '..', 'fixtures', 'catalog-sheet-demo.csv');
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading') && !document.querySelector('#ct-log .ct-loading'));
const body = (page) => page.locator('#ct-body');
const dlg = (page) => page.locator('.ce-modal');
const nav = async (page, screen) => { await page.locator('.ct-nav button', { hasText: screen }).click(); await ready(page); };
const rowEl = (page, n) => page.locator('.cip-row[data-row="' + n + '"]');
const q = async (sql) => (await demo.pg.query(sql)).rows;

test('the demonstration: providers, services and engagements, prices and approval states, loading the sheet, and the data after the import', async ({ page }, ti) => {
  test.setTimeout(180000);
  await demo.setMode('full'); fs.mkdirSync('tests/shots', { recursive: true });
  let n = 0; const shot = async (name, full) => { n++; await page.screenshot({ path: 'tests/shots/' + ti.project.name + '-demo-' + String(n).padStart(2, '0') + '-' + name + '.png', fullPage: full !== false }); };
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin'); await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);

  // 1. the registry of providers
  await nav(page, 'נותני שירות'); await expect(body(page)).toContainText('[דמו] נותן שירות א׳'); await expect(body(page)).toContainText('זמין'); await expect(body(page)).toContainText('בארכיון'); await shot('providers');
  await body(page).locator('button[data-ct=open-provider][data-id="11"]').click(); await ready(page); await expect(body(page)).toContainText('פרטי נותן השירות'); await shot('provider-card');

  // 2. the services and the engagements
  await nav(page, 'שירותים'); await expect(body(page)).toContainText('[דמו] בדיקת זכאות להחזר מס'); await shot('services');
  await nav(page, 'התקשרויות'); await expect(body(page)).toContainText('ממתין לאישור'); await shot('engagements');
  await body(page).locator('button[data-ct=open-eng][data-p="15"][data-s="1"]').click(); await ready(page);

  // 3. the prices and their states of approval: the layers kept apart, the linked price and its approval
  await expect(page.locator('#ct-price-tools')).toContainText('מדווחים'); await expect(page.locator('.ct-price-approved')).toContainText('מאושר'); await expect(page.locator('.ct-price-market')).toContainText('1,150'); await shot('engagement-card-prices');
  await nav(page, 'מחירים'); await expect(body(page).locator('table tbody tr')).toHaveCount(7); await expect(body(page)).toContainText('הצעת הספק (מוצע)'); await shot('prices');
  await page.locator('[data-cpv=rows]').click(); await expect(body(page).locator('table tbody tr')).toHaveCount(2); await shot('prices-rows');

  // 4. loading the CSV of the sheet: the preview, the approvals, the explicit approval of the save
  await nav(page, 'ייבוא מהגיליון'); await page.locator('#cip-file').setInputFiles(DEMO_CSV); await expect(page.locator('#cip-file-info')).toContainText('catalog-sheet-demo.csv'); await shot('import-load', false);
  await page.locator('[data-cip=preview]').click(); await expect(page.locator('.cip-row').first()).toBeVisible(); await expect(page.locator('.cip-counts')).toContainText('חדשה 5'); await shot('import-preview-top', false);
  await rowEl(page, 5).scrollIntoViewIfNeeded(); await shot('import-preview', true);
  await page.locator('[data-cipval]').selectOption('contacted'); await page.locator('[data-cip=apply-values]').click(); await expect(rowEl(page, 6)).toContainText('חדשה');   // the unknown word, mapped on the screen
  await page.locator('[data-cip=approve-clean]').click(); await rowEl(page, 6).locator('[data-cipapply]').check(); await rowEl(page, 5).locator('[data-cipapply]').check(); await rowEl(page, 5).locator('input[data-use=new]').check();
  await expect(page.locator('.cip-bottom')).toContainText('שורות מאושרות'); await page.locator('.cip-bottom').scrollIntoViewIfNeeded(); await shot('import-approved', false);
  await page.locator('[data-cip=review]').click(); await expect(dlg(page)).toContainText('אישור הייבוא'); await shot('import-confirm', false);
  await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await dlg(page).locator('[data-ce=submit]').click(); await expect(page.locator('.cip-done')).toContainText('הייבוא נשמר'); await shot('import-done', false);

  // 5. the data after the import, in the demo environment
  expect((await q("SELECT 1 FROM provider_services WHERE activation = 'active'")).length).toBe(0);
  await page.locator('[data-cipgo=providers]').click(); await ready(page); await page.locator('#ct-q').fill('גולן'); await expect(body(page)).toContainText('[דמו] גולן כהן'); await shot('after-providers');
  await nav(page, 'שירותים'); await page.locator('#ct-q').fill('החזר מס לעצמאים'); await expect(body(page)).toContainText('[דמו] החזר מס לעצמאים'); await expect(body(page)).toContainText('כבוי'); await shot('after-services');
  await nav(page, 'התקשרויות'); await page.locator('#ct-q').fill('גולן'); await expect(body(page).locator('button[data-ct=open-eng]')).toHaveCount(1); await body(page).locator('button[data-ct=open-eng]').first().click(); await ready(page);
  await expect(page.locator('.ct-price-doc')).toContainText('1,800'); await expect(page.locator('.ct-price-approved')).toContainText('אין מחיר מקושר'); await shot('after-engagement-card');
  await nav(page, 'מחירים'); await page.locator('#cp-q').fill('גולן'); await expect(body(page).locator('table tbody tr')).toHaveCount(1); await expect(body(page)).toContainText('לא מקושר'); await shot('after-prices');
  await nav(page, 'היסטוריית ייבוא'); await expect(body(page)).toContainText('CSV'); await shot('after-import-history');
});
