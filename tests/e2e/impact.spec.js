const { test, expect } = require('@playwright/test');
const fs = require('fs');

// The simple impact counter: the home page shows two figures (families, shekels); the dashboard tab "השפעה" has exactly three controls and a preview;
// completed treatments with an amount are added automatically. Runs at 360 / 390 / 768 / 1440.
// Every figure is obviously fake TEST DATA, except the one test that reproduces the owner's real preview state (6 families, 201,653 ₪) to prove it is shown as-is.
// Each test puts the database in a known state through the dev server's test-only seed route, and leaves the counter OFF and empty for the other specs.
const ADM = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const AS_ADMIN = '/admin/kaspchem/?test=' + encodeURIComponent('yosi@example.test|admin');
const WIDTHS = ['mobile-360', 'mobile-390', 'tablet-768', 'desktop-1440'];
const S1 = 'אתם משלמים יותר מדי...', S2 = 'המשכנתא? הביטוח?הבנק?';
const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
const nothingSticksOut = async (page) => expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('body *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 0.5 || r.left < -0.5) && !e.closest('#tabs'); }).map((e) => e.tagName + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })).toEqual([]);
// random per call: Playwright restarts the worker after a failed test, so a counter would repeat numbers (applicants are unique by phone)
const phoneFor = (ti) => '0528' + WIDTHS.indexOf(ti.project.name) + String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const seed = async (request, state) => { const r = await request.post('/__test/impact-seed', { data: state || {} }); expect(r.ok()).toBe(true); };
const OFF = {};                                                                  // no starting row, no cutoff, switch absent (= off)
const fake = (over) => Object.assign({ baseline: { kind: 'located_funds', amount: '3000.50', family_count: 7 }, cutoff: '2026-01-01', flag: true }, over || {});
async function lead(request, phone, name) {
  const r = await request.post('/api/kaspchem/lead', { data: { topic: 'household', answers: { bills: 'old', subs: 'no', homeins: 'yes', mobile: 'no' }, name: name || 'נבדק פיקטיבי', phone, consentContact: true } });
  const j = await r.json(); expect(j.ok).toBe(true); return j.ref;
}
const adm = async (request, method, url, data) => { const r = await request[method](A + url, { headers: ADM, data }); expect(r.ok(), method + ' ' + url).toBe(true); return r.json(); };
const impactApi = async (request) => (await request.get(A + '/impact', { headers: ADM })).json();
const shot = async (page, ti, n) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: `tests/shots/${ti.project.name}-impact-${n}.png`, fullPage: true }); };
const openTab = async (page) => { await page.goto(AS_ADMIN); await page.getByRole('button', { name: 'השפעה' }).click(); await expect(page.locator('h1')).toHaveText('השפעה'); await expect(page.locator('#ia-fam')).toBeVisible(); };

// a routed request bypasses the browser's HTTP cache (the endpoint itself is no-store anyway)
test.beforeEach(async ({ page, request }) => { await page.route('**/api/kaspchem/impact', (route) => route.continue()); await seed(request, OFF); });
test.afterEach(async ({ request }) => { await seed(request, OFF); });

// ---------------- home page ----------------
test('counter: absent while switched off, even with data; the headline stays as it was', async ({ page, request }) => {
  await seed(request, fake({ flag: false }));
  await page.goto('/kaspchem'); await page.waitForTimeout(500);
  await expect(page.locator('#impact')).toBeHidden();
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('₪');
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  await noHScroll(page);
  expect(await (await request.get('/api/kaspchem/impact')).json()).toEqual({ ok: true, enabled: false });
});

