const { test, expect } = require('@playwright/test');
const fs = require('fs');

// Stage 3: the impact counter on the home page, headline sentence 3, and the dashboard. Runs at 360 / 390 / 768 / 1440.
// ALL figures are clearly fake round TEST DATA (1000 / 2000 / 3000 ...); each test starts by clearing every outcome and switching the counter off,
// so the other specs (which expect the counter OFF) are never affected. Applicants are unique by phone, so every width uses its own numbers.
const ADM = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const AS_ADMIN = '/admin/kaspchem/?test=' + encodeURIComponent('yosi@example.test|admin');
const WIDTHS = ['mobile-360', 'mobile-390', 'tablet-768', 'desktop-1440'];
const S1 = 'אתם משלמים יותר מדי...', S2 = 'המשכנתא? הביטוח?הבנק?';
const THIRD_1 = 'ברגע זה יש אדם אחד שנעזר בנו וחוסך ומרוויח';
const THIRD_2 = 'ברגע זה יש 2 אנשים שנעזרים בנו וחוסכים ומרוויחים';
const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const nothingSticksOut = async (page) => expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('body *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.left < -0.5) && !e.closest('#tabs'); }).map((e) => e.tagName + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })).toEqual([]);

// random per call: Playwright restarts the worker after a failed test, so a counter would repeat numbers (applicants are unique by phone)
const phoneFor = (ti) => '0528' + WIDTHS.indexOf(ti.project.name) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
async function lead(request, phone, name) {
  const r = await request.post('/api/kaspchem/lead', { data: { topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: name || 'נבדק פיקטיבי', phone, consentContact: true } });
  const j = await r.json(); expect(j.ok).toBe(true); return j.ref;
}
const adm = async (request, method, url, data) => { const r = await request[method](A + url, { headers: ADM, data }); expect(r.ok(), method + ' ' + url).toBe(true); return r.json(); };
async function reset(request) {
  const ov = await (await request.get(A + '/impact', { headers: ADM })).json();
  for (const o of ov.baseline.concat(ov.outcomes)) if (!o.voided) await adm(request, 'post', `/impact/outcomes/${o.id}/void`, {});
  await adm(request, 'post', '/impact/counter', { enabled: false });
  await adm(request, 'put', '/impact/baseline-cutoff', { date: null });
}
async function doneRequest(request, ti, phone) { const id = await lead(request, phone || phoneFor(ti)); await adm(request, 'patch', '/requests/' + id, { status: 'done' }); return id; }
const outcome = (request, id, over) => adm(request, 'post', `/requests/${id}/outcomes`, Object.assign({ kind: 'one_time_refund', amount: '1000', amount_basis: 'documented', evidence_note: 'נתוני בדיקה' }, over));
// 1000.50 / 2000 / 3000: three kinds, three families, one of them with an active ongoing saving
async function seedThree(request, ti) {
  const a = await doneRequest(request, ti), b = await doneRequest(request, ti), c = await doneRequest(request, ti);
  await outcome(request, a, { kind: 'one_time_refund', amount: '1000.50' });
  await outcome(request, b, { kind: 'ongoing_saving', amount: '2000' });
  await outcome(request, c, { kind: 'located_funds', amount: '3000' });
}
// The answer must arrive within the headline's 700 ms window to be used. On a heavily loaded machine that can be missed (by design: the headline then simply goes on without sentence 3),
// so load again up to three times before judging; the slow-answer test below proves the "too late" case separately.
async function gotoWithThird(page, expected) {
  for (let i = 0; i < 3; i++) {
    await page.goto('/kaspchem'); await page.waitForTimeout(1500);
    if ((await page.locator('#h .sr').textContent()) === expected) return;
  }
}
const shot = async (page, ti, n) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: `tests/shots/${ti.project.name}-impact-${n}.png`, fullPage: true }); };

// a routed request bypasses the browser's HTTP cache, so every page load in these tests sees the current answer (production caches it for up to an hour on purpose)
test.beforeEach(async ({ page, request }) => { await page.route('**/api/kaspchem/impact', (route) => route.continue()); await reset(request); });
test.afterEach(async ({ request }) => { await reset(request); });

