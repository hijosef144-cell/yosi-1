// Takes preview screenshots of the real banner on real pages (demo mode, no network to any CRM).
// usage: node tests/launch-banner/screenshots.js <outDir> [baseUrl]
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const out = path.resolve(process.argv[2] || 'shots');
const base = process.argv[3] || 'http://127.0.0.1:4190';
fs.mkdirSync(out, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 82, ...opts });

(async () => {
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
  async function ctxFor(w, h, mobile) { return browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile, locale: 'he-IL', deviceScaleFactor: mobile ? 2 : 1 }); }
  async function load(page, url) { await page.goto(base + url, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('.lb-root', { state: 'attached', timeout: 20000 }); await page.waitForTimeout(2200); }

  // 1. wide desktop: full scroll, then after sign-up (demo), then minimized
  let ctx = await ctxFor(2000, 1100, false), page = await ctx.newPage();
  await page.goto(base + '/?lbDemo=ok', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-scroll[data-on="1"]', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(500); await shot(page, 'd2000-unfurling');
  await page.waitForTimeout(1900); await shot(page, 'd2000-open');
  await page.fill('.lb-scroll input[type=email]', 'name@example.com'); await page.check('.lb-scroll input[type=checkbox]'); await page.click('.lb-scroll .lb-btn');
  await page.waitForTimeout(2600); await shot(page, 'd2000-thanks');
  await ctx.close();

  // 2. 1440: totem, panel open, success
  ctx = await ctxFor(1440, 900, false); page = await ctx.newPage();
  await page.goto(base + '/?lbDemo=ok', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-totem[data-on="1"]', { state: 'attached', timeout: 20000 });
  await page.waitForTimeout(2200); await shot(page, 'd1440-totem');
  await page.click('.lb-tt-open'); await page.waitForTimeout(1900); await shot(page, 'd1440-panel');
  await page.fill('.lb-scroll input[type=email]', 'name@example.com'); await page.check('.lb-scroll input[type=checkbox]'); await page.click('.lb-scroll .lb-btn');
  await page.waitForTimeout(2600); await shot(page, 'd1440-panel-thanks');
  await ctx.close();

  // 3. 1100: side tab, then another page keeps the state
  ctx = await ctxFor(1100, 800, false); page = await ctx.newPage();
  await page.goto(base + '/?lbDemo=ok', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lb-tab[data-on="1"]', { state: 'attached', timeout: 20000 }); await page.waitForTimeout(1500);
  await shot(page, 'd1100-tab');
  await page.goto(base + '/knowledge/', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500); await shot(page, 'd1100-tab-knowledge');
  await ctx.close();

  // 4. tablet 768 and phones
  for (const [w, h, name] of [[768, 1024, 't768'], [390, 844, 'm390'], [360, 740, 'm360']]) {
    ctx = await ctxFor(w, h, w < 700); page = await ctx.newPage();
    await page.goto(base + '/?lbDemo=ok', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lb-bar[data-on="1"]', { state: 'attached', timeout: 20000 }); await page.waitForTimeout(1800);
    await shot(page, name + '-bar');
    await page.click('.lb-open'); await page.waitForTimeout(1000); await shot(page, name + '-sheet');
    await page.fill('.lb-sheetm input[type=email]', 'name@example.com'); await page.check('.lb-sheetm input[type=checkbox]'); await page.click('.lb-sheetm .lb-btn');
    await page.waitForTimeout(2800); await shot(page, name + '-thanks');
    await ctx.close();
  }
  // 5. a calculator page and a guide page on a phone (bar above the page's own floating buttons)
  for (const [u, name] of [['/pension-calc', 'm390-pension'], ['/knowledge/guides/buy-money-fund-pagi/', 'm390-guide']]) {
    ctx = await ctxFor(390, 844, true); page = await ctx.newPage();
    await page.goto(base + u, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lb-bar[data-on="1"]', { state: 'attached', timeout: 20000 }); await page.waitForTimeout(2200);
    await shot(page, name);
    await ctx.close();
  }
  await browser.close();
  console.log('screenshots in', out);
})().catch(e => { console.error(e); process.exit(1); });