test('counter: shows exactly two figures, families and shekels (agorot only when there are some), a calm update line, nothing else', async ({ page, request }, ti) => {
  await seed(request, fake());
  const [resp] = await Promise.all([page.waitForResponse((r) => /\/api\/kaspchem\/impact$/.test(r.url())), page.goto('/kaspchem')]);
  const api = await resp.json();
  expect(Object.keys(api).sort()).toEqual(['amount', 'as_of', 'enabled', 'families', 'ok']);
  const sec = page.locator('#impact');
  await expect(sec).toBeVisible();
  await expect(sec.locator('h2')).toHaveText('מה כבר קרה בפועל');
  await expect(sec.locator('#imp-fam .imp-fin')).toHaveText('7');
  await expect(sec.locator('#imp-fam .imp-cap')).toHaveText('משפחות נעזרו');
  await expect(sec.locator('#imp-money .imp-fin')).toHaveText('3,000.50 ₪');
  await expect(sec.locator('#imp-money .imp-cap')).toHaveText('נחסכו או הושגו עבור משפחות');
  await expect(sec.locator('#imp-money .imp-v')).toHaveText('3,000.50 ₪', { timeout: 6000 });    // the count-up ends on the exact figure
  const hhmm = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' }).format(new Date(api.as_of));
  await expect(page.locator('#imp-upd')).toHaveText('נכון ל־' + hhmm);
  const txt = await sec.innerText();
  for (const gone of ['בזמן אמת', 'מתעדכן אחת לשעה', 'חיסכון שנתי', 'החזרים', 'כספים שאותרו', 'בנפרד לפי סוג']) expect(txt).not.toContain(gone);
  await expect(sec.locator('[data-kind], .imp-kind, .imp-kinds, .imp-lab')).toHaveCount(0);   // the three kind boxes are gone
  expect(await sec.locator('.imp-v').first().getAttribute('aria-hidden')).toBe('true');         // the animated copy is decoration; the real text is read once
  await expect(sec).toHaveAttribute('aria-labelledby', 'imp-h');
  await expect(sec.locator('.imp-fine')).toContainText('אין בנתונים הבטחה');
  await noHScroll(page); await nothingSticksOut(page);
  await sec.scrollIntoViewIfNeeded(); await page.waitForTimeout(1800);
  await shot(page, ti, 'home');
});

test('counter: one family is singular, whole shekels have no decimals, a side with nothing is not shown (no zeros as a claim)', async ({ page, request }) => {
  await seed(request, fake({ baseline: { amount: '5000', family_count: 1 } }));
  await page.goto('/kaspchem'); await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('#imp-fam .imp-fin')).toHaveText('1'); await expect(page.locator('#imp-fam .imp-cap')).toHaveText('משפחה נעזרה');
  await expect(page.locator('#imp-money .imp-fin')).toHaveText('5,000 ₪');
  await seed(request, fake({ baseline: { amount: '0', family_count: 3 } }));
  await page.reload(); await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('#imp-fam')).toBeVisible(); await expect(page.locator('#imp-money')).toBeHidden();
  await seed(request, fake({ baseline: { amount: '100', family_count: 0 } }));
  await page.reload(); await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('#imp-money')).toBeVisible(); await expect(page.locator('#imp-fam')).toBeHidden();
  expect(await page.locator('#impact').innerText()).not.toMatch(/(^|\s)0(\s|$)/);
  await seed(request, fake({ baseline: { amount: '0', family_count: 0 } }));                       // nothing at all: the whole section stays away
  await page.reload(); await page.waitForTimeout(600); await expect(page.locator('#impact')).toBeHidden();
});

test('counter: a count-up runs and ends on the exact figure', async ({ page, request }) => {
  await seed(request, fake());
  await page.addInitScript(() => {
    window.__seen = [];
    document.addEventListener('DOMContentLoaded', () => { const el = document.querySelector('#imp-money .imp-v'); new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  });
  await page.goto('/kaspchem'); await expect(page.locator('#impact')).toBeVisible();
  await page.locator('#impact').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.__seen.length > 6, null, { timeout: 8000 });     // it is counting through values (starts when the figure is in view)
  await expect(page.locator('#imp-money .imp-v')).toHaveText('3,000.50 ₪', { timeout: 6000 });
  await page.waitForTimeout(300);
  const seen = await page.evaluate(() => window.__seen);
  expect(new Set(seen).size).toBeGreaterThan(3); expect(seen[seen.length - 1]).toBe('3,000.50 ₪');
});

test('counter: with reduced motion the final figures are in place at once and nothing animates', async ({ browser, request }, ti) => {
  await seed(request, fake());
  const ctx = await browser.newContext({ baseURL: ti.project.use.baseURL, viewport: ti.project.use.viewport, reducedMotion: 'reduce', locale: 'he-IL' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__seen = [];
    document.addEventListener('DOMContentLoaded', () => { const el = document.querySelector('#imp-money .imp-v'); new MutationObserver(() => window.__seen.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true }); });
  });
  await page.goto('/kaspchem');
  await expect(page.locator('#impact')).toBeVisible();
  await expect(page.locator('#imp-money .imp-v')).toHaveText('3,000.50 ₪');
  await page.locator('#impact').scrollIntoViewIfNeeded(); await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__seen)).toEqual(['3,000.50 ₪']);                  // written once, never counted through
  await noHScroll(page);
  await ctx.close();
});

