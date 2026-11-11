// Catalog admin screens, stage 5b-2b-2 (the life cycle of an engagement: PAUSE, RETURN TO REVIEW, REOPEN, its history, and what the card says about the agreement and the price), in a real browser (the four projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page and the real function code on an in-memory Postgres with invented "[דמו]" data. Nothing here touches Neon or any network.
// What the demo cannot produce (a busy server, a cut connection, a gateway page, a refusal with reasons) is put in by intercepting the request.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4185, BASE = 'http://localhost:' + PORT, API = '**/api/kaspchem/admin/catalog/';
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });
test.beforeEach(async () => { await demo.setMode('full'); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading') && !document.querySelector('#ct-log .ct-loading'));
async function open(page) {
  const writes = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') { const u = new URL(r.url()); writes.push({ method: r.method(), path: u.pathname.replace('/api/kaspchem/admin', ''), body: r.postData() ? JSON.parse(r.postData()) : null, csrf: r.headers()['x-kaspchem'] }); } });
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  return writes;
}
async function nav(page, screen) { await page.locator('.ct-nav button', { hasText: screen }).click(); await ready(page); }
const body = (page) => page.locator('#ct-body');
const dlg = (page) => page.locator('.ce-modal');
const q = async (sql, params) => (await demo.pg.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const submit = (page) => dlg(page).locator('[data-ce=submit]');
const bar = (page, a) => page.locator('.ce-bar [data-ce=' + a + ']');
const life = (page) => page.locator('#ct-life');
async function openEngagement(page, p, s) { await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="' + p + '"][data-s="' + s + '"]').click(); await ready(page); }
const row = (p, s) => one('SELECT activation, contact_state, agreement_state, pricing_model, pricing_id::int AS pricing_id, paused_reason, retired_reason, retired_at, updated_by FROM provider_services WHERE professional_id = $1 AND service_id = $2', [p, s]);
const journal = (p, s) => q("SELECT actor, action, detail FROM audit_log WHERE entity = 'engagement' AND entity_id = $1 AND action LIKE 'catalog.engagement.%' ORDER BY id", [p + '/' + s]);
const set = (p, s, sets) => q('UPDATE provider_services SET ' + sets + ' WHERE professional_id = ' + p + ' AND service_id = ' + s);
const noActive = async (except) => expect((await q("SELECT professional_id::text || '/' || service_id::text AS k FROM provider_services WHERE activation = 'active' ORDER BY 1")).map((r) => r.k)).toEqual(except || []);
const shot = async (page, ti, name) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: 'tests/shots/' + ti.project.name + '-lifecycle-' + name + '.png', fullPage: true }); };
const buttons = (page) => page.locator('.ce-bar button');
// the states a test needs (provider 15 is available): a paused one, a retired one that was signed and active, and the pending one with an approved price that fits
const PAUSED = "activation = 'paused', paused_reason = 'ממתין להבהרות מהספק'";
const RETIRED = "activation = 'retired', retired_reason = 'הספק פרש מהפרויקט', retired_at = now() - interval '5 days', agreement_state = 'signed', contact_state = 'active'";
async function fill(page, reason, word) { await page.locator('#ce-reason').fill(reason); await page.locator('#ce-confirm').fill(word); }

test('the buttons follow the state: pending -> pause, active -> pause (and nothing else), paused -> return to review, retired -> reopen, a draft none of the three; a provider who is paused or archived hides the two that bring an engagement back and says why; never an activation', async ({ page }) => {
  await open(page);
  await openEngagement(page, 15, 1); await expect(buttons(page)).toHaveText(['עדכון מעקב', 'השהיה']);   // pending
  await openEngagement(page, 11, 2); await expect(buttons(page)).toHaveText(['עדכון מעקב', 'העברה למצב ממתין לאישור']);   // a draft: no pause
  await set(15, 2, PAUSED); await openEngagement(page, 15, 2); await expect(buttons(page)).toHaveText(['החזרה לבדיקה']); await expect(page.locator('.ce-bar')).toContainText('ההתקשרות מושהית'); await expect(page.locator('.ce-bar')).toContainText('אפשר להחזיר אותה לבדיקה (ממתינה לאישור)');
  await set(15, 5, RETIRED); await openEngagement(page, 15, 5); await expect(buttons(page)).toHaveText(['פתיחה מחדש']); await expect(page.locator('.ce-bar')).toContainText('אפשר לפתוח אותה מחדש כטיוטה');
  await set(11, 1, "activation = 'active', agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 1"); await openEngagement(page, 11, 1);
  await expect(buttons(page)).toHaveText(['השהיה']); await expect(page.locator('.ce-bar')).toContainText('ההתקשרות פעילה'); await expect(page.locator('.ce-bar')).toContainText('אפשר להשהות אותה'); await expect(page.locator('.ce-bar')).toContainText('אינן זמינות במסך הזה');
  // a provider that is paused (12) or archived (13): no button for a way back, and the sentence says why
  await openEngagement(page, 12, 3); await expect(buttons(page)).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('ההתקשרות מושהית'); await expect(page.locator('.ce-bar')).toContainText('נותן השירות מושהה או בארכיון, ולכן אי אפשר להחזיר את ההתקשרות לבדיקה עד שיחזור לזמינות');
  await openEngagement(page, 13, 5); await expect(buttons(page)).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('ההתקשרות הוצאה משימוש'); await expect(page.locator('.ce-bar')).toContainText('נותן השירות מושהה או בארכיון, ולכן אי אפשר לפתוח את ההתקשרות מחדש עד שיחזור לזמינות');
  // a paused provider does not take the pause away from a pending engagement of his
  await q("UPDATE provider_services SET activation = 'pending' WHERE professional_id = 12 AND service_id = 3"); await openEngagement(page, 12, 3); await expect(buttons(page)).toHaveText(['עדכון מעקב', 'השהיה']);
  // on every engagement of the demo: no button that activates, resumes, retires or withdraws
  for (const [p, s] of [[11, 1], [11, 2], [12, 3], [13, 5], [15, 1], [15, 2], [15, 5]]) { await openEngagement(page, p, s); for (const t of await buttons(page).allInnerTexts()) expect(t).not.toMatch(/הפעל|חידוש|הוצאה משימוש|משיכה|לחדש/); }
  expect(await page.evaluate(() => ['activate', 'resume', 'retire', 'withdraw'].map((a) => window.KaspchemCatalogEdit._t.allowed('POST', '/catalog/engagements/11/1/actions/' + a)))).toEqual([false, false, false, false]);
});

