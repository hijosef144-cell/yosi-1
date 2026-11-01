// Design alternatives for the Kaspchem entry on the existing homepage. DOM-injected mocks only: nothing in the repo changes.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const BASE = process.env.BASE;
const OUT = 'tests/shots/home'; fs.mkdirSync(OUT, { recursive: true });

const ICONS = ['lost-funds', 'tax-refunds', 'housing', 'mortgage', 'insurance-pension', 'payslip-rights', 'national-insurance', 'banking-loans', 'household', 'education-work'];
const mini = `<div class="kmini">${'{{icons}}'}</div>`;

const CSS = `
.kfont{font-family:'Heebo',sans-serif}
.kcard{background:linear-gradient(155deg,#0e3b41,#0a2a2f);color:#fff;border-radius:24px;box-shadow:0 8px 0 #061d21,0 24px 40px rgba(6,29,33,.25);padding:28px 22px;display:grid;gap:22px;direction:rtl}
@media(min-width:900px){.kcard{grid-template-columns:1.15fr .85fr;padding:44px 48px;align-items:center;gap:40px}}
.kbrand{display:flex;align-items:center;gap:10px;font:900 1.35rem 'Frank Ruhl Libre',serif;color:#f4d27f}
.kh{font:900 clamp(1.9rem,6vw,2.9rem)/1.15 'Frank Ruhl Libre',serif;margin:10px 0 12px}
.kp{color:#cfe3e0;max-width:34em;margin:0 0 18px;line-height:1.7}
.kbtn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 28px;border-radius:14px;background:#e3b04b;color:#0a2a2f;font-weight:700;font-size:1.05rem;text-decoration:none;box-shadow:0 4px 0 #a97a1d}
.kmicro{margin-top:12px;font-size:.88rem;color:#a9c7c3}
.kmini{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
.kmini span{aspect-ratio:1;border-radius:14px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);display:grid;place-items:center;color:#d9ece9}
.kmini svg{width:60%;height:60%}.kmini svg .a{stroke:#e3b04b}
.kpill{display:inline-flex;align-items:center;gap:10px;margin-top:18px;padding:9px 18px;border-radius:999px;background:rgba(10,42,47,.78);border:1px solid rgba(244,210,127,.55);color:#fff;font:500 .95rem 'Heebo',sans-serif;text-decoration:none;backdrop-filter:blur(6px)}
.kpill b{color:#f4d27f}.kpill i{width:8px;height:8px;border-radius:50%;background:#e3b04b;display:inline-block}
.kslim{display:flex;flex-wrap:wrap;align-items:center;gap:14px 20px;background:#fff;border:1px solid #d3e2e0;border-inline-start:6px solid #e3b04b;border-radius:16px;padding:18px 22px;direction:rtl;box-shadow:0 2px 10px rgba(30,58,138,.06)}
.kslim h3{font:900 1.35rem 'Frank Ruhl Libre',serif;color:#0a2a2f;margin:0}.kslim p{margin:0;color:#3e5f63;flex:1;min-width:220px}
.kslim a{background:#0e3b41;color:#fff;border-radius:12px;padding:12px 22px;font-weight:700;text-decoration:none}
`;

