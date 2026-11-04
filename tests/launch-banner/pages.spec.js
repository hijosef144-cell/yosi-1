// Every public page of the site gets the banner; no internal page does; no banner-caused errors or overlaps on any of them.
const { test, expect } = require('@playwright/test');
const { execFileSync } = require('child_process');
const path = require('path');
const { waitBanner, currentMode, overlaps, lastContentAboveBar, MODE_SEL } = require('./helpers');

const root = path.resolve(__dirname, '..', '..');
const all = execFileSync('git', ['-c', 'core.quotepath=off', 'ls-files', '*.html'], { cwd: root, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
const INTERNAL = [/^admin\//, /^kaspchem\//, /^tests?\//, /^docs?\//, /^scripts\//];
const isPublic = f => !INTERNAL.some(re => re.test(f));
const publicPages = all.filter(isPublic);
const internalPages = all.filter(f => !isPublic(f));

const toUrl = f => '/' + f.split('/').map(encodeURIComponent).join('/');

test('page inventory: counts and groups', async () => {
  console.log(`public pages: ${publicPages.length}, internal: ${internalPages.length}`);
  const groups = {};
  for (const f of publicPages) { const g = f.startsWith('knowledge/dictionary/') ? 'knowledge dictionary term' : f.startsWith('knowledge/guides/') ? 'knowledge guide' : f.startsWith('knowledge/') ? 'knowledge index' : /^[^/]+\.html$/.test(f) && /[֐-׿]/.test(f) ? 'calculator (Hebrew name)' : 'site page'; groups[g] = (groups[g] || 0) + 1; }
  console.log(JSON.stringify(groups));
  expect(publicPages.length).toBeGreaterThan(80);
});

test('the shared tag is on every public page and on no internal page (script check)', async () => {
  const out = execFileSync('node', ['scripts/apply-launch-banner.js', '--check'], { cwd: root, encoding: 'utf8' });
  expect(out).toContain('OK: every public page has the tag');
});

for (const f of internalPages) {
  test(`internal page has no tag: ${f}`, async () => {
    const src = require('fs').readFileSync(path.join(root, f), 'utf8');
    expect(src).not.toContain('launch-banner.js');
  });
}

for (const [label, viewport, mobile, allowed] of [['390 phone', { width: 390, height: 844 }, true, ['bar']], ['1440 desktop', { width: 1440, height: 900 }, false, ['full', 'totem', 'tab', 'bar']], ['1650 wide', { width: 1650, height: 1000 }, false, ['full', 'totem', 'tab', 'bar']], ['1920 wide', { width: 1920, height: 1080 }, false, ['full', 'totem', 'tab', 'bar']], ['2000 wide', { width: 2000, height: 1100 }, false, ['full', 'totem', 'tab', 'bar']]]) {
  test.describe(`sweep ${label}`, () => {
    // the very wide screen: every non-dictionary page plus a handful of dictionary terms (the term pages share one template)
    const list = /^(1650|1920|2000)/.test(label) ? publicPages.filter((f, i) => !f.startsWith('knowledge/dictionary/') || i % 16 === 0) : publicPages;
    for (const f of list) {
      test(f, async ({ browser }) => {
        const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
        const page = await ctx.newPage();
        const bannerErrors = [];
        page.on('pageerror', e => { if (/launch-banner/.test(e.stack || '') || /lb-/.test(e.message)) bannerErrors.push(e.message); });
        await page.goto(toUrl(f), { waitUntil: 'domcontentloaded' });
        await waitBanner(page);
        const expected = await currentMode(page);
        expect(allowed, `mode ${expected}`).toContain(expected);
        console.log(`MODE ${label} ${f} -> ${expected}`);
        expect(bannerErrors).toEqual([]);
        const bad = await overlaps(page, MODE_SEL[expected], expected === 'bar');
        expect(bad, JSON.stringify(bad.slice(0, 3))).toEqual([]);
        if (expected === 'bar') { const end = await lastContentAboveBar(page); expect(end.maxBottom, JSON.stringify(end)).toBeLessThanOrEqual(end.barTop + 2); }
        await ctx.close();
      });
    }
  });
}
