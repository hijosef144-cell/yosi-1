// The home page's small handler for Netlify Identity links (invite, password reset, confirmation, e-mail change): it must send those links to the Kaspchem
// dashboard and must do NOTHING for any other visit. The home page is requested as /index.html (the dev server has no directory index).
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const TYPES = ['invite', 'recovery', 'confirmation', 'email_change'];

for (const type of TYPES) {
  test(`a ${type} link on the home page goes to the dashboard sign-in with the token kept`, async ({ page }) => {
    const hash = '#' + type + '_token=FAKEFAKEFAKE0123456789';
    await page.goto('/index.html' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/admin/kaspchem/**', { timeout: 10000 });
    expect(new URL(page.url()).pathname).toBe('/admin/kaspchem/');
    // the dashboard page consumes an invite token (it removes it from the address once it has read it); the other types stay in the address
    const left = new URL(page.url()).hash; expect(left === hash || (type === 'invite' && left === '')).toBe(true);
    await expect(page).toHaveTitle(/ניהול כספכם/);
    await expect(page.locator('body')).not.toBeEmpty();
    expect(await page.locator('input, button').count()).toBeGreaterThan(0); // a sign-in or set-password form is on screen, not a blank page
  });
}

test('a fake invite link on the dashboard page shows a form and does not crash; a fake reset link falls back to the sign-in form', async ({ page }) => {
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/admin/kaspchem/#invite_token=FAKEFAKEFAKE0123456789');
  await page.waitForTimeout(2500);
  expect(await page.locator('form, #lf, input[type=password]').count()).toBeGreaterThan(0);
  await page.goto('/admin/kaspchem/#recovery_token=FAKEFAKEFAKE0123456789');
  await page.waitForTimeout(2500);
  expect(await page.locator('input[type=password]').count()).toBeGreaterThan(0);
  expect(errors, 'no uncaught error on the dashboard page').toEqual([]);
});

for (const hash of ['', '#', '#contact', '#faq', '#access_token=abc', '#recovery', '#recovery_token', '#xinvite_token=abc', '#error=access_denied', '#calculators']) {
  test(`no redirect for the ordinary hash "${hash || '(none)'}": the home page stays where it is`, async ({ page }) => {
    await page.goto('/index.html' + hash, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    expect(new URL(page.url()).pathname).toBe('/index.html');
    // the home page's own scripts may set a hash such as #home; the point is that it was not sent anywhere
    await expect(page).toHaveTitle(/מצפן כלכלי/);
  });
}

test('the home page file carries exactly one handler, no temporary redirect, and no link or card pointing to Kaspchem', async () => {
  const home = fs.readFileSync('index.html', 'utf8');
  expect((home.match(/kc-identity-shim/g) || []).length).toBe(1);
  expect(home).not.toContain('kc-invite-redirect');
  expect(/href="[^"]*kaspchem/i.test(home)).toBe(false);
  expect(home).not.toContain('kc-cta');
  // the handler is the first script of the page, so it runs before anything else can touch the address
  expect(home.indexOf('kc-identity-shim')).toBeLessThan(home.indexOf('<meta charset'));
});
