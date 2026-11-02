const { test, expect } = require('@playwright/test');

// Stage 4: the quick check. Runs at 360 / 390 / 768 / 1440 (all projects) against the local test server (in-memory database); nothing real is touched.
const ADM = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const TEN = ['lost-funds', 'tax-refunds', 'housing', 'mortgage', 'insurance-pension', 'payslip-rights', 'national-insurance', 'banking-loans', 'household', 'education-work'];

const L = {
  employee: 'שכיר/ה', self: 'עצמאי/ת', seeking: 'לא עובד/ת כרגע', retired: 'גמלאי/ת', student: 'סטודנט/ית, חייל/ת או משוחרר/ת',
  mortgageOld: 'בדירה שלי, עם משכנתה שנלקחה או שונתה לפני חמש שנים או יותר', mortgageNew: 'בדירה שלי, עם משכנתה שנלקחה או שונתה בחמש השנים האחרונות', owned: 'בדירה שלי, בלי משכנתה', rent: 'בשכירות', other: 'אחר, למשל גרים עם המשפחה',
  hbYes: 'כן, בדקתי', hbNo: 'לא בדקתי', hbUnk: 'לא בטוח/ה',
  birth: 'לידה או אימוץ', job: 'פיטורים או סיום עבודה', none: 'אף אחד מאלה', jobs: 'עבדתי ביותר ממקום עבודה אחד במהלך החיים', oldacc: 'החלפתי בנק או דירה בלי לסגור חשבונות ישנים',
  coverRecent: 'בשלוש השנים האחרונות', coverOld: 'לפני יותר משלוש שנים',
  recent: 'בשנה האחרונה', old: 'לפני יותר משנה', never: 'מעולם לא בדקתי',
  yes: 'כן', no: 'לא', unk: 'לא בטוח/ה'
};

const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2); // Edge phone emulation: see nothingSticksOut
// (the honeypot field of the lead form is deliberately parked off-screen.) Edge's phone emulation can report a layout viewport 2px wider than the page, so we check that no element sticks out instead.
const nothingSticksOut = async (page) => expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('body *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.left < -0.5) && !e.closest('#kp-defs') && !e.closest('.hp'); }).map((e) => e.tagName + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })).toEqual([]);
const frac = (page) => page.locator('.kp-ring:visible').first().getAttribute('data-frac').then(Number);
const coins = (page) => page.locator('.kp-jar:visible').first().getAttribute('data-coins').then(Number);
const h1 = (page) => page.locator('.q h1').first().textContent();

async function open(page) {
  await page.goto('/kaspchem/check/quick');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await page.locator('.opt').first().waitFor();
}
async function changed(page, prev) { await page.waitForFunction((p) => { const h = document.querySelector('.q h1'); return !h || h.textContent !== p; }, prev); }
async function pick(page, label) { const prev = await h1(page); await page.getByRole('radio', { name: label, exact: true }).first().click(); await changed(page, prev); }
async function multi(page, labels) {
  const prev = await h1(page);
  for (const l of labels) await page.getByRole('checkbox', { name: l, exact: true }).click();
  await page.locator('#mgo').click(); await changed(page, prev);
}
// A whole path. `a` = { work, home, hb?, events, lost, cover, bank, bills, tax?, pay? } (labels)
async function answer(page, a) {
  await pick(page, a.work); await pick(page, a.home);
  if (a.hb) await pick(page, a.hb);
  await multi(page, a.events); await multi(page, a.lost);
  await pick(page, a.cover); await pick(page, a.bank); await pick(page, a.bills);
  if (a.tax) await pick(page, a.tax);
  if (a.pay) await pick(page, a.pay);
}
const result = (page) => page.locator('#result h1').waitFor({ timeout: 8000 });
const NONE_PATH = { work: L.employee, home: L.owned, hb: L.hbYes, events: [L.none], lost: [L.none], cover: L.coverRecent, bank: L.recent, bills: L.recent, tax: L.yes, pay: L.yes };
const BIG_PATH = { work: L.employee, home: L.mortgageOld, hb: L.hbNo, events: [L.birth, L.job], lost: [L.jobs, L.oldacc], cover: L.coverOld, bank: L.old, bills: L.never, tax: L.no, pay: L.no };

test('home page: the featured quick tile is above the ten topic tiles, which are unchanged; the ring of light stays on the ten', async ({ page }) => {
  await page.goto('/kaspchem');
  const tile = page.locator('a.qk-tile');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute('href', '/kaspchem/check/quick');
  await expect(tile).toContainText('אני לא יודע מה מגיע לי — תבדקו אותי');
  await expect(tile).toContainText('עד עשר שאלות קצרות');
  await expect(page.locator('.tile')).toHaveCount(10);                                  // the ten are still the ten
  await expect(page.locator('#tiles .qk-tile')).toHaveCount(0);                          // the quick tile is not one of the cubes
  await expect(page.locator('#tiles > li')).toHaveCount(10);
  for (let i = 0; i < 3; i++) { await expect(page.locator('.tile.lit')).toHaveCount(1); await expect(page.locator('.qk-tile.lit, .qk-tile.tile')).toHaveCount(0); await page.waitForTimeout(1400); }
  // one snapshot of the three boxes (measured in the same frame, so a moving page cannot skew the comparison)
  const { t, grid, first } = await page.evaluate(() => { const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }; return { t: r(document.querySelector('a.qk-tile')), grid: r(document.querySelector('#tiles')), first: r(document.querySelector('.tile')) }; });
  expect(t.y + t.height).toBeLessThanOrEqual(first.y);                                   // above the grid, no overlap
  expect(t.height).toBeGreaterThanOrEqual(44);
  expect(Math.abs(t.x - grid.x)).toBeLessThanOrEqual(2); expect(Math.abs(t.width - grid.width)).toBeLessThanOrEqual(2); // full width of the grid at every viewport
  if (page.viewportSize().width < 700) expect(t.width).toBeGreaterThan(page.viewportSize().width - 40);
  await nothingSticksOut(page);
  expect(await page.evaluate(() => document.querySelector('.qk-arrow').getBoundingClientRect().left < document.querySelector('.qk-h').getBoundingClientRect().left)).toBe(true); // RTL: the arrow is at the end (left)
});