test('counter: absent while switched off, even with counted outcomes; the headline stays as it was', async ({ page, request }, ti) => {
  await seedThree(request, ti);
  await page.goto('/kaspchem');
  await page.waitForTimeout(500);
  await expect(page.locator('#impact')).toBeHidden();
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('₪');
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  await noHScroll(page);
  const r = await (await request.get('/api/kaspchem/impact')).json();
  expect(r).toEqual({ ok: true, enabled: false });
});

test('counter: shown with exact amounts per kind, families, a calm update line; no combined total; no overflow', async ({ page, request }, ti) => {
  await seedThree(request, ti);
  await adm(request, 'post', '/impact/counter', { enabled: true });
  const [resp] = await Promise.all([page.waitForResponse((r) => /\/api\/kaspchem\/impact$/.test(r.url())), page.goto('/kaspchem')]);
  const api = await resp.json();
  expect(api.enabled).toBe(true);
  expect(api.amounts).toEqual({ ongoing_saving: 2000, one_time_refund: 1000.5, located_funds: 3000 });
  expect(api.families_helped).toBe(3);
  const sec = page.locator('#impact');
  await expect(sec).toBeVisible();
  await expect(sec.locator('h2')).toHaveText('מה כבר קרה בפועל');
  // the real (screen-reader) text is exact and unrounded
  await expect(sec.locator('[data-kind="one_time_refund"] .imp-fin')).toHaveText('1,000.50 ₪');
  await expect(sec.locator('[data-kind="ongoing_saving"] .imp-fin')).toHaveText('2,000 ₪');
  await expect(sec.locator('[data-kind="located_funds"] .imp-fin')).toHaveText('3,000 ₪');
  await expect(sec.locator('.imp-fam .imp-fin')).toHaveText('3');
  await expect(sec.locator('.imp-cap')).toHaveText('משפחות נעזרו');
  // labels for the three kinds, each its own card
  await expect(sec.locator('.imp-lab')).toHaveText(['חיסכון שנתי מתמשך', 'החזרים חד־פעמיים', 'כספים שאותרו']);
  // the animation ends on the exact same text
  await expect(sec.locator('[data-kind="one_time_refund"] .imp-v')).toHaveText('1,000.50 ₪', { timeout: 6000 });
  // update line: HH:MM of the answer, never "real time"
  const hhmm = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).format(new Date(api.as_of));
  await expect(page.locator('#imp-upd')).toHaveText('מתעדכן אחת לשעה. נכון ל־' + hhmm);
  const txt = await page.evaluate(() => document.body.innerText);
  expect(txt).not.toContain('בזמן אמת');
  expect(txt).not.toMatch(/סה״כ|סך הכול|סכום כולל/);       // no combined total anywhere
  // accessibility: the animated copy is decoration, the real text is read once; the section is a named region
  expect(await sec.locator('.imp-v').first().getAttribute('aria-hidden')).toBe('true');
  await expect(sec).toHaveAttribute('aria-labelledby', 'imp-h');
  await noHScroll(page); await nothingSticksOut(page);
  await sec.scrollIntoViewIfNeeded(); await page.waitForTimeout(1800);
  await shot(page, ti, 'home');
});

test('counter: kinds without an amount are not shown (no zeros as a claim)', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'located_funds', amount: '3000' });
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await page.goto('/kaspchem');
  await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('[data-kind="located_funds"]')).toBeVisible();
  await expect(page.locator('[data-kind="ongoing_saving"]')).toBeHidden();
  await expect(page.locator('[data-kind="one_time_refund"]')).toBeHidden();
  await expect(page.locator('.imp-fam .imp-fin')).toHaveText('1');
  await expect(page.locator('.imp-cap')).toHaveText('משפחה נעזרה');
  expect(await page.evaluate(() => document.getElementById('impact').innerText)).not.toMatch(/\b0 ₪/);
});

