// Keyboard, screen readers, reduced motion, touch targets, short screens, the old guide popup.
const { test, expect } = require('@playwright/test');
const { waitBanner, openForm, currentMode, MODE_SEL, legacyCtx } = require('./helpers');

const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

test('mobile sheet: dialog semantics, focus moves in, Escape closes and returns focus, Tab is trapped', async ({ browser }) => {
  const ctx = await legacyCtx(browser, MOBILE); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  const open = page.locator('.lb-open');
  await open.focus(); await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const sheet = page.locator('.lb-sheetm');
  expect(await sheet.getAttribute('role')).toBe('dialog');
  expect(await sheet.getAttribute('aria-modal')).toBe('true');
  const labelId = await sheet.getAttribute('aria-labelledby');
  expect(await page.locator('#' + labelId).textContent()).toContain('משהו גדול עומד להתגלות');
  expect(await page.evaluate(() => document.activeElement.classList.contains('lb-sheetm'))).toBe(true);
  // Tab stays inside the sheet
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => !!document.activeElement.closest('.lb-sheetm'))).toBe(true); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  await expect(sheet).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.classList.contains('lb-open'))).toBe(true);
  await ctx.close();
});

test('mobile: controls are at least 44px, the bar stays closable and does not block the page afterwards', async ({ browser }) => {
  const ctx = await legacyCtx(browser, MOBILE); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  for (const sel of ['.lb-bx', '.lb-open']) { const b = await page.locator(sel).boundingBox(); expect(b.height).toBeGreaterThanOrEqual(43.5); expect(b.width).toBeGreaterThanOrEqual(43.5); }
  await page.click('.lb-open'); await page.waitForTimeout(700);
  const x = await page.locator('.lb-sheetm .lb-x').boundingBox(); expect(x.width).toBeGreaterThanOrEqual(43.5); expect(x.height).toBeGreaterThanOrEqual(43.5);
  // the sheet's minimize button folds it back to the bar; the scrim must not intercept clicks afterwards
  const noBlock = () => page.evaluate(() => { const s = document.querySelector('.lb-scrim'); return !s || getComputedStyle(s).visibility === 'hidden'; });
  const m = await page.locator('.lb-sheetm .lb-min').boundingBox(); expect(m.width).toBeGreaterThanOrEqual(43.5); expect(m.height).toBeGreaterThanOrEqual(43.5);
  await page.click('.lb-sheetm .lb-min'); await page.waitForTimeout(700);
  expect(await noBlock()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains('lb-modal'))).toBe(false);
  await expect(page.locator('.lb-bar')).toBeVisible();
  // the X closes the whole banner (7-day rule) and leaves nothing that blocks the page
  await page.click('.lb-open'); await page.waitForTimeout(700);
  await page.click('.lb-sheetm .lb-x'); await page.waitForTimeout(1200);
  expect(await noBlock()).toBe(true);
  expect(await page.evaluate(() => document.documentElement.classList.contains('lb-modal'))).toBe(false);
  expect(await page.locator('.lb-root').count()).toBe(0);
  await ctx.close();
});

test('short screen / on-screen keyboard: the sheet fits the viewport and the form stays reachable', async ({ browser }) => {
  const ctx = await legacyCtx(browser, { viewport: { width: 360, height: 400 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  await page.click('.lb-open'); await page.waitForTimeout(800);
  const r = await page.locator('.lb-sheetm').boundingBox();
  expect(r.height).toBeLessThanOrEqual(400); expect(r.y).toBeGreaterThanOrEqual(0);
  await page.locator('.lb-sheetm .lb-btn').scrollIntoViewIfNeeded();
  const b = await page.locator('.lb-sheetm .lb-btn').boundingBox();
  expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.height).toBeLessThanOrEqual(400);
  await ctx.close();
});

test('mobile: floating buttons and the cookie banner are lifted above the bar (no overlap)', async ({ browser }) => {
  for (const url of ['/', '/pension-calc', '/מחשבון-שכר-ברוטו-נטו']) {
    const ctx = await legacyCtx(browser, MOBILE); const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitBanner(page);
    await page.waitForTimeout(1500);
    const hits = await page.evaluate(() => {
      const bar = document.querySelector('.lb-bar').getBoundingClientRect(); const out = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('.lb-root')) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.width > innerWidth * 0.8) continue;
        const iy = Math.min(r.bottom, bar.bottom) - Math.max(r.top, bar.top), ix = Math.min(r.right, bar.right) - Math.max(r.left, bar.left);
        if (ix > 2 && iy > 2) out.push(el.id || el.className);
      }
      // the cookie banner: the bar sits on top of it, not over it
      const cb = document.getElementById('cookie-banner');
      if (cb && getComputedStyle(cb).display !== 'none') { const c = cb.getBoundingClientRect(); if (Math.min(c.bottom, bar.bottom) - Math.max(c.top, bar.top) > 2) out.push('cookie-banner'); }
      return out;
    });
    expect(hits, url).toEqual([]);
    await ctx.close();
  }
});