test('home page: the quick tile is reachable and works by keyboard', async ({ page }) => {
  await page.goto('/kaspchem');
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('qk-tile')); }
  expect(reached, 'Tab reaches the quick tile before the ten topic tiles').toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/kaspchem\/check\/quick$/);
  await expect(page.locator('.crumb')).toContainText('בדיקה מהירה');
});

test('questions: a ten-question path with live progress (ring and jar rise, step back lowers), branching and no horizontal overflow', async ({ page }) => {
  await open(page);
  await expect(page.locator('.pmeta')).toContainText('שאלה 1 מתוך 7');
  await expect(page.locator('.q')).toContainText('עד עשר שאלות קצרות');                // the topic intro on the first screen
  expect(await frac(page)).toBe(0); expect(await coins(page)).toBe(0);
  const seen = [];
  const rise = async () => { await expect.poll(() => frac(page)).toBeGreaterThan(seen[seen.length - 1]); seen.push(await frac(page)); };
  seen.push(0);
  await pick(page, L.employee); await rise();
  await expect(page.locator('.pmeta')).toContainText('שאלה 2 מתוך 9');                  // an employee also gets the tax and payslip questions
  await pick(page, L.mortgageOld); await rise();
  await expect(page.locator('.pmeta')).toContainText('שאלה 3 מתוך 10');                 // an owner/renter also gets the housing-benefit question
  await nothingSticksOut(page);
  await pick(page, L.hbNo); await rise();
  await expect(page.locator('.q h1')).toContainText('קרה אצלכם בשנה האחרונה');
  await multi(page, [L.birth, L.job]); await rise();
  await expect(page.locator('.q h1')).toContainText('האם אחד מהבאים נכון לגביכם');
  await multi(page, [L.jobs, L.oldacc]); await rise();
  await pick(page, L.coverOld); await rise();
  await pick(page, L.old); await rise();
  await pick(page, L.never); await rise();
  await expect(page.locator('.pmeta')).toContainText('שאלה 9 מתוך 10');
  await pick(page, L.no); await rise();
  await expect(page.locator('.pmeta')).toContainText('שאלה 10 מתוך 10');
  await expect(page.locator('.q h1')).toContainText('תלוש השכר');
  expect(await coins(page)).toBe(Math.round(seen[seen.length - 1] * 20));
  // step back: allowed to lower the progress
  const before = await frac(page);
  await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
  await expect.poll(() => frac(page)).toBeLessThan(before);
  await expect(page.locator('.q h1')).toContainText('דוח שנתי');
  await pick(page, L.no); await pick(page, L.no);
  await result(page);
  await expect.poll(() => frac(page)).toBe(1);
  expect(await coins(page)).toBe(20);
  await noHScroll(page); await nothingSticksOut(page);
});