test('counter: a count-up animation runs and ends on the exact figure', async ({ page, request }, ti) => {
  await seedThree(request, ti);
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await page.addInitScript(() => {
    window.__seen = [];
    document.addEventListener('DOMContentLoaded', () => { const el = document.querySelector('[data-kind="located_funds"] .imp-v'); new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  });
  await page.goto('/kaspchem');
  await expect(page.locator('#impact')).toBeVisible();
  await page.locator('#impact').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.__seen.length > 6, null, { timeout: 8000 });   // it is counting through values (starts when the figure is in view)
  await expect(page.locator('[data-kind="located_funds"] .imp-v')).toHaveText('3,000 ₪', { timeout: 6000 });
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => window.__seen);
  expect(new Set(seen).size).toBeGreaterThan(3);           // it counted through several values
  expect(seen[seen.length - 1]).toBe('3,000 ₪');
});

test('counter: with reduced motion the final figures are in place at once and nothing animates', async ({ browser, request }, ti) => {
  await seedThree(request, ti);
  await adm(request, 'post', '/impact/counter', { enabled: true });
  const ctx = await browser.newContext({ baseURL: ti.project.use.baseURL, viewport: ti.project.use.viewport, reducedMotion: 'reduce', locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__seen = [];
    document.addEventListener('DOMContentLoaded', () => { const el = document.querySelector('[data-kind="located_funds"] .imp-v'); new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  });
  await page.goto('/kaspchem');
  await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('[data-kind="located_funds"] .imp-v')).toHaveText('3,000 ₪');
  await page.locator('#impact').scrollIntoViewIfNeeded(); await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__seen)).toEqual(['3,000 ₪']);   // written once, never counted through
  await noHScroll(page);
  await ctx.close();
});

test('counter: opening data that is not approved keeps the whole counter hidden; approval shows it', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { amount: '1000' });
  await adm(request, 'post', '/impact/baseline', { kind: 'located_funds', amount: '3000', family_count: 2, amount_basis: 'documented', evidence_note: 'נתוני בדיקה' });
  await adm(request, 'put', '/impact/baseline-cutoff', { date: '2026-01-01' });
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await page.goto('/kaspchem'); await page.waitForTimeout(500);
  await expect(page.locator('#impact')).toBeHidden();
  await adm(request, 'post', '/impact/approve-baseline', { confirm: true });
  await page.reload();
  await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('.imp-fam .imp-fin')).toHaveText('3');                          // 2 opening families + 1
  await expect(page.locator('[data-kind="located_funds"] .imp-fin')).toHaveText('3,000 ₪');
  await expect(page.locator('[data-kind="one_time_refund"] .imp-fin')).toHaveText('1,000 ₪');
});

test('headline sentence 3: only with the counter on and a real active_now, singular at 1; the height never changes while typing', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'ongoing_saving', amount: '2000' });
  const refundOnly = await doneRequest(request, ti); await outcome(request, refundOnly, { kind: 'one_time_refund', amount: '1000' });
  // counter OFF: no sentence 3 at all
  await page.goto('/kaspchem'); await page.waitForTimeout(1200);
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  // counter ON, one active family: singular form
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await gotoWithThird(page, S1 + ' ' + S2 + ' ' + THIRD_1);
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2 + ' ' + THIRD_1);
  await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
  const h0 = (await page.locator('#h').boundingBox()).height;
  await expect(page.locator('#h')).toHaveClass(/done/, { timeout: 20000 });
  await expect(page.locator('#h .tw-t')).toHaveText(THIRD_1);                               // the page rests on sentence 3
  expect(Math.abs((await page.locator('#h').boundingBox()).height - h0)).toBeLessThanOrEqual(1);
  // two active families: plural form
  const b = await doneRequest(request, ti); await outcome(request, b, { kind: 'ongoing_saving', amount: '3000' });
  await gotoWithThird(page, S1 + ' ' + S2 + ' ' + THIRD_2);
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2 + ' ' + THIRD_2);
  // the number is the measured count and nothing typed: no 6 unless there really are six
  expect(await page.evaluate(() => document.getElementById('h').innerText)).not.toMatch(/\b6\b/);
  await noHScroll(page);
});

test('headline sentence 3: not shown when nobody has an active ongoing saving (never a zero, never another wording)', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'one_time_refund', amount: '1000' });
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await page.goto('/kaspchem'); await page.waitForTimeout(1200);
  await expect(page.locator('#impact')).toBeVisible();                                        // the counter itself is shown
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('ברגע זה');
});

