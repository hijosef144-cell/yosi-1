// Registration against a fake CRM that implements the waitlist contract (the real CRM app is covered by the CRM branch's own tests).
const { test, expect } = require('@playwright/test');
const { CRM, waitBanner, openForm, setMode, resetCrm, crmLog, releaseCrm, crmHeld } = require('./helpers');

const CONSENT = 'אני מסכים/ה לקבל בדוא״ל עדכון על השקת המיזם החדש בשיתוף מצפן כלכלי. ניתן לבטל את ההרשמה בכל עת.';
const API = '/?lbApi=' + encodeURIComponent(CRM);
const VIEWS = [
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true, source: 'mobile' },
  { name: 'wide', viewport: { width: 2000, height: 1100 }, mobile: false, source: 'desktop' },
  { name: 'totem', viewport: { width: 1440, height: 900 }, mobile: false, source: 'compact' },
  { name: 'tab', viewport: { width: 1366, height: 768 }, mobile: false, source: 'tab' }
];

test.beforeEach(async ({ request }) => { await resetCrm(request); });

for (const v of VIEWS) {
  test.describe(v.name, () => {
    async function start(browser, url = API) {
      const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.mobile, hasTouch: v.mobile });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await waitBanner(page);
      const box = await openForm(page);
      return { ctx, page, box };
    }

    test('consent is not pre-checked; validation messages; honeypot hidden', async ({ browser, request }) => {
      const { ctx, page, box } = await start(browser);
      await expect(box.locator('input[type=checkbox]')).not.toBeChecked();
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-msg')).toHaveText('נא להזין כתובת אימייל תקינה.');
      await box.locator('input[type=email]').fill('not-an-email');
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-msg')).toHaveText('נא להזין כתובת אימייל תקינה.');
      await box.locator('input[type=email]').fill('a@example.com');
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-msg')).toHaveText('כדי להירשם יש לאשר קבלת עדכון במייל.');
      expect((await crmLog(request)).length).toBe(0);                 // nothing was sent without email + consent
      const hp = box.locator('input[name=website]');
      expect(await hp.getAttribute('tabindex')).toBe('-1');
      expect(await hp.evaluate(e => e.getBoundingClientRect().left < -1000)).toBe(true);
      await expect(box.locator('.lb-check span')).toHaveText(CONSENT);   // the approved wording, verbatim
      await ctx.close();
    });

    test('success is shown only after the server confirms; payload is right', async ({ browser, request }) => {
      await setMode(request, 'hold');                                 // the server keeps the request open until the test releases it
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('Ron@Example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').click();
      await expect.poll(() => crmHeld(request), { timeout: 10000 }).toBe(1);   // the request reached the server and is unanswered
      await expect(box.locator('.lb-thanks')).toBeHidden();           // so no success message yet
      await expect(box.locator('.lb-btn')).toBeDisabled();
      await expect(box.locator('.lb-signup')).toBeVisible();
      await releaseCrm(request);                                      // now the server answers 201
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 10000 });
      await expect(box.locator('.lb-thanks h3')).toHaveText('תודה, אתם ברשימה');
      await expect(box.locator('.lb-signup')).toBeHidden();
      const log = await crmLog(request);
      expect(log.length).toBe(1);
      expect(log[0].body).toMatchObject({ email: 'Ron@Example.com', consent: true, consent_version: '2026-11-v1', consent_text: CONSENT, source_detail: v.source, website: '' });
      expect(log[0].body.page).toBe('/');
      await ctx.close();
    });

    test('server error: honest message, email stays, can retry', async ({ browser, request }) => {
      await setMode(request, 'server_error');
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('keep@example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-msg')).toContainText('לא הצלחנו לשמור', { timeout: 4000 });
      await expect(box.locator('.lb-thanks')).toBeHidden();
      await expect(box.locator('input[type=email]')).toHaveValue('keep@example.com');
      await expect(box.locator('input[type=checkbox]')).toBeChecked();
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1') || '{}').joined || null)).toBeNull();
      await setMode(request, 'ok');
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 4000 });
      await ctx.close();
    });

    test('network failure keeps the email too', async ({ browser, request }) => {
      await setMode(request, 'abort');
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('net@example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-msg')).toContainText('לא הצלחנו לשמור', { timeout: 5000 });
      await expect(box.locator('input[type=email]')).toHaveValue('net@example.com');
      await expect(box.locator('.lb-thanks')).toBeHidden();
      await ctx.close();
    });

    test('server answers: stale page, rate limit, bad email', async ({ browser, request }) => {
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('x@example.com');
      await box.locator('input[type=checkbox]').check();
      for (const [m, text] of [['mismatch', 'העמוד לא מעודכן'], ['rate', 'יותר מדי ניסיונות'], ['bad_email', 'לא נראית תקינה']]) {
        await setMode(request, m);
        await box.locator('.lb-btn').click();
        await expect(box.locator('.lb-msg')).toContainText(text, { timeout: 4000 });
        await expect(box.locator('.lb-thanks')).toBeHidden();
      }
      await ctx.close();
    });

    test('double click sends one request; duplicate registration from a fresh browser still succeeds', async ({ browser, request }) => {
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('dup@example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').dblclick();
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 4000 });
      expect((await crmLog(request)).length).toBe(1);
      await ctx.close();
      // second browser, same address
      const s = await start(browser);
      await s.box.locator('input[type=email]').fill('dup@example.com');
      await s.box.locator('input[type=checkbox]').check();
      await s.box.locator('.lb-btn').click();
      await expect(s.box.locator('.lb-thanks')).toBeVisible({ timeout: 4000 });
      expect((await crmLog(request)).length).toBe(2);
      await s.ctx.close();
    });

    test('after success the form never comes back in this browser; messages keep rotating; no layout break', async ({ browser, request }) => {
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('joined@example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 4000 });
      expect(await page.evaluate(() => !!JSON.parse(localStorage.getItem('lb.v1')).joined)).toBe(true);
      await page.goto('/knowledge/', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      const box2 = await openForm(page);
      await expect(box2.locator('.lb-thanks')).toBeVisible();
      await expect(box2.locator('.lb-signup')).toBeHidden();
      await expect(box2.locator('input[type=email]')).toBeHidden();
      // teasers still rotate (4.2 s)
      const before = await box2.locator('.lb-slide.on').first().textContent();
      await page.waitForTimeout(4800);
      const after = await box2.locator('.lb-slide.on').first().textContent();
      expect(after).not.toBe(before);
      await ctx.close();
    });

    test('verification status: asks to confirm by mail and does not mark the browser as joined', async ({ browser, request }) => {
      await setMode(request, 'verify');
      const { ctx, page, box } = await start(browser);
      await box.locator('input[type=email]').fill('back@example.com');
      await box.locator('input[type=checkbox]').check();
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-thanks h3')).toHaveText('כמעט סיימנו', { timeout: 4000 });
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1') || '{}').joined || null)).toBeNull();
      await ctx.close();
    });
  });
}

test('demo hook is inert on the production domain', async ({ browser }) => {
  // the production hostnames are fixed in the script; verify the guard by reading the source that ships
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const js = await (await page.request.get('/static/launch-banner.js')).text();
  expect(js).toMatch(/PROD_HOSTS = \{ 'matzpenkalkali\.com': 1, 'www\.matzpenkalkali\.com': 1 \}/);
  expect(js).toMatch(/function demoMode\(\) \{ return PROD_HOSTS\[loc\.hostname\] \? null/);
  expect(js).toMatch(/function apiBase\(\) \{ var c = cfg\(\); return \(c\.api && \(loc\.hostname === 'localhost' \|\| loc\.hostname === '127\.0\.0\.1'\)\)/);
  await ctx.close();
});