test('branching: a retiree skips the tax and payslip questions; "other" housing skips the housing-benefit question', async ({ page }) => {
  await open(page);
  await pick(page, L.retired); await pick(page, L.other);
  await expect(page.locator('.pmeta')).toContainText('שאלה 3 מתוך 7');
  await expect(page.locator('.q h1')).toContainText('קרה אצלכם בשנה האחרונה');            // straight to the events question: no housing-benefit question
  await multi(page, [L.none]); await multi(page, [L.none]);
  await pick(page, L.coverRecent); await pick(page, L.recent);
  await expect(page.locator('.pmeta')).toContainText('שאלה 7 מתוך 7');
  await pick(page, L.recent);                                                          // seven questions and done: no tax report / payslip question
  await result(page);
  await expect(page.locator('#result h1')).toContainText('זיהינו תחום אחד שכדאי להתחיל בו');
  await expect(page.locator('.qk-sentence')).toHaveText('לפי התשובות שלכם, כדאי להתחיל בביטוח לאומי.');
  await expect(page.locator('.find')).toHaveCount(1);
});

test('multi-select screens fit, long labels wrap, tap targets are large, and the checkboxes work by keyboard (Space toggles, Enter on continue)', async ({ page }) => {
  await open(page);
  await pick(page, L.student); await pick(page, L.mortgageOld);
  // the home question has the longest labels: they wrap inside their button
  // (already answered; go back to look at it)
  await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
  await expect(page.locator('.q h1')).toContainText('איך אתם מתגוררים');
  const opts = await page.locator('.opt').evaluateAll((els) => els.map((e) => ({ w: e.scrollWidth, c: e.clientWidth, h: e.getBoundingClientRect().height, r: e.getBoundingClientRect().right, l: e.getBoundingClientRect().left })));
  for (const o of opts) { expect(o.w).toBeLessThanOrEqual(o.c + 1); expect(o.h).toBeGreaterThanOrEqual(44); }
  await pick(page, L.mortgageOld);
  await pick(page, L.hbYes);
  // now the multi-select screen by keyboard
  await expect(page.locator('.q h1')).toContainText('קרה אצלכם בשנה האחרונה');
  await expect(page.locator('.multihint')).toContainText('יותר מתשובה אחת');
  await expect(page.locator('#mgo')).toBeDisabled();
  await nothingSticksOut(page);
  for (const o of await page.locator('.opt').all()) expect((await o.boundingBox()).height).toBeGreaterThanOrEqual(44);
  const tab = async (until) => { for (let i = 0; i < 20; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(until)) return true; } return false; };
  expect(await tab(() => document.activeElement.classList.contains('opt'))).toBe(true);
  await page.keyboard.press('Space');                                                   // first option: "birth"
  await expect(page.getByRole('checkbox', { name: L.birth, exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#mgo')).toBeEnabled();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');                   // skip one, "job" is the third option
  await page.keyboard.press('Enter');
  await expect(page.getByRole('checkbox', { name: L.job, exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await tab(() => document.activeElement.id === 'mgo')).toBe(true);
  const prev = await h1(page);
  await page.keyboard.press('Enter');
  await changed(page, prev);
  await expect(page.locator('.q h1')).toContainText('האם אחד מהבאים נכון לגביכם');
  // exclusive option clears the others
  await page.getByRole('checkbox', { name: L.jobs, exact: true }).click();
  await page.getByRole('checkbox', { name: L.none, exact: true }).click();
  await expect(page.getByRole('checkbox', { name: L.jobs, exact: true })).toHaveAttribute('aria-checked', 'false');
  await nothingSticksOut(page);
});

test('wide screens: the progress ring and the coin jar sit beside the card; narrow screens show the compact pair in the header', async ({ page }) => {
  await open(page);
  const vw = page.viewportSize().width, card = await page.locator('#app').boundingBox();
  await page.waitForTimeout(900);
  if (vw >= 1180) {
    const ring = await page.locator('#kp-ring .kp-ring').boundingBox(), jar = await page.locator('#kp-jar .kp-jar').boundingBox();
    expect(ring.x).toBeGreaterThanOrEqual(card.x + card.width); expect(jar.x + jar.width).toBeLessThanOrEqual(card.x);
    await expect(page.locator('.kp-mini')).toBeHidden();
  } else {
    await expect(page.locator('#kp-ring')).toBeHidden();
    const mini = await page.locator('.kp-mini').boundingBox();
    expect(mini.x).toBeGreaterThanOrEqual(card.x - 1); expect(mini.x + mini.width).toBeLessThanOrEqual(card.x + card.width + 1);
  }
  await expect(page.locator('[role=progressbar]')).toBeVisible();
  await nothingSticksOut(page);
});

test('result: personal heading and one sentence, a card per topic with a real link to that topic\'s check, the caveat once, and no form before the click', async ({ page }) => {
  await open(page);
  await answer(page, BIG_PATH);
  await result(page);
  await expect(page.locator('#result h1')).toHaveText('זיהינו 9 תחומים שכדאי להתחיל בהם');
  await expect(page.locator('.qk-sentence')).toHaveText('לפי התשובות שלכם, כדאי להתחיל בכספים אבודים, במסים והחזרים ובביטוח לאומי, ויש עוד 6 תחומים ברשימה.');
  await expect(page.locator('#result .find')).toHaveCount(9);
  const hrefs = await page.locator('a.qk-go').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(hrefs).toEqual(['lost-funds', 'tax-refunds', 'national-insurance', 'mortgage', 'insurance-pension', 'banking-loans', 'household', 'housing', 'payslip-rights'].map((t) => '/kaspchem/check/' + t));
  // every card: the topic name as title, one line per reason, a button that names the topic; nothing from the ordinary cards
  const titles = await page.locator('#result .find > div > b').allTextContents();
  const btns = await page.locator('a.qk-go').allTextContents();
  titles.forEach((tt, i) => expect(btns[i]).toBe('לבדיקה מלאה: ' + tt));
  const payslip = page.locator('#result .find', { hasText: 'תלושי שכר וזכויות עובדים' });
  await expect(payslip.locator('.qk-reasons li')).toHaveCount(2);                        // two reasons, one card
  await expect(page.locator('#result .fxd, #result .fx, #result .big, #result a[target=_blank]')).toHaveCount(0); // no cost details, steps, official links, big number
  const txt = await page.locator('#result').innerText();
  expect((txt.match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
  // results come first: the contact form is not there until the call to action is clicked
  await expect(page.locator('#lead')).toHaveCount(0);
  await expect(page.locator('#cta')).toBeVisible();
  await expect(page.locator('#cta')).toHaveText('אני רוצה עזרה בבדיקה');
  expect(await page.locator('#cta').evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  for (const b of await page.locator('a.qk-go').all()) expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('#result a.btn.link')).toHaveAttribute('href', '/kaspchem');
  await noHScroll(page); await nothingSticksOut(page);
});

test('result: the link on a card really opens that topic\'s own questionnaire', async ({ page }) => {
  await open(page);
  await answer(page, BIG_PATH);
  await result(page);
  await page.locator('a.qk-go[href$="/mortgage"]').click();
  await expect(page).toHaveURL(/\/kaspchem\/check\/mortgage$/);
  await expect(page.locator('.q h1')).toContainText('האם יש לכם משכנתה');
  await page.goBack();
  await page.goto('/kaspchem/check/quick');                                              // the quick check remembers the answers: straight back to the result
  await result(page);
  await expect(page.locator('#result .find')).toHaveCount(9);
  for (const t of ['housing', 'payslip-rights', 'tax-refunds']) {
    await page.locator('a.qk-go[href$="/' + t + '"]').click();
    await expect(page.locator('.q h1')).toBeVisible();
    await expect(page.locator('#app h1')).not.toContainText('לא נמצא');
    await page.goto('/kaspchem/check/quick'); await result(page);
  }
});

test('result: nothing recognised ("none") uses the topic\'s own messages and offers another topic; the caveat appears once', async ({ page }) => {
  await open(page);
  await answer(page, NONE_PATH);
  await result(page);
  await expect(page.locator('#result h1')).toHaveText('כרגע לא זיהינו תחום מסוים שכדאי להתחיל בו');
  await expect(page.locator('#result .sub')).toContainText('אפשר לבדוק כל אחד מעשרת התחומים בנפרד');
  await expect(page.locator('#result .find')).toHaveCount(0);
  await expect(page.locator('#result a.btn[href="/kaspchem"]')).toHaveText('לבדוק תחום אחר');
  expect(((await page.locator('#result').innerText()).match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
  await expect(page.locator('#fix')).toBeVisible();
  await nothingSticksOut(page);
  await page.locator('#fix').click();                                                    // back to fix: the last answer is asked again
  await expect(page.locator('.q h1')).toContainText('תלוש השכר');
});

test('result: "not sure" about the tax report with nothing else leaves "insufficient" (the topic\'s own message), with a way back to fix', async ({ page }) => {
  await open(page);
  await answer(page, Object.assign({}, NONE_PATH, { tax: L.unk }));
  await result(page);
  await expect(page.locator('#result h1')).toHaveText('חסר לנו מידע כדי להמליץ על תחום');
  await expect(page.locator('#result .sub')).toContainText('אפשר לחזור ולתקן');
  await expect(page.locator('#fix')).toBeVisible();
  expect(((await page.locator('#result').innerText()).match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
  await page.locator('#fix').click();
  await expect(page.locator('.q h1')).toContainText('תלוש השכר');
});

test('lead form: opens only after the click; refuses empty name/phone and no consent; accepts an empty e-mail; the request reaches the dashboard with the recommended topics', async ({ page, request }, ti) => {
  await open(page);
  await answer(page, BIG_PATH);
  await result(page);
  await page.locator('#cta').click();
  await expect(page.locator('#lead')).toBeVisible();
  await expect(page.locator('#c-mkt')).not.toBeChecked();                                // marketing consent: separate and unchecked
  await expect(page.locator('#c-contact')).not.toBeChecked();
  await page.getByRole('button', { name: 'שליחה' }).click();
  await expect(page.locator('#e-name')).toContainText('שם'); await expect(page.locator('#e-phone')).toContainText('טלפון'); await expect(page.locator('#e-consent')).toContainText('לאשר');
  const name = 'בודק מהיר ' + ti.project.name + ' ' + Math.floor(Math.random() * 1e9);
  const phone = '05' + (2 + (ti.project.name.length % 6)) + String(Math.floor(1e6 + Math.random() * 9e6));
  await page.fill('#f-name', name); await page.fill('#f-phone', phone);
  await page.getByRole('button', { name: 'שליחה' }).click();                              // no consent
  await expect(page.locator('#e-consent')).toContainText('לאשר'); await expect(page.locator('#done')).toHaveCount(0);
  await page.fill('#f-email', 'not-an-email'); await page.check('#c-contact');
  await page.getByRole('button', { name: 'שליחה' }).click();
  await expect(page.locator('#e-email')).toContainText('אינה תקינה');
  await page.fill('#f-email', '');                                                       // e-mail is optional
  await nothingSticksOut(page);
  await page.getByRole('button', { name: 'שליחה' }).click();
  await expect(page.locator('#done')).toContainText('הפנייה התקבלה');
  await expect(page.locator('#done')).toContainText('בדיקה מהירה');
  const more = await page.locator('.more a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(more.sort()).toEqual(TEN.map((t) => '/kaspchem/check/' + t).sort());           // the ten topics only, never the quick check itself
  await noHScroll(page);
  // the dashboard side
  const list = await (await request.get('/api/kaspchem/admin/requests?topic=quick&q=' + encodeURIComponent(name), { headers: ADM })).json();
  expect(list.requests.length).toBe(1);
  expect(list.requests[0].topic).toBe('quick'); expect(list.requests[0].outcome).toBe('found');
  const d = (await (await request.get('/api/kaspchem/admin/requests/' + list.requests[0].id, { headers: ADM })).json()).request;
  expect(d.findingTitles.length).toBe(13);                                               // the 13 rules that fire on this path
  expect(d.findingTitles.some((t) => t.startsWith('מסים והחזרים: '))).toBe(true);
  expect(d.findingTitles.some((t) => t.startsWith('תלושי שכר וזכויות עובדים: '))).toBe(true);
  expect(d.consent_marketing).toBe(false);
});

test('session: a reload resumes the quick check where it was; a stale or malformed saved shape is dropped', async ({ page }) => {
  await open(page);
  await pick(page, L.employee); await pick(page, L.rent); await pick(page, L.hbNo);
  await page.reload();
  await expect(page.locator('.q h1')).toContainText('קרה אצלכם בשנה האחרונה');
  await expect(page.locator('.pmeta')).toContainText('שאלה 4 מתוך 10');
  expect(await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('kaspchem:quick')).a))).toEqual(['work', 'home', 'housebenefit']);
  // a saved multi answer of the wrong shape, an option that no longer exists, and an answer to a question that is no longer shown: all dropped
  await page.evaluate(() => sessionStorage.setItem('kaspchem:quick', JSON.stringify({ a: { work: 'employee', home: 'rent', housebenefit: 'gone', events: 'job', lost: ['jobs'], payslip: 'yes' }, o: ['work', 'home', 'housebenefit', 'events', 'lost', 'payslip'] })));
  await page.reload();
  await expect(page.locator('.q h1')).toContainText('תשלומי הדיור');                       // housebenefit (removed option) is asked again
  await expect(page.locator('.pmeta')).toContainText('שאלה 5 מתוך 10');                  // work, home, lost and payslip survived
  await pick(page, L.hbNo);
  await expect(page.locator('.q h1')).toContainText('קרה אצלכם בשנה האחרונה');            // events (wrong shape) was dropped too, so it is asked
  // finished answers resume straight at the result
  await page.evaluate(() => sessionStorage.setItem('kaspchem:quick', JSON.stringify({ a: { work: 'retired', home: 'other', events: ['none'], lost: ['none'], cover: 'recent', bank: 'recent', bills: 'recent' }, o: ['work', 'home', 'events', 'lost', 'cover', 'bank', 'bills'] })));
  await page.reload(); await result(page);
  await expect(page.locator('#result h1')).toContainText('תחום אחד');
});

test('reduced motion: the whole flow works without waiting for animations and nothing is cut off', async ({ browser, baseURL }, ti) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: ti.project.use.viewport, locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.goto(baseURL + '/kaspchem');
  await page.waitForTimeout(1500);
  await expect(page.locator('.tile.lit')).toHaveCount(0);
  await expect(page.locator('a.qk-tile')).toBeVisible();
  await page.goto(baseURL + '/kaspchem/check/quick'); await page.locator('.opt').first().waitFor();
  await answer(page, BIG_PATH);
  await page.locator('#result h1').waitFor({ timeout: 1500 });                           // no 1.3 s "summing up" pause
  await expect(page.locator('#result .find')).toHaveCount(9);
  expect(parseFloat(await page.locator('#result .find').first().evaluate((e) => getComputedStyle(e).animationDuration))).toBeLessThan(0.01);
  await nothingSticksOut(page);
  await ctx.close();
});