test('PAUSE: the dialog says what changes, asks for a reason and the typed word, sends nothing until both are right, then ONE request; the engagement is paused, the journal and the card say who and why', async ({ page }, ti) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await bar(page, 'pause').click();
  await expect(dlg(page)).toBeVisible(); await expect(page.locator('#ce-title')).toHaveText('השהיית התקשרות'); await expect(page.locator('#ce-reason')).toBeFocused();
  const t = dlg(page);
  await expect(t).toContainText('ההתקשרות תושהה'); await expect(t).toContainText('לא תהיה פעילה'); await expect(t).toContainText('הסיבה, מי שהשהה והזמן יירשמו ביומן');
  const table = t.locator('table.ce-conseq'); await expect(table.locator('tbody tr')).toHaveCount(4);
  await expect(table.locator('tbody tr').nth(0)).toContainText('ממתין לאישור'); await expect(table.locator('tbody tr').nth(0)).toContainText('מושהה'); await expect(table.locator('tbody tr').nth(1)).toContainText('ללא שינוי'); await expect(table.locator('tbody tr').nth(2)).toContainText('ללא שינוי');
  await expect(table.locator('tbody tr').nth(3)).toContainText('מחיר מקושר'); await expect(table.locator('tbody tr').nth(3)).toContainText('1,150'); await expect(table.locator('tbody tr').nth(3)).toContainText('ללא שינוי');
  await expect(t).toContainText('אל תכתבו בסיבה טלפון, דוא״ל, מספר זיהוי, קישור או פרטים אישיים'); await expect(t).toContainText('נשמרת ביומן לצמיתות ואי אפשר למחוק אותה');
  await shot(page, ti, 'pause-dialog');
  // the table keeps the words of its first column whole (no "התקשרו|ת" on two lines) on a wide window
  if (page.viewportSize().width > 700) for (const h of await table.locator('tbody td:first-child').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(h).toBeLessThan(60);
  // nothing is sent while the form is not right
  await submit(page).click(); await expect(page.locator('[data-field=reason] .ce-fe')).toHaveText('חובה לכתוב סיבה.'); await expect(page.locator('#ce-reason')).toBeFocused(); expect(writes).toEqual([]);
  await page.locator('#ce-reason').fill('ממתינים להבהרות מהספק'); await submit(page).click(); await expect(page.locator('[data-field=confirm] .ce-fe')).toHaveText('כדי לאשר יש להקליד בדיוק: pause'); await expect(page.locator('#ce-confirm')).toBeFocused(); expect(writes).toEqual([]);
  for (const wrong of ['PAUSE', 'Pause', 'pause now', 'resume', 'reopen', ' ']) { await page.locator('#ce-confirm').fill(wrong); await submit(page).click(); await expect(page.locator('[data-field=confirm] .ce-fe')).toContainText('יש להקליד בדיוק: pause'); }
  expect(writes).toEqual([]); expect((await row(15, 1)).activation).toBe('pending');
  await page.locator('#ce-confirm').fill('pause'); await submit(page).click();
  await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/engagements/15/1/actions/pause', csrf: '1' });
  expect(Object.keys(writes[0].body).sort()).toEqual(['confirm', 'expected_activation', 'reason', 'seen']); expect(writes[0].body).toMatchObject({ expected_activation: 'pending', reason: 'ממתינים להבהרות מהספק', confirm: 'pause' }); expect(String(writes[0].body.seen).length).toBeGreaterThan(5);
  expect(await row(15, 1)).toMatchObject({ activation: 'paused', paused_reason: 'ממתינים להבהרות מהספק', agreement_state: 'draft', contact_state: 'negotiating', pricing_id: 2, updated_by: 'yosi@example.test' });
  const j = await journal(15, 1); expect(j.map((r) => [r.actor, r.action, r.detail])).toEqual([['yosi@example.test', 'catalog.engagement.pause', { from: 'pending', to: 'paused', reason: 'ממתינים להבהרות מהספק' }]]);
  await expect(page.locator('#toast')).toContainText('ההתקשרות הושהתה');
  await expect(body(page)).toContainText('סיבת השהיה'); await expect(body(page)).toContainText('ממתינים להבהרות מהספק'); await expect(buttons(page)).toHaveText(['החזרה לבדיקה']);
  await expect(life(page)).toContainText('ההשהיה הנוכחית'); await expect(life(page)).toContainText('yosi@example.test'); await expect(life(page)).toContainText('אירועים שקרו בעבר'); await expect(life(page).locator('tbody tr').first()).toContainText('הושהתה');
  await expect(page.locator('#ct-log')).toContainText('השהיית התקשרות'); await noActive();
  await shot(page, ti, 'paused-card');
});

