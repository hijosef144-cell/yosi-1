const { test, expect } = require('@playwright/test');
const fs = require('fs');

const shot = async (page, testInfo, name) => {
  fs.mkdirSync('tests/shots', { recursive: true });
  await page.screenshot({ path: `tests/shots/${testInfo.project.name}-${name}.png`, fullPage: true });
};
const pick = async (page, label) => {
  const prev = await page.locator(".q h1").first().textContent();
  await page.getByRole("radio", { name: label, exact: true }).first().click();
  await page.waitForFunction((p) => { const h = document.querySelector(".q h1"); return !h || h.textContent !== p; }, prev);
};
const noHScroll = async (page) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, 'horizontal overflow').toBeLessThanOrEqual(0);
};

test('landing: ten tiles, RTL, no horizontal scroll, light travels clockwise', async ({ page }, ti) => {
  await page.goto('/kaspchem');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.tile')).toHaveCount(10);
  await noHScroll(page);
  // collect the sequence of lit tiles and verify angles advance clockwise
  const seq = [];
  for (let i = 0; i < 6; i++) {
    seq.push(await page.evaluate(() => { const l = document.querySelector('.tile.lit'); const r = l.getBoundingClientRect(); const all = [...document.querySelectorAll('.tile')].map((t) => t.getBoundingClientRect()); const cx = all.reduce((s, b) => s + b.left + b.width / 2, 0) / all.length, cy = all.reduce((s, b) => s + b.top + b.height / 2, 0) / all.length; return Math.atan2(r.top + r.height / 2 - cy, r.left + r.width / 2 - cx); }));
    await page.waitForTimeout(1350);
  }
  for (let i = 1; i < seq.length; i++) {
    let d = seq[i] - seq[i - 1]; if (d < -Math.PI) d += 2 * Math.PI;
    expect(d, 'clockwise step').toBeGreaterThan(0);
  }
  await shot(page, ti, 'landing');
});

test('landing: reduced motion keeps tiles static', async ({ browser, baseURL }, ti) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: ti.project.use.viewport });
  const page = await ctx.newPage(); await page.goto(baseURL + '/kaspchem');
  await expect(page.locator('.tile')).toHaveCount(10);
  await page.waitForTimeout(1600);
  await expect(page.locator('.tile.lit')).toHaveCount(0);
  await ctx.close();
});

test('wizard: found result, back/forward, branching, lead submit, thanks', async ({ page }, ti) => {
  await page.goto('/kaspchem/check/mortgage');
  await expect(page.locator('h1')).toContainText('משכנתה');
  await expect(page.locator('.pmeta')).toContainText('שאלה 1');
  await pick(page, 'כן, יש לי משכנתה');
  await expect(page.locator('h1')).toContainText('מתי נלקחה');
  await page.waitForTimeout(500);
  await shot(page, ti, 'question');
  await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
  await expect(page.locator('h1')).toContainText('האם יש לכם משכנתה');
  await pick(page, 'כן, יש לי משכנתה');
  await pick(page, 'לפני יותר מחמש שנים');
  await pick(page, 'לא');
  await pick(page, 'כן'); // know tracks
  await expect(page.locator('#result h1')).toContainText('נושא אחד', { timeout: 8000 });
  await expect(page.locator('.find')).toHaveCount(1);
  await page.waitForTimeout(1500);
  await shot(page, ti, 'result');
  await noHScroll(page);

  await page.getByRole('button', { name: 'אני רוצה עזרה בבדיקה' }).click();
  await page.getByRole('button', { name: 'שליחה' }).click();
  await expect(page.locator('#e-name')).toContainText('שם');
  await expect(page.locator('#e-phone')).toContainText('טלפון');
  await expect(page.locator('#e-consent')).toContainText('לאשר');
  await page.fill('#f-name', 'בדיקה אוטומטית');
  await page.fill('#f-phone', '0501234567');
  await page.check('#c-contact');
  await shot(page, ti, 'form');
  await page.getByRole('button', { name: 'שליחה' }).click();
  await expect(page.locator('#done')).toContainText('הפנייה התקבלה');
  await expect(page.locator('.more a')).toHaveCount(9);
  await page.waitForTimeout(700);
  await shot(page, ti, 'thanks');
  await noHScroll(page);
});

