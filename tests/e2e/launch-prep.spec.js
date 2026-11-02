const { test, expect } = require('@playwright/test');

const AS_ADMIN = '/admin/kaspchem/?test=' + encodeURIComponent('yosi@example.test|admin');
test.beforeEach(({}, ti) => { test.skip(!/desktop|mobile-390/.test(ti.project.name), 'admin checked on desktop and one phone width'); });

test('admin: export an applicant\'s data, correct their details, and a referral fee is refused', async ({ page, request }, ti) => {
  const phone = ti.project.name.includes('mobile') ? '0536660001' : '0536660002';
  const lead = await request.post('/api/kaspchem/lead', { data: { topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: 'בדיקת תיקון ' + ti.project.name, phone, consentContact: true } });
  expect((await lead.json()).ok).toBe(true);
  const otherPhone = ti.project.name.includes('mobile') ? '0536660003' : '0536660004'; // a second, different applicant
  expect((await (await request.post('/api/kaspchem/lead', { data: { topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: 'פונה אחר ' + ti.project.name, phone: otherPhone, consentContact: true } })).json()).ok).toBe(true);

  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת תיקון ' + ti.project.name }).first().click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('עיון ותיקון פרטים');

  // export downloads a JSON file with the applicant's own data
  const [dl] = await Promise.all([page.waitForEvent('download'), drawer.locator('#aexp').click()]);
  expect(dl.suggestedFilename()).toMatch(/^applicant-\d+\.json$/);
  const body = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
  expect(body.applicant.phone).toBe(phone); expect(body.consents.length).toBe(2);

  // correction form: hidden until asked, refuses a bad phone with a readable message, saves a good one
  await expect(drawer.locator('#afix')).toBeHidden();
  await drawer.locator('#aedit').click();
  await expect(drawer.locator('#afix')).toBeVisible();
  await drawer.locator('#ap').fill('123');
  await drawer.locator('#asave').click();
  await expect(page.locator('#toast')).toContainText('מספר טלפון לא תקין');
  await drawer.locator('#ap').fill(otherPhone); // a phone that belongs to someone else is refused with a readable message
  await drawer.locator('#asave').click();
  await expect(page.locator('#toast')).toContainText('כבר רשום אצל פונה אחר');
  await drawer.locator('#an').fill('שם מתוקן ' + ti.project.name);
  await drawer.locator('#ap').fill(phone);
  await drawer.locator('#asave').click();
  await expect(page.locator('.drawer strong').first()).toContainText('שם מתוקן');
  await page.keyboard.press('Escape');

  // a commission is refused, with a readable message and WITHOUT being kicked back to the login gate
  await page.getByRole('button', { name: 'שירותים' }).click();
  await page.getByRole('button', { name: 'תמחור' }).click();
  await expect(page.locator('.warn').nth(1)).toContainText('חסומה כברירת מחדל');
  await page.locator('#xl').fill('בדיקת עמלה');
  await page.locator('#xm').fill('50');
  await page.locator('#xf button').first().click();
  await expect(page.locator('#toast')).toContainText('עמלת הפניה חסומה');
  await expect(page.locator('.gate')).toHaveCount(0);
});