test('RETURN TO REVIEW: a paused engagement goes back to PENDING (never to active), the pause reason leaves the card and stays in the history, and the history says who returned it and why', async ({ page }, ti) => {
  const writes = await open(page);
  await set(15, 2, PAUSED); await openEngagement(page, 15, 2); await bar(page, 'return_to_review').click();
  await expect(page.locator('#ce-title')).toHaveText('החזרת התקשרות לבדיקה'); await expect(dlg(page)).toContainText('ההחזרה אינה הפעלה'); await expect(dlg(page)).toContainText('ההפעלה אינה זמינה במסך הזה'); await expect(dlg(page)).toContainText('סיבת ההשהיה תימחק מהכרטיס ותישמר ביומן');
  await expect(dlg(page).locator('table.ce-conseq tbody tr').nth(0)).toContainText('מושהה'); await expect(dlg(page).locator('table.ce-conseq tbody tr').nth(0)).toContainText('ממתין לאישור'); await expect(page.locator('label[for=ce-confirm]')).toContainText('return_to_review');
  await shot(page, ti, 'return-dialog');
  await fill(page, 'ההבהרות התקבלו', 'return_to_review'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/engagements/15/2/actions/return_to_review' }); expect(writes[0].body).toMatchObject({ expected_activation: 'paused', reason: 'ההבהרות התקבלו', confirm: 'return_to_review' });
  expect(await row(15, 2)).toMatchObject({ activation: 'pending', paused_reason: null, updated_by: 'yosi@example.test' }); await noActive();
  expect((await journal(15, 2)).map((r) => [r.action, r.detail])).toEqual([['catalog.engagement.return_to_review', { from: 'paused', to: 'pending', reason: 'ההבהרות התקבלו' }]]);
  await expect(body(page)).not.toContainText('סיבת השהיה'); await expect(buttons(page)).toHaveText(['עדכון מעקב', 'השהיה']);
  await expect(life(page)).toContainText('ההבהרות התקבלו'); await expect(life(page).locator('tbody tr').first()).toContainText('הוחזרה לבדיקה'); await expect(life(page)).toContainText('מצב: מושהה ← ממתין לאישור');
});

test('REOPEN: the dialog shows what is set back (a signature becomes a draft, an active collaboration becomes "a contact was made"), the linked price is kept and is not approved again; after it the card says all that, keeps the retirement as the past, and shows who reopened it and what was reset', async ({ page }, ti) => {
  const writes = await open(page);
  await set(15, 1, RETIRED); await openEngagement(page, 15, 1);
  await expect(body(page)).toContainText('הוצא משימוש'); await expect(life(page)).toContainText('המצב הנוכחי: הוצאה משימוש ב־'); await bar(page, 'reopen').click();
  const t = dlg(page); await expect(page.locator('#ce-title')).toHaveText('פתיחה מחדש של התקשרות');
  await expect(t).toContainText('ההתקשרות תחזור למצב ״טיוטה״ על אותה שורה (לא נוצר עותק)'); await expect(t).toContainText('זו אינה הפעלה, וההפעלה אינה זמינה במסך הזה'); await expect(t).toContainText('הסכם שהיה חתום חוזר ל״טיוטת הסכם״, ושיתוף פעולה פעיל חוזר ל״נוצר קשר״'); await expect(t).toContainText('קישור המחיר נשמר ואינו נמחק, אך אינו אישור חדש');
  const rows = t.locator('table.ce-conseq tbody tr');
  await expect(rows.nth(0)).toContainText('הוצא משימוש'); await expect(rows.nth(0)).toContainText('טיוטה'); await expect(rows.nth(1)).toContainText('חתום'); await expect(rows.nth(1)).toContainText('טיוטת הסכם'); await expect(rows.nth(2)).toContainText('שיתוף פעולה פעיל'); await expect(rows.nth(2)).toContainText('נוצר קשר');
  await expect(rows.nth(3)).toContainText('הקישור נשמר. אינו אישור חדש וייבדק מחדש לפני הפעלה'); await shot(page, ti, 'reopen-dialog');
  await fill(page, 'חזרנו לעבוד יחד', 'reopen'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/engagements/15/1/actions/reopen' }); expect(writes[0].body).toMatchObject({ expected_activation: 'retired', reason: 'חזרנו לעבוד יחד', confirm: 'reopen' });
  const after = await row(15, 1); expect(after).toMatchObject({ activation: 'draft', agreement_state: 'draft', contact_state: 'contacted', pricing_model: 'fixed', pricing_id: 2, retired_reason: 'הספק פרש מהפרויקט', paused_reason: null }); expect(after.retired_at).not.toBeNull(); await noActive();
  const j = await journal(15, 1); expect(j.length).toBe(1); expect(j[0].detail).toMatchObject({ from: 'retired', to: 'draft', reason: 'חזרנו לעבוד יחד', reset: { agreement_state: ['signed', 'draft'], contact_state: ['active', 'contacted'] } });
  await expect(page.locator('#toast')).toContainText('ההתקשרות נפתחה מחדש כטיוטה'); await expect(page.locator('#toast')).toContainText('ההסכם הוחזר לטיוטה'); await expect(page.locator('#toast')).toContainText('מצב הקשר הוחזר ל״נוצר קשר״');
  // the card now
  const state = body(page).locator('.panel').first();
  await expect(state).toContainText('טיוטה'); await expect(state).toContainText('טיוטת הסכם'); await expect(state).toContainText('נוצר קשר'); await expect(state).not.toContainText('הוצא משימוש');
  await expect(state).toContainText('ההתקשרות נפתחה מחדש ב־'); await expect(state).toContainText('הסכם שהיה חתום חוזר לטיוטה'); await expect(state).toContainText('אינו תקף מעצם הפתיחה מחדש');
  await expect(page.locator('.ct-checklist')).toContainText('הסכם חתום'); await expect(page.locator('.ct-ck.no', { hasText: 'הסכם חתום' })).toHaveCount(1); await expect(page.locator('.ct-ck.no', { hasText: 'שיתוף פעולה פעיל' })).toHaveCount(1);
  await expect(body(page)).toContainText('המחיר המקושר כפוף לבדיקה מחדש לפני הפעלה'); await expect(body(page)).toContainText('פתיחה מחדש לא מחקה את הקישור ולא אישרה אותו מחדש'); await expect(body(page)).toContainText('בבדיקה של הרגע המחיר המקושר עומד בכללי השיוך והאישור');
  await expect(life(page)).toContainText('בעבר: ההתקשרות אינה מוצאת משימוש כעת'); await expect(life(page)).toContainText('הספק פרש מהפרויקט'); await expect(life(page)).toContainText('yosi@example.test'); await expect(life(page)).toContainText('חזרנו לעבוד יחד');
  await expect(life(page)).toContainText('אופס · הסכם: חתום ← טיוטת הסכם'); await expect(life(page)).toContainText('אופס · מצב קשר: שיתוף פעולה פעיל ← נוצר קשר'); await expect(life(page)).not.toContainText('המצב הנוכחי: הוצאה משימוש');
  await expect(page.locator('#ct-log')).toContainText('פתיחה מחדש של התקשרות'); await expect(page.locator('#ct-log')).toContainText('אופס · הסכם: חתום ← טיוטת הסכם');
  // the history tables keep the person and the time whole: no e-mail address broken into one letter per line, the details take the rest of the width (on a wide window; on a phone the rows are stacked cards)
  const wide = page.viewportSize().width > 700, cells = await page.evaluate(() => [...document.querySelectorAll('.ct-hist tbody tr')].map((tr) => [...tr.children].map((td) => { const r = td.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), over: td.scrollWidth > td.clientWidth + 1 }; })));
  expect(cells.length).toBe(2);   // one row of the life cycle events, one of the change log
  for (const r of cells) { expect(r.some((c) => c.over)).toBe(false); if (wide) { expect(r[1].w).toBeGreaterThanOrEqual(110); expect(r[0].w).toBeGreaterThanOrEqual(100); } }
  await expect(buttons(page)).toHaveText(['עדכון מעקב', 'העברה למצב ממתין לאישור']); expect(await page.locator('#ct-root').innerText()).not.toMatch(/catalog\.engagement|return_to_review|previous_retired_at|agreement_state|contact_state/);
  await shot(page, ti, 'reopened-card');
});