test('headline: sentence 3 stays OFF even with the counter on (there is no honest "saving now" number); the headline is not delayed or blocked by a slow answer', async ({ page, request }) => {
  await seed(request, fake());
  await page.route('**/api/kaspchem/impact', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue(); });
  await page.goto('/kaspchem', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#h .tw-t')).not.toHaveText('', { timeout: 1800 });                // typing starts long before the 2.5 s answer (cap: 700 ms)
  await expect(page.locator('#h')).toHaveClass(/tw-done/, { timeout: 20000 });
  await expect(page.locator('#h .tw-t')).toHaveText(S1);                                        // rests on sentence 1, as without data
  await expect(page.locator('#impact')).toBeVisible({ timeout: 6000 });                          // the counter itself still appears once the answer arrives
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain('ברגע זה');
  // a fast answer: the same
  await page.unroute('**/api/kaspchem/impact'); await page.route('**/api/kaspchem/impact', (r) => r.continue());
  await page.reload(); await expect(page.locator('#impact')).toBeVisible(); await page.waitForTimeout(1500);
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  expect(await page.evaluate(() => typeof window.KaspHeadline.impact + typeof window.KaspHeadline.setThird)).toBe('functionfunction');  // the hook is still there
});

test('counter: a failing endpoint leaves the page exactly as before', async ({ page }) => {
  await page.route('**/api/kaspchem/impact', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
  await page.goto('/kaspchem'); await page.waitForTimeout(900);
  await expect(page.locator('#impact')).toBeHidden();
  await expect(page.locator('#h .sr')).toHaveText(S1 + ' ' + S2);
  await expect(page.locator('.tile')).toHaveCount(10);
});

// ---------------- dashboard tab ----------------
test("the tab opens on the owner's existing numbers (6 families, 201,653, switch on) WITHOUT writing anything, and has exactly three controls and a preview", async ({ page, request }, ti) => {
  await seed(request, { baseline: { kind: 'ongoing_saving', amount: '201653.00', family_count: 6 }, cutoff: '2026-11-03', flag: true, approval: true });
  const logBefore = (await (await request.get(A + '/audit', { headers: ADM })).json()).audit.length;
  await openTab(page);
  await expect(page.locator('#ia-fam')).toHaveValue('6');
  await expect(page.locator('#ia-amt')).toHaveValue('201,653.00');
  await expect(page.locator('#ia-sw')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#ia-sw')).toHaveText('כן');
  await expect(page.locator('#ia-badge')).toHaveText('מוצג כרגע באתר');
  await expect(page.locator('#ia-prev')).toContainText('6'); await expect(page.locator('#ia-prev')).toContainText('201,653 ₪'); await expect(page.locator('#ia-prev')).toContainText('נכון ל־');
  await expect(page.locator('#ia-quiet')).toContainText('נוספו אוטומטית מטיפולים שהושלמו');
  await expect(page.locator('#ia-quiet')).toContainText('טיפולים שהושלמו לפני נקודת ההתחלה כלולים כבר במספרים שהזנתם');
  await expect(page.locator('#ia-quiet')).toContainText('אם משפחה שכבר נכללת במספר ההתחלה חוזרת עם טיפול חדש, היא תיספר שוב אלא אם יש לה רשומה קודמת במערכת.');
  expect(await page.locator('#ia-quiet').innerText()).not.toMatch(/d{4}|d{1,2}[./-]d{1,2}[./-]d{2,4}|עד היום/);   // no date anywhere
  await expect(page.locator('#ia-quiet')).toContainText('מכאן ואילך טיפול שמסומן ״הושלם״ ויש בו סכום יתווסף אוטומטית');
  // exactly: two text fields, one switch, one save button. Nothing about kinds, cutoff, approval, verification, statuses, tables, lists.
  const view = page.locator('#view');
  await expect(view.locator('input')).toHaveCount(2);
  await expect(view.locator('input[type=text]')).toHaveCount(2);
  await expect(view.locator('[role=switch]')).toHaveCount(1);
  await expect(view.locator('button')).toHaveCount(2);                                       // the switch and "שמירה"
  await expect(view.locator('button[type=submit]')).toHaveText('שמירה');
  await expect(view.locator('select, textarea, table, input[type=date], input[type=checkbox], a')).toHaveCount(0);
  const txt = await view.innerText();
  for (const gone of ['חיסכון שנתי', 'החזרים', 'כספים שאותרו', 'חיתוך', 'אישור פרסום', 'אימות', 'סטטוס', 'בוטל', 'הושלמו ללא סכום', 'משוער', 'מתועד', 'אסמכתא']) expect(txt).not.toContain(gone);
  await shot(page, ti, 'tab-owner-state');
  // loading wrote nothing: no audit entry, the public counter shows exactly the owner's numbers
  expect((await (await request.get(A + '/audit', { headers: ADM })).json()).audit.length).toBe(logBefore);
  const pub = await (await request.get('/api/kaspchem/impact')).json();
  expect([pub.enabled, pub.families, pub.amount]).toEqual([true, 6, 201653]);
  const g = await impactApi(request); expect(g.start).toEqual({ families: 6, amount: 201653, split: false });
});

test('empty state: nothing typed yet, switch off, preview says it is not shown and has no numbers', async ({ page, request }, ti) => {
  await openTab(page);
  await expect(page.locator('#ia-fam')).toHaveValue('0'); await expect(page.locator('#ia-amt')).toHaveValue('0.00');
  await expect(page.locator('#ia-sw')).toHaveAttribute('aria-checked', 'false'); await expect(page.locator('#ia-sw')).toHaveText('לא');
  await expect(page.locator('#ia-badge')).toHaveText('כרגע לא מוצג לציבור');
  await expect(page.locator('#ia-prev')).toContainText('אין עדיין מספרים להצגה');
  await shot(page, ti, 'tab-empty');
});

test('save: both numbers are validated in plain Hebrew, the typed values stay on an error, success shows a toast and the formatted numbers; nothing public changes while the switch is off', async ({ page, request }, ti) => {
  await openTab(page);
  const fam = page.locator('#ia-fam'), amt = page.locator('#ia-amt'), err = page.locator('#ia-err');
  await fam.fill('abc'); await amt.fill('10');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(err).toHaveText('יש להזין מספר שלם של משפחות (0 או יותר)');
  await expect(fam).toHaveValue('abc'); await expect(amt).toHaveValue('10');                 // typed values are kept
  await fam.fill('5'); await amt.fill('1.234');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(err).toHaveText('יש להזין סכום בשקלים (מספר, עד שתי ספרות אחרי הנקודה)');
  await expect(fam).toHaveValue('5'); await expect(amt).toHaveValue('1.234');
  await shot(page, ti, 'tab-error');
  expect((await impactApi(request)).start).toEqual({ families: 0, amount: 0, split: false }); // nothing was saved
  await fam.fill('12'); await amt.fill('3,000.5');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('#toast')).toContainText('נשמר');
  await expect(err).toHaveText('');
  await expect(amt).toHaveValue('3,000.50'); await expect(fam).toHaveValue('12');
  await expect(page.locator('#ia-prev')).toContainText('3,000.50 ₪'); await expect(page.locator('#ia-prev')).toContainText('12');
  await expect(page.locator('#ia-badge')).toHaveText('כרגע לא מוצג לציבור');                  // the switch is still off
  expect((await impactApi(request)).start).toEqual({ families: 12, amount: 3000.5, split: false });
  expect(await (await request.get('/api/kaspchem/impact')).json()).toEqual({ ok: true, enabled: false });
  await shot(page, ti, 'tab-saved-off');
});

test('the switch applies at once (no dialog), the toast says what happened, and the home page follows the very next visit', async ({ page, request, browser }, ti) => {
  await seed(request, fake({ flag: false, baseline: { amount: '1000', family_count: 2 } }));
  const dialogs = []; page.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss(); });
  await openTab(page);
  const sw = page.locator('#ia-sw');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#ia-badge')).toHaveText('כרגע לא מוצג לציבור');
  await expect(page.locator('#ia-prev')).toContainText('1,000 ₪');                           // the preview is shown even while off
  const home = await (await browser.newContext({ baseURL: ti.project.use.baseURL, viewport: ti.project.use.viewport })).newPage();
  await home.goto('/kaspchem'); await home.waitForTimeout(500); await expect(home.locator('#impact')).toBeHidden();
  await sw.click();
  await expect(page.locator('#toast')).toHaveText('המונה דלוק באתר');
  await expect(sw).toHaveAttribute('aria-checked', 'true'); await expect(sw).toHaveText('כן');
  await expect(page.locator('#ia-badge')).toHaveText('מוצג כרגע באתר');
  expect((await (await request.get('/api/kaspchem/impact')).json()).enabled).toBe(true);
  await home.reload(); await expect(home.locator('#impact')).toBeVisible(); await expect(home.locator('#imp-fam .imp-fin')).toHaveText('2');
  await shot(page, ti, 'tab-on');
  await sw.click();
  await expect(page.locator('#toast')).toHaveText('המונה כבוי באתר');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect(await (await request.get('/api/kaspchem/impact')).json()).toEqual({ ok: true, enabled: false });
  await home.reload(); await home.waitForTimeout(500); await expect(home.locator('#impact')).toBeHidden();   // gone for the very next visitor
  expect(dialogs).toEqual([]);                                                                // no confirm dialog
  await shot(page, ti, 'tab-off');
  await home.context().close();
});