test('desktop keyboard: tab reaches the side tab and Enter opens the panel, Escape closes it, focus returns', async ({ browser }) => {
  const ctx = await legacyCtx(browser, { viewport: { width: 1300, height: 800 } }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  expect(await currentMode(page)).toBe('tab');
  await page.locator('.lb-tab').focus(); await page.keyboard.press('Enter');
  await page.waitForTimeout(1300);
  const panel = page.locator('.lb-scroll[data-overlay="1"]');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.activeElement.type)).toBe('email');
  expect(await panel.getAttribute('role')).toBe('dialog');
  await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => document.activeElement.classList.contains('lb-tab'))).toBe(true);
  // clicking outside also folds it back
  await page.click('.lb-tab'); await page.waitForTimeout(1200);
  await page.mouse.click(300, 400); await page.waitForTimeout(900);
  await expect(panel).toBeHidden();
  await ctx.close();
});

test('reduced motion: no unfurl animation, no automatic rotation; pause button and dots work', async ({ browser }) => {
  const ctx = await legacyCtx(browser, { viewport: { width: 2000, height: 1100 }, reducedMotion: 'reduce' }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(MODE_SEL.full, { state: 'attached', timeout: 7000 });
  const running = await page.evaluate(() => document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.lb-sheet,.lb-rod') && a.playState === 'running' && !a.effect.target.closest('.lb-h') && !a.effect.target.classList.contains('lb-sp')).length);
  expect(running).toBe(0);
  const first = await page.locator('.lb-scroll .lb-slide.on').textContent();
  await page.waitForTimeout(5200);
  expect(await page.locator('.lb-scroll .lb-slide.on').textContent()).toBe(first);   // not rotating by itself
  await page.locator('.lb-scroll .lb-dot').nth(2).click();
  expect(await page.locator('.lb-scroll .lb-slide.on').textContent()).not.toBe(first); // manual control works
  await ctx.close();
});

test('rotation can be paused (WCAG pause control)', async ({ browser }) => {
  const ctx = await legacyCtx(browser, { viewport: { width: 2000, height: 1100 } }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  await page.click('.lb-scroll .lb-pause');
  expect(await page.locator('.lb-scroll .lb-pause').getAttribute('aria-label')).toContain('הפעלת');
  const t = await page.locator('.lb-scroll .lb-slide.on').textContent();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(5200);
  expect(await page.locator('.lb-scroll .lb-slide.on').textContent()).toBe(t);
  await ctx.close();
});

test('every banner button has an accessible name', async ({ browser }) => {
  for (const [w, h] of [[390, 844], [1440, 900], [2000, 1100]]) {
    const ctx = await legacyCtx(browser, { viewport: { width: w, height: h } }); const page = await ctx.newPage();
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitBanner(page);
    const nameless = await page.evaluate(() => [...document.querySelectorAll('.lb-root button, .lb-root input:not(.lb-hp)')].filter(e => {
      const n = (e.getAttribute('aria-label') || e.textContent || '').trim();
      const lab = e.id && document.querySelector('label[for="' + e.id + '"]');
      const wrapped = e.closest('label');
      return !n && !lab && !wrapped;
    }).map(e => e.outerHTML.slice(0, 60)));
    expect(nameless, `${w}`).toEqual([]);
    await ctx.close();
  }
});

/* ---- the old guide popup (exit intent) must not compete with the banner ---- */
test('guide popup stays off while the banner is active, and works again after the banner is closed', async ({ browser }) => {
  const ctx = await legacyCtx(browser, { viewport: { width: 2000, height: 1100 } }); const page = await ctx.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  const popupVisible = () => page.evaluate(() => { const p = document.getElementById('newsletterPopup'); return !!p && getComputedStyle(p).display !== 'none' && !p.classList.contains('hidden'); });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null })));
  await page.waitForTimeout(500);
  expect(await popupVisible()).toBe(false);
  expect(await page.evaluate(() => sessionStorage.getItem('hasSeenGuidePopup'))).toBeNull(); // not consumed, will work later
  // close the banner for 7 days
  await page.click('.lb-scroll .lb-x'); await page.waitForTimeout(1400);
  expect(await page.evaluate(() => !!window.__lbActive)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(500);
  expect(await popupVisible()).toBe(true);
  await ctx.close();
});

test('the guide popup is not removed from the site (form + popup still in the page)', async ({ request }) => {
  const html = await (await request.get('/')).text();
  expect(html).toContain('id="newsletterPopup"');
  expect(html).toContain("bindNewsletterById('newsletterForm')");
  expect(html).toContain("bindNewsletterById('newsletterFormPopup')");
  expect(html).toContain('/api/email/guide-signup');
});