test('a reopening that had nothing to reset says so; an engagement whose agreement ended or whose collaboration stopped keeps those values', async ({ page }) => {
  await open(page);
  await set(15, 5, "activation = 'retired', retired_reason = 'סיום', retired_at = now() - interval '2 days', agreement_state = 'ended', contact_state = 'stopped'"); await openEngagement(page, 15, 5); await bar(page, 'reopen').click();
  const rows = dlg(page).locator('table.ce-conseq tbody tr'); await expect(rows.nth(1)).toContainText('הסתיים'); await expect(rows.nth(1)).toContainText('ללא שינוי'); await expect(rows.nth(2)).toContainText('הופסק'); await expect(rows.nth(2)).toContainText('ללא שינוי'); await expect(rows.nth(3)).toContainText('אין מחיר מקושר');
  await fill(page, 'נפתח מחדש', 'reopen'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(await row(15, 5)).toMatchObject({ activation: 'draft', agreement_state: 'ended', contact_state: 'stopped' }); await expect(life(page)).toContainText('לא אופס דבר: ההסכם לא היה חתום ושיתוף הפעולה לא היה פעיל'); await expect(page.locator('#toast')).not.toContainText('הוחזר');
});

test('a double click, a double Enter and a double submit make exactly one request and one journal row; the form is locked while it sends', async ({ page }) => {
  const writes = await open(page);
  await page.route(API + 'engagements/*/*/actions/*', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await openEngagement(page, 15, 1); await bar(page, 'pause').click(); await fill(page, 'בדיקת לחיצה כפולה', 'pause');
  await submit(page).dblclick(); await page.locator('#ce-reason').evaluate((el) => { el.form.requestSubmit(); el.form.requestSubmit(); });
  await expect(submit(page)).toBeDisabled(); await expect(page.locator('#ce-reason')).toBeDisabled(); await expect(dlg(page)).toHaveCount(0, { timeout: 10000 }); await ready(page);
  expect(writes.map((w) => w.method + ' ' + w.path)).toEqual(['POST /catalog/engagements/15/1/actions/pause']);
  expect((await journal(15, 1)).length).toBe(1); expect((await row(15, 1)).activation).toBe('paused');
});

test('two admins: the other one changed the engagement after the dialog was opened: nothing is written, the page says who and when and why it stopped, the form cannot be sent again, and a refresh shows the present', async ({ page }, ti) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await bar(page, 'pause').click(); await fill(page, 'שלי', 'pause');
  await set(15, 1, "activation = 'paused', paused_reason = 'של אבי'");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.engagement.pause', 'engagement', '15/1', '{\"from\":\"pending\",\"to\":\"paused\",\"reason\":\"של אבי\"}')");
  await submit(page).click(); const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('ההתקשרות השתנתה מאז שצפיתם בה'); await expect(panel).toContainText('avi@example.test'); await expect(panel).toContainText('לא נשמר דבר, והפעולה שבחרתם לא בוצעה'); await expect(panel).toContainText('יש לרענן, לבדוק את המצב הנוכחי ולהחליט שוב');
  await expect(dlg(page).locator('.ce-fields')).toBeHidden(); await expect(submit(page)).toBeHidden(); await expect(panel.locator('[data-ce=refresh]')).toBeVisible(); await expect(panel).not.toContainText(/conflict|expected_activation/);
  await shot(page, ti, 'conflict');
  expect(writes.length).toBe(1); expect((await journal(15, 1)).map((r) => r.actor)).toEqual(['avi@example.test']); expect((await row(15, 1)).paused_reason).toBe('של אבי');
  await panel.locator('[data-ce=refresh]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page)).toContainText('של אבי'); await expect(buttons(page)).toHaveText(['החזרה לבדיקה']); expect(writes.length).toBe(1);
});

test('the view went stale (the contact state, the price or the provider changed after the card was opened): the server refuses, the page says the view changed, nothing is written and Escape refreshes', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await bar(page, 'pause').click(); await fill(page, 'סיבה', 'pause');
  await set(15, 1, "contact_state = 'stopped'"); await submit(page).click(); const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('המצב של ההתקשרות, ההסכם, הקשר או המחיר שלה השתנה מאז שצפיתם בו'); await expect(panel).toContainText('לא נשמר דבר'); await expect(submit(page)).toBeHidden();
  expect((await row(15, 1)).activation).toBe('pending'); expect(writes.length).toBe(1); await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page)).toContainText('הופסק');
  // the provider archived after the card of a paused engagement was opened: the same panel (the view includes the provider), and the engagement stays paused
  await set(15, 2, PAUSED); await openEngagement(page, 15, 2); await bar(page, 'return_to_review').click(); await fill(page, 'חזרה', 'return_to_review');
  await q('UPDATE provider_profiles SET archived_at = now() WHERE professional_id = 15'); await submit(page).click(); await expect(dlg(page).locator('.ce-panel')).toContainText('השתנה מאז שצפיתם בו'); expect((await row(15, 2)).activation).toBe('paused');
  await page.keyboard.press('Escape'); await ready(page); await expect(buttons(page)).toHaveCount(0); await expect(page.locator('.ce-bar')).toContainText('נותן השירות מושהה או בארכיון');   // after the refresh the button is gone and the sentence says why
});

