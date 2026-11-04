// Cost of the banner: bytes, layout shifts, main-thread time, and nothing loaded when the banner is closed.
const { test, expect } = require('@playwright/test');
const zlib = require('zlib');
const { closedContext, waitBanner } = require('./helpers');

test('payload is small', async ({ request }) => {
  const js = await (await request.get('/static/launch-banner.js')).body();
  const css = await (await request.get('/static/launch-banner.css')).body();
  console.log(`js ${js.length} B (gzip ${zlib.gzipSync(js).length}), css ${css.length} B (gzip ${zlib.gzipSync(css).length})`);
  expect(zlib.gzipSync(js).length + zlib.gzipSync(css).length).toBeLessThan(20000);
});

async function measure(ctx, url) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__cls = 0; window.__long = 0; window.__bannerScript = 0; window.__loaf = false;
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
    // Long Animation Frames list which script spent the time: only the banner's own script counts here (page load noise does not)
    try { new PerformanceObserver(l => { window.__loaf = true; for (const e of l.getEntries()) for (const s of e.scripts || []) if (/launch-banner\.js/.test(s.sourceURL || '')) window.__bannerScript += s.duration; }).observe({ type: 'long-animation-frame', buffered: true }); } catch (e) {}
  });
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(7000);
  const r = await page.evaluate(() => ({ cls: window.__cls, long: window.__long, script: window.__bannerScript, banner: !!document.querySelector('.lb-root') }));
  return { ...r, requests };
}

for (const [w, h, mobile] of [[390, 844, true], [1440, 900, false], [2000, 1100, false]]) {
  for (const url of ['/', '/pension-calc']) {
    test(`${url} at ${w}: no layout shift caused by the banner, its script causes no slow frame`, async ({ browser }) => {
      const base = await closedContext(browser, { viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
      const b = await measure(base, url); await base.close();
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mobile, hasTouch: mobile });
      const m = await measure(ctx, url); await ctx.close();
      console.log(`${url} ${w}: CLS ${b.cls.toFixed(4)} -> ${m.cls.toFixed(4)}; page long tasks ${Math.round(b.long)} -> ${Math.round(m.long)} ms (page noise); banner script time in slow frames ${Math.round(m.script)} ms`);
      expect(m.banner).toBe(true);
      expect(m.cls - b.cls).toBeLessThan(0.01);
      expect(m.script).toBeLessThan(150);   // guard only: the banner script itself measures ~5 ms when idle; a loaded machine adds noise
    });
  }
}

test('a visitor who closed the banner downloads only the tiny script, no CSS and no extra font', async ({ browser }) => {
  const ctx = await closedContext(browser, { viewport: { width: 1440, height: 900 } }, false);
  const m = await measure(ctx, '/knowledge/');
  await ctx.close();
  expect(m.banner).toBe(false);
  expect(m.requests.filter(u => /launch-banner\.js/.test(u))).toHaveLength(1);
  expect(m.requests.filter(u => /launch-banner\.css|Frank\+Ruhl/.test(u))).toHaveLength(0);
});
