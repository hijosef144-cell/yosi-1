// Does the preview behave like production for the EXISTING site? Read-only GETs + page loads (no forms submitted, no emails sent).
// Usage: PROD=https://matzpenkalkali.com PREVIEW=https://deploy-preview-1--matzpenkalkali.netlify.app node tests/compare-existing.js
const { chromium } = require('@playwright/test');
const PROD = process.env.PROD, PREVIEW = process.env.PREVIEW;
const PAGES = ['/', '/index.html', '/pension-calc.html', '/מחשבון-שכר-ברוטו-נטו.html', '/מחשבון-עלות-דירה.html', '/מחשבון-אנונה.html', '/מחשבון-ריבית-דריבית.html', '/מחשבון-נדלן-מקצועי.html', '/מחשבון-מחיר-למשתכן.html', '/article.html', '/privacy.html', '/terms.html', '/accessibility.html', '/knowledge/', '/admin/', '/robots.txt', '/sitemap.xml'];

async function visit(browser, base, path) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push('JS ' + e.message.slice(0, 80)));
  p.on('console', (m) => { if (m.type() === 'error' && !/app\.netlify\.com|Failed to load resource.*(googletag|analytics|fonts)/i.test(m.text())) errs.push(m.text().slice(0, 90)); });
  await p.addInitScript(() => { window.__m = { lcp: 0, cls: 0 }; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__m.cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
  let status = 0; try { const r = await p.goto(base + path, { waitUntil: 'load', timeout: 45000 }); status = r.status(); await p.waitForTimeout(2500); } catch (e) { errs.push('NAV ' + e.message.slice(0, 60)); }
  const m = await p.evaluate(() => ({ lcp: Math.round(window.__m.lcp), cls: +window.__m.cls.toFixed(3), title: document.title.slice(0, 30) })).catch(() => ({}));
  await ctx.close(); return { status, errs, ...m };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' }); let bad = 0;
  console.log('page'.padEnd(36) + 'status prod/prev   LCP prod/prev   CLS prod/prev   new console errors');
  for (const path of PAGES) {
    const a = await visit(browser, PROD, path), b = await visit(browser, PREVIEW, path);
    const newErr = b.errs.filter((e) => !a.errs.includes(e));
    const ok = a.status === b.status && !newErr.length && (!b.lcp || !a.lcp || b.lcp <= a.lcp * 1.5 + 400) && (b.cls || 0) <= (a.cls || 0) + 0.05;
    if (!ok) bad++;
    console.log((ok ? '✔ ' : '✘ ') + decodeURIComponent(path).padEnd(34) + `${a.status}/${b.status}`.padEnd(14) + `${a.lcp}/${b.lcp}`.padEnd(16) + `${a.cls}/${b.cls}`.padEnd(15) + (newErr.length ? newErr.join(' | ') : '-'));
  }
  // the email function: same answers for the same empty request (no mail is sent: validation fails first)
  const ctx = await browser.newContext(); const body = JSON.stringify({});
  const f = async (b) => (await ctx.request.post(b + '/.netlify/functions/send-results', { data: body, headers: { 'content-type': 'application/json' } }));
  const [x, y] = [await f(PROD), await f(PREVIEW)]; const same = x.status() === y.status() && (await x.text()) === (await y.text());
  if (!same) bad++; console.log((same ? '✔ ' : '✘ ') + 'send-results empty request: prod ' + x.status() + ' / preview ' + y.status() + (same ? ' (identical response)' : ' DIFFERENT'));
  await browser.close(); console.log(bad ? `\n${bad} difference(s)` : '\nexisting site matches production'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
