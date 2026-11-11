// Catalog admin screens, stage 5b-3 (the PRICES: the layers of an engagement, the link of an approved price, and the screen of all the prices), in a real browser (the four projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page and the real function code on an in-memory Postgres with invented "[דמו]" data. Nothing here touches Neon or any network.
const fs = require('fs');
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4186, BASE = 'http://localhost:' + PORT, API = '**/api/kaspchem/admin/catalog/';
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
const cp = (page, a) => page.locator('[data-cp=' + a + ']');
const tools = (page) => page.locator('#ct-price-tools');
async function openEngagement(page, p, s) { await nav(page, 'התקשרויות'); await body(page).locator('button[data-ct=open-eng][data-p="' + p + '"][data-s="' + s + '"]').click(); await ready(page); }
const layer = (p, s, kind) => one('SELECT kind, model, amount::float8 AS amount, percent_low::float8 AS percent_low, percent_high::float8 AS percent_high, minimum_amount::float8 AS minimum_amount, terms_text, status, basis_missing, source_note, source_date::text AS source_date, recorded_by FROM provider_service_prices WHERE professional_id = $1 AND service_id = $2 AND kind = $3', [p, s, kind]);
const eng = (p, s) => one('SELECT activation, pricing_model, pricing_id::int AS pricing_id, agreement_state, contact_state FROM provider_services WHERE professional_id = $1 AND service_id = $2', [p, s]);
const journal = (p, s) => q("SELECT actor, action, detail FROM audit_log WHERE entity = 'engagement' AND entity_id = $1 AND action LIKE 'catalog.price.%' ORDER BY id", [p + '/' + s]);
const shot = async (page, ti, name) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: 'tests/shots/' + ti.project.name + '-prices-' + name + '.png', fullPage: true }); };
const ALLOWED = [/^PUT \/catalog\/engagements\/\d+\/\d+\/prices\/(market|provider_offer|unclassified)$/, /^POST \/catalog\/engagements\/\d+\/\d+\/prices\/unclassified\/classify$/, /^POST \/catalog\/engagements\/\d+\/\d+\/link-price$/, /^POST \/catalog\/engagements\/\d+\/\d+\/unlink-price$/];
async function fillLayer(page, f) { for (const [id, v] of Object.entries(f)) { const el = page.locator('#ce-' + id); if (id === 'model' || id === 'status') await el.selectOption(v); else await el.fill(v); } }
// the demo has two prices in the older table; these are the rows a link needs
const SERVICE5_ROWS = "INSERT INTO pricing (id, service_id, professional_id, label, price, approved, approved_by, approved_at, public) VALUES (3, 5, NULL, '[דמו] מחיר כללי לשירות 5', 700, true, 'yosi@example.test', now(), false), (4, 5, NULL, '[דמו] מחיר שלא אושר', 650, false, NULL, NULL, false), (5, 5, 11, '[דמו] מחיר של נותן שירות אחר', 600, true, 'yosi@example.test', now(), false), (6, 5, NULL, '[דמו] מחיר בלי סכום', NULL, true, 'yosi@example.test', now(), false)";

