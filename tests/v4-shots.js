// Screenshots of the v4 DRAFT questionnaires on the local test server (never published): multi-select question + rich result screen.
const { chromium } = require('@playwright/test'); const fs = require('fs'); const path = require('path');
process.env.TOPICS_FILE = path.join(__dirname, '..', 'docs', 'research', 'drafts-v4', 'ALL-v4.draft.json'); process.env.PORT = '4231';
const { start } = require('./dev-server');
const OUT = path.join(__dirname, 'shots', 'v4'); fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const { server } = await start(4231); const base = 'http://localhost:4231';
  const b = await chromium.launch({ channel: 'msedge' });
  for (const [mode, vp, mobile] of [['mobile', { width: 390, height: 844 }, true], ['desktop', { width: 1440, height: 900 }, false]]) {
    for (const topic of ['lost-funds', 'tax-refunds', 'national-insurance']) {
      const ctx = await b.newContext({ viewport: vp, locale: 'he-IL', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 }); const p = await ctx.newPage();
      await p.goto(base + '/kaspchem/check/' + topic); await p.waitForSelector('.opt'); await p.waitForTimeout(600);
      let shotQ = false, n = 0;
      while (!(await p.locator('#result').count()) && n++ < 8) {
        const multi = await p.locator('.opt.chk').count();
        if (multi) {
          const opts = p.locator('.opt.chk:not([data-x])'); const c = Math.min(await opts.count(), 3);
          for (let i = 0; i < c; i++) await opts.nth(i).click();
          if (!shotQ) { await p.waitForTimeout(300); await p.screenshot({ path: `${OUT}/${mode}-${topic}-multi-question.png`, fullPage: true }); shotQ = true; }
          await p.locator('#mgo').click();
        } else { await p.locator('.opt').first().click(); }
        await p.waitForTimeout(700);
      }
      await p.waitForSelector('#result h1', { timeout: 10000 }); await p.waitForTimeout(2500);
      await p.screenshot({ path: `${OUT}/${mode}-${topic}-result.png`, fullPage: true });
      await ctx.close();
    }
  }
  await b.close(); server.close(); console.log('done', fs.readdirSync(OUT).length);
})().catch((e) => { console.error(e); process.exit(1); });