test('mobile usability: big touch targets, no horizontal overflow, the switch works from the keyboard', async ({ page, request }) => {
  await seed(request, fake({ flag: false }));
  await openTab(page);
  for (const sel of ['#ia-fam', '#ia-amt', '#ia-sw', '.ia-save']) { const b = await page.locator(sel).boundingBox(); expect(b.height, sel).toBeGreaterThanOrEqual(44); expect(b.width, sel).toBeGreaterThanOrEqual(44); }
  expect(await page.locator('#ia-fam').getAttribute('inputmode')).toBe('numeric'); expect(await page.locator('#ia-amt').getAttribute('inputmode')).toBe('decimal');
  await nothingSticksOut(page);
  const sw = page.locator('#ia-sw');
  await sw.focus(); await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  expect((await impactApi(request)).enabled).toBe(true);
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  expect((await impactApi(request)).enabled).toBe(false);
  expect(await sw.getAttribute('aria-labelledby')).toBe('ia-swl');
});

test('old data split over several starting rows: shown as a sum, read-only, no save button, the plain message; the switch still works', async ({ page, request }) => {
  await seed(request, fake({ baseline: [{ amount: '1000', family_count: 2 }, { kind: 'one_time_refund', amount: '500.50', family_count: 3 }] }));
  await openTab(page);
  await expect(page.locator('#ia-fam')).toHaveValue('5'); await expect(page.locator('#ia-amt')).toHaveValue('1,500.50');
  await expect(page.locator('#ia-fam')).toHaveAttribute('readonly', ''); await expect(page.locator('#ia-amt')).toHaveAttribute('readonly', '');
  await expect(page.locator('#view')).toContainText('נתוני ההתחלה מפוצלים לכמה שורות; פנו אליי לאיחוד');
  await expect(page.locator('#view button[type=submit]')).toHaveCount(0);
  await page.locator('#ia-sw').click(); await expect(page.locator('#ia-sw')).toHaveAttribute('aria-checked', 'false');
  expect((await impactApi(request)).start).toEqual({ families: 5, amount: 1500.5, split: true });
});