test('the tools of the card: what each state offers, the kinds of price kept apart in words, what was agreed as the owners reported it, and no approval, publication or activation anywhere', async ({ page }, ti) => {
  await open(page);
  await openEngagement(page, 15, 2); await expect(tools(page).locator('button')).toHaveText(['רישום מחיר שוק', 'רישום הצעת הספק', 'רישום ערך שטרם סווג', 'קישור מחיר מאושר']);
  await expect(tools(page)).toContainText('מדווחים'); await expect(tools(page)).toContainText('הצעת הספק היא מוצעת ואינה הסכמה'); await expect(tools(page)).toContainText('מאושר הוא רק המחיר המקושר מהלשונית ״תמחור״ שאושר שם'); await expect(tools(page)).toContainText('מה סוכם עם הספק (דיווח של הבעלים, לא אימות): מצב ההסכם: לא נדון'); await expect(tools(page)).toContainText('אין שדה של מחיר מוסכם נפרד');
  await openEngagement(page, 11, 1); await expect(tools(page).locator('button')).toHaveText(['עריכת מחיר שוק', 'עריכת הצעת הספק', 'רישום ערך שטרם סווג', 'החלפת המחיר המקושר', 'ניתוק המחיר המקושר']); await expect(tools(page)).toContainText('הערת התנאים: שוחחנו בטלפון (דמו)');
  await openEngagement(page, 11, 2); await expect(tools(page).locator('button')).toHaveText(['רישום מחיר שוק', 'רישום הצעת הספק', 'עריכת ערך שטרם סווג', 'סיווג הערך שטרם סווג', 'קישור מחיר מאושר']);
  await q("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 15 AND service_id = 1"); await openEngagement(page, 15, 1);
  await expect(tools(page).locator('button')).toHaveText(['עריכת מחיר שוק', 'עריכת הצעת הספק', 'רישום ערך שטרם סווג']); await expect(tools(page)).toContainText('ההתקשרות פעילה: כדי להחליף או לנתק את המחיר המקושר יש להשהות אותה');
  for (const [p, s] of [[11, 1], [11, 2], [12, 3], [15, 1], [15, 5], [15, 2]]) { await openEngagement(page, p, s); for (const t of await tools(page).locator('button').allInnerTexts()) expect(t).not.toMatch(/אישור|פרסום|הפעל|למחוק|מחיקה/); }
  await shot(page, ti, 'card-tools');
});

test('CREATE a layer: the boxes follow the model, a bad number or a missing one stops at the box and sends nothing; then ONE request, and the layer shows in its own card with its source', async ({ page }, ti) => {
  const writes = await open(page);
  await openEngagement(page, 15, 2); await cp(page, 'market').click();
  await expect(page.locator('#ce-title')).toHaveText('רישום מחיר שוק'); await expect(dlg(page)).toContainText('אין כאן מחיר מאושר ואין הפעלה'); await expect(page.locator('#ce-model')).toHaveValue('tbd');
  await expect(page.locator('[data-grp=amount]')).toBeHidden(); await expect(page.locator('[data-grp=percent]')).toBeHidden(); await expect(page.locator('[data-grp=minimum]')).toBeHidden(); await expect(page.locator('#ce-status')).toHaveCount(0);   // a market price has no state of an answer
  await page.locator('#ce-model').selectOption('fixed'); await expect(page.locator('[data-grp=amount]')).toBeVisible(); await expect(page.locator('[data-grp=percent]')).toBeHidden();
  await submit(page).click(); await expect(page.locator('[data-field=amount] .ce-fe')).toContainText('מחיר קבוע דורש סכום בלבד'); expect(writes).toEqual([]);
  for (const bad of ['abc', '-5', '1,5', '1.150,5', '₪100']) { await page.locator('#ce-amount').fill(bad); await submit(page).click(); await expect(page.locator('[data-field=amount] .ce-fe')).toContainText('יש להזין מספר'); await expect(page.locator('[data-field=amount] .ce-fe')).toContainText('פסיק מותר רק להפרדת אלפים'); }
  expect(writes).toEqual([]); await expect(page.locator('#ce-amount')).toHaveAttribute('inputmode', 'decimal'); await expect(page.locator('#ce-terms_text')).toHaveAttribute('maxlength', '600');
  await fillLayer(page, { amount: '1,150.50', source_note: 'אתר הספק (בדיקה)', source_date: '2026-10-20' }); await shot(page, ti, 'layer-dialog'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'PUT', path: '/catalog/engagements/15/2/prices/market', csrf: '1' });
  expect(writes[0].body).toEqual({ layer: { model: 'fixed', amount: 1150.5, percent_low: null, percent_high: null, minimum_amount: null, terms_text: null, status: 'recorded', basis_missing: false, source_note: 'אתר הספק (בדיקה)', source_date: '2026-10-20' } });
  expect(await layer(15, 2, 'market')).toMatchObject({ model: 'fixed', amount: 1150.5, status: 'recorded', source_note: 'אתר הספק (בדיקה)', source_date: '2026-10-20', recorded_by: 'yosi@example.test' });
  expect((await journal(15, 2)).map((r) => [r.action, r.detail])).toEqual([['catalog.price.create', { kind: 'market', model: 'fixed', status: 'recorded', created: true }]]);
  await expect(page.locator('.ct-price-market')).toContainText('1,150.5'); await expect(page.locator('.ct-price-market')).toContainText('אתר הספק (בדיקה)'); await expect(page.locator('#toast')).toContainText('השכבה נרשמה'); await expect(cp(page, 'market')).toHaveText('עריכת מחיר שוק');
  await expect(page.locator('.ct-price-approved')).toContainText('אין מחיר מקושר');   // a reported price is not an approved one
  expect((await q('SELECT id FROM pricing ORDER BY id')).map((r) => Number(r.id))).toEqual([1, 2]); expect((await q("SELECT 1 FROM provider_services WHERE activation = 'active'")).length).toBe(0);
});

