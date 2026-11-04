// Which presentation each screen width gets, and that none of them covers page content, controls or floating buttons.
const { test, expect } = require('@playwright/test');
const { closedContext, waitBanner, currentMode, overlaps, lastContentAboveBar, MODE_SEL } = require('./helpers');

const CASES = [
  [360, 740, 'bar'], [390, 844, 'bar'], [768, 1024, 'bar'], [1100, 800, 'tab'], [1440, 900, 'totem'], [1425, 900, 'totem'], [2000, 1100, 'full']
];
const PAGES = ['/', '/knowledge/', '/knowledge/dictionary/aktuar/', '/מחשבון-שכר-ברוטו-נטו', '/pension-calc', '/privacy'];

for (const [w, h, expected] of CASES) {
  test.describe(`${w}x${h} -> ${expected}`, () => {
    for (const url of PAGES) {
      test(`${url}`, async ({ browser }) => {
        const touch = w < 700;
        // baseline: same page with the banner off
        const base = await closedContext(browser, { viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
        const bp = await base.newPage();
        await bp.goto(url, { waitUntil: 'domcontentloaded' });
        await bp.waitForTimeout(800);
        const baseW = await bp.evaluate(() => document.documentElement.scrollWidth);
        await base.close();

        const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await waitBanner(page);
        expect(await currentMode(page)).toBe(expected);

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