// ---------------- completed treatments ----------------
test('marking a request done opens a small dialog with ONE money field; saving adds it to the counter automatically; the drawer can edit and remove it', async ({ page, request }, ti) => {
  await seed(request, fake({ baseline: { amount: '1000', family_count: 2 } }));
  const id = await lead(request, phoneFor(ti), 'בדיקת השלמה');
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת השלמה' }).first().click();
  await expect(page.locator('.drawer')).toContainText('אפשר לרשום סכום כשהבקשה בסטטוס ״הושלם״');
  await page.locator('#ds').selectOption('done'); await page.locator('#dsave').click();
  const dlg = page.getByRole('dialog', { name: /הושלמה/ });
  await expect(dlg).toBeVisible();
  await expect(page.locator('.drawer #ds')).toHaveValue('done');                             // the status was saved first
  await expect(dlg.locator('input')).toHaveCount(1); await expect(dlg.locator('select, textarea, input[type=date]')).toHaveCount(0);
  await expect(dlg.getByLabel('סכום שנחסך או הושג (₪)')).toBeFocused();
  await expect(dlg.getByRole('button', { name: 'שמירה' })).toBeVisible(); await expect(dlg.getByRole('button', { name: 'ללא סכום' })).toBeVisible();
  await dlg.locator('#io-amt').fill('abc'); await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(dlg.locator('#io-err')).toContainText('יש להזין סכום בשקלים'); await expect(dlg.locator('#io-amt')).toHaveValue('abc');   // typed value kept
  await shot(page, ti, 'dialog');
  await dlg.locator('#io-amt').fill('1,234.56'); await dlg.getByRole('button', { name: 'שמירה' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.drawer')).toContainText('1,234.56 ₪');
  await expect(page.locator('.drawer #oedit')).toHaveText('עריכה'); await expect(page.locator('.drawer #orem')).toHaveText('הסרה');
  let pub = await (await request.get('/api/kaspchem/impact')).json();
  expect([pub.families, pub.amount]).toEqual([3, 2234.56]);                                   // added automatically, one more family
  // edit
  await page.locator('.drawer #oedit').click();
  const ed = page.getByRole('dialog', { name: 'סכום שנחסך או הושג' });
  await expect(ed.locator('#io-amt')).toHaveValue('1,234.56');
  await ed.locator('#io-amt').fill('2000'); await ed.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('.drawer')).toContainText('2,000 ₪');
  pub = await (await request.get('/api/kaspchem/impact')).json(); expect([pub.families, pub.amount]).toEqual([3, 3000]);
  // remove
  page.once('dialog', (d) => d.accept());
  await page.locator('.drawer #orem').click();
  await expect(page.locator('.drawer')).toContainText('לא נרשם סכום');
  pub = await (await request.get('/api/kaspchem/impact')).json(); expect([pub.families, pub.amount]).toEqual([2, 1000]);
  // and the tab's quiet line follows
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'השפעה' }).click();
  await expect(page.locator('#ia-quiet')).toContainText('0 משפחות, 0 ₪');
  expect((await impactApi(request)).total).toEqual({ families: 2, amount: 1000 });
});