test('the boxes of each model and every rule of the layer, at the box: a percentage, a range, a minimum; nothing is sent while the layer is not valid, and the offer alone has a state', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 15, 2); await cp(page, 'provider_offer').click();
  await expect(page.locator('#ce-status')).toHaveValue('recorded'); await expect(page.locator('#ce-status option')).toHaveText(['נרשם', 'ממתין לתשובה', 'התקבלה תשובה', 'נדחה']); await expect(dlg(page)).toContainText('התקבלה תשובה: אין בכך הסכמה');
  const seen = async (model) => ({ amount: await page.locator('[data-grp=amount]').isVisible(), percent: await page.locator('[data-grp=percent]').isVisible(), minimum: await page.locator('[data-grp=minimum]').isVisible() });
  const want = { fixed: [true, false, false], percent_of_result: [false, true, false], percent_with_minimum: [false, true, true], variable: [false, false, false], quote: [false, false, false], tbd: [false, false, false] };
  for (const [model, [a, p, m]] of Object.entries(want)) { await page.locator('#ce-model').selectOption(model); expect(await seen(model)).toEqual({ amount: a, percent: p, minimum: m }); }
  await page.locator('#ce-model').selectOption('percent_of_result'); const err = (f) => page.locator('[data-field=' + f + '] .ce-fe');
  await submit(page).click(); await expect(err('percent_low')).toContainText('מודל באחוזים דורש אחוז');
  for (const [low, high, field, text] of [['0', '', 'percent_low', 'מעל 0 ועד 100'], ['101', '', 'percent_low', 'מעל 0 ועד 100'], ['10', '5', 'percent_high', 'סוף הטווח קטן מתחילתו'], ['5', '120', 'percent_high', 'מעל 0 ועד 100']]) { await page.locator('#ce-percent_low').fill(low); await page.locator('#ce-percent_high').fill(high); await submit(page).click(); await expect(err(field)).toContainText(text); }
  await page.locator('#ce-model').selectOption('percent_with_minimum'); await page.locator('#ce-percent_low').fill('5'); await page.locator('#ce-percent_high').fill(''); await submit(page).click(); await expect(err('minimum_amount')).toContainText('דורש סכום מינימום');
  expect(writes).toEqual([]);
  await page.locator('#ce-minimum_amount').fill('600'); await page.locator('#ce-status').selectOption('awaiting_response'); await page.locator('#ce-basis_missing').check(); await page.locator('#ce-terms_text').fill('5% מהחיסכון, לא פחות מ־600 ₪'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes[0].body.layer).toMatchObject({ model: 'percent_with_minimum', amount: null, percent_low: 5, percent_high: null, minimum_amount: 600, status: 'awaiting_response', basis_missing: true, terms_text: '5% מהחיסכון, לא פחות מ־600 ₪' });
  expect(await layer(15, 2, 'provider_offer')).toMatchObject({ model: 'percent_with_minimum', status: 'awaiting_response', basis_missing: true });
  await expect(page.locator('.ct-price-doc')).toContainText('ממתין לתשובה'); await expect(page.locator('.ct-price-doc')).toContainText('חסר בסיס לחישוב');
});

