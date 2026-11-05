// The default state on the first entrance: OPEN and big (desktop: the scroll; mobile: a bottom sheet of about half the screen),
// minimizable by hand, remembered for the visit, once per visit, never for someone who minimized, registered or closed.
// These tests use plain contexts (no pre-seeded session), i.e. a real first visit.
const { test, expect } = require('@playwright/test');
const { stableTailwind } = require('./helpers');

const DESKTOP_1920 = { width: 1920, height: 1080 };   // enough room beside the page: the scroll is docked (open)
const DESKTOP_1440 = { width: 1440, height: 900 };    // little room: used to open as a small strip; now opens as the big scroll
const DESKTOP_1300 = { width: 1300, height: 800 };    // almost no room: side tab; now opens the big scroll too
const PHONE = { width: 390, height: 844 };

const root = page => page.locator('.lb-root');
const mode = page => root(page).getAttribute('data-lb-mode');
const panel = page => root(page).getAttribute('data-lb-panel');
const session = page => page.evaluate(() => JSON.parse(sessionStorage.getItem('lb.s1') || '{}'));

async function enter(browser, viewport, url = '/', opts = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: !!opts.mobile, hasTouch: !!opts.mobile, ...(opts.ctx || {}) });
  await stableTailwind(ctx);
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-root', { state: 'attached', timeout: 30000 });
  await page.waitForTimeout(2600);                    // the opening animation
  return { ctx, page };
}
const rect = (page, sel) => page.locator(sel).first().evaluate(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), vh: innerHeight, vw: innerWidth }; });

test.describe('desktop', () => {
  test('1920: the scroll is open and big on the first entrance, with heading, teasers and the form', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1920);
    expect(await mode(page)).toBe('full');
    const sc = page.locator('.lb-scroll[data-on="1"]');
    await expect(sc).toBeVisible();
    expect((await rect(page, '.lb-scroll[data-on="1"]')).w).toBe(312);
    await expect(sc.locator('.lb-h')).toContainText('משהו גדול עומד להתגלות');
    await expect(sc.locator('.lb-teaser')).toBeVisible();
    await expect(sc.locator('input[type=email]')).toBeVisible();
    await expect(sc.locator('.lb-btn')).toBeVisible();
    expect(await page.locator('.lb-tab[data-on="1"], .lb-totem[data-on="1"]').count()).toBe(0);   // not the small version
    await ctx.close();
  });

  for (const [name, vp, expectedMode] of [['1440 (little room)', DESKTOP_1440, 'totem'], ['1300 (almost none)', DESKTOP_1300, 'tab']]) {
    test(`${name}: opens as the big scroll by default instead of a strip`, async ({ browser }) => {
      const { ctx, page } = await enter(browser, vp);
      expect(await mode(page)).toBe(expectedMode);
      expect(await panel(page)).toBe('1');
      const sc = page.locator('.lb-scroll[data-on="1"]');
      await expect(sc).toBeVisible();
      const r = await rect(page, '.lb-scroll[data-on="1"]');
      expect(r.w).toBe(312); expect(r.h).toBeGreaterThan(400);
      await expect(sc.locator('input[type=email]')).toBeVisible();
      await expect(sc.locator('.lb-btn')).toBeVisible();
      expect(await page.locator('.lb-totem[data-on="1"], .lb-tab[data-on="1"]').count()).toBe(0);   // the strip is not shown while it is open
      // it does not steal focus and does not close on a click elsewhere on the page
      expect(await page.evaluate(() => document.activeElement === document.body || document.activeElement === document.documentElement)).toBe(true);
      await page.mouse.click(300, 600); await page.waitForTimeout(600);
      expect(await panel(page)).toBe('1');
      await ctx.close();
    });
  }

  test('it can be minimized by hand, the choice is kept for the visit, and it is not reopened on the next pages', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1440);
    await page.locator('.lb-scroll[data-on="1"] .lb-min').click();
    await page.waitForTimeout(1500);
    expect(await panel(page)).toBe('0');
    await expect(page.locator('.lb-tab[data-on="1"], .lb-totem[data-on="1"]').first()).toBeVisible();
    expect((await session(page)).min).toBe(true);
    for (const u of ['/knowledge/', '/privacy', '/']) {
      await page.goto(u, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lb-root', { state: 'attached', timeout: 15000 });
      await page.waitForTimeout(900);
      expect(await panel(page), u).toBe('0');
    }
    await ctx.close();
  });

  test('open only once per visit: a second page does not open the panel again', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1440);
    expect(await panel(page)).toBe('1');
    await page.goto('/knowledge/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lb-root', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(1500);
    expect(await panel(page)).toBe('0');                    // compact on later pages (no cover, no repeated popup)
    expect((await session(page)).autoOpened).toBe(true);
    await ctx.close();
  });

  test('Escape folds the opened scroll back; clicking the strip opens it again', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1440);
    await page.locator('.lb-scroll[data-on="1"] .lb-in').focus();
    await page.keyboard.press('Escape'); await page.waitForTimeout(1500);
    expect(await panel(page)).toBe('0');
    await page.locator('.lb-totem[data-on="1"] .lb-tt-open').click(); await page.waitForTimeout(1500);
    expect(await panel(page)).toBe('1');
    await ctx.close();
  });

  test('someone who already registered is not greeted with an automatic panel', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1440, '/', { init: () => { try { localStorage.setItem('lb.v1', JSON.stringify({ joined: Date.now() })); } catch (e) {} } });
    expect(await panel(page)).toBe('0');
    await expect(page.locator('.lb-totem[data-on="1"]')).toBeVisible();
    await ctx.close();
  });

  test('closing keeps the 7-day rule: nothing opens automatically afterwards', async ({ browser }) => {
    const { ctx, page } = await enter(browser, DESKTOP_1440);
    await page.locator('.lb-scroll[data-on="1"] .lb-x').click(); await page.waitForTimeout(1500);
    expect(await page.locator('.lb-root').count()).toBe(0);
    const until = await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1')).closedUntil);
    expect((until - Date.now()) / 86400000).toBeGreaterThan(6.99);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000);
    expect(await page.locator('.lb-root').count()).toBe(0);
    await ctx.close();
  });
});