test('closing the dialog with "ללא סכום" keeps the status, counts nothing and leaves no flag or list; the amount can still be recorded later from the request', async ({ page, request }, ti) => {
  await seed(request, fake({ baseline: { amount: '1000', family_count: 2 } }));
  const id = await lead(request, phoneFor(ti), 'בדיקת דילוג');
  await page.goto(AS_ADMIN);
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת דילוג' }).first().click();
  await page.locator('#ds').selectOption('done'); await page.locator('#dsave').click();
  const dlg = page.getByRole('dialog', { name: /הושלמה/ });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'ללא סכום' }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.drawer #ds')).toHaveValue('done');
  expect((await (await request.get(A + '/requests/' + id, { headers: ADM })).json()).request.status).toBe('done');
  const pub = await (await request.get('/api/kaspchem/impact')).json(); expect([pub.families, pub.amount]).toEqual([2, 1000]);
  await expect(page.locator('.drawer')).toContainText('לא נרשם סכום');
  // Escape closes the dialog the same way
  await page.locator('.drawer #oedit').click();
  const d2 = page.getByRole('dialog', { name: 'סכום שנחסך או הושג' }); await expect(d2).toBeVisible(); await page.keyboard.press('Escape'); await expect(d2).toHaveCount(0);
  await expect(page.locator('.drawer #ds')).toHaveValue('done');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'השפעה' }).click();
  await expect(page.locator('#view')).not.toContainText('הושלמו ללא סכום');                    // no flag, no list
  await expect(page.locator('#view table')).toHaveCount(0);
});

