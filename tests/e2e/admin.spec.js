const { test, expect } = require('@playwright/test');
const fs = require('fs');

const AS_ADMIN = '/admin/kaspchem/?test=' + encodeURIComponent('yosi@example.test|admin');
const shot = async (page, ti, n) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: `tests/shots/${ti.project.name}-admin-${n}.png`, fullPage: true }); };

test.beforeEach(({}, ti) => { test.skip(!process.env.ALL_WIDTHS && !/desktop|mobile-390/.test(ti.project.name), 'admin checked on desktop and one phone width'); });

test('admin: not logged in sees only the gate', async ({ page }) => {
  await page.goto('/admin/kaspchem/');
  await expect(page.locator('.gate')).toBeVisible();
  await expect(page.locator('#tabs')).toBeHidden();
});

test('admin: a signed-in user who is not on the allow-list is refused', async ({ page }) => {
  await page.goto('/admin/kaspchem/?test=' + encodeURIComponent('stranger@example.test|admin'));
  await expect(page.locator('.gate .err')).toContainText('אין לחשבון');
});

test('admin: submit a lead publicly, handle it, edit a questionnaire and publish', async ({ page, request }, ti) => {
  // create a request through the public API
  const lead = await request.post('/api/kaspchem/lead', { data: { topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: 'נבדק ' + ti.project.name, phone: ti.project.name.includes('desktop') ? '0521110001' : '0521110002', consentContact: true, consentMarketing: true } });
  expect((await lead.json()).ok).toBe(true);

  await page.goto(AS_ADMIN);
  await expect(page.locator('h1')).toContainText('סקירה');
  await shot(page, ti, 'dash');
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click').first().click();
  await expect(page.locator('.drawer')).toContainText('הסכמות');
  await expect(page.locator('.drawer')).toContainText('אושר');
  await shot(page, ti, 'request');
  await page.locator('#ds').selectOption('in_progress');
  await page.locator('#da').fill('יוסי');
  // wait for the save to finish and the drawer to settle: pressing Escape before the re-render let the drawer re-open (a race that flaked on phones)
  await Promise.all([page.waitForResponse((r) => r.request().method() === 'PATCH' && /requests\/\d+$/.test(r.url())), page.locator('#dsave').click()]);
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.drawer #ds')).toHaveValue('in_progress');
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);

  await page.getByRole('button', { name: 'שאלונים' }).click();
  await page.locator('[data-e="household"]').click();
  const q0 = page.locator('textarea[data-f="text"]').first();
  await q0.fill('נוסח ערוך מהדשבורד?');
  await shot(page, ti, 'editor');
  await page.locator('#pv').click();
  await expect(page.locator('#pvbox')).toContainText('תצוגה מקדימה');
  page.once('dialog', (d) => d.accept());
  await page.locator('#pub').click();
  await expect(page.locator('h1')).toContainText('עריכת שאלונים');
  const cfg = await (await request.get('/api/kaspchem/config')).json();
  expect(cfg.topics.find((t) => t.id === 'household').questions[0].text).toBe('נוסח ערוך מהדשבורד?');
  await page.goto('/kaspchem/check/household');
  await expect(page.locator('h1')).toContainText('נוסח ערוך מהדשבורד');
});

test('admin: editing an invalid rule blocks publishing', async ({ page }) => {
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'שאלונים' }).click();
  await page.locator('[data-e="tax-refunds"]').click();
  await page.locator('input[data-f="rtitle"]').first().fill('');
  page.once('dialog', (d) => d.accept());
  await page.locator('#pub').click();
  await expect(page.locator('#errs')).toContainText('ללא כותרת ממצא');
});

test('admin: pricing is manual, unapproved, and never public until approved', async ({ page, request }, ti) => {
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'תמחור' }).click();
  await page.locator('#xl').fill('בדיקת מחיר ' + ti.project.name);
  await page.locator('#xp').fill('199');
  await page.locator('#xf button').click();
  await expect(page.locator('.tbl')).toContainText('ממתין לאישור');
  const pub = await (await request.get('/api/kaspchem/config')).json();
  expect(pub.prices.filter((p) => p.label.includes('בדיקת מחיר'))).toHaveLength(0);
  await shot(page, ti, 'pricing');
});