test('EDIT a layer: the version seen is sent (compare-and-set), "no change" sends nothing; another admin changed it meanwhile: nothing is overwritten, the person is told, and the form cannot be sent again', async ({ page }, ti) => {
  const writes = await open(page);
  await openEngagement(page, 15, 1); await cp(page, 'provider_offer').click(); await expect(page.locator('#ce-title')).toHaveText('עריכת הצעת הספק'); await expect(page.locator('#ce-model')).toHaveValue('fixed'); await expect(page.locator('#ce-amount')).toHaveValue('1050');
  await submit(page).click(); await expect(page.locator('[data-field=model] .ce-fe')).toHaveText('לא בוצע שינוי, ולכן אין מה לשמור.'); expect(writes).toEqual([]);
  await page.locator('#ce-amount').fill('1060'); await page.locator('#ce-status').selectOption('received'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0].body.layer).toMatchObject({ model: 'fixed', amount: 1060, status: 'received' }); expect(typeof writes[0].body.expected_updated_at).toBe('string');
  expect(await layer(15, 1, 'provider_offer')).toMatchObject({ amount: 1060, status: 'received', recorded_by: 'yosi@example.test' }); expect((await journal(15, 1)).map((r) => r.action)).toEqual(['catalog.price.update']);
  await expect(page.locator('.ct-price-doc')).toContainText('התקבלה תשובה'); await expect(page.locator('.ct-price-approved')).toContainText('1,150');   // an answer received changes no approved price
  // another admin changes the same layer while this dialog is open
  await cp(page, 'provider_offer').click(); await page.locator('#ce-amount').fill('1070');
  await q("UPDATE provider_service_prices SET amount = 999, recorded_by = 'avi@example.test', updated_at = now() + interval '2 seconds' WHERE professional_id = 15 AND service_id = 1 AND kind = 'provider_offer'");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.price.update', 'engagement', '15/1', '{}')");
  await submit(page).click(); const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('השכבה השתנתה מאז שצפיתם בה'); await expect(panel).toContainText('avi@example.test'); await expect(panel).toContainText('לא נשמר דבר'); await expect(submit(page)).toBeHidden(); await shot(page, ti, 'conflict');
  expect((await layer(15, 1, 'provider_offer')).amount).toBe(999); expect(writes.length).toBe(2);
  await panel.locator('[data-ce=refresh]').click(); await ready(page); await expect(page.locator('.ct-price-doc')).toContainText('999');
});