test('a request that leaves "done" drops out of the counter at once; a recorded amount on a request that is not done is refused', async ({ page, request }, ti) => {
  await seed(request, fake({ baseline: { amount: '1000', family_count: 2 } }));
  const id = await lead(request, phoneFor(ti)); await adm(request, 'patch', '/requests/' + id, { status: 'done' });
  await adm(request, 'put', `/requests/${id}/outcome`, { amount: '500' });
  let pub = await (await request.get('/api/kaspchem/impact')).json(); expect([pub.families, pub.amount]).toEqual([3, 1500]);
  await adm(request, 'patch', '/requests/' + id, { status: 'in_progress' });
  pub = await (await request.get('/api/kaspchem/impact')).json(); expect([pub.families, pub.amount]).toEqual([2, 1000]);
  const r = await request.put(A + `/requests/${id}/outcome`, { headers: ADM, data: { amount: '5' } });
  expect(r.status()).toBe(409); expect((await r.json()).error).toBe('request_not_done');
  await page.goto(AS_ADMIN); await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click').first().click();
  await expect(page.locator('.drawer')).toContainText('סכום שנחסך או הושג');
});

test('nothing about the old applicant erase has returned (no button, route still refuses)', async ({ page, request }, ti) => {
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
  expect(await page.locator('#view').innerText()).not.toMatch(/ERASE|מחיקת פונה/);
  const applicant = (await (await request.get(A + '/requests/' + id, { headers: ADM })).json()).request.applicant_id;
  const r = await request.post(A + `/applicants/${applicant}/erase`, { headers: ADM, data: { confirm: 'ERASE' } });
  expect(r.status()).toBe(410);
});

// ---------------- the scenario, the fixed reference point, legacy amounts ----------------
const settingValue = async (request, key) => { const s = (await (await request.get(A + '/settings', { headers: ADM })).json()).settings.find((x) => x.key === key); return s ? s.value : undefined; };
const publicTotals = async (request) => { const p = await (await request.get('/api/kaspchem/impact')).json(); return p.enabled ? [p.families, p.amount] : p; };

test("SCENARIO from the owner's numbers: two new families complete treatments, the owner edits the starting numbers, one amount is corrected, the switch goes off; the reference point never moves", async ({ page, request }, ti) => {
  // the owner's figures (6 families, 201,653 ₪); the reference date is set well before today so that treatments completed today count automatically
  await seed(request, { baseline: { kind: 'ongoing_saving', amount: '201653.00', family_count: 6 }, cutoff: '2026-01-01', flag: true, approval: true });
  const a = await lead(request, phoneFor(ti), 'בדיקת תרחיש א'), b = await lead(request, phoneFor(ti), 'בדיקת תרחיש ב');
  await adm(request, 'patch', '/requests/' + a, { status: 'done' }); await adm(request, 'patch', '/requests/' + b, { status: 'done' });
  expect(await publicTotals(request)).toEqual([6, 201653]);
  await adm(request, 'put', `/requests/${a}/outcome`, { amount: '1000' }); await adm(request, 'put', `/requests/${b}/outcome`, { amount: '2500' });   // fake amounts
  expect(await publicTotals(request)).toEqual([8, 205153]);

  await openTab(page);
  await expect(page.locator('#ia-fam')).toHaveValue('6'); await expect(page.locator('#ia-amt')).toHaveValue('201,653.00');          // the starting numbers are the typed ones
  await expect(page.locator('#ia-prev')).toContainText('205,153 ₪'); await expect(page.locator('#ia-quiet')).toContainText('2 משפחות, 3,500 ₪');
  await page.locator('#ia-fam').fill('7'); await page.locator('#ia-amt').fill('200000');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('#toast')).toContainText('נשמר');
  await expect(page.locator('#ia-prev')).toContainText('203,500 ₪'); await expect(page.locator('#ia-prev .imp-num').first()).toHaveText('9');
  await expect(page.locator('#ia-quiet')).toContainText('2 משפחות, 3,500 ₪');                                                     // the automatic part is untouched
  expect(await publicTotals(request)).toEqual([9, 203500]);
  expect(await settingValue(request, 'private.impact_baseline_cutoff')).toBe('2026-01-01');                                           // not moved by the save
  expect(await settingValue(request, 'private.impact_reference_at')).toBeUndefined();
  await shot(page, ti, 'tab-after-scenario');

  // correct one automatic amount from the request
  await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת תרחיש א' }).first().click();
  await page.locator('.drawer #oedit').click();
  const ed = page.getByRole('dialog', { name: 'סכום שנחסך או הושג' }); await ed.locator('#io-amt').fill('1200'); await ed.getByRole('button', { name: 'שמירה' }).click();
  await expect(page.locator('.drawer')).toContainText('1,200 ₪');
  expect(await publicTotals(request)).toEqual([9, 203700]);
  expect(await settingValue(request, 'private.impact_baseline_cutoff')).toBe('2026-01-01');
  await page.keyboard.press('Escape');

  // the switch off: the very next request says so
  await page.getByRole('button', { name: 'השפעה' }).click();
  await page.locator('#ia-sw').click(); await expect(page.locator('#toast')).toHaveText('המונה כבוי באתר');
  expect(await publicTotals(request)).toEqual({ ok: true, enabled: false });
  expect(await settingValue(request, 'private.impact_baseline_cutoff')).toBe('2026-01-01');
});

