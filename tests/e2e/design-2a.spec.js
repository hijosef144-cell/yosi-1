const { test, expect } = require('@playwright/test');

// Stage 2a: typed headline (sentence 3 stays off), the single short caveat on results, ring + coin jar around the question.
// Runs at 360 / 390 / 768 / 1440 (all projects). No data is sent anywhere; nothing here needs the database.
const S1 = 'אתם משלמים יותר מדי...', S2 = 'המשכנתא? הביטוח?הבנק?';
const pick = async (page, label) => {
  const prev = await page.locator('.q h1').first().textContent();
  await page.getByRole('radio', { name: label, exact: true }).first().click();
  await page.waitForFunction((p) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== p; }, prev);
};
const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
// Edge's phone emulation can report a layout viewport 2px wider than the page (the unmodified wizard does too), so for the wizard we check that no element sticks out instead.
const nothingSticksOut = async (page) => expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('body *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.left < -0.5) && !e.closest('#kp-defs'); }).map((e) => e.tagName + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })).toEqual([]);
const frac = (page) => page.locator('.kp-ring:visible').first().getAttribute('data-frac').then(Number);
const coins = (page) => page.locator('.kp-jar:visible').first().getAttribute('data-coins').then(Number);

test('headline: types sentence 1, 2, then rests on sentence 1; sentence 3 is not shown; the page does not move', async ({ page }) => {
  await page.goto('/kaspchem');
  const h1 = page.locator('#h');
  await expect(h1.locator('.sr')).toHaveText(S1 + ' ' + S2);                          // screen readers get both enabled sentences, once
  await expect(h1.locator('.tw-vis')).toHaveAttribute('aria-hidden', 'true');           // the typed layer is decoration
  await expect(h1.locator('.tw-cur')).toHaveText('_');
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400); // fonts settled: the reserved height is final
  const h0 = (await h1.boundingBox()).height;
  await expect(h1).toHaveClass(/done/, { timeout: 12000 });
  await expect(h1.locator('.tw-t')).toHaveText(S1);                                     // rests on the same text the no-JS page shows
  expect(Math.abs((await h1.boundingBox()).height - h0)).toBeLessThanOrEqual(1);       // height reserved: no layout shift while typing
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('ברגע זה');  // sentence 3 stays off until stage 3
  expect(await page.evaluate(() => /\d/.test(document.getElementById('h').innerText))).toBe(false); // no number anywhere in the headline
  await expect(page.locator('.tile')).toHaveCount(10);
  await noHScroll(page);
});

test('headline: it passes through sentence 2 while typing', async ({ page }) => {
  await page.goto('/kaspchem');
  await page.waitForFunction((s) => (document.querySelector('.tw-t') || {}).textContent === s, S2, { timeout: 12000 });
});

test('headline: any interaction stops the animation and shows the resting sentence at once', async ({ page }) => {
  await page.goto('/kaspchem');
  await page.waitForTimeout(700);
  await page.keyboard.press('Shift');
  await expect(page.locator('#h')).toHaveClass(/done/);
  await expect(page.locator('#h .tw-t')).toHaveText(S1);
});

test('headline: with reduced motion nothing is animated and both sentences are simply shown', async ({ browser }, ti) => {
  const ctx = await browser.newContext({ baseURL: ti.project.use.baseURL, viewport: ti.project.use.viewport, reducedMotion: 'reduce', locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.goto('/kaspchem');
  await expect(page.locator('#h')).toHaveClass(/tw-static/);
  await expect(page.locator('#h .tw-line')).toHaveText([S1, S2]);
  await expect(page.locator('#h .tw-cur')).toHaveCount(0);
  await noHScroll(page);
  await ctx.close();
});

test('headline: sentence 3 is wired but off; it needs a real integer, with the right singular form', async ({ page }) => {
  await page.goto('/kaspchem');
  const r = await page.evaluate(() => { const H = window.KaspHeadline; return { one: H.thirdSentence(1), many: H.thirdSentence(12), zero: H.thirdSentence(0), frac: H.thirdSentence(1.5), nan: H.thirdSentence(NaN), str: H.thirdSentence('6'), late: H.setThird(5) }; });
  expect(r.many).toBe('ברגע זה יש 12 אנשים שנעזרים בנו וחוסכים ומרוויחים');
  expect(r.one).toBe('ברגע זה יש אדם אחד שנעזר בנו וחוסך ומרוויח');
  expect([r.zero, r.frac, r.nan, r.str]).toEqual([null, null, null, null]);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.KaspHeadline.setThird(5))).toBe(false);       // too late once the animation has started
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('ברגע זה');
});