const A = (icons) => `<section id="mock" class="kfont" style="background:#f4f7fb;padding:48px 0"><div class="section-container"><div class="kcard"><div><div class="kbrand"><svg width="30" height="30" viewBox="0 0 34 34"><circle cx="15" cy="15" r="11" fill="#e3b04b"/><circle cx="15" cy="15" r="6" fill="none" stroke="#08262b" stroke-width="2.2"/><path d="M23 23l8 8" stroke="#e3b04b" stroke-width="3" stroke-linecap="round"/></svg>כספכם</div><h2 class="kh">מאתרים את הכסף האבוד שלכם</h2><p class="kp">עשרה תחומים, שלוש עד חמש שאלות קצרות, ותמונה ברורה של מה שכדאי לבדוק. בלי להשאיר פרטים לפני התוצאה.</p><a class="kbtn" href="/kaspchem">התחילו בדיקה חינמית</a><div class="kmicro">כספכם הוא ארגון חסד, בשיתוף מצפן כלכלי · הבדיקה הראשונית חינמית</div></div><div class="kmini">${icons}</div></div></div></section>`;
const B = () => `<div class="kfont" id="mock" style="text-align:center;direction:rtl"><a class="kpill" href="/kaspchem"><i></i><span><b>חדש: כספכם</b> · בדיקה חינמית בעשרה תחומים</span><span aria-hidden="true">←</span></a></div>`;
const C = () => `<section id="mock" class="kfont" style="background:#fff;padding:36px 0"><div class="section-container"><div class="kslim"><h3>כספכם</h3><p>מאתרים את הכסף האבוד שלכם: עשרה תחומים, כמה שאלות קצרות, תוצאה מיד.</p><a href="/kaspchem">להתחיל בדיקה</a></div></div></section>`;

(async () => {
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [mode, vp, mobile] of [['mobile', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    for (const alt of ['A', 'B', 'C']) {
      const ctx = await b.newContext({ viewport: vp, locale: 'he-IL', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      const p = await ctx.newPage(); await p.goto(BASE + '/'); await p.waitForTimeout(2500);
      await p.addStyleTag({ content: CSS });
      await p.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Frank+Ruhl+Libre:wght@900&family=Heebo:wght@400;500;700&display=swap' }).catch(() => {});
      await p.addScriptTag({ url: BASE + '/kaspchem/assets/icons.js' });
      await p.evaluate(({ alt, html, ICONS }) => {
        const strip = document.querySelector('a[href="/kaspchem"][aria-label]'); if (strip) strip.style.display = 'none';
        const nf = document.querySelector('#netlify-drawer, [data-netlify-drawer]'); if (nf) nf.remove();
        const icons = ICONS.map((n) => '<span>' + window.KaspIcon(n) + '</span>').join('');
        const home = document.querySelector('#home'); const hero = home.querySelector('.gradient-bg');
        const wrap = document.createElement('div'); wrap.innerHTML = html.replace('{{icons}}', icons).replace('${icons}', icons);
        if (alt === 'A') hero.after(wrap.firstElementChild);
        if (alt === 'B') hero.querySelector('.flex.flex-col').after(wrap.firstElementChild);
        if (alt === 'C') home.lastElementChild.after(wrap.firstElementChild);
      }, { alt, html: alt === 'A' ? A('{{icons}}') : alt === 'B' ? B() : C(), ICONS });
      await p.waitForTimeout(800);
      await p.evaluate((alt) => { const m = document.getElementById('mock'); const r = m.getBoundingClientRect(); window.scrollTo(0, Math.max(0, r.top + scrollY - (alt === 'B' ? 380 : 140))); }, alt);
      await p.waitForTimeout(600);
      await p.screenshot({ path: `${OUT}/alt-${alt}-${mode}.png` });
      await ctx.close();
    }
  }
  await b.close();
  // contact sheet
  const html = ['mobile', 'desktop'].map((mode) => `<h3 style="font:700 16px system-ui;direction:ltr">${mode}</h3><div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:24px">` + ['A', 'B', 'C'].map((a) => `<figure style="margin:0;width:${mode === 'mobile' ? 300 : 560}px"><img src="alt-${a}-${mode}.png" style="width:100%;border:1px solid #888"><figcaption style="font:600 15px system-ui;direction:ltr">Option ${a}</figcaption></figure>`).join('') + '</div>').join('');
  fs.writeFileSync(`${OUT}/alts.html`, `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:18px;background:#e7ecef">${html}`);
  const b2 = await chromium.launch({ channel: 'msedge' }); const pg = await b2.newPage({ viewport: { width: 1850, height: 900 } });
  await pg.goto('file:///' + require('path').resolve(OUT, 'alts.html').replace(/\\/g, '/')); await pg.waitForTimeout(600);
  await pg.screenshot({ path: `${OUT}/ALTERNATIVES.png`, fullPage: true }); await b2.close(); console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
