// ?lbDemo / ?lbApi must never work on a production address, so nobody (or a crafted link) can show a fake "registered" message there.
// Each hostname is served from the local static server through request interception (no DNS, no certificates, no real network);
// the production CRM URL is intercepted too and answered by the test.
const { test, expect } = require('@playwright/test');
const { waitBanner, openForm, crmLog, resetCrm } = require('./helpers');

const PRODUCTION_LIKE = ['matzpenkalkali.com', 'www.matzpenkalkali.com', 'matzpenkalkali.netlify.app', 'matzpenkalkali--evil.netlify.app', 'not-matzpenkalkali.com', 'shop.matzpenkalkali.com'];
const TEST_HOSTS = ['deploy-preview-6--matzpenkalkali.netlify.app', 'some-branch--matzpenkalkali.netlify.app'];

async function prepare(browser, host, query, crmAnswer) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const calls = [];
  // the site itself: https://<host>/... is answered from the local static server
  await ctx.route(`https://${host}/**`, async route => {
    const u = new URL(route.request().url());
    const response = await route.fetch({ url: 'http://127.0.0.1:4190' + u.pathname + u.search });
    await route.fulfill({ response });
  });
  // the CRM: answered by the test, with proper CORS answers
  await ctx.route('https://matzpen-crm.netlify.app/**', async route => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ url: req.url(), body: req.postDataJSON() });
    return route.fulfill({ status: crmAnswer.status, headers: cors, contentType: 'application/json', body: JSON.stringify(crmAnswer.body) });
  });
  const page = await ctx.newPage();
  await page.goto(`https://${host}/${query}`, { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  const box = await openForm(page);
  await box.locator('input[type=email]').fill('visitor@example.com');
  await box.locator('input[type=checkbox]').check();
  await box.locator('.lb-btn').click();
  return { ctx, page, box, calls };
}

test.beforeEach(async ({ request }) => { await resetCrm(request); });

for (const host of PRODUCTION_LIKE) {
  test.describe(`${host} (production)`, () => {
    for (const mode of ['ok', 'verify', 'err']) {
      test(`?lbDemo=${mode} is ignored: a real request goes to the production CRM; a failure shows an error, never success`, async ({ browser, request }) => {
        const { ctx, page, box, calls } = await prepare(browser, host, `?lbDemo=${mode}&lbApi=${encodeURIComponent('http://127.0.0.1:4191')}`, { status: 500, body: { error: 'server error' } });
        await expect(box.locator('.lb-msg')).toContainText('לא הצלחנו לשמור', { timeout: 15000 });
        await expect(box.locator('.lb-thanks')).toBeHidden();
        await expect(box.locator('input[type=email]')).toHaveValue('visitor@example.com');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://matzpen-crm.netlify.app/api/email/initiative-waitlist');
        expect(await crmLog(request)).toHaveLength(0);                                      // ?lbApi did not redirect the request
        expect(await page.evaluate(() => sessionStorage.getItem('lb.cfg'))).toBeNull();     // the test settings were never stored
        await ctx.close();
      });
    }
    test('only a real 201 {ok:true} from the CRM shows success (even with ?lbDemo=err)', async ({ browser }) => {
      const { ctx, box, calls } = await prepare(browser, host, '?lbDemo=err', { status: 201, body: { ok: true, status: 'registered' } });
      await expect(box.locator('.lb-thanks h3')).toHaveText('תודה, אתם ברשימה', { timeout: 15000 });
      expect(calls).toHaveLength(1);
      await ctx.close();
    });
    test('an unsubscribed address gets the "verify your email" state, not the success state', async ({ browser }) => {
      const { ctx, page, box } = await prepare(browser, host, '', { status: 201, body: { ok: true, status: 'verification_sent' } });
      await expect(box.locator('.lb-thanks h3')).toHaveText('כמעט סיימנו', { timeout: 15000 });
      await expect(box.locator('.lb-thanks-p')).toContainText('ההרשמה תיכנס לתוקף רק אחרי שתלחצו על הקישור');
      await expect(box.locator('.lb-thanks-p')).not.toContainText('ברשימה');
      await expect(box.locator('.lb-thanks h3')).not.toContainText('תודה');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1') || '{}').joined || null)).toBeNull();
      await ctx.close();
    });
  });
}

for (const host of TEST_HOSTS) {
  test(`${host} (preview/branch deploy): the demo hook works there and sends nothing to the CRM`, async ({ browser }) => {
    const { ctx, box, calls } = await prepare(browser, host, '?lbDemo=ok', { status: 500, body: {} });
    await expect(box.locator('.lb-thanks h3')).toHaveText('תודה, אתם ברשימה', { timeout: 15000 });
    expect(calls).toHaveLength(0);
    await ctx.close();
  });
}

test('the source keeps the closed allow-list (nothing is "production unless listed")', async ({ request }) => {
  const js = await (await request.get('http://127.0.0.1:4190/static/launch-banner.js')).text();
  expect(js).toContain(String.raw`var PREVIEW_HOST = /^[a-z0-9-]+--matzpenkalkali\.netlify\.app$/;`);
  expect(js).toContain('function demoMode() { return isTestHost() ? (cfg().demo || null) : null; }');
  expect(js).toContain('function apiBase() { var c = cfg(); return (c.api && isLocalHost()) ? c.api : DEFAULT_API; }');
});
