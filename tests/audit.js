// Accessibility + resilience audit of the public site and admin gate, run against the local test server (in-memory DB).
// Custom checks (no extra dependencies): structure, names, labels, contrast, target size, focus visibility, keyboard flow.
const { chromium } = require('@playwright/test');
const { start } = require('./dev-server');

const PAGES = [
  ['landing', '/kaspchem/'],
  ['question', '/kaspchem/check/tax-refunds'],
  ['privacy', '/kaspchem/privacy.html'],
  ['terms', '/kaspchem/terms.html'],
  ['admin-gate', '/admin/kaspchem/']
];

function pageChecks() {
  const out = { issues: [], stats: {} };
  const add = (k, m) => out.issues.push(k + ': ' + m);
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.innerText || el.value || el.getAttribute('title') || '').trim();

  if (document.documentElement.lang !== 'he') add('lang', 'html lang is not he');
  if (document.documentElement.dir !== 'rtl') add('dir', 'html dir is not rtl');
  if (!document.title.trim()) add('title', 'missing');
  if (!document.querySelector('main')) add('landmark', 'no <main>');
  const h1s = [...document.querySelectorAll('h1')].filter(vis);
  if (h1s.length !== 1) add('h1', 'expected 1 visible h1, found ' + h1s.length);
  let prev = 0; document.querySelectorAll('h1,h2,h3,h4').forEach((h) => { if (!vis(h)) return; const n = +h.tagName[1]; if (prev && n > prev + 1) add('heading-order', h.tagName + ' after h' + prev + ': ' + h.textContent.trim().slice(0, 30)); prev = n; });

  document.querySelectorAll('input:not([type=hidden]),select,textarea').forEach((el) => {
    if (!vis(el) && !el.closest('.hp')) return;
    if (el.closest('.hp')) return; // honeypot is intentionally hidden
    const named = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
    if (!named) add('form-label', (el.id || el.name || el.type) + ' has no label');
  });
  document.querySelectorAll('button,a[href],[role=button],[role=radio]').forEach((el) => {
    if (!vis(el) || (el.closest('details:not([open])') && !el.closest('summary'))) return; // closed <details> content is not rendered
    if (!label(el)) add('name', el.outerHTML.slice(0, 80) + ' has no accessible name');
  });
  document.querySelectorAll('img').forEach((i) => { if (!i.hasAttribute('alt')) add('img-alt', i.src); });

  // target size (buttons, radios, tiles, standalone links) — WCAG 2.5.8 minimum 24px, we aim for 44px
  let small = 0;
  document.querySelectorAll('button,[role=radio],a.tile,a.btn,.opt,input[type=checkbox]').forEach((el) => {
    if (!vis(el)) return; const r = el.getBoundingClientRect();
    if (el.type === 'checkbox') { if (r.width < 20 || r.height < 20) { small++; add('target', 'checkbox ' + Math.round(r.width) + 'x' + Math.round(r.height)); } return; }
    if (r.height < 40) { small++; add('target', (el.innerText || el.className).trim().slice(0, 25) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); }
  });
  out.stats.smallTargets = small;

  // contrast
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { c: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = (el) => { let e = el; while (e) { const s = getComputedStyle(e); const b = parse(s.backgroundColor); if (b && b.a > 0.9) return { c: b.c }; if (s.backgroundImage !== 'none' && /gradient/.test(s.backgroundImage)) { const m = s.backgroundImage.match(/rgba?\([^)]+\)/g); if (m) { const first = parse(m[m.length - 1]); if (first && first.a > 0.9) return { c: first.c, grad: true }; } } e = e.parentElement; } return { c: [255, 255, 255] }; };
  const seen = new Set(); let low = 0, checked = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const t = w.currentNode; if (!t.textContent.trim()) continue; const el = t.parentElement; if (!el || seen.has(el) || !vis(el)) continue; seen.add(el);
    if (el.closest('.hp,[hidden],.sr,.skip')) continue;
    const s = getComputedStyle(el); const fg = parse(s.color); if (!fg) continue;
    const bg = bgOf(el); const L1 = lum(fg.c), L2 = lum(bg.c); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700; const large = px >= 24 || (px >= 18.66 && bold);
    checked++;
    if (ratio < (large ? 3 : 4.5)) { low++; add('contrast', ratio.toFixed(2) + ' "' + el.textContent.trim().slice(0, 28) + '" ' + s.color + ' on rgb(' + bg.c + ')' + (bg.grad ? ' (gradient end)' : '')); }
  }
  out.stats.textChecked = checked; out.stats.lowContrast = low;
  return out;
}