test('wizard: ring and coin jar - beside the card on wide screens, compact in the header otherwise; card width unchanged', async ({ page }, ti) => {
  await page.goto('/kaspchem/check/household');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await page.locator('.opt').first().waitFor();
  const vw = page.viewportSize().width, card = await page.locator('#app').boundingBox();
  const wide = vw >= 1180;
  expect(Math.round(card.width)).toBe(Math.min(680, vw - 32));                          // the question card keeps its width at every viewport
  await page.waitForTimeout(900);                                                       // the slide-in of the card (existing behaviour) is over
  await nothingSticksOut(page);
  if (wide) {
    const ring = await page.locator('#kp-ring .kp-ring').boundingBox(), jar = await page.locator('#kp-jar .kp-jar').boundingBox();
    expect(ring.x).toBeGreaterThanOrEqual(card.x + card.width);                         // ring: right of the card (RTL start side)
    expect(jar.x + jar.width).toBeLessThanOrEqual(card.x);                              // jar: left of the card
    expect(ring.width).toBeGreaterThanOrEqual(150); expect(jar.height).toBeGreaterThanOrEqual(150); // substantial, not a tiny ornament
    await expect(page.locator('.kp-mini')).toBeHidden();
  } else {
    await expect(page.locator('#kp-ring')).toBeHidden(); await expect(page.locator('#kp-jar')).toBeHidden();
    const mini = await page.locator('.kp-mini').boundingBox();
    expect(mini.x).toBeGreaterThanOrEqual(card.x - 1); expect(mini.x + mini.width).toBeLessThanOrEqual(card.x + card.width + 1);
    expect(mini.height).toBeLessThan(60);                                               // compact: sits in the existing header row
  }
  await expect(page.locator('.kp-ring, .kp-jar, .kp-mini, .side').first()).toBeAttached();
  for (const sel of ['#kp-ring', '#kp-jar', '.kp-mini']) expect(await page.locator(sel).first().getAttribute('aria-hidden')).toBe('true'); // decoration only
  await expect(page.locator('[role=progressbar]')).toBeVisible();                       // the existing bar stays
  expect(await page.locator('.progress.segs span').count()).toBeGreaterThan(2);
});

test('wizard: progress fills as questions are answered, moves back when the user steps back, and ends full', async ({ page }) => {
  await page.goto('/kaspchem/check/lost-funds');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await page.locator('.opt').first().waitFor();
  expect(await frac(page)).toBe(0); expect(await coins(page)).toBe(0);
  await pick(page, 'מקום אחד');
  await expect.poll(() => frac(page)).toBeGreaterThan(0);
  const f1 = await frac(page), c1 = await coins(page);
  expect(c1).toBe(Math.round(f1 * 20));
  await pick(page, 'לא');
  await expect.poll(() => frac(page)).toBeGreaterThan(f1);
  await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
  await expect.poll(async () => Math.abs((await frac(page)) - f1)).toBeLessThan(0.011);   // stepping back is allowed to lower it
  await pick(page, 'לא'); await pick(page, 'לא'); await pick(page, 'לא');
  await expect(page.locator('#result h1')).toBeVisible({ timeout: 8000 });
  await expect.poll(() => frac(page)).toBe(1);
  expect(await coins(page)).toBe(20);
});

test('results: only the short caveat; the long paragraph and the old footer note are gone (found, none, insufficient)', async ({ page }) => {
  const OLD = ['נקודות התחלה ברורות', 'ולא זכאות מאומתת', 'אינה ייעוץ מקצועי', 'הבדיקה כללית ומבוססת'];
  const run = async (topic, answers, expectText) => {
    await page.goto('/kaspchem/check/' + topic); await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.locator('.opt').first().waitFor();
    for (const a of answers) await pick(page, a);
    await expect(page.locator('#result h1')).toContainText(expectText, { timeout: 8000 });
    const txt = await page.locator('#result').innerText();
    expect(txt).toContain('תוצאות ראשוניות בלבד');
    expect((txt.match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
    OLD.forEach((o) => expect(txt).not.toContain(o));
    await noHScroll(page);
  };
  await page.goto('/kaspchem/check/household'); await page.evaluate(() => sessionStorage.clear()); await page.reload();
  for (let i = 0; i < 4; i++) { await page.locator('.opt').first().waitFor(); await page.locator('.opt').first().click(); await page.waitForTimeout(450); }
  await expect(page.locator('#result h1')).toContainText('זיהינו', { timeout: 8000 });
  const found = await page.locator('#result').innerText();
  expect(found).toContain('תוצאות ראשוניות בלבד'); OLD.forEach((o) => expect(found).not.toContain(o));
  await run('lost-funds', ['מקום אחד', 'לא', 'לא', 'לא'], 'לא זיהינו');
  await run('lost-funds', ['לא זוכר/ת', 'לא', 'לא', 'לא'], 'חסר לנו מידע');
});
