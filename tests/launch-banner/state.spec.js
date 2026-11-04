// First entrance, navigation between pages, minimize/close persistence, joined state, exclusions.
const { test, expect } = require('@playwright/test');
const { waitBanner, currentMode, openForm, MODE_SEL, ANY_VISIBLE } = require('./helpers');

const FULL = { width: 2000, height: 1100 };
const TOTEM = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

async function bannerAnimations(page) {
  return page.evaluate(() => document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.matches && a.effect.target.matches('.lb-sheet,.lb-rod') && a.playState === 'running').length);
}

test('first entrance: nothing for ~3 s after load, then the scroll unfurls once', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: FULL }); const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__shownAt = null;
    new MutationObserver(() => { if (window.__shownAt === null && document.querySelector('.lb-root')) window.__shownAt = Math.round(performance.now()); }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/?lbDemo=ok', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(MODE_SEL.full, { state: 'attached', timeout: 9000 });
  const t = await page.evaluate(() => window.__shownAt);
  expect(t).toBeGreaterThan(2900);                                       // about 3 s after the page started
  expect(t).toBeLessThan(7000);
  expect(await bannerAnimations(page)).toBeGreaterThan(0);              // the unfurl is animating
  await ctx.close();
});

test('moving to another page: no second opening animation, state kept (open)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: FULL }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  await page.goto('/knowledge/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(MODE_SEL.full, { state: 'attached', timeout: 2500 }); // far sooner than the 3 s first-entrance delay
  expect(await bannerAnimations(page)).toBe(0);
  await ctx.close();
});

test('minimized stays minimized on the next pages (no auto reopen)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: FULL }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  await page.click('.lb-scroll .lb-min');
  await page.waitForSelector(MODE_SEL.tab, { state: 'attached' });
  for (const u of ['/knowledge/', '/privacy', '/']) {
    await page.goto(u, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(MODE_SEL.tab, { state: 'attached', timeout: 3000 });
    expect(await page.locator(MODE_SEL.full).count()).toBe(0);
  }
  // opening again from the tab works and is remembered
  await page.click('.lb-tab');
  await page.waitForSelector(MODE_SEL.full, { state: 'attached' });
  await page.goto('/privacy', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(MODE_SEL.full, { state: 'attached', timeout: 3000 });
  await ctx.close();
});

test('totem screens: minimize to the tab survives navigation', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: TOTEM }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  expect(await currentMode(page)).toBe('totem');
  await page.click('.lb-tt-min');
  await page.waitForSelector(MODE_SEL.tab, { state: 'attached' });
  await page.goto('/knowledge/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(MODE_SEL.tab, { state: 'attached', timeout: 3000 });
  expect(await page.locator(MODE_SEL.totem).count()).toBe(0);
  await ctx.close();
});

test('closed: gone on every page for 7 days, back after that', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  await page.click('.lb-bx');
  await page.waitForTimeout(1200);
  expect(await page.locator('.lb-root').count()).toBe(0);
  const closedUntil = await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1')).closedUntil);
  const days = (closedUntil - Date.now()) / 86400000;
  expect(days).toBeGreaterThan(6.99); expect(days).toBeLessThan(7.01);
  expect(await page.evaluate(() => !!window.__lbActive)).toBe(false);
  for (const u of ['/knowledge/', '/privacy', '/pension-calc']) {
    await page.goto(u, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4200);
    expect(await page.locator('.lb-root').count()).toBe(0);
  }
  // seven days later
  await page.evaluate(() => localStorage.setItem('lb.v1', JSON.stringify({ closedUntil: Date.now() - 1000 })));
  await page.goto('/privacy', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ANY_VISIBLE, { state: 'attached', timeout: 8000 });
  await ctx.close();
});

test('entering directly on an inner page works', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
  await page.goto('/knowledge/dictionary/shpitzer/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  expect(await currentMode(page)).toBe('bar');
  await ctx.close();
});

test('storage blocked: no crash, banner still works for the page', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    for (const n of ['localStorage', 'sessionStorage']) Object.defineProperty(window, n, { get() { throw new Error('blocked'); } });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  expect(await currentMode(page)).toBe('bar');
  expect(errors.filter(e => !/blocked/.test(e))).toEqual([]);
  await ctx.close();
});

test('internal pages never get the banner (admin, secure sign-in paths)', async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: FULL }); const page = await ctx.newPage();
  await page.goto('/admin/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);
  expect(await page.locator('.lb-root').count()).toBe(0);
  expect(await page.locator('script[src*="launch-banner"]').count()).toBe(0);
  // even if the script were loaded on a protected path it refuses to run
  for (const p of ['/admin/', '/kaspchem/check/x', '/portal/login']) {
    await page.goto('/privacy', { waitUntil: 'domcontentloaded' });
    const ran = await page.evaluate(async (p) => {
      const iframeSafe = true; history.pushState({}, '', p);
      window.__lbLoaded = false; window.__lbActive = false;
      const s = document.createElement('script'); s.src = '/static/launch-banner.js?x=' + Date.now(); document.head.appendChild(s);
      await new Promise(r => s.onload = r); await new Promise(r => setTimeout(r, 300));
      return !!window.__lbLoaded && !!document.querySelector('.lb-root');
    }, p);
    expect(ran).toBe(false);
  }
  await ctx.close();
});

test('data-lb-off opts a page out', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: FULL }); const page = await ctx.newPage();
  await page.route('**/privacy', async route => {
    const resp = await route.fetch(); let body = await resp.text();
    await route.fulfill({ response: resp, body: body.replace('<html', '<html data-lb-off') });
  });
  await page.goto('/privacy', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4200);
  expect(await page.locator('.lb-root').count()).toBe(0);
  await ctx.close();
});

test('launch=reset clears the remembered state', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
  await page.addInitScript(() => { if (!sessionStorage.getItem('x')) { sessionStorage.setItem('x', '1'); localStorage.setItem('lb.v1', JSON.stringify({ closedUntil: Date.now() + 6e8 })); } });
  await page.goto('/?launch=reset', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  expect(await currentMode(page)).toBe('bar');
  await ctx.close();
});
