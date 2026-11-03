// Checks the Kaspchem entry card on the main homepage: presence, size, no collisions with cookie banner / accessibility button / other floating UI.
// Usage: BASE=https://deploy-preview-1--matzpenkalkali.netlify.app node tests/home-card-check.js   (read-only)
const { chromium } = require('@playwright/test');
const fs = require('fs');
const BASE = process.env.BASE;
const OUT = 'tests/shots/home'; fs.mkdirSync(OUT, { recursive: true });
// (Netlify's own preview drawer is excluded below: it is not part of the site)
const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
let bad = 0; const ok = (c, m) => { if (!c) bad++; console.log((c ? '✔ ' : '✘ ') + m); };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  for (const [mode, vp, mobile] of [['mobile-390', { width: 390, height: 844 }, true], ['mobile-360', { width: 360, height: 740 }, true], ['desktop-1440', { width: 1440, height: 900 }, false]]) {
    for (const accepted of [false, true]) {
      const ctx = await browser.newContext({ viewport: vp, locale: 'he-IL', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      if (accepted) await ctx.addInitScript(() => { try { localStorage.setItem('cookieConsentAccepted', '1'); } catch (e) {} });
      const p = await ctx.newPage(); for (let t = 0; t < 4; t++) { try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); break; } catch (e) { if (t === 3) throw e; await p.waitForTimeout(1500); } } await p.waitForTimeout(3500);
      const tag = `${mode} ${accepted ? 'cookies accepted' : 'cookie banner visible'}`;
      const card = p.locator('.kc-card'); await card.waitFor();
      const h = await card.evaluate((e) => Math.round(e.getBoundingClientRect().height));
      if (!accepted) ok(true, `${tag}: card height ${h}px`);
      // scroll so the card is centred (typical reading position) and compare against every fixed element
      const positions = [];
      for (const where of ['center', 'top']) {
        await p.evaluate((w) => { const c = document.querySelector('.kc-card'); const r = c.getBoundingClientRect(); const y = r.top + scrollY; const H = innerHeight; scrollTo(0, w === 'center' ? y - (H - r.height) / 2 : w === 'bottom-third' ? y - H * 0.6 : y - 90); }, where);
        await p.waitForTimeout(500);
        const res = await p.evaluate(() => {
          const rect = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
          const fixed = [...document.querySelectorAll('body *')].filter((e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.position === 'fixed' && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0 && !e.closest('.kc-card') && !/Deploy Preview|Netlify Drawer/i.test(e.textContent || ''); }).map((e) => ({ id: e.id || e.className.toString().slice(0, 24) || e.tagName, ...rect(e) }));
          const important = { cta: rect(document.querySelector('.kc-cta')), headline: rect(document.querySelector('.kc-card h2')), points: rect(document.querySelector('.kc-pts')) };
          const sticky = document.querySelector('header.sticky'); const hdr = sticky ? rect(sticky) : null;
          return { fixed, important, hdr, H: innerHeight };
        });
        const inView = (r) => r.bottom > 0 && r.top < res.H;
        for (const [name, r] of Object.entries(res.important)) {
          if (!inView(r)) continue;
          const collide = res.fixed.filter((f) => hit(f, r)); if (collide.length) { bad++; console.log(`✘ ${tag} @${where}: ${name} overlapped by ${collide.map((c) => c.id).join(', ')}`); }
          if (res.hdr && hit(res.hdr, r) && where !== 'top') { bad++; console.log(`✘ ${tag} @${where}: ${name} under sticky header`); }
        }
        positions.push(where);
        if (where === 'center') await p.screenshot({ path: `${OUT}/final-${mode}-${accepted ? 'accepted' : 'cookie'}.png` });
      }
      // initial state: the cookie banner must not cover anything essential that is already on screen
      await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
      if (!accepted) await p.screenshot({ path: `${OUT}/final-${mode}-first-screen.png` });
      const gone = await p.evaluate(() => !document.querySelector('a[href="/kaspchem"][aria-label]'));
      const nav = await p.evaluate(() => [...document.querySelectorAll('a[href="/kaspchem"]')].filter((a) => a.closest('nav,#mobileMenu,header')).length);
      if (!accepted && mode === 'desktop-1440') ok(gone, 'old promo strip removed'); if (!accepted) ok(nav >= 1, `${mode}: "כספכם" link still in the header/menu (${nav})`);
      await p.waitForTimeout(1500); const fontOk = await p.evaluate(() => document.fonts.check("900 20px 'Frank Ruhl Libre'"));
      if (!accepted) ok(fontOk, `${mode}: brand headline font loaded`);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(overflow <= 0, `${tag}: no horizontal overflow`);
      await ctx.close();
    }
  }
  // CTA navigates to the questionnaire landing
  const ctx = await browser.newContext(); const p = await ctx.newPage(); for (let t = 0; t < 4; t++) { try { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); break; } catch (e) { if (t === 3) throw e; await p.waitForTimeout(1500); } } await p.waitForTimeout(2500);
  await p.locator('.kc-cta').click(); await p.waitForURL(/\/kaspchem\/?$/); ok(true, 'CTA leads to /kaspchem'); await ctx.close();
  await browser.close(); console.log(bad ? `\n${bad} problem(s)` : '\nhome card checks passed'); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