test('headline sentence 3: with reduced motion it is one more static line; the answer never makes the page jump later', async ({ browser, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'ongoing_saving', amount: '2000' });
  await adm(request, 'post', '/impact/counter', { enabled: true });
  const ctx = await browser.newContext({ baseURL: ti.project.use.baseURL, viewport: ti.project.use.viewport, reducedMotion: 'reduce', locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.goto('/kaspchem');
  await expect(page.locator('#h .tw-line')).toHaveText([S1, S2, THIRD_1]);
  await noHScroll(page);
  await ctx.close();
});

test('headline: if the impact answer is slow it never delays or blocks the headline, and a late answer is ignored', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'ongoing_saving', amount: '2000' });
  await adm(request, 'post', '/impact/counter', { enabled: true });
  await page.route('**/api/kaspchem/impact', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  await page.goto('/kaspchem', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#h .tw-t')).not.toHaveText('', { timeout: 1800 });                // typing starts long before the 2.5 s answer (cap: 700 ms)
  await expect(page.locator('#h')).toHaveClass(/done/, { timeout: 20000 });
  await expect(page.locator('#h .tw-t')).toHaveText(S1);                                        // rests on sentence 1, as without data
  await expect(page.locator('#impact')).toBeVisible({ timeout: 6000 });                          // the counter itself still appears once the answer arrives
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);                                // sentence 3 was too late and was ignored
});

test('counter: a failing endpoint leaves the page exactly as before', async ({ page }) => {
  await page.route('**/api/kaspchem/impact', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await page.goto('/kaspchem'); await page.waitForTimeout(900);
  await expect(page.locator('#impact')).toBeHidden();
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  await expect(page.locator('.tile')).toHaveCount(10);
});

// ---------------- dashboard ----------------
test('admin: marking a request done opens the outcome dialog; saving records a counted outcome visible in the request and in the impact tab', async ({ page, request }, ti) => {
  const phone = phoneFor(ti), id = await lead(request, phone, 'בדיקת השלמה');
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת השלמה' }).first().click();
  await page.locator('#ds').selectOption('done');
  await page.locator('#dsave').click();
  const dlg = page.getByRole('dialog', { name: /רישום ההישג/ });
  await expect(dlg).toBeVisible();
  await expect(page.locator('.drawer #ds')).toHaveValue('done');                             // the status was saved first
  await dlg.locator('#io-kind').selectOption('one_time_refund');
  await dlg.locator('#io-amt').fill('1234.56');
  await dlg.locator('#io-ev').fill('נתוני בדיקה');
  await shot(page, ti, 'dialog');
  await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.drawer')).toContainText('החזר חד־פעמי');
  await expect(page.locator('.drawer')).toContainText('1,234.56');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'השפעה' }).click();
  await expect(page.locator('h1')).toHaveText('השפעה');
  await expect(page.locator('#ia-root')).toContainText('1,234.56');
  await expect(page.locator('#ia-root')).toContainText('נספר');
  expect((await (await request.get(A + '/impact', { headers: ADM })).json()).outcomes.some((o) => o.request_id === id && o.counted && o.amount === 1234.56)).toBe(true);
});

