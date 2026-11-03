// Screenshots of the existing homepage (fresh visitor: cookie banner visible) to study how a Kaspchem entry point collides with floating UI.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const BASE = process.env.BASE;
const OUT = 'tests/shots/home'; fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [mode, vp, mobile] of [['mobile', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    const ctx = await b.newContext({ viewport: vp, locale: 'he-IL', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const p = await ctx.newPage(); await p.goto(BASE + '/'); await p.waitForTimeout(3500);
    await p.screenshot({ path: `${OUT}/${mode}-0-fold.png` });
    const info = await p.evaluate(() => {
      const fixed = [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.position === 'fixed' && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; })
        .map((e) => { const r = e.getBoundingClientRect(); return (e.id || e.className.toString().slice(0, 30) || e.tagName) + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); });
      const banner = document.querySelector('a[href="/kaspchem"][aria-label]'); const br = banner && banner.getBoundingClientRect();
      return { fixed, bannerTop: br && Math.round(br.top + scrollY), bannerH: br && Math.round(br.height), heroH: Math.round(document.querySelector('#home .gradient-bg').getBoundingClientRect().height) };
    });
    console.log(mode, JSON.stringify(info, null, 1));
    await p.evaluate(() => { const b = document.querySelector('a[href="/kaspchem"][aria-label]'); if (b) window.scrollTo(0, b.getBoundingClientRect().top + scrollY - 200); });
    await p.waitForTimeout(500); await p.screenshot({ path: `${OUT}/${mode}-1-banner-area.png` });
    await ctx.close();
  }
  await b.close();
})();