test('a provider who is not available: the refusal is said in words with what to do, nothing is written, and the form cannot be sent again; the same words as a conflict and as a refusal', async ({ page }) => {
  const writes = await open(page);
  await set(15, 2, PAUSED);
  for (const [status, payload, re] of [[409, { error: 'provider_paused' }, /נותן השירות מושהה[^]*עד שיחזור לזמינות/], [409, { error: 'provider_archived' }, /נותן השירות בארכיון[^]*יש לבטל קודם את הארכוב/], [422, { error: 'transition_refused', errors: ['provider_paused'], missing: [], documented_only: false }, /נותן השירות מושהה[^]*עד שיחזור לזמינות/], [422, { error: 'transition_refused', errors: ['provider_archived'], missing: [], documented_only: false }, /נותן השירות בארכיון/]]) {
    await page.route(API + 'engagements/15/2/actions/return_to_review', (route) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(Object.assign({ message: 'SELECT secret FROM x' }, payload)) }));
    await openEngagement(page, 15, 2); await bar(page, 'return_to_review').click(); await fill(page, 'חזרה', 'return_to_review'); await submit(page).click();
    const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('אי אפשר לבצע את הפעולה'); await expect(panel).toContainText(re); await expect(panel).toContainText('לא נשמר דבר'); await expect(panel).not.toContainText(/provider_|SELECT|secret|transition_refused/); await expect(submit(page)).toBeHidden();
    await panel.locator('[data-ce=refresh]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page); await page.unroute(API + 'engagements/15/2/actions/return_to_review');
  }
  expect(writes.length).toBe(4); expect((await row(15, 2)).activation).toBe('paused'); expect((await journal(15, 2)).length).toBe(0);
});