test('admin: cancelling the dialog keeps the status change and flags the request "completed without an amount"; "nothing to count" clears the flag', async ({ page, request }, ti) => {
  const id1 = await lead(request, phoneFor(ti), 'בדיקת דילוג'), id2 = await lead(request, phoneFor(ti), 'בדיקת ללא סכום');
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת דילוג' }).first().click();
  await page.locator('#ds').selectOption('done'); await page.locator('#dsave').click();
  const dlg = page.getByRole('dialog', { name: /רישום ההישג/ });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: /דילוג/ }).click();                                  // cancel
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.drawer #ds')).toHaveValue('done');                             // status NOT forced back, not forced to carry an amount
  expect((await (await request.get(A + '/requests/' + id1, { headers: ADM })).json()).request.status).toBe('done');
  await page.keyboard.press('Escape');
  // second request: Escape closes the dialog the same way; then "no amount" from the tab
  await page.locator('tr.click', { hasText: 'בדיקת ללא סכום' }).first().click();
  await page.locator('#ds').selectOption('done'); await page.locator('#dsave').click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'אין סכום לספירה' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.drawer #ds')).toHaveValue('done');   // the drawer reopens, refreshed
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'השפעה' }).click();
  const panel = page.locator('.panel', { hasText: 'הושלמו ללא סכום' });
  await expect(panel).toContainText('הושלמו ללא סכום');
  await expect(panel.locator('tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp('^' + id1 + '$') }) })).toHaveCount(1);   // flagged
  await expect(panel.locator('tbody tr', { has: page.locator('td:first-child', { hasText: new RegExp('^' + id2 + '$') }) })).toHaveCount(0);   // decided: nothing to count
  await shot(page, ti, 'tab-missing');
  // recording the amount from the list removes it from the flag
  await panel.locator('tr', { has: page.locator('td:first-child', { hasText: new RegExp('^' + id1 + '$') }) }).getByRole('button', { name: 'רישום הישג' }).click();
  const d2 = page.getByRole('dialog', { name: /רישום הישג/ });
  await d2.locator('#io-kind').selectOption('located_funds'); await d2.locator('#io-amt').fill('3000'); await d2.locator('#io-ev').fill('נתוני בדיקה');
  await d2.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('.panel', { hasText: 'הושלמו ללא סכום' }).locator('td:first-child', { hasText: new RegExp('^' + id1 + '$') })).toHaveCount(0);
});

test('admin: the dialog refuses a documented amount without its internal source and shows a readable error', async ({ page, request }, ti) => {
  const id = await doneRequest(request, ti);
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'השפעה' }).click();
  const row = page.locator('.panel', { hasText: 'הושלמו ללא סכום' }).locator('tr', { has: page.locator('td:first-child', { hasText: new RegExp('^' + id + '$') }) });
  await row.getByRole('button', { name: 'רישום הישג' }).click();
  const dlg = page.getByRole('dialog', { name: /רישום הישג/ });
  await dlg.locator('#io-amt').fill('500');
  await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(dlg.locator('#io-err')).toContainText('מקור או אסמכתא');
  await dlg.locator('#io-basis').selectOption('estimate');                                      // an estimate may be stored without one
  await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('#ia-root')).toContainText('משוער: אינו נספר');
});

test('admin: impact tab - opening data, cutoff, one explicit approval, the switch, a live preview, void', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'ongoing_saving', amount: '2000' });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'הוזן בטעות' : undefined));
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'השפעה' }).click();
  await expect(page.locator('h1')).toHaveText('השפעה');
  await expect(page.locator('#ia-on')).not.toBeChecked();                                      // the switch is off by default
  await expect(page.locator('#ia-root')).toContainText('המתג כבוי');
  // opening data: add a row (test data), the approve button needs a cutoff
  await page.getByRole('button', { name: 'הוספת שורת פתיחה' }).click();
  const dlg = page.getByRole('dialog', { name: /נתוני פתיחה/ });
  await dlg.locator('#io-kind').selectOption('located_funds'); await dlg.locator('#io-amt').fill('3000'); await dlg.locator('#io-fam').fill('2'); await dlg.locator('#io-ev').fill('נתוני בדיקה');
  await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('#ia-root')).toContainText('נתוני הפתיחה טרם אושרו');
  await expect(page.getByRole('button', { name: 'אישור פרסום נתוני פתיחה' })).toBeDisabled();
  await page.locator('#ia-cut').fill('2026-01-01');
  await page.getByRole('button', { name: 'שמירת תאריך חיתוך' }).click();
  await expect(page.locator('#ia-cut')).toHaveValue('2026-01-01');
  // turn the switch on: still nothing public, and the page says why; the draft shows what it will look like
  await page.locator('#ia-on').check();
  await expect(page.locator('#ia-state')).toContainText('הציבור לא רואה דבר');
  await expect(page.locator('#ia-root')).toContainText('כרגע הציבור לא רואה מונה');
  await expect(page.locator('.ia-prev').last()).toContainText('3,000 ₪');
  expect(await (await request.get('/api/kaspchem/impact')).json()).toEqual({ ok: true, enabled: false });
  await shot(page, ti, 'tab-before-approval');
  // the single approval
  await page.getByRole('button', { name: 'אישור פרסום נתוני פתיחה' }).click();
  await expect(page.locator('#ia-appr')).toContainText('אושר על ידי yosi@example.test');
  await expect(page.getByRole('button', { name: 'אישור פרסום נתוני פתיחה' })).toBeDisabled();
  await expect(page.locator('#ia-root')).toContainText('כרגע מוצג לציבור');
  const pub = await (await request.get('/api/kaspchem/impact')).json();
  expect(pub.enabled).toBe(true); expect(pub.amounts.located_funds).toBe(3000); expect(pub.families_helped).toBe(3); expect(pub.active_now).toBe(1);
  await shot(page, ti, 'tab');
  // void the outcome: the preview and the public numbers drop at once
  const row = page.locator('.panel', { hasText: 'הישגים לפי טיפול' }).locator('tbody tr').first();
  await row.getByRole('button', { name: 'ביטול רשומה' }).click();
  await expect(page.locator('.panel', { hasText: 'הישגים לפי טיפול' }).locator('tbody tr').first()).toContainText('בוטל');
  const pub2 = await (await request.get('/api/kaspchem/impact')).json();
  expect(pub2.amounts.ongoing_saving).toBe(0); expect(pub2.active_now).toBe(0); expect(pub2.families_helped).toBe(2);
  // the audit tab shows every step
  await page.getByRole('button', { name: 'יומן שינויים' }).click();
  const log = await page.locator('.tbl').innerText();
  for (const act of ['impact.baseline.create', 'impact.baseline.cutoff', 'impact.baseline.approve', 'impact.counter.enable', 'impact.outcome.void']) expect(log).toContain(act);
  await page.getByRole('button', { name: 'השפעה' }).click();
  await page.locator('#ia-on').uncheck();
  await expect(page.locator('#ia-state')).toContainText('המתג כבוי');
});

