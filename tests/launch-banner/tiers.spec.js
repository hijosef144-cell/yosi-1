// Which presentation each screen width gets, and that none of them covers page content, controls or floating buttons.
const { test, expect } = require('@playwright/test');
const { closedContext, waitBanner, currentMode, overlaps, lastContentAboveBar, MODE_SEL, legacyCtx } = require('./helpers');

// [width, height, modes allowed for any page, mode the home page must get]. The presentation depends on how much free room the
// page leaves on the right (measured on the page itself), so wide-content pages get a smaller one instead of being covered.
const CASES = [
  [360, 740, ['bar'], 'bar'], [390, 844, ['bar'], 'bar'], [768, 1024, ['bar'], 'bar'],
  [1100, 800, ['bar', 'tab', 'totem', 'full'], 'tab'], [1366, 768, ['bar', 'tab', 'totem', 'full'], 'totem'],
  [1425, 900, ['bar', 'tab', 'totem', 'full'], 'totem'], [1440, 900, ['bar', 'tab', 'totem', 'full'], 'totem'],
  [1650, 1000, ['bar', 'tab', 'totem', 'full'], 'full'], [1920, 1080, ['bar', 'tab', 'totem', 'full'], 'full'], [2000, 1100, ['bar', 'tab', 'totem', 'full'], 'full']
];
const PAGES = ['/', '/knowledge/', '/knowledge/dictionary/aktuar/', '/מחשבון-שכר-ברוטו-נטו', '/pension-calc', '/privacy'];

for (const [w, h, allowed, homeMode] of CASES) {
  test.describe(`${w}x${h} -> ${allowed.join('/')}`, () => {
    for (const url of PAGES) {
      test(`${url}`, async ({ browser }) => {
        const touch = w < 700;
        // baseline: same page with the banner off
        const base = await closedContext(browser, { viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
        const bp = await base.newPage();
        await bp.goto(url, { waitUntil: 'domcontentloaded' });
        // The pages use the Tailwind CDN runtime, which re-lays the page out a few seconds after load; take the widest value seen.
        await bp.waitForTimeout(3000);
        const w1 = await bp.evaluate(() => document.documentElement.scrollWidth);
        await bp.waitForTimeout(4500);
        const w2 = await bp.evaluate(() => document.documentElement.scrollWidth);
        const baseW = Math.max(w1, w2);
        await base.close();

        const ctx = await legacyCtx(browser, { viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await waitBanner(page);
        const expected = await currentMode(page);
        expect(allowed, `mode ${expected} for ${url}`).toContain(expected);
        if (url === '/') expect(expected).toBe(homeMode);
        if (expected === 'full') {                       // the scroll is big whenever it is shown: 312px when there is room, never below 230px
          const sw = await page.locator('.lb-scroll[data-on="1"]').evaluate(e => Math.round(e.getBoundingClientRect().width));
          expect(sw).toBeGreaterThanOrEqual(230); expect(sw).toBeLessThanOrEqual(312);
          if (w >= 1920) expect(sw).toBe(312);
        }
        console.log(`${w}px ${url} -> ${expected}`);

        // the banner never makes the page wider
        const withW = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(withW).toBeLessThanOrEqual(baseW);

        // no overlap with content / controls / floating buttons, at the top and after scrolling
        const sel = MODE_SEL[expected] + (expected === 'bar' ? '' : '');
        for (const y of [0, 700]) {
          await page.evaluate(v => window.scrollTo(0, v), y);
          await page.waitForTimeout(500);
          // side presentations must not touch any page content; the bottom bar is a fixed strip, so it must not touch
          // fixed things (floating buttons, cookie banner), and the end of the page must stay reachable above it
          const bad = await overlaps(page, sel, expected === 'bar');
          expect(bad, `overlap at scrollY=${y}: ${JSON.stringify(bad.slice(0, 4))}`).toEqual([]);
        }
        if (expected === 'bar') {
          const end = await lastContentAboveBar(page);
          expect(end.maxBottom, JSON.stringify(end)).toBeLessThanOrEqual(end.barTop + 2);
        }
        expect(errors).toEqual([]);
        await ctx.close();
      });
    }
  });
}