test('wizard: insufficient and none outcomes', async ({ page }) => {
  await page.goto('/kaspchem/check/household');
  await pick(page, 'מעולם לא');
  await pick(page, 'לא בטוח/ה');
  await pick(page, 'כן');
  await pick(page, 'לא');
  await expect(page.locator('#result h1')).toBeVisible({ timeout: 8000 });
  // first answer 'never' already yields a finding, so this path must be 'found'
  await expect(page.locator('#result h1')).toContainText('זיהינו');

  await page.goto('/kaspchem/check/lost-funds');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await pick(page, 'מקום אחד');
  await pick(page, 'לא');
  await pick(page, 'לא');
  await pick(page, 'לא');
  await expect(page.locator('#result h1')).toContainText('לא זיהינו', { timeout: 8000 });

  await page.goto('/kaspchem/check/lost-funds');
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await pick(page, 'לא זוכר/ת');
  await pick(page, 'לא');
  await pick(page, 'לא');
  await pick(page, 'לא');
  await expect(page.locator('#result h1')).toContainText('חסר לנו מידע', { timeout: 8000 });
});

test('wizard: keyboard only', async ({ page }) => {
  await page.goto('/kaspchem/check/banking-loans');
  await expect(page.locator('.opt').first()).toBeVisible();
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement.classList.contains('opt'))) break; }
  expect(await page.evaluate(() => document.activeElement.className)).toContain('opt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.pmeta')).toContainText('שאלה 2');
});

test('unknown topic shows a clear message', async ({ page }) => {
  await page.goto('/kaspchem/check/does-not-exist');
  await expect(page.locator('#app h1')).toContainText('לא נמצא');
});

test('branding: Kaspchem is a charity organization with Matzpen Kalkali as the professional partner; free first check, paid follow-up possible', async ({ page }) => {
  for (const url of ['/kaspchem', '/kaspchem/privacy.html', '/kaspchem/terms.html']) {
    await page.goto(url);
    const text = await page.locator('body').innerText();
    expect(text, url).not.toContain('מיזם מסחרי');
    expect(text, url).toContain('ארגון חסד');
    expect(text, url).toContain('מצפן כלכלי');
  }
  await page.goto('/kaspchem');
  await expect(page.locator('#about')).toContainText('הבדיקה הראשונית חינמית');
  await expect(page.locator('#about')).toContainText('עשויים להיות בתשלום');
  await expect(page.locator('#org-details')).toBeHidden(); // nothing about legal form is asserted until an admin fills it
});

test('result: never a big zero; gold moment only when something was identified; no scattering effects', async ({ page }) => {
  const pick = async (label) => { const prev = await page.locator('.q h1').first().textContent(); await page.getByRole('radio', { name: label, exact: true }).first().click(); await page.waitForFunction((x) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== x; }, prev); };
  await page.goto('/kaspchem/check/lost-funds');
  await pick('מקום אחד'); await pick('לא'); await pick('לא'); await pick('לא');
  await expect(page.locator('#result h1')).toContainText('לא זיהינו', { timeout: 8000 });
  await expect(page.locator('#num')).toHaveCount(0);
  await expect(page.locator('#result.found')).toHaveCount(0);
  await expect(page.locator('#result')).not.toContainText(/(^|s)0(s|$)/);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto('/kaspchem/check/mortgage');
  await pick('כן, יש לי משכנתה'); await pick('לפני יותר מחמש שנים'); await pick('לא'); await pick('כן');
  await expect(page.locator('#result.found')).toHaveCount(1, { timeout: 8000 });
  await expect(page.locator('#result .goldline')).toHaveCount(1);
  await expect(page.locator('#result .burst, #result .coin')).toHaveCount(0);
  await expect(page.locator('#result')).toContainText('תוצאות ראשוניות בלבד');
  await expect(page.locator('#result')).toContainText('חינמית');
});