test('a contact detail or personal information in the reason is refused by the server at the reason field, nothing is saved, and the typed text stays', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await bar(page, 'pause').click();
  for (const reason of ['התקשרו אליו 050-1234567', 'dana@example.test שלחה', 'ת"ז 123456789 של הספק', 'https://example.test/x']) {
    await fill(page, reason, 'pause'); await submit(page).click();
    await expect(page.locator('[data-field=reason] .ce-fe')).toContainText('אי אפשר לכלול בסיבה מספר טלפון, כתובת דוא״ל, מספר ארוך (כמו מספר זיהוי) או קישור'); await expect(page.locator('#ce-reason')).toBeFocused(); await expect(page.locator('#ce-reason')).toHaveValue(reason); await expect(page.locator('#ce-reason')).toHaveAttribute('aria-invalid', 'true'); await expect(submit(page)).toBeEnabled();
  }
  expect(writes.length).toBe(4); expect((await row(15, 1)).activation).toBe('pending'); expect((await journal(15, 1)).length).toBe(0);
  await fill(page, 'ממתינים לתשובה', 'pause'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect((await row(15, 1)).activation).toBe('paused');   // a clean reason goes through
});

test('the server is busy: nothing was saved, the form keeps what was typed, nothing is sent again by itself, and the second click works; a refusal with reasons is shown in words, never as codes', async ({ page }) => {
  const writes = await open(page); let n = 0;
  await page.route(API + 'engagements/15/1/actions/pause', (route) => { n++; if (n === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy_retry', message: 'SELECT secret' }) }); if (n === 2) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'transition_refused', message: 'SQLSTATE 23514 password=x', errors: ['not_allowed_from_active', 'transition_not_allowed:pending->draft', 'some_new_rule'], missing: [], documented_only: false }) }); return route.continue(); });
  await openEngagement(page, 15, 1); await bar(page, 'pause').click(); await fill(page, 'סיבה שנשמרת בשדה', 'pause'); await submit(page).click();
  const status = dlg(page).locator('.ce-status'); await expect(status).toContainText('המערכת עסוקה'); await expect(status).toContainText('לא נשמר דבר'); await expect(dlg(page)).not.toContainText(/busy_retry|SELECT/);
  await expect(page.locator('#ce-reason')).toHaveValue('סיבה שנשמרת בשדה'); await expect(page.locator('#ce-confirm')).toHaveValue('pause'); await expect(submit(page)).toBeEnabled();
  await page.waitForTimeout(1600); expect(writes.length).toBe(1); expect((await row(15, 1)).activation).toBe('pending');
  await submit(page).click(); await expect(status).toContainText('המעבר אינו מותר במצב הנוכחי'); await expect(status).toContainText('הפעולה אינה מותרת ממצב ״פעיל״'); await expect(status).toContainText('אינה עומדת בכלל מובנה'); await expect(dlg(page)).not.toContainText(/SQLSTATE|password|not_allowed|transition_not_allowed|some_new_rule|transition_refused/); expect(writes.length).toBe(2);
  await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect(writes.length).toBe(3); expect((await row(15, 1)).activation).toBe('paused'); expect((await journal(15, 1)).length).toBe(1);
});

test('the result is unknown (a cut connection, a gateway page, a server fault): nothing is sent again, only a check of the state; the check shows what really happened; the form cannot come back', async ({ page }, ti) => {
  const writes = await open(page); let n = 0;
  await page.route(API + 'engagements/15/1/actions/pause', (route) => { n++; if (n === 1) return route.abort('connectionreset'); if (n === 2) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway at db.internal</body></html>' }); return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server_error', message: 'stack at /var/task/x.js' }) }); });
  await openEngagement(page, 15, 1);
  for (let i = 0; i < 3; i++) {
    await bar(page, 'pause').click(); await fill(page, 'בדיקת תוצאה לא ידועה', 'pause'); await submit(page).click();
    const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('לא ידוע אם נשמר'); await expect(panel).toContainText('אל תשלחו שוב'); await expect(panel).toContainText('רעננו את הכרטיס ובדקו את מצב ההתקשרות ואת ההיסטוריה שלה'); await expect(panel).not.toContainText(/db\.internal|stack|\/var\/task|Bad gateway/);
    await expect(panel.locator('[data-ce=again]')).toHaveCount(0); await expect(panel.locator('[data-ce=refresh]')).toBeVisible(); await expect(submit(page)).toBeHidden(); if (i === 0) await shot(page, ti, 'unknown');
    await page.waitForTimeout(700); expect(writes.length).toBe(i + 1);
    await panel.locator('[data-ce=refresh]').click(); await expect(dlg(page)).toHaveCount(0); await ready(page); await expect(body(page)).toContainText('ממתין לאישור'); expect((await row(15, 1)).activation).toBe('pending');   // the check: it did not happen
  }
  // the reply was lost but the write HAPPENED: the check shows it, and the person does not send it again
  await set(15, 1, PAUSED); await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('yosi@example.test', 'catalog.engagement.pause', 'engagement', '15/1', '{\"from\":\"pending\",\"to\":\"paused\",\"reason\":\"ממתין להבהרות מהספק\"}')");
  await openEngagement(page, 15, 1); await expect(body(page)).toContainText('מושהה'); await expect(buttons(page)).toHaveText(['החזרה לבדיקה']); await expect(life(page)).toContainText('ההשהיה הנוכחית'); expect(writes.length).toBe(3);
});