(async () => {
  process.env.PORT = '4196';
  const { server } = await start(4196);
  const base = 'http://localhost:4196';
  const browser = await chromium.launch({ channel: 'msedge' });
  let total = 0;
  const report = (name, issues, stats) => { total += issues.length; console.log((issues.length ? '✘ ' : '✔ ') + name + (stats ? ' ' + JSON.stringify(stats) : '')); issues.slice(0, 12).forEach((i) => console.log('    ' + i)); };

  for (const [mode, vp] of [['mobile-390', { width: 390, height: 844 }], ['desktop-1440', { width: 1440, height: 900 }]]) {
    const ctx = await browser.newContext({ viewport: vp, locale: 'he-IL' }); const p = await ctx.newPage();
    const errors = []; p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', (e) => errors.push(String(e)));
    for (const [n, u] of PAGES) {
      await p.goto(base + u); await p.waitForTimeout(700);
      const r = await p.evaluate(pageChecks); report(`${mode} ${n}`, r.issues, r.stats);
    }
    // result + form screens
    await p.goto(base + '/kaspchem/check/mortgage');
    const pick = async (l) => { const prev = await p.locator('.q h1').first().textContent(); await p.getByRole('radio', { name: l, exact: true }).first().click(); await p.waitForFunction((x) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== x; }, prev); };
    await pick('כן, יש לי משכנתה'); await pick('לפני יותר מחמש שנים'); await pick('לא'); await pick('כן');
    await p.waitForSelector('#result h1'); await p.waitForTimeout(2200);
    report(`${mode} result`, (await p.evaluate(pageChecks)).issues);
    await p.getByRole('button', { name: 'אני רוצה עזרה בבדיקה' }).click(); await p.waitForTimeout(700);
    const rf = await p.evaluate(pageChecks); report(`${mode} lead-form`, rf.issues, rf.stats);

    // focus visibility while tabbing through the form
    await p.goto(base + '/kaspchem/'); let invisible = 0, stops = 0;
    for (let i = 0; i < 18; i++) { await p.keyboard.press('Tab'); const ok = await p.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; }); if (ok === null) continue; stops++; if (!ok) invisible++; }
    console.log((invisible ? '✘ ' : '✔ ') + `${mode} keyboard focus visible on ${stops - invisible}/${stops} stops`); total += invisible;
    if (errors.length) { console.log('✘ ' + mode + ' console errors:', errors.slice(0, 5)); total += errors.length; } else console.log('✔ ' + mode + ' no console errors');
    await ctx.close();
  }

  // ---- resilience ----
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL' }); const p = await ctx.newPage();
  const pick = async (l) => { const prev = await p.locator('.q h1').first().textContent(); await p.getByRole('radio', { name: l, exact: true }).first().click(); await p.waitForFunction((x) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== x; }, prev); };
  // reload mid-wizard keeps progress
  await p.goto(base + '/kaspchem/check/mortgage'); await pick('כן, יש לי משכנתה'); await p.reload(); await p.waitForSelector('.q h1');
  const resumed = (await p.locator('.pmeta').innerText()).includes('2'); console.log((resumed ? '✔' : '✘') + ' reload mid-wizard resumes at question 2'); total += resumed ? 0 : 1;
  // browser Back steps one question back
  await p.goBack(); await p.waitForTimeout(400);
  const backOk = (await p.locator('.q h1').innerText()).includes('האם יש לכם משכנתה'); console.log((backOk ? '✔' : '✘') + ' browser Back returns to previous question'); total += backOk ? 0 : 1;
  // config API down → bundled seed still serves the questionnaire
  await p.route('**/api/kaspchem/config', (r) => r.abort()); await p.goto(base + '/kaspchem/check/household'); await p.waitForTimeout(800);
  const seedOk = await p.locator('.q h1').count(); console.log((seedOk ? '✔' : '✘') + ' config API down → seed questionnaire still renders'); total += seedOk ? 0 : 1; await p.unroute('**/api/kaspchem/config');
  // lead API 500 → friendly error, button re-enabled, no double submit
  await p.goto(base + '/kaspchem/check/mortgage'); await p.evaluate(() => sessionStorage.clear()); await p.reload();
  await pick('כן, יש לי משכנתה'); await pick('לפני יותר מחמש שנים'); await pick('לא'); await pick('כן');
  await p.waitForSelector('#result h1'); await p.waitForTimeout(1800); let calls = 0;
  await p.route('**/api/kaspchem/lead', async (r) => { calls++; await new Promise((x) => setTimeout(x, 400)); r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"server_error"}' }); });
  await p.getByRole('button', { name: 'אני רוצה עזרה בבדיקה' }).click(); await p.fill('#f-name', 'בדיקה'); await p.fill('#f-phone', '0501234567'); await p.check('#c-contact');
  await p.getByRole('button', { name: 'שליחה' }).dblclick(); await p.waitForSelector('.formerr'); await p.waitForTimeout(300);
  const reenabled = await p.getByRole('button', { name: 'שליחה' }).isEnabled();
  console.log((calls === 1 ? '✔' : '✘') + ' double-click sends once (calls=' + calls + ')'); console.log((reenabled ? '✔' : '✘') + ' server error shown, button re-enabled'); total += (calls === 1 ? 0 : 1) + (reenabled ? 0 : 1);
  await ctx.close(); await browser.close(); server.close();
  console.log(total ? `\n${total} issue(s)` : '\nall audit checks passed'); process.exit(total ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
