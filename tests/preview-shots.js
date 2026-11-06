// Visual review of a Deploy Preview at the four required widths. No data is submitted.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const BASE = process.env.BASE;
const sizes = { 360: 740, 390: 844, 768: 1024, 1440: 900 };
(async () => {
  fs.mkdirSync('tests/shots', { recursive: true });
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [w, h] of Object.entries(sizes)) {
    const ctx = await b.newContext({ viewport: { width: +w, height: h }, locale: 'he-IL', isMobile: +w < 700, hasTouch: +w < 700 });
    const p = await ctx.newPage();
    await p.goto(BASE + '/kaspchem'); await p.waitForSelector('.tile'); await p.waitForTimeout(800);
    await p.screenshot({ path: `tests/shots/pv-${w}-landing.png`, fullPage: true });
    await p.goto(BASE + '/kaspchem/check/tax-refunds'); await p.waitForSelector('.opt');
    await p.waitForTimeout(500); await p.screenshot({ path: `tests/shots/pv-${w}-q1.png` });
    for (let i = 0; i < 6; i++) {
      if (await p.locator('#result').count()) break;
      const o = p.locator('.opt').first(); await o.click(); await p.waitForTimeout(450);
    }
    await p.waitForSelector('#result h1', { timeout: 8000 }); await p.waitForTimeout(1800);
    await p.screenshot({ path: `tests/shots/pv-${w}-result.png`, fullPage: true });
    // keyboard-focus visibility check on the landing
    await p.goto(BASE + '/kaspchem'); await p.waitForSelector('.tile');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(w, 'horizontal overflow px:', overflow);
    await ctx.close();
  }
  await b.close();
})();