test('CLASSIFY a value that has no kind yet: the person says what it is, it moves as it is, nothing becomes approved; a kind that exists already is refused at the box', async ({ page }) => {
  const writes = await open(page);
  await openEngagement(page, 11, 2); await cp(page, 'classify').click(); await expect(dlg(page)).toContainText('8–10% מהתוצאה'); await expect(dlg(page)).toContainText('לא נוצר מחיר מאושר, ואין בכך הסכמה של הספק');
  await page.locator('#ce-to').selectOption('provider_offer'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/engagements/11/2/prices/unclassified/classify', body: { to: 'provider_offer' } }); expect(typeof writes[0].body.expected_updated_at).toBe('string');
  expect((await layer(11, 2, 'unclassified'))).toBeUndefined(); expect(await layer(11, 2, 'provider_offer')).toMatchObject({ model: 'percent_of_result', percent_low: 8, percent_high: 10, status: 'recorded' });
  expect((await journal(11, 2)).map((r) => [r.action, r.detail])).toEqual([['catalog.price.classify', { from: 'unclassified', to: 'provider_offer' }]]); await expect(page.locator('.ct-price-doc')).toContainText('8–10% מהתוצאה'); await expect(cp(page, 'classify')).toHaveCount(0);
  // a kind that exists: refused before anything is sent
  await q("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, status, recorded_by) VALUES (11, 2, 'unclassified', 'fixed', 500, 'recorded', 'import:x')"); await openEngagement(page, 11, 2); await cp(page, 'classify').click();
  await page.locator('#ce-to').selectOption('provider_offer'); await submit(page).click(); await expect(page.locator('[data-field=to] .ce-fe')).toContainText('כבר קיימת שכבת ״הצעת הספק״'); expect(writes.length).toBe(1);
});

test('LINK an approved price of the older pricing tab: only a row that is approved, has an amount and belongs to this service (general or this provider) can be chosen, the others say why; the link is not an approval; it can be removed', async ({ page }, ti) => {
  const writes = await open(page); await q(SERVICE5_ROWS);
  await openEngagement(page, 15, 5); await cp(page, 'link').click(); await expect(page.locator('#ce-title')).toHaveText('קישור מחיר מאושר'); await expect(dlg(page)).toContainText('הקישור אינו אישור ואינו הפעלה'); await expect(dlg(page)).toContainText('מחיר חדש, עריכה, אישור ופרסום נעשים בלשונית ״תמחור״');
  const rows = dlg(page).locator('.cp-row'); await expect(rows).toHaveCount(4); await expect(dlg(page).locator('.cp-row input:not([disabled])')).toHaveCount(1);
  await expect(dlg(page).locator('.cp-row.cp-off', { hasText: 'מחיר שלא אושר' })).toContainText('אי אפשר לקשר: לא מאושר'); await expect(dlg(page).locator('.cp-row.cp-off', { hasText: 'נותן שירות אחר' })).toContainText('של נותן שירות אחר'); await expect(dlg(page).locator('.cp-row.cp-off', { hasText: 'בלי סכום' })).toContainText('אין בו סכום');
  await shot(page, ti, 'link-dialog');
  await submit(page).click(); await expect(page.locator('[data-field=pick] .ce-fe')).toContainText('יש לבחור שורה מאושרת'); expect(writes).toEqual([]);
  await dlg(page).locator('.cp-row', { hasText: 'מחיר כללי לשירות 5' }).locator('input').check(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/engagements/15/5/link-price', body: { pricing_id: 3, expected_pricing_id: null } });
  expect(await eng(15, 5)).toMatchObject({ pricing_id: 3, pricing_model: 'fixed', activation: 'pending' }); expect((await journal(15, 5)).map((r) => [r.action, r.detail])).toEqual([['catalog.price.link', { pricing_id: 3 }]]);
  await expect(page.locator('.ct-price-approved')).toContainText('700'); await expect(body(page)).toContainText('המחיר המקושר כפוף לבדיקה מחדש לפני הפעלה'); await expect(body(page)).toContainText('הקישור נשמר ואינו אישור של ההתקשרות'); await expect(cp(page, 'unlink')).toHaveText('ניתוק המחיר המקושר');
  expect((await q('SELECT approved, public FROM pricing WHERE id = 3'))[0]).toEqual({ approved: true, public: false }); expect((await q("SELECT 1 FROM provider_services WHERE activation = 'active'")).length).toBe(0);
  // remove the link: the row of the older tab is untouched, the model goes back to "not set"
  await cp(page, 'unlink').click(); await expect(dlg(page)).toContainText('השורה בלשונית ״תמחור״ לא נמחקת ולא משתנה'); await expect(dlg(page)).toContainText('מודל התמחור של ההתקשרות יחזור ל״טרם נקבע״'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(writes[1]).toMatchObject({ method: 'POST', path: '/catalog/engagements/15/5/unlink-price', body: { expected_pricing_id: 3 } }); expect(await eng(15, 5)).toMatchObject({ pricing_id: null, pricing_model: 'tbd' }); expect(Number((await one('SELECT count(*)::int AS n FROM pricing')).n)).toBe(6);
});

test('LINK, when the world moved: the price lost its approval after the list was loaded, or the engagement became active: the server refuses, the person is told in words, nothing is written, and the dialog cannot be sent again', async ({ page }) => {
  const writes = await open(page); await q(SERVICE5_ROWS);
  await openEngagement(page, 15, 5); await cp(page, 'link').click(); await dlg(page).locator('.cp-row', { hasText: 'מחיר כללי לשירות 5' }).locator('input').check();
  await q('UPDATE pricing SET approved = false, approved_by = NULL, approved_at = NULL, public = false WHERE id = 3'); await submit(page).click();
  let panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('השורה אינה קיימת, אינה מאושרת, אין בה סכום'); await expect(panel).toContainText('לא נשמר דבר'); await expect(submit(page)).toBeHidden(); expect((await eng(15, 5)).pricing_id).toBeNull();
  await panel.locator('[data-ce=refresh]').click(); await ready(page);
  await q('UPDATE pricing SET approved = true, approved_by = $1, approved_at = now() WHERE id = 3', ['yosi@example.test']); await openEngagement(page, 15, 5); await cp(page, 'link').click(); await dlg(page).locator('.cp-row', { hasText: 'מחיר כללי לשירות 5' }).locator('input').check();
  await q("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active', pricing_model = 'fixed', pricing_id = 3 WHERE professional_id = 15 AND service_id = 5");
  await submit(page).click(); panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('ההתקשרות פעילה. יש להשהות אותה לפני החלפת המחיר המקושר'); await expect(panel).toContainText('לא נשמר דבר'); expect(writes.length).toBe(2); expect((await journal(15, 5)).length).toBe(0);
});

test('the screen of all the prices: every engagement with its layers kept apart and the linked price with its approval; the filters, the search, the rows of the older tab, the way to open an engagement; nothing confidential; no approval or publication here', async ({ page }, ti) => {
  await open(page); await nav(page, 'מחירים');
  await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('מחירים'); await expect(page.locator('#ct-h')).toHaveText('מחירים'); await expect(body(page)).toContainText('מדווחים'); await expect(body(page)).toContainText('אין כאן הפעלה ואין פרסום');
  const table = body(page).locator('table'); await expect(table.locator('thead th')).toHaveText(['התקשרות', 'מצב', 'מחיר שוק (מדווח)', 'הצעת הספק (מוצע)', 'ערך שטרם סווג (מדווח)', 'מחיר מקושר (מאושר רק כשמסומן)']);
  await expect(table.locator('tbody tr')).toHaveCount(7); const row = (p, s) => table.locator('tr', { has: page.locator('button[data-p="' + p + '"][data-s="' + s + '"]') });
  await expect(row(11, 1)).toContainText('1,100 ₪'); await expect(row(11, 1)).toContainText('1,000 ₪'); await expect(row(11, 1)).toContainText('ממתין לתשובה'); await expect(row(11, 1)).toContainText('ממתין לאישור'); await expect(row(11, 1)).toContainText('אינו מתאים להתקשרות');   // price 1 is not approved
  await expect(row(15, 1)).toContainText('1,150 ₪'); await expect(row(15, 1)).toContainText('מאושר'); await expect(row(15, 1)).not.toContainText('אינו מתאים'); await expect(row(11, 2)).toContainText('8–10% מהתוצאה'); await expect(row(12, 3)).toContainText('התקבלה תשובה'); await expect(row(15, 5)).toContainText('נדחה');
  const text = await body(page).innerText(); expect(text).not.toMatch(/31337|41414|77\.77|NOTE-SECRET|PAYER-SECRET|עמלה|commission/i);
  await page.locator('#cp-f').selectOption('awaiting_answer'); await expect(table.locator('tbody tr')).toHaveCount(1); await expect(row(11, 1)).toBeVisible();
  await page.locator('#cp-f').selectOption('linked_problem'); await expect(table.locator('tbody tr')).toHaveCount(1); await page.locator('#cp-f').selectOption('no_price'); await expect(table.locator('tbody tr')).toHaveCount(2);
  await page.locator('#cp-f').selectOption(''); await page.locator('#cp-q').fill('נותן שירות ה'); await expect(table.locator('tbody tr')).toHaveCount(3); await page.locator('#cp-q').fill('zzz'); await expect(body(page)).toContainText('לא נמצאו התקשרויות שמתאימות לסינון'); await page.locator('#cp-q').fill(''); await expect(table.locator('tbody tr')).toHaveCount(7);
  await shot(page, ti, 'screen');
  await row(15, 1).locator('button[data-ct=open-eng]').click(); await ready(page); await expect(body(page).locator('h2').first()).toContainText('נותן שירות ה׳'); await expect(tools(page)).toBeVisible();
  // the rows of the older tab
  await nav(page, 'מחירים'); await page.locator('[data-cpv=rows]').click(); await expect(page.locator('[data-cpv=rows]')).toHaveAttribute('aria-pressed', 'true');
  const rows = body(page).locator('table tbody tr'); await expect(rows).toHaveCount(2); await expect(rows.first()).toContainText('מאושר, פנימי'); await expect(rows.nth(1)).toContainText('ממתין לאישור');   // newest first await expect(body(page).locator('table')).toContainText('מקושר'); await expect(body(page).locator('table')).not.toContainText(/31337|NOTE-SECRET/);
  expect(await body(page).locator('button').allInnerTexts()).not.toContain('אישור'); await expect(page.locator('[data-cpv=tab]')).toHaveText('לאישור או פרסום: ללשונית ״תמחור״');
  await page.locator('[data-cpv=tab]').click(); await expect(page.locator('#view h1, #view h2').first()).toContainText('תמחור');
});

test('a price that the older pricing screen moved: the screen of the prices and the card name it; paging of a long list', async ({ page }) => {
  await open(page); await q('UPDATE pricing SET service_id = 2 WHERE id = 2'); await nav(page, 'מחירים'); await page.locator('#cp-f').selectOption('linked_problem');
  const table = body(page).locator('table'); await expect(table.locator('tbody tr')).toHaveCount(2); await expect(table).toContainText('אינו מתאים להתקשרות');
  await openEngagement(page, 15, 1); await expect(body(page)).toContainText('מאושר ויש לו סכום, אך אינו שייך לשירות הזה או לנותן השירות הזה'); await expect(page.locator('.ct-price-approved')).toContainText('מאושר, אך אינו מתאים להתקשרות');
  await demo.setMode('big'); await page.reload(); await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page); await nav(page, 'מחירים');
  await expect(body(page).locator('table tbody tr')).toHaveCount(50); await expect(page.locator('.ct-pager')).toContainText('1–50 מתוך 260'); await page.locator('[data-cpp="1"]').click(); await expect(page.locator('.ct-pager')).toContainText('51–100 מתוך 260'); await page.locator('[data-cpp="-1"]').click(); await expect(page.locator('.ct-pager')).toContainText('1–50 מתוך 260');
});

test('a double click makes one request; an unknown result is only a check of the state; a busy server leaves the form as it was; every request of these screens is one of the listed ones, and nothing goes to the older pricing routes', async ({ page }) => {
  const writes = await open(page); await q(SERVICE5_ROWS);
  await page.route(API + 'engagements/15/2/prices/*', async (route) => { await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await openEngagement(page, 15, 2); await cp(page, 'market').click(); await fillLayer(page, { model: 'fixed', amount: '500' }); await submit(page).dblclick(); await page.locator('#ce-model').evaluate((el) => { el.form.requestSubmit(); el.form.requestSubmit(); });
  await expect(submit(page)).toBeDisabled(); await expect(dlg(page)).toHaveCount(0, { timeout: 10000 }); await ready(page); expect(writes.map((w) => w.method + ' ' + w.path)).toEqual(['PUT /catalog/engagements/15/2/prices/market']); expect((await journal(15, 2)).length).toBe(1);
  await page.unroute(API + 'engagements/15/2/prices/*'); let n = 0;
  await page.route(API + 'engagements/15/2/prices/provider_offer', (route) => { n++; return n === 1 ? route.abort('connectionreset') : n === 2 ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy_retry', message: 'SELECT secret' }) }) : route.continue(); });
  await cp(page, 'provider_offer').click(); await fillLayer(page, { model: 'fixed', amount: '450' }); await submit(page).click(); let panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('לא ידוע אם נשמר'); await expect(panel).toContainText('אל תשלחו שוב'); await expect(panel.locator('[data-ce=again]')).toHaveCount(0); await page.waitForTimeout(1200); expect(writes.length).toBe(2);
  await panel.locator('[data-ce=refresh]').click(); await ready(page); expect(await layer(15, 2, 'provider_offer')).toBeUndefined();
  await cp(page, 'provider_offer').click(); await fillLayer(page, { model: 'fixed', amount: '450' }); await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toContainText('המערכת עסוקה'); await expect(dlg(page).locator('.ce-status')).toContainText('לא נשמר דבר'); await expect(dlg(page)).not.toContainText(/busy_retry|SELECT/); await expect(page.locator('#ce-amount')).toHaveValue('450');
  await page.waitForTimeout(1200); expect(writes.length).toBe(3); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page); expect(writes.length).toBe(4); expect((await layer(15, 2, 'provider_offer')).amount).toBe(450);
  await openEngagement(page, 15, 5); await cp(page, 'link').click(); await dlg(page).locator('.cp-row', { hasText: 'מחיר כללי לשירות 5' }).locator('input').check(); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  for (const w of writes) { expect(ALLOWED.some((re) => re.test(w.method + ' ' + w.path))).toBe(true); expect(w.csrf).toBe('1'); expect(w.path).not.toMatch(/\/pricing|approve|publish|import|actions\/activate/); }
});

test('text from the records is shown as text, never as markup: a source, an offer text and a label of a price with tags, on the card, in the list, in the dialogs; the dialogs are accessible and fit the screen', async ({ page }) => {
  await open(page); const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await q("UPDATE provider_service_prices SET source_note = $1, terms_text = $1 WHERE professional_id = 15 AND service_id = 1 AND kind = 'provider_offer'", [evil]); await q('INSERT INTO pricing (id, service_id, professional_id, label, price, approved, approved_by, approved_at) VALUES (9, 5, NULL, $1, 100, true, $2, now())', [evil, 'yosi@example.test']);
  await openEngagement(page, 15, 1); await expect(body(page)).toContainText('<img src=x'); await expect(body(page).locator('img, script')).toHaveCount(0); await cp(page, 'provider_offer').click(); await expect(page.locator('#ce-source_note')).toHaveValue(evil); await expect(dlg(page).locator('img, script')).toHaveCount(0);
  await expect(dlg(page)).toHaveAttribute('role', 'dialog'); await expect(page.locator('label[for=ce-model]')).toBeVisible(); await expect(page.locator('#ce-model')).toHaveAttribute('aria-describedby', /ce-model-h/); await expect(page.locator('#ce-terms_text')).toHaveAttribute('aria-describedby', /ce-terms_text-h/);
  for (let i = 0; i < 16; i++) await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  const m = await page.evaluate(() => { const f = document.querySelector('.ce-form').getBoundingClientRect(); return { left: f.left, right: f.right, w: innerWidth, bottom: f.bottom, h: innerHeight, sw: document.documentElement.scrollWidth }; }); expect(m.left).toBeGreaterThanOrEqual(0); expect(m.right).toBeLessThanOrEqual(m.w + 1); expect(m.bottom).toBeLessThanOrEqual(m.h + 1); expect(m.sw).toBeLessThanOrEqual(m.w);
  for (const b of await dlg(page).locator('button').all()) { const box = await b.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(40); }
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0);
  await nav(page, 'מחירים'); await expect(body(page).locator('img, script')).toHaveCount(0); await page.locator('[data-cpv=rows]').click(); await expect(body(page)).toContainText('<img src=x'); await expect(body(page).locator('img, script')).toHaveCount(0);
  await openEngagement(page, 15, 5); await cp(page, 'link').click(); await expect(dlg(page)).toContainText('<img src=x'); await expect(dlg(page).locator('img, script')).toHaveCount(0); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('CLASSIFY with a stale view: another owner changed the value after the dialog was opened, so nothing is classified (409), the box says what changed and offers a refresh, and with the fresh view it goes through', async ({ page }) => {
  await q("DELETE FROM provider_service_prices WHERE professional_id = 11 AND service_id = 2 AND kind IN ('unclassified', 'market')");
  await q("INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, status, recorded_by) VALUES (11, 2, 'unclassified', 'fixed', 640, 'recorded', 'import:x')");
  const writes = await open(page);
  await openEngagement(page, 11, 2); await cp(page, 'classify').click(); await expect(dlg(page)).toContainText('640');
  await q("UPDATE provider_service_prices SET amount = 660, recorded_by = 'avi@example.test', updated_at = now() + interval '2 seconds' WHERE professional_id = 11 AND service_id = 2 AND kind = 'unclassified'");
  await q("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('avi@example.test', 'catalog.price.update', 'engagement', '11/2', '{}')");
  await page.locator('#ce-to').selectOption('market'); await submit(page).click();
  const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('השכבה השתנתה מאז שצפיתם בה'); await expect(panel).toContainText('avi@example.test'); await expect(panel).toContainText('לא נשמר דבר'); await expect(submit(page)).toBeHidden();
  expect(writes.length).toBe(1); expect(writes[0].body).toMatchObject({ to: 'market' }); expect(typeof writes[0].body.expected_updated_at).toBe('string');
  expect(await layer(11, 2, 'market')).toBeUndefined(); expect(await layer(11, 2, 'unclassified')).toMatchObject({ amount: 660 }); expect((await journal(11, 2)).filter((r) => r.action === 'catalog.price.classify')).toEqual([]);
  await panel.locator('[data-ce=refresh]').click(); await ready(page); await expect(page.locator('.ct-price-doc')).toContainText('660');
  await cp(page, 'classify').click(); await page.locator('#ce-to').selectOption('market'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await ready(page);
  expect(await layer(11, 2, 'market')).toMatchObject({ amount: 660, status: 'recorded' }); expect(await layer(11, 2, 'unclassified')).toBeUndefined(); expect(writes.length).toBe(2);
});