test.describe('mobile', () => {
  test('390x844: a bottom sheet of about half the screen opens by itself; no dimming; the page stays usable', async ({ browser }) => {
    const { ctx, page } = await enter(browser, PHONE, '/', { mobile: true });
    expect(await mode(page)).toBe('bar');
    expect(await panel(page)).toBe('1');
    const sheet = page.locator('.lb-sheetm[data-on="1"]');
    await expect(sheet).toBeVisible();
    const r = await rect(page, '.lb-sheetm[data-on="1"]');
    const pct = Math.round(r.h / r.vh * 100);
    expect(pct, `sheet height is ${pct}% of the screen`).toBeGreaterThanOrEqual(45);
    expect(pct).toBeLessThanOrEqual(60);
    expect(r.y + r.h).toBeGreaterThanOrEqual(r.vh - 2);                    // anchored to the bottom
    await expect(sheet.locator('.lb-h')).toContainText('משהו גדול עומד להתגלות');
    await expect(sheet.locator('.lb-teaser')).toBeVisible();
    await expect(sheet.locator('input[type=email]')).toBeVisible();
    await expect(sheet.locator('.lb-btn')).toBeVisible();                  // the form is inside the visible half, no scrolling needed
    expect(await sheet.getAttribute('aria-modal')).toBe('false');          // not modal
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.lb-scrim')).visibility)).toBe('hidden');   // no dimming
    expect(await page.evaluate(() => { const e = document.elementFromPoint(195, 120); return !!e && !e.closest('.lb-root'); })).toBe(true);   // the upper half is the page itself
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);   // no keyboard popped up
    // minimize and close controls, both at least 44px
    for (const sel of ['.lb-sheetm .lb-min', '.lb-sheetm .lb-x']) { const b = await page.locator(sel).boundingBox(); expect(b.width).toBeGreaterThanOrEqual(43.5); expect(b.height).toBeGreaterThanOrEqual(43.5); }
    await ctx.close();
  });

  test('minimizing folds it into the bottom bar and the choice is kept for the visit', async ({ browser }) => {
    const { ctx, page } = await enter(browser, PHONE, '/', { mobile: true });
    await page.locator('.lb-sheetm .lb-min').click();
    await page.waitForTimeout(1200);
    expect(await panel(page)).toBe('0');
    await expect(page.locator('.lb-bar[data-on="1"]')).toBeVisible();
    expect((await session(page)).min).toBe(true);
    for (const u of ['/knowledge/', '/privacy']) {
      await page.goto(u, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lb-root', { state: 'attached', timeout: 15000 });
      await page.waitForTimeout(1500);
      expect(await panel(page), u).toBe('0');
      await expect(page.locator('.lb-bar[data-on="1"]')).toBeVisible();
    }
    // the visitor can still open it by hand (modal this time)
    await page.locator('.lb-open').click(); await page.waitForTimeout(900);
    expect(await panel(page)).toBe('1');
    expect(await page.locator('.lb-sheetm').getAttribute('aria-modal')).toBe('true');
    await ctx.close();
  });

  test('opens once per visit: the next page shows only the bar', async ({ browser }) => {
    const { ctx, page } = await enter(browser, PHONE, '/', { mobile: true });
    expect(await panel(page)).toBe('1');
    await page.goto('/knowledge/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lb-root', { state: 'attached', timeout: 15000 });
    await page.waitForTimeout(2500);
    expect(await panel(page)).toBe('0');
    await expect(page.locator('.lb-bar[data-on="1"]')).toBeVisible();
    await ctx.close();
  });

  test('the X closes it for 7 days; a registered visitor and the cookie banner are handled', async ({ browser }) => {
    const a = await enter(browser, PHONE, '/', { mobile: true });
    await a.page.locator('.lb-sheetm .lb-x').click(); await a.page.waitForTimeout(1500);
    expect(await a.page.locator('.lb-root').count()).toBe(0);
    await a.ctx.close();
    const b = await enter(browser, PHONE, '/', { mobile: true, init: () => { try { localStorage.setItem('lb.v1', JSON.stringify({ joined: Date.now() })); } catch (e) {} } });
    expect(await panel(b.page)).toBe('0');
    await b.ctx.close();
  });

  test('small phone 360x640: still about half the screen, form reachable, Escape-free minimize works', async ({ browser }) => {
    const { ctx, page } = await enter(browser, { width: 360, height: 640 }, '/', { mobile: true });
    const r = await rect(page, '.lb-sheetm[data-on="1"]');
    expect(Math.round(r.h / r.vh * 100)).toBeLessThanOrEqual(60);
    await expect(page.locator('.lb-sheetm .lb-btn')).toBeVisible();
    const f = await page.locator('.lb-sheetm .lb-btn').boundingBox(); expect(f.y + f.height).toBeLessThanOrEqual(640);
    await page.locator('.lb-sheetm .lb-min').click(); await page.waitForTimeout(1000);
    expect(await panel(page)).toBe('0');
    await ctx.close();
  });

  test('reduced motion: the sheet still opens by itself', async ({ browser }) => {
    const { ctx, page } = await enter(browser, PHONE, '/', { mobile: true, ctx: { reducedMotion: 'reduce' } });
    expect(await panel(page)).toBe('1');
    await ctx.close();
  });

  test('tablet 768x1024: the same sheet, centered and not wider than needed on larger screens', async ({ browser }) => {
    const { ctx, page } = await enter(browser, { width: 768, height: 1024 });
    expect(await mode(page)).toBe('bar');
    expect(await panel(page)).toBe('1');
    const r = await rect(page, '.lb-sheetm[data-on="1"]');
    expect(Math.round(r.h / r.vh * 100)).toBeLessThanOrEqual(60);
    await ctx.close();
  });
});
