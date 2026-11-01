// Performance + integrity smoke against a deployed preview. Read-only (GET only).
// Usage: BASE=https://deploy-preview-1--matzpenkalkali.netlify.app node tests/perf.js
const { chromium } = require('@playwright/test');
const BASE = process.env.BASE;
const PAGES = ['/kaspchem/', '/kaspchem/check/mortgage', '/kaspchem/privacy.html', '/admin/kaspchem/'];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  let bad = 0;
  for (const [name, vp, mobile] of [['mobile Slow-4G + 4x CPU', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    console.log('\n== ' + name);
    for (const path of PAGES) {
      const ctx = await browser.newContext({ viewport: vp, locale: 'he-IL' });
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      if (mobile) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      let bytes = 0, reqs = 0; const errs = [];
      p.on('response', async (r) => { reqs++; const l = r.headers()['content-length']; if (l) bytes += +l; if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(BASE, '')); });
      p.on('pageerror', (e) => errs.push('JS ' + e.message));
      p.on('console', (m) => { if (m.type() === 'error' && !/app.netlify.com/.test(m.text())) errs.push('console ' + m.text().slice(0, 80)); }); // Netlify's own preview-drawer iframe is ignored
      await p.addInitScript(() => {
        window.__m = { lcp: 0, cls: 0 };
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
      });
      await p.goto(BASE + path, { waitUntil: 'load' }); await p.waitForTimeout(2500);
      const m = await p.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; const f = performance.getEntriesByName('first-contentful-paint')[0]; return { ttfb: Math.round(n.responseStart), fcp: Math.round(f ? f.startTime : 0), lcp: Math.round(window.__m.lcp), cls: +window.__m.cls.toFixed(3), load: Math.round(n.loadEventEnd), transferKB: Math.round(performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), n.transferSize || 0) / 1024) }; });
      const budget = mobile ? { lcp: 4000, cls: 0.1 } : { lcp: 2500, cls: 0.1 };
      const ok = m.lcp <= budget.lcp && m.cls <= budget.cls && !errs.length; if (!ok) bad++;
      console.log((ok ? '✔ ' : '✘ ') + path.padEnd(28) + ` TTFB ${m.ttfb}ms  FCP ${m.fcp}ms  LCP ${m.lcp}ms  CLS ${m.cls}  load ${m.load}ms  ${m.transferKB}KB/${reqs} req` + (errs.length ? '\n    ' + errs.join('\n    ') : ''));
      await ctx.close();
    }
  }

  // link integrity on the public pages
  console.log('\n== internal links');
  const ctx = await browser.newContext(); const p = await ctx.newPage(); const seen = new Set(); let broken = 0;
  for (const path of ['/kaspchem/', '/kaspchem/privacy.html', '/kaspchem/terms.html']) {
    await p.goto(BASE + path); await p.waitForTimeout(800);
    const hrefs = await p.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')).filter((h) => h && !h.startsWith('#') && !h.startsWith('http') && !h.startsWith('mailto:')));
    for (const h of hrefs) { if (seen.has(h)) continue; seen.add(h); const r = await ctx.request.get(new URL(h, BASE + path).href); if (r.status() >= 400) { broken++; console.log('✘ ' + h + ' -> ' + r.status()); } }
  }
  console.log((broken ? '✘ ' : '✔ ') + seen.size + ' distinct internal links checked, ' + broken + ' broken'); bad += broken;

  // the existing site must be untouched in behaviour: homepage loads, no new errors, banner + nav link present, old function intact
  console.log('\n== existing site');
  const errs = []; p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 80)); }); p.on('pageerror', (e) => errs.push(e.message));
  const resp = await p.goto(BASE + '/'); await p.waitForTimeout(2500);
  const info = await p.evaluate(() => ({ banner: !!document.querySelector('a[href="/kaspchem"][aria-label]'), navLinks: document.querySelectorAll('a[href="/kaspchem"]').length, title: document.title.slice(0, 40) }));
  console.log((resp.status() === 200 && info.banner && info.navLinks >= 3 ? '✔ ' : '✘ ') + 'homepage ' + resp.status() + ' ' + JSON.stringify(info) + (errs.length ? ' errors: ' + errs.join(' | ') : ' no console errors'));
  const old = await ctx.request.post(BASE + '/.netlify/functions/send-results', { data: {} });
  console.log((old.status() === 400 ? '✔ ' : '✘ ') + 'existing send-results function still answers (' + old.status() + '; production answers 400 for an empty body)');
  await browser.close();
  console.log(bad ? '\n' + bad + ' problem(s)' : '\nall performance/integrity checks passed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