test('admin: the impact tab does not overflow and its buttons are reachable (no hidden controls)', async ({ page, request }, ti) => {
  const a = await doneRequest(request, ti); await outcome(request, a, { kind: 'ongoing_saving', amount: '2000', last_verified_at: new Date(Date.now() - 340 * 864e5).toISOString().slice(0, 10), starts_on: '2025-01-01' });
  await doneRequest(request, ti);
  await adm(request, 'post', '/impact/baseline', { kind: 'one_time_refund', amount: '1000', family_count: 1, amount_basis: 'documented', evidence_note: 'נתוני בדיקה' });
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'השפעה' }).click();
  await expect(page.locator('#ia-root')).toContainText('אימות שמתקרב לפוג');
  await expect(page.locator('.panel', { hasText: 'אימות שמתקרב לפוג' }).getByRole('button', { name: 'אומת היום' }).first()).toBeVisible();
  await nothingSticksOut(page);
  for (const name of ['הוספת שורת פתיחה', 'שמירת תאריך חיתוך', 'אישור פרסום נתוני פתיחה']) await expect(page.getByRole('button', { name })).toBeVisible();
  for (const b of await page.locator('#ia-root button[data-ia]:visible').all()) { const r = await b.boundingBox(); expect(r.width).toBeGreaterThan(20); expect(r.x).toBeGreaterThanOrEqual(0); }
  // re-verifying brings the saving off the list
  await page.getByRole('button', { name: 'אומת היום' }).first().click();
  await expect(page.locator('.panel', { hasText: 'אימות שמתקרב לפוג' }).getByRole('button', { name: 'אומת היום' })).toHaveCount(0);
  await shot(page, ti, 'tab-verify');
});

test('admin: nothing about the old applicant erase has returned (no button, route still refuses)', async ({ page, request }, ti) => {
  const id = await lead(request, phoneFor(ti), 'בדיקת פונה');
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת פונה' }).first().click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('עיון ותיקון פרטים');
  expect(await drawer.innerText()).not.toMatch(/מחיקת|מחיקה|ERASE|למחוק/);
  await expect(drawer.locator('[id*=erase i], [data-erase]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'השפעה' }).click();
  expect(await page.locator('#ia-root').innerText()).not.toMatch(/ERASE|מחיקת פונה/);
  const applicant = (await (await request.get(A + '/requests/' + id, { headers: ADM })).json()).request.applicant_id;
  const r = await request.post(A + `/applicants/${applicant}/erase`, { headers: ADM, data: { confirm: 'ERASE' } });
  expect(r.status()).toBe(410);
});
