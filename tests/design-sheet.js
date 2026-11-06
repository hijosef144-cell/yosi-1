// Generates the design-review screenshots (desktop + mobile) of every key screen, plus two contact sheets.
// Runs against the local test server (in-memory DB). Output: tests/shots/final/
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { start } = require('./dev-server');

const OUT = path.join(__dirname, 'shots', 'final');
const ADMIN = '?test=' + encodeURIComponent('yosi@example.test|admin');
const MODES = {
  desktop: { viewport: { width: 1440, height: 900 }, isMobile: false },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
};

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  process.env.PORT = '4195';
  const { server } = await start(4195);
  const base = 'http://localhost:4195';
  const browser = await chromium.launch({ channel: 'msedge' });

  // seed a few requests so admin screens show real content
  const lead = (b) => fetch(base + '/api/kaspchem/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign({ consentContact: true, consentMarketing: false }, b)) });
  await lead({ topic: 'mortgage', answers: { has: 'yes', when: 'old', reviewed: 'no', know: 'no' }, name: 'דנה לוי (ניסוי)', phone: '0541110001' });
  await lead({ topic: 'lost-funds', answers: { jobs: 'many', forgotten: 'yes', inherit: 'no', oldacc: 'no', checked: 'no' }, name: 'משה כהן (ניסוי)', phone: '0541110002', email: 'x@example.test' });
  await lead({ topic: 'tax-refunds', answers: { work: 'part', multi: 'yes', filed: 'no', family: 'yes', deposits: 'yes' }, name: 'רות אברהם (ניסוי)', phone: '0541110003' });

  for (const [mode, opts] of Object.entries(MODES)) {
    const ctx = await browser.newContext(Object.assign({ locale: 'he-IL' }, opts));
    const p = await ctx.newPage();
    let n = 0;
    const shot = async (name, full) => { n++; await p.screenshot({ path: path.join(OUT, `${mode}-${String(n).padStart(2, '0')}-${name}.png`), fullPage: !!full }); };
    const pick = async (label) => { const prev = await p.locator('.q h1').first().textContent(); await p.getByRole('radio', { name: label, exact: true }).first().click(); await p.waitForFunction((x) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== x; }, prev); };

    // ---- public ----
    await p.goto(base + '/kaspchem/'); await p.waitForSelector('.tile'); await p.waitForTimeout(1500);
    await shot('landing-top'); await shot('landing-full', true);
    await p.goto(base + '/kaspchem/check/tax-refunds'); await p.waitForSelector('.opt'); await p.waitForTimeout(600);
    await shot('question-first');
    await pick('עבדתי חלק מהשנה'); await p.waitForTimeout(500); await shot('question-branch');
    await pick('כן'); await pick('לא'); await pick('כן'); await p.waitForTimeout(500); await shot('question-last');
    await p.getByRole('radio', { name: 'כן', exact: true }).first().click();
    await p.waitForSelector('#result .scan'); await p.waitForTimeout(250); await shot('result-scan');
    await p.waitForSelector('#result h1'); await p.waitForTimeout(2200); await shot('result-found', true);
    await p.getByRole('button', { name: 'אני רוצה עזרה בבדיקה' }).click(); await p.waitForTimeout(700);
    await p.fill('#f-name', 'דנה לוי (ניסוי)'); await p.fill('#f-phone', '0541119999'); await p.check('#c-contact'); await shot('form-open', true);
    await p.getByRole('button', { name: 'שליחה' }).click(); await p.waitForSelector('#done'); await p.waitForTimeout(900); await shot('thanks', true);
    // insufficient + none
    await p.evaluate(() => sessionStorage.clear());
    await p.goto(base + '/kaspchem/check/lost-funds'); await p.waitForSelector('.opt');
    await pick('לא זוכר/ת'); await pick('לא'); await pick('לא'); await pick('לא');
    await p.waitForSelector('#result h1'); await p.waitForTimeout(1200); await shot('result-insufficient');
    await p.evaluate(() => sessionStorage.clear());
    await p.goto(base + '/kaspchem/check/lost-funds'); await p.waitForSelector('.opt');
    await pick('מקום אחד'); await pick('לא'); await pick('לא'); await pick('לא');
    await p.waitForSelector('#result h1'); await p.waitForTimeout(1200); await shot('result-none');
    await p.goto(base + '/kaspchem/terms.html'); await shot('legal-draft');

    // ---- admin ----
    await p.goto(base + '/admin/kaspchem/'); await p.waitForSelector('.gate'); await shot('admin-login');
    await p.goto(base + '/admin/kaspchem/' + ADMIN); await p.waitForSelector('#tabs button'); await p.waitForTimeout(800); await shot('admin-dashboard');
    await p.locator('#tabs [data-t="requests"]').click(); await p.waitForSelector('tr.click'); await shot('admin-requests', true);
    await p.locator('tr.click').first().click(); await p.waitForSelector('.drawer'); await p.waitForTimeout(500); await shot('admin-request-detail');
    await p.keyboard.press('Escape');
    await p.locator('#tabs [data-t="forms"]').click(); await p.locator('[data-e="mortgage"]').click(); await p.waitForSelector('.qcard'); await shot('admin-questionnaire-editor');
    await p.locator('#tabs [data-t="pricing"]').click(); await p.waitForSelector('#xf'); await shot('admin-pricing');
    await p.locator('#tabs [data-t="settings"]').click(); await p.waitForSelector('#la'); await shot('admin-settings');
    await ctx.close();
  }
  await browser.close(); server.close();

  // contact sheets
  for (const mode of Object.keys(MODES)) {
    const files = fs.readdirSync(OUT).filter((f) => f.startsWith(mode + '-') && !f.includes('sheet')).sort();
    const w = mode === 'desktop' ? 700 : 260;
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#dfe8e7;font:14px system-ui"><div style="display:flex;flex-wrap:wrap;gap:18px;padding:18px;align-items:flex-start">` +
      files.map((f) => `<figure style="margin:0;width:${w}px"><img src="${f}" style="width:100%;border:1px solid #9db9b6;background:#fff;display:block"><figcaption style="padding:4px 2px;direction:ltr">${f.replace(mode + '-', '').replace('.png', '')}</figcaption></figure>`).join('') + '</div>';
    fs.writeFileSync(path.join(OUT, `${mode}-sheet.html`), html);
  }
  const b2 = await chromium.launch({ channel: 'msedge' });
  for (const mode of Object.keys(MODES)) {
    const pg = await b2.newPage({ viewport: { width: mode === 'desktop' ? 1500 : 1500, height: 900 } });
    await pg.goto('file:///' + path.join(OUT, `${mode}-sheet.html`).replace(/\\/g, '/'));
    await pg.waitForTimeout(800);
    await pg.screenshot({ path: path.join(OUT, `SHEET-${mode}.png`), fullPage: true });
  }
  await b2.close();
  console.log('done', fs.readdirSync(OUT).length, 'files in', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