test('a new family with several treatments is counted once (all of its amounts are added)', async ({ request }, ti) => {
  await seed(request, fake({ baseline: { amount: '1000', family_count: 2 }, cutoff: '2026-01-01' }));
  const phone = phoneFor(ti);
  for (const amt of ['400', '100']) { const id = await lead(request, phone, 'בדיקת משפחה'); await adm(request, 'patch', '/requests/' + id, { status: 'done' }); await adm(request, 'put', `/requests/${id}/outcome`, { amount: amt }); }
  expect(await publicTotals(request)).toEqual([3, 1500]);
});

test('old data with two amounts on one request: the drawer shows the total with the plain line, no edit, one removal (with its own confirmation) that voids all; marking done on a request that already has amounts opens no dialog', async ({ page, request }, ti) => {
  const id = await lead(request, phoneFor(ti), 'בדיקת ישן'); await adm(request, 'patch', '/requests/' + id, { status: 'done' });
  await seed(request, Object.assign(fake({ baseline: { amount: '1000', family_count: 2 } }), { outcomes: [{ request_id: id, kind: 'one_time_refund', amount: '900' }, { request_id: id, kind: 'ongoing_saving', amount: '250.5' }] }));
  expect(await publicTotals(request)).toEqual([3, 2150.5]);
  await page.goto(AS_ADMIN); await page.getByRole('button', { name: 'בקשות טיפול' }).click();
  await page.locator('tr.click', { hasText: 'בדיקת ישן' }).first().click();
  const dr = page.locator('.drawer');
  await expect(dr).toContainText('1,150.50 ₪');
  await expect(dr).toContainText('הסכום מורכב מכמה רישומים ישנים; אפשר להסיר אותם, אך לא לערוך מכאן');
  await expect(dr.locator('#oedit')).toHaveCount(0); await expect(dr.locator('#orem')).toHaveText('הסרה');
  await shot(page, ti, 'drawer-legacy');
  const r = await request.put(A + `/requests/${id}/outcome`, { headers: ADM, data: { amount: '5' } });
  expect(r.status()).toBe(409); expect((await r.json()).error).toBe('several_outcomes');
  expect(await publicTotals(request)).toEqual([3, 2150.5]);                                        // nothing lost
  let msg = ''; page.once('dialog', (d) => { msg = d.message(); d.accept(); });
  await dr.locator('#orem').click();
  await expect(page.locator('.drawer')).toContainText('לא נרשם סכום');
  expect(msg).toBe('להסיר את כל הסכומים של הטיפול?');
  expect(await publicTotals(request)).toEqual([2, 1000]);
  // a request that already has amounts: marking it done opens no dialog (nothing hidden is overwritten)
  const id2 = await lead(request, phoneFor(ti), 'בדיקת בלי חלון');
  await seed(request, Object.assign(fake({ baseline: { amount: '1000', family_count: 2 } }), { outcomes: [{ request_id: id2, kind: 'located_funds', amount: '300' }] }));
  await page.keyboard.press('Escape');
  await page.locator('tr.click', { hasText: 'בדיקת בלי חלון' }).first().click();
  await page.locator('#ds').selectOption('done'); await page.locator('#dsave').click();
  await expect(page.locator('.drawer #ds')).toHaveValue('done');
  await expect(page.locator('.drawer')).toContainText('300 ₪');
  await expect(page.getByRole('dialog', { name: /הושלמה/ })).toHaveCount(0);
  expect(await publicTotals(request)).toEqual([3, 1300]);
});
