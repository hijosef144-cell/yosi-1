const CRM = 'http://127.0.0.1:4191';

const MODE_SEL = { full: '.lb-scroll[data-on="1"]', totem: '.lb-totem[data-on="1"]', tab: '.lb-tab[data-on="1"]', bar: '.lb-bar[data-on="1"]' };
const ANY_VISIBLE = Object.values(MODE_SEL).join(',');

async function setMode(request, mode) { await request.post(CRM + '/__mode', { data: { mode } }); }
async function resetCrm(request) { await request.post(CRM + '/__reset', { data: {} }); }
async function releaseCrm(request) { return (await request.post(CRM + '/__release', { data: {} })).json(); }
async function crmHeld(request) { return (await (await request.get(CRM + '/__held')).json()).held; }
async function crmLog(request) { return (await request.get(CRM + '/__log')).json(); }

/** Context that already has "closed for 7 days", so the page runs with the banner off (baseline). */
async function closedContext(browser, opts, dummyFont = true) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript((dummy) => {
    try { localStorage.setItem('lb.v1', JSON.stringify({ closedUntil: Date.now() + 6e8 })); } catch (e) {}
    // Adding the banner's font stylesheet link nudges this (already horizontally overflowing at 768px) page by a few px in the
    // test browser, where fonts are blocked. The baseline adds the same link so that only the banner's own UI is compared.
    if (dummy) document.addEventListener('DOMContentLoaded', () => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@700;900&family=Heebo:wght@400;500;600;700&display=swap'; document.head.appendChild(l); });
  }, dummyFont);
  return ctx;
}

async function waitBanner(page, timeout = 30000) {
  await page.waitForSelector(ANY_VISIBLE, { state: 'attached', timeout });
  await page.waitForTimeout(1800); // let the unfurl/slide finish
}

async function currentMode(page) {
  return page.evaluate((sel) => { for (const [m, s] of Object.entries(sel)) if (document.querySelector(s)) return m; return null; }, MODE_SEL);
}

/** Open the registration form whatever the mode is; returns a locator for the container that holds it. */
async function openForm(page) {
  const mode = await currentMode(page);
  if (mode === 'bar') { await page.click('.lb-open'); await page.waitForTimeout(700); return page.locator('.lb-sheetm'); }
  if (mode === 'totem') { await page.click('.lb-tt-open'); await page.waitForTimeout(1200); return page.locator('.lb-scroll[data-overlay="1"]'); }
  if (mode === 'tab') { await page.click('.lb-tab'); await page.waitForTimeout(1200); return page.locator('.lb-scroll[data-overlay="1"]'); }
  return page.locator('.lb-scroll');
}

/** Visible, text-bearing or interactive page elements outside the banner that intersect it. */
async function overlaps(page, bannerSel, fixedOnly) {
  return page.evaluate(([bannerSel, fixedOnly]) => {
    const banner = [...document.querySelectorAll(bannerSel)].filter(e => e.getBoundingClientRect().width > 0);
    const root = document.querySelector('.lb-root');
    const rects = banner.map(b => b.getBoundingClientRect());
    const out = [];
    const sel = 'a,button,input,select,textarea,label,h1,h2,h3,h4,h5,p,li,img,canvas,summary,td,th';
    const TEXT = /^(H[1-6]|P|LI|LABEL|SUMMARY|TD|TH)$/; const rg = document.createRange();
    for (const el of document.querySelectorAll(sel)) {
      if (root && root.contains(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      let r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (TEXT.test(el.tagName)) { rg.selectNodeContents(el); const tr = rg.getBoundingClientRect(); if (tr.width > 0) r = { left: Math.max(r.left, tr.left), right: Math.min(r.right, tr.right), top: r.top, bottom: r.bottom }; }   // the text itself, not the whole block
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (el.closest('[hidden],.hidden')) continue;
      if (fixedOnly) { let f = false; for (let n = el; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') { f = true; break; } } if (!f) continue; }
      for (const b of rects) {
        const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
        const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
        if (ix > 2 && iy > 2) out.push({ tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 50), text: (el.textContent || '').trim().slice(0, 30), pos: cs.position, ix: Math.round(ix), iy: Math.round(iy) });
      }
    }
    return out;
  }, [bannerSel, !!fixedOnly]);
}

/** Scroll to the very end of the page: the last piece of content must end above the bar (nothing is trapped under it). */
async function lastContentAboveBar(page) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const bar = document.querySelector('.lb-bar').getBoundingClientRect();
    let maxBottom = 0, who = '';
    for (const el of document.querySelectorAll('a,button,p,li,h1,h2,h3,h4,span,label,input')) {
      if (el.closest('.lb-root')) continue;
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      let fixed = false; for (let n = el; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') { fixed = true; break; } }
      if (fixed || el.closest('[hidden],.hidden')) continue;
      const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2 || r.top > innerHeight) continue;
      if (!(el.textContent || '').trim() && el.tagName !== 'INPUT') continue;
      if (r.bottom > maxBottom) { maxBottom = r.bottom; who = el.tagName + ':' + (el.textContent || '').trim().slice(0, 25); }
    }
    return { maxBottom: Math.round(maxBottom), barTop: Math.round(bar.top), who };
  });
}

module.exports = { CRM, MODE_SEL, ANY_VISIBLE, setMode, resetCrm, crmLog, releaseCrm, crmHeld, closedContext, waitBanner, currentMode, openForm, overlaps, lastContentAboveBar };
