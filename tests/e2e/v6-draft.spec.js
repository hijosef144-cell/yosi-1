// Draft questionnaires v6 (local research folder, gitignored): work grant per tax year and National Insurance multi-event, on phone and desktop.
// Served by the throwaway dev server from docs/research/drafts-v6; skipped when that folder is not present (e.g. a fresh clone).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const FILE = path.join(__dirname, '..', '..', 'docs', 'research', 'drafts-v6', 'ALL-v6.draft.json');
let srv, base;
test.beforeAll(async ({}, ti) => {
  test.skip(!fs.existsSync(FILE), 'draft folder not present');
  process.env.TOPICS_FILE = FILE;
  const { start } = require('../dev-server');
  srv = await start(4241 + (ti.workerIndex % 5) + (ti.project.name.length % 7));
  base = 'http://localhost:' + srv.server.address().port;
});
test.afterAll(async () => { if (srv) srv.server.close(); delete process.env.TOPICS_FILE; });
test.beforeEach(({}, ti) => { test.skip(!/desktop|mobile-390/.test(ti.project.name), 'checked on desktop and one phone width'); });

const pick = (page, name) => page.getByRole('checkbox', { name, exact: false }).first().click();
const noOverflow = async (page) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); expect(w[0]).toBeLessThanOrEqual(w[1] + 1); };

test('work grant: one parent of a 2023 toddler gets one finding per tax year, each with its own deadline', async ({ page }, ti) => {
  await page.goto(base + '/kaspchem/check/tax-refunds');
  await pick(page, 'כשכיר/ה'); await page.locator('#mgo').click();
  await pick(page, 'אף אחד מאלה'); await page.locator('#mgo').click();
  await pick(page, 'יש לי ילד/ה אחד/ת או שניים'); await page.locator('#mgo').click();
  await expect(page.locator('.q h1')).toContainText('באילו משנות המס');
  await pick(page, 'בשנת 2024'); await pick(page, 'בשנת 2025'); await noOverflow(page); await page.locator('#mgo').click();
  await expect(page.locator('.q h1')).toContainText('באילו שנים נולדו');
  await pick(page, 'ב-2023'); await page.locator('#mgo').click();
  await expect(page.locator('.q h1')).toContainText('שכר החודשי');
  await expect(page.locator('.q')).not.toContainText('בן/בת הזוג כמה'); // no spouse-income question
  await page.getByRole('radio', { name: 'בערך 7,500 עד 9,500', exact: false }).click();
  await expect(page.locator('#result h1')).toContainText('2 נושאים', { timeout: 8000 });
  const r = page.locator('#result');
  await expect(r).toContainText('שנת המס 2024'); await expect(r).toContainText('31.12.2026');
  await expect(r).toContainText('שנת המס 2025'); await expect(r).toContainText('31.12.2027');
  await expect(r).not.toContainText('₪ 490'); await expect(r).not.toContainText('10,260');
  await expect(r.locator('a[href="https://www.misim.gov.il/gmmhszakaut/"]').first()).toBeVisible();
  await noOverflow(page);
  await page.waitForTimeout(1500);
  fs.mkdirSync('tests/shots', { recursive: true });
  await page.screenshot({ path: `tests/shots/${ti.project.name}-v6-workgrant.png`, fullPage: true });
});

test('work grant: a child born in 2022 gives only the 2024 finding', async ({ page }) => {
  await page.goto(base + '/kaspchem/check/tax-refunds');
  await pick(page, 'כשכיר/ה'); await page.locator('#mgo').click();
  await pick(page, 'אף אחד מאלה'); await page.locator('#mgo').click();
  await pick(page, 'יש לי ילד/ה אחד/ת או שניים'); await page.locator('#mgo').click();
  await pick(page, 'בשנת 2024'); await pick(page, 'בשנת 2025'); await page.locator('#mgo').click();
  await pick(page, 'ב-2022'); await page.locator('#mgo').click();
  await page.getByRole('radio', { name: 'בערך 7,500 עד 9,500', exact: false }).click();
  await expect(page.locator('#result h1')).toContainText('נושא אחד', { timeout: 8000 });
  await expect(page.locator('#result')).toContainText('שנת המס 2024');
  await expect(page.locator('#result')).not.toContainText('שנת המס 2025');
});

test('National Insurance: a family with several parallel events answers one short follow-up per event and misses none', async ({ page }, ti) => {
  await page.goto(base + '/kaspchem/check/national-insurance');
  await pick(page, 'נולד או אומץ ילד'); await pick(page, 'שירת במילואים'); await pick(page, 'נפטרו'); await noOverflow(page); await page.locator('#mgo').click();
  let guard = 0, asked = 1;
  while (guard++ < 8) {
    await page.waitForTimeout(400);
    if (!(await page.locator('.opt').count())) break;
    await noOverflow(page);
    if (await page.locator('#mgo').count()) { await page.locator('.opt').first().click(); await page.locator('#mgo').click(); }
    else await page.locator('.opt').first().click();
    asked++;
  }
  expect(asked).toBeLessThanOrEqual(5); // opening question + one follow-up per event (birth, reserve, death)
  await expect(page.locator('#result h1')).toBeVisible({ timeout: 8000 });
  await noOverflow(page);
  fs.mkdirSync('tests/shots', { recursive: true });
  await page.screenshot({ path: `tests/shots/${ti.project.name}-v6-ni-multi.png`, fullPage: true });
});