test('a closed activation switch cannot be gone round: no screen offers an activation, the page refuses to send one, and the server refuses it when asked directly', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1);
  expect(await page.evaluate(() => ['activate', 'resume', 'retire', 'withdraw'].map((a) => window.KaspchemCatalogEdit._t.allowed('POST', '/catalog/engagements/15/1/actions/' + a)))).toEqual([false, false, false, false]);
  const seen = await page.evaluate(async () => { const r = await fetch('/api/kaspchem/admin/catalog/engagements/15/1', { headers: { 'x-test-user': 'yosi@example.test|admin' } }); return (await r.json()).checklist.seen; });
  const out = await page.evaluate(async (s) => { const post = (a, b) => fetch('/api/kaspchem/admin/catalog/engagements/15/1/actions/' + a, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Kaspchem': '1', 'x-test-user': 'yosi@example.test|admin' }, body: JSON.stringify(b) }).then(async (r) => [r.status, (await r.json()).error]); return [await post('activate', { expected_activation: 'pending', confirm: 'activate', seen: s }), await post('resume', { expected_activation: 'pending', confirm: 'activate', seen: s })]; }, seen);
  expect(out.map((x) => x[0])).toEqual([403, 403]); expect(out[0][1]).toBe('activation_disabled');
  expect((await row(15, 1)).activation).toBe('pending'); await noActive(); expect(writes.map((w) => w.path)).toEqual(['/catalog/engagements/15/1/actions/activate', '/catalog/engagements/15/1/actions/resume']);   // only the two direct calls above, none from the screens
  // and the three actions of the screens are never able to make anything active, whatever the data
  await set(15, 1, "agreement_state = 'signed', contact_state = 'active'"); await openEngagement(page, 15, 1); await bar(page, 'pause').click(); await fill(page, 'סיבה', 'pause'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  await bar(page, 'return_to_review').click(); await fill(page, 'חזרה', 'return_to_review'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect((await row(15, 1)).activation).toBe('pending'); await noActive();
});

test('the history window: when the journal of the card is longer than what was fetched, the page says it looked only at the newest records and never says "none"; what the row itself holds (the last retirement, the last reopening) is still shown', async ({ page }) => {
  await open(page);
  await set(15, 2, "activation = 'draft', agreement_state = 'draft', contact_state = 'contacted'"); await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) VALUES ('avi@example.test', 'catalog.engagement.reopen', 'engagement', '15/2', '{\"from\":\"retired\",\"to\":\"draft\",\"reason\":\"ישן\"}', now() - interval '3 days')");
  await set(15, 2, "retired_reason = 'הוצאה ישנה', retired_at = now() - interval '4 days'");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail, created_at) SELECT 'a@example.test', 'catalog.engagement.update', 'engagement', '15/2', '{\"fields\":[\"priority\"]}', now() - interval '1 hour' + g * interval '1 second' FROM generate_series(1, 230) g");
  await openEngagement(page, 15, 2);
  await expect(life(page)).toContainText('לא נמצא בין 200 הרישומים האחרונים של ההתקשרות'); await expect(life(page)).toContainText('לא נמצאו אירועי מחזור חיים בין 200'); await expect(life(page)).not.toContainText('לא נרשמה השהיה'); await expect(life(page)).not.toContainText('לא נרשמו אירועי מחזור חיים.');
  await expect(life(page)).toContainText('בעבר: ההתקשרות אינה מוצאת משימוש כעת'); await expect(life(page)).toContainText('הוצאה ישנה');
  await expect(page.locator('#ct-log')).toContainText('200 הרישומים האחרונים');
});

test('what the journal and the records hold is shown as text, never as markup: a reason, a pause reason, an actor, a provider name and a service name with tags, on the card, in the history, in the dialog and in the panel of a conflict', async ({ page }) => {
  await open(page);
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await set(15, 2, "activation = 'paused', paused_reason = '" + evil.replace(/'/g, "''") + "'");
  await q('UPDATE professionals SET name = $1 WHERE id = 15', [evil]); await q('UPDATE services SET name = $1 WHERE id = 2', [evil]);
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, 'catalog.engagement.pause', 'engagement', '15/2', $2::jsonb)", [evil, JSON.stringify({ from: 'pending', to: 'paused', reason: evil })]);
  await openEngagement(page, 15, 2);
  await expect(body(page)).toContainText('<img src=x'); await expect(body(page).locator('img, script')).toHaveCount(0); await expect(life(page)).toContainText('<img src=x'); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await bar(page, 'return_to_review').click(); await expect(dlg(page).locator('img, script')).toHaveCount(0); await expect(dlg(page)).toContainText('<img src=x');   // the names are in the dialog, as text
  await page.locator('#ce-reason').fill(evil); await expect(page.locator('#ce-reason')).toHaveValue(evil);
  // a conflict: the other admin's name (the actor of the last change) is in the panel, as text
  await fill(page, 'חזרה', 'return_to_review'); await set(15, 2, "activation = 'pending', paused_reason = NULL"); await submit(page).click();
  await expect(dlg(page).locator('.ce-panel')).toContainText('ההתקשרות השתנתה מאז שצפיתם בה'); await expect(dlg(page).locator('.ce-panel')).toContainText('<img src=x'); await expect(dlg(page).locator('img, script')).toHaveCount(0); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('the dialogs are accessible: role, labels, descriptions, focus kept inside and returned to the button, Escape closes without sending, errors are announced, the table has a caption and headers, the buttons are big enough, and nothing slides off the screen', async ({ page }) => {
  const writes = await open(page);
  await set(15, 1, RETIRED); await openEngagement(page, 15, 1);
  const opener = bar(page, 'reopen'); await opener.click();
  await expect(dlg(page)).toHaveAttribute('role', 'dialog'); await expect(dlg(page)).toHaveAttribute('aria-modal', 'true'); await expect(dlg(page)).toHaveAttribute('aria-labelledby', 'ce-title'); await expect(page.locator('#ce-title')).toHaveText('פתיחה מחדש של התקשרות');
  await expect(page.locator('label[for=ce-reason]')).toHaveText('סיבה (חובה)'); await expect(page.locator('label[for=ce-confirm]')).toContainText('reopen'); await expect(page.locator('#ce-reason')).toBeFocused();
  await expect(page.locator('#ce-reason')).toHaveAttribute('aria-describedby', /ce-reason-h/); await expect(page.locator('#ce-reason-h')).toContainText('נשמרת ביומן לצמיתות'); await expect(page.locator('#ce-confirm')).toHaveAttribute('aria-describedby', /ce-confirm-h/); await expect(page.locator('#ce-confirm-h')).toContainText('הקלידו בדיוק את המילה reopen');
  await expect(page.locator('#ce-reason')).toHaveAttribute('maxlength', '300'); await expect(page.locator('#ce-confirm')).toHaveAttribute('dir', 'ltr'); await expect(page.locator('#ce-confirm')).toHaveAttribute('autocomplete', 'off');
  await expect(dlg(page).locator('table.ce-conseq caption')).toHaveText('מה ישתנה בהתקשרות'); await expect(dlg(page).locator('table.ce-conseq th')).toHaveText(['נושא', 'עכשיו', 'אחרי הפעולה']); await expect(dlg(page).locator('.ce-status')).toHaveAttribute('role', 'alert');
  for (let i = 0; i < 14; i++) await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  for (let i = 0; i < 14; i++) await page.keyboard.press('Shift+Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  const m = await page.evaluate(() => { const f = document.querySelector('.ce-form').getBoundingClientRect(); return { right: f.right, left: f.left, w: innerWidth, h: innerHeight, bottom: f.bottom, sw: document.documentElement.scrollWidth, fw: document.querySelector('.ce-form').scrollWidth, fcw: document.querySelector('.ce-form').clientWidth }; });
  expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(m.w + 1); expect(m.bottom).toBeLessThanOrEqual(m.h + 1); expect(m.sw).toBeLessThanOrEqual(m.w); expect(m.fw).toBeLessThanOrEqual(m.fcw + 1);
  for (const b of await dlg(page).locator('button').all()) { const box = await b.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(40); }
  for (const id of ['#ce-reason', '#ce-confirm']) { const box = await page.locator(id).boundingBox(); expect(box.height).toBeGreaterThanOrEqual(40); }
  // an error is announced at its field; Escape on a clean form closes it and gives the focus back to the button; a typed form asks first and sends nothing
  await submit(page).click(); await expect(page.locator('#ce-reason')).toHaveAttribute('aria-invalid', 'true'); await expect(page.locator('[data-field=reason]')).toHaveClass(/bad/);
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click(); await page.locator('#ce-reason').fill('הקלדה'); await page.keyboard.press('Escape'); await expect(dlg(page).locator('.ce-panel')).toContainText('לסגור בלי לשמור?'); await dlg(page).locator('[data-ce=keep]').click(); await expect(page.locator('#ce-reason')).toHaveValue('הקלדה');
  await dlg(page).locator('[data-ce=cancel]').click(); await dlg(page).locator('[data-ce=discard]').click(); await expect(dlg(page)).toHaveCount(0); expect(writes).toEqual([]); expect((await row(15, 1)).activation).toBe('retired');
  // the card itself: no sideways scroll, no clipped text, no error in the page
  const sw = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, inner: [...document.querySelectorAll('#ct-body .scroll, #ct-body .panel')].filter((e) => e.scrollWidth > e.clientWidth + 1).length })); expect(sw.sw).toBeLessThanOrEqual(sw.w); expect(sw.inner).toBe(0);
});

test('screenshots for the review (desktop and mobile): the buttons of each state, the card of an active engagement whose price was moved by the older pricing screen, and the history of a paused and reopened engagement', async ({ page }, ti) => {
  await open(page);
  await set(11, 1, "activation = 'active', agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 1"); await q("UPDATE pricing SET approved = true, approved_by = 'yosi@example.test', approved_at = now(), service_id = 2 WHERE id = 1");
  await openEngagement(page, 11, 1); await expect(body(page)).toContainText('ההתקשרות פעילה, אך המחיר המקושר אינו עומד בכללי השיוך והאישור'); await expect(body(page)).toContainText('אינו שייך לשירות הזה או לנותן השירות הזה'); await expect(body(page)).toContainText('מאושר, אך אינו מתאים להתקשרות'); await shot(page, ti, 'active-price-moved');
  await set(15, 2, PAUSED); await openEngagement(page, 15, 2); await shot(page, ti, 'paused-card-buttons');
  await set(15, 5, RETIRED); await openEngagement(page, 15, 5); await shot(page, ti, 'retired-card-buttons');
  await openEngagement(page, 13, 5); await shot(page, ti, 'retired-provider-archived');
});
