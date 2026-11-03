const { test, expect } = require('@playwright/test');

// The counter never moves the page when its data arrives, and switching it off is seen by the very next visitor (nothing is cached).
// All figures are obviously fake TEST DATA. Each test seeds the database through the dev server's test-only route and leaves the counter off and empty.
const ADM = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const seed = async (request, state) => { const r = await request.post('/__test/impact-seed', { data: state || {} }); expect(r.ok()).toBe(true); };
const ON = { baseline: { kind: 'located_funds', amount: '3000.50', family_count: 7 }, cutoff: '2026-01-01', flag: true };
// Layout Instability API: the sum of shifts that did not follow a user action.
const watchShifts = (page) => page.addInitScript(() => {
  window.__cls = 0; window.__src = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
      // only shifts that involve the counter section or anything after it (a web-font swap moving the hero is a different matter and is measured separately)
      const imp = document.getElementById('impact');
      const mine = imp && (e.sources || []).some((x) => { const n = x.node; return n && (imp === n || imp.contains(n) || (imp.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)); });
      window.__all = (window.__all || 0) + e.value; if (mine) { window.__cls += e.value; (e.sources || []).forEach((x) => { const n = x.node; window.__src.push((n && (n.id || n.className || n.nodeName)) + ' ' + e.value.toFixed(4)); }); }
    } }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
});
const cls = (page) => page.evaluate(() => window.__cls);

test.beforeEach(async ({ request }) => { await seed(request, {}); });
test.afterEach(async ({ request }) => { await seed(request, {}); });

test('switching the counter off is seen by the very next visitor: the endpoint is never cached', async ({ page, request }) => {
  await seed(request, ON);
  const on = await request.get('/api/kaspchem/impact');
  expect((await on.json()).enabled).toBe(true);
  expect(on.headers()['cache-control']).toBe('no-store');
  await page.goto('/kaspchem'); await expect(page.locator('#impact')).toBeVisible();

  const r = await request.post(A + '/impact/counter', { headers: ADM, data: { enabled: false } }); expect(r.ok()).toBe(true);   // switched off ...
  const off = await request.get('/api/kaspchem/impact');                                // ... the very next request sees it
  expect(await off.json()).toEqual({ ok: true, enabled: false }); expect(off.headers()['cache-control']).toBe('no-store');
  await page.reload();                                                                  // a normal reload, no cache tricks: the counter is gone
  await page.waitForTimeout(600);
  await expect(page.locator('#impact')).toBeHidden();
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('₪');
  expect(await page.evaluate(() => localStorage.getItem('kasp:imp'))).toBeNull();      // and the remembered height is forgotten
});

test('layout: loading the counter data moves (almost) nothing on a first visit, and nothing at all for a returning visitor', async ({ page, request }, ti) => {
  await seed(request, ON);
  await watchShifts(page);

  await page.goto('/kaspchem'); await expect(page.locator('#impact')).toBeVisible(); await page.waitForTimeout(2500);
  const first = await cls(page);
  console.log(ti.project.name, 'first visit: counter-related CLS', first.toFixed(4), 'all shifts', (await page.evaluate(() => window.__all || 0)).toFixed(4));
  expect(first).toBeLessThan(0.02);                                                      // first visit: only content below the fold moves

  const hint = await page.evaluate(() => JSON.parse(localStorage.getItem('kasp:imp')));
  expect(hint.w).toBe(page.viewportSize().width); expect(hint.h).toBeGreaterThan(100);
  expect(Object.keys(hint).sort()).toEqual(['h', 'w']);                                  // no field for sentence 3 any more

  await watchShifts(page);
  await page.reload(); await expect(page.locator('#impact')).toBeVisible(); await page.waitForTimeout(2500);
  expect(await page.evaluate(() => document.documentElement.classList.contains('imp-expect'))).toBe(true);
  const h = await page.locator('#impact').evaluate((e) => e.getBoundingClientRect().height);
  expect(Math.abs(h - hint.h)).toBeLessThanOrEqual(1);                                   // the reserved space was exactly the real height
  const second = await cls(page);
  console.log(ti.project.name, 'returning visit: counter-related CLS', second.toFixed(4), 'all shifts', (await page.evaluate(() => window.__all || 0)).toFixed(4));
  expect(second).toBeLessThan(0.001);
  expect(await page.evaluate(() => window.__all || 0)).toBeLessThan(0.02);               // and nothing else moves noticeably either (the small remainder is the web-font swap)
});

test('layout: if the answer is "off" or fails, a reserved space is given back (never a blank gap), and a failure keeps the remembered height', async ({ page, request }) => {
  await seed(request, ON);
  await page.goto('/kaspchem'); await expect(page.locator('#impact')).toBeVisible();     // remembers the height
  await page.route('**/api/kaspchem/impact', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await page.reload(); await page.waitForTimeout(800);
  expect(await page.locator('#impact').evaluate((e) => getComputedStyle(e).display)).toBe('none');
  expect(await page.evaluate(() => localStorage.getItem('kasp:imp'))).not.toBeNull();   // a failed answer says nothing about the switch
  await page.unroute('**/api/kaspchem/impact');
  await seed(request, Object.assign({}, ON, { flag: false }));
  await page.reload(); await page.waitForTimeout(800);
  expect(await page.locator('#impact').evaluate((e) => getComputedStyle(e).display)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.classList.contains('imp-expect'))).toBe(false);
});
