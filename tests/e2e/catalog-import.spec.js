// Catalog admin screens, stage 5c (the IMPORT of the sheet: load a CSV, see what it would do, approve it by hand, save it, see the result), in a real browser (the four projects of playwright.config.js).
// The server is the local demo (tests/catalog-demo-server.js): the real admin page, the real import engine and the real function code on an in-memory Postgres with invented "[דמו]" data, and a demo sheet in the
// format of the owners' sheet (tests/fixtures/catalog-sheet-demo.csv). Nothing here touches Neon or any network; the real sheet is not imported.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { startDemo } = require('../catalog-demo-server');

const PORT = 4187, BASE = 'http://localhost:' + PORT, API = '**/api/kaspchem/admin/catalog/';
const DEMO_CSV = path.join(__dirname, '..', 'fixtures', 'catalog-sheet-demo.csv'), DEMO_TEXT = fs.readFileSync(DEMO_CSV, 'utf8');
let demo;
test.beforeAll(async () => { demo = await startDemo(PORT); });
test.afterAll(async () => { await new Promise((r) => demo.server.close(r)); await demo.pg.close(); });
test.beforeEach(async () => { await demo.setMode('full'); });

const ready = (page) => page.waitForFunction(() => document.querySelector('#ct-root') && !document.querySelector('.ct-loading'));
async function open(page) {
  const writes = [];
  page.on('request', (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') { const u = new URL(r.url()); writes.push({ method: r.method(), path: u.pathname.replace('/api/kaspchem/admin', ''), body: r.postData() ? JSON.parse(r.postData()) : null, csrf: r.headers()['x-kaspchem'] }); } });
  await page.goto(BASE + '/admin/kaspchem/?test=yosi@example.test|admin');
  await page.getByRole('button', { name: 'קטלוג ספקים' }).click(); await ready(page);
  await page.locator('.ct-nav button', { hasText: 'ייבוא מהגיליון' }).click(); await ready(page);
  return writes;
}
const body = (page) => page.locator('#ct-body');
const dlg = (page) => page.locator('.ce-modal');
const submit = (page) => dlg(page).locator('[data-ce=submit]');
const q = async (sql, params) => (await demo.pg.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const rowEl = (page, n) => page.locator('.cip-row[data-row="' + n + '"]');
const act = (page, a) => page.locator('[data-cip=' + a + ']');
const shot = async (page, ti, name) => { fs.mkdirSync('tests/shots', { recursive: true }); await page.screenshot({ path: 'tests/shots/' + ti.project.name + '-import-' + name + '.png', fullPage: true }); };
async function loadDemo(page, file) { await page.locator('#cip-file').setInputFiles(file || DEMO_CSV); await expect(page.locator('#cip-file-info')).toContainText('catalog-sheet-demo.csv'); }
async function previewIt(page) { await act(page, 'preview').click(); await expect(page.locator('.cip-review')).toBeVisible(); await expect(page.locator('.cip-row').first()).toBeVisible(); }
const counts = async () => ({ services: Number((await one('SELECT count(*)::int AS n FROM services')).n), providers: Number((await one('SELECT count(*)::int AS n FROM professionals')).n), engagements: Number((await one('SELECT count(*)::int AS n FROM provider_services')).n), layers: Number((await one('SELECT count(*)::int AS n FROM provider_service_prices')).n), imports: Number((await one('SELECT count(*)::int AS n FROM catalog_imports')).n), pricing: Number((await one('SELECT count(*)::int AS n FROM pricing')).n) });
const approve = async (page, n) => { await rowEl(page, n).locator('[data-cipapply]').check(); };
const ALLOWED = [/^POST \/catalog\/imports\/preview$/, /^POST \/catalog\/imports\/apply$/];

test('the screen and the first step: it sits in the menu before the history of imports, says what an import never does, reads the file in the browser only, refuses a file that is too big, and sends nothing until a click', async ({ page }, ti) => {
  const writes = await open(page);
  await expect(page.locator('.ct-nav button')).toHaveText(['סקירה', 'נותני שירות', 'שירותים', 'התקשרויות', 'מחירים', 'ייבוא מהגיליון', 'היסטוריית ייבוא', 'יומן שינויים']); await expect(page.locator('.ct-nav button[aria-current=page]')).toHaveText('ייבוא מהגיליון'); await expect(page.locator('#ct-h')).toHaveText('ייבוא מהגיליון');
  await expect(body(page)).toContainText('שום דבר לא נשמר עד שתאשרו בעצמכם, שורה אחרי שורה'); await expect(body(page)).toContainText('הייבוא אינו מפעיל דבר'); await expect(body(page)).toContainText('מחירים נרשמים כמדווחים בלבד (לא מאושרים ולא הצעת ספק)'); await expect(body(page)).toContainText('ערך שנערך ידנית לא נדרס בלי אישור נפרד');
  await expect(act(page, 'preview')).toBeDisabled(); await expect(act(page, 'edit')).toBeDisabled(); await expect(page.locator('label[for=cip-file]')).toBeVisible(); await expect(page.locator('#cip-file-info')).toContainText('לא נשלח עד שתלחצו');
  await loadDemo(page); await expect(act(page, 'preview')).toBeEnabled(); await expect(page.locator('#cip-file-info')).toContainText('עדיין לא נשלח דבר'); expect(writes).toEqual([]);   // reading the file sends nothing
  await shot(page, ti, 'load');
  await page.locator('#cip-file').setInputFiles({ name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.alloc(1024 * 1024 + 10, 'a') }); await expect(body(page)).toContainText('הקובץ גדול מדי'); expect(writes).toEqual([]);
  // the template of the headers: the very names the engine knows, in the order of the sheet
  await act(page, 'reset').isVisible().catch(() => false);
  const [dl] = await Promise.all([page.waitForEvent('download'), act(page, 'template').click()]); expect(dl.suggestedFilename()).toBe('kaspchem-sheet-headers.csv');
  const text = fs.readFileSync(await dl.path(), 'utf8'); expect(text.charCodeAt(0)).toBe(0xFEFF); expect(text).toContain('"תחום","השירות המדויק","מה השירות נותן ללקוח","שם הספק"'); expect(text.trim().split('\n').length).toBe(1); expect(writes).toEqual([]);
});

test('PREVIEW: one request that writes nothing; the counts; every row in words with what exists, what is new, the price kept as REPORTED, the changes, the questions and the problems; nothing is saved', async ({ page }, ti) => {
  const writes = await open(page); const before = await counts(); const auditBefore = Number((await one('SELECT count(*)::int AS n FROM audit_log')).n);
  await loadDemo(page); await previewIt(page);
  expect(writes.length).toBe(1); expect(writes[0]).toMatchObject({ method: 'POST', path: '/catalog/imports/preview', csrf: '1' }); expect(Object.keys(writes[0].body)).toEqual(['csv']); expect(writes[0].body.csv).toBe(DEMO_TEXT);
  const c = page.locator('.cip-counts'); await expect(c).toContainText('חדשה 5'); await expect(c).toContainText('עם שינויים 1'); await expect(c).toContainText('ללא שינוי 0'); await expect(c).toContainText('דולגה 1'); await expect(c).toContainText('בעיה 5'); await expect(c).toContainText('סך השורות 12'); await expect(c).toContainText('החלטות נדרשות 1');
  await expect(page.locator('.cip-row')).toHaveCount(12);
  await expect(rowEl(page, 2)).toContainText('החזר מס לעצמאים'); await expect(rowEl(page, 2)).toContainText('חדש'); await expect(rowEl(page, 2)).toContainText('תיווצר כטיוטה, לא פעילה'.replace('כטיוטה', 'ממתינה לאישור')); await expect(rowEl(page, 2)).toContainText('מחיר (מדווח בלבד)'); await expect(rowEl(page, 2)).toContainText('ערך שטרם סווג'); await expect(rowEl(page, 2)).toContainText('לא מחיר מאושר ולא הצעת ספק'); await expect(rowEl(page, 2)).toContainText('המחיר נרשם כערך שדווח ושטרם סווג');
  await expect(rowEl(page, 3)).toContainText('מחיר שוק'); await expect(rowEl(page, 3)).toContainText('קיים'); await expect(rowEl(page, 4)).toContainText('שינויים לעומת מה שקיים'); await expect(rowEl(page, 4)).toContainText('מצב קשר'); await expect(rowEl(page, 4)).toContainText('נוצר קשר');
  await expect(rowEl(page, 5).locator('.cip-dec')).toContainText('קיים שירות בשם דומה'); await expect(rowEl(page, 5).locator('.cip-dec')).toContainText('שום דבר לא ימוזג אוטומטית'); await expect(rowEl(page, 5).locator('.cip-dec input[type=radio]')).toHaveCount(3);   // two similar services and "create a new one"
  await expect(rowEl(page, 6)).toContainText('ערך שאינו מוכר'); await expect(rowEl(page, 6)).toContainText('בדרך'); await expect(rowEl(page, 6).locator('[data-cipapply]')).toHaveCount(0);
  await expect(rowEl(page, 7)).toContainText('בקובץ כתוב ששיתוף הפעולה פעיל'); await expect(rowEl(page, 7)).toContainText('בקובץ כתוב שההסכם חתום'); await expect(rowEl(page, 7)).toContainText('אינם נעשים בייבוא'); await expect(rowEl(page, 7).locator('.cip-confirm input[type=checkbox]')).toHaveCount(3);
  await expect(rowEl(page, 8)).toContainText('בטלפון יש אותיות'); await expect(rowEl(page, 9)).toContainText('אותו נותן שירות ואותו שירות מופיעים ביותר משורה אחת'); await expect(rowEl(page, 9)).toContainText('בשורות 9, 10'); await expect(rowEl(page, 11)).toContainText('יש מחיר אבל אין נותן שירות');
  await expect(rowEl(page, 12)).toContainText('עמלות לא מיובאות'); await expect(rowEl(page, 13)).toContainText('דולגה'); await expect(rowEl(page, 13)).toContainText('שורה ריקה');
  expect(await counts()).toEqual(before); expect(Number((await one('SELECT count(*)::int AS n FROM audit_log')).n)).toBe(auditBefore);   // a preview writes nothing, not even a log row
  const text = await body(page).innerText(); expect(text).not.toMatch(/unknown_value|duplicate_engagement|file_says|commission_not_imported|undefined|\[object/); await shot(page, ti, 'preview');
  for (const n of [2, 5, 7]) await rowEl(page, n).screenshot({ path: 'tests/shots/' + ti.project.name + '-import-row' + n + '.png' });   // a row at a size that can be read
});

test('APPROVALS: nothing is approved for the person; a row is complete only when its question is answered and its notes are confirmed; "approve the clean rows" takes only the clean ones; the summary says what would be saved and never an activation', async ({ page }) => {
  await open(page); await loadDemo(page); await previewIt(page);
  await expect(page.locator('.cip-bottom')).toContainText('לא אושר שינוי כלשהו'); await expect(act(page, 'review')).toBeDisabled(); await expect(page.locator('[data-cipapply]:checked')).toHaveCount(0);
  await approve(page, 2); const sum = page.locator('.cip-bottom'); await expect(sum.locator('.cip-sum li')).toHaveText(['1 שירות חדש (כבוי)', '1 נותן שירות חדש', '1 התקשרות חדשה (טיוטה או ממתינה, לא פעילה)', '1 שכבת מחיר מדווחת חדשה']); await expect(act(page, 'review')).toBeEnabled();
  await approve(page, 5); await expect(rowEl(page, 5)).toContainText('האישור לא שלם: חסרה החלטה על שם השירות'); await expect(sum).toContainText('בשורות 5 האישור לא שלם'); await expect(act(page, 'review')).toBeDisabled();
  await rowEl(page, 5).locator('input[data-use=new]').check(); await expect(rowEl(page, 5)).not.toContainText('האישור לא שלם'); await expect(act(page, 'review')).toBeEnabled();
  await approve(page, 7); await expect(rowEl(page, 7)).toContainText('האישור לא שלם: חסר אישור על הערה'); await expect(act(page, 'review')).toBeDisabled();
  for (const box of await rowEl(page, 7).locator('.cip-confirm input').all()) await box.check(); await expect(rowEl(page, 7)).not.toContainText('האישור לא שלם'); await expect(act(page, 'review')).toBeEnabled();
  await act(page, 'approve-none').click(); await expect(page.locator('[data-cipapply]:checked')).toHaveCount(0);
  await act(page, 'approve-clean').click(); await expect(page.locator('[data-cipapply]:checked')).toHaveCount(3); for (const n of [2, 3, 12]) await expect(rowEl(page, n).locator('[data-cipapply]')).toBeChecked(); for (const n of [4, 5, 7]) await expect(rowEl(page, n).locator('[data-cipapply]')).not.toBeChecked();   // not the changed one, not the one with a question, not the ones to confirm
  await expect(sum.locator('.cip-sum')).toContainText('3 נותני שירות חדשים'); await expect(sum.locator('.cip-sum')).toContainText('3 שכבות מחיר מדווחות חדשות'); await expect(sum.locator('.cip-sum')).not.toContainText('עדכוני שירות'); await expect(sum).not.toContainText(/הופעל/);
  // a value that a person edited by hand (or whose origin is unknown) is not overwritten by ticking a row: it has its own, separate tick
  const manual3 = rowEl(page, 3).locator('[data-cipchange][data-cipmanual="1"]'); await expect(manual3).toHaveCount(1); await expect(rowEl(page, 3).locator('[data-cipchange]:checked')).toHaveCount(0); await expect(rowEl(page, 3)).toContainText('הערך נערך ידנית: הסימון הזה הוא אישור נפרד לדרוס אותו');
  await manual3.first().check(); await expect(sum.locator('.cip-sum')).toContainText('1 עדכון שירות'); await manual3.first().uncheck(); await expect(sum.locator('.cip-sum')).not.toContainText('עדכון שירות');
  await rowEl(page, 4).locator('[data-cipapply]').check(); await expect(rowEl(page, 4).locator('[data-cipchange]:checked')).toHaveCount(1); await expect(rowEl(page, 4).locator('[data-cipchange="engagement.contact_state"]')).toBeChecked(); await expect(rowEl(page, 4).locator('[data-cipchange][data-cipmanual="1"]:checked')).toHaveCount(0);
  await rowEl(page, 4).locator('[data-cipchange="provider.contact_phone"]').check(); await expect(sum.locator('.cip-sum')).toContainText('1 עדכון נותן שירות');
  // a filter shows what the person approved; the search box finds a row by its names
  await page.locator('#cip-f').selectOption('approved'); await expect(page.locator('.cip-row')).toHaveCount(4); await page.locator('#cip-f').selectOption('problem'); await expect(page.locator('.cip-row')).toHaveCount(5); await page.locator('#cip-f').selectOption('all'); await page.locator('#cip-q').fill('אורן'); await expect(page.locator('.cip-row')).toHaveCount(1);
});

test('SAVE: an explicit approval (a summary, an acknowledgement, a typed word), then ONE request; what exists afterwards is exactly what was approved: switched-off services, draft or pending engagements, reported prices only, nothing active, no approved price, no commission; the result and the data are shown', async ({ page }, ti) => {
  const writes = await open(page); const before = await counts(); const importedBefore = (await q("SELECT 1 FROM provider_services WHERE updated_by = 'import:yosi@example.test'")).length; await loadDemo(page); await previewIt(page);
  await act(page, 'approve-clean').click(); const shown = await page.locator('.cip-bottom .cip-sum').innerText(); await act(page, 'review').click();
  await expect(page.locator('#ce-title')).toHaveText('אישור הייבוא'); await expect(dlg(page)).toContainText('3 שורות מאושרות'); await expect(dlg(page)).toContainText('לא מופעל שום שירות או התקשרות'); await expect(dlg(page)).toContainText('לא נוצר מחיר מאושר ולא הצעת ספק'); await expect(dlg(page)).toContainText('לא מיובאות עמלות, ושום דבר לא נמחק'); await expect(dlg(page)).toContainText('הקובץ עצמו לא נשמר'); await shot(page, ti, 'save-dialog');
  await submit(page).click(); await expect(page.locator('[data-field=ack] .ce-fe')).toHaveText('יש לסמן שעברתם על השינויים.'); await page.locator('#ce-ack').check();
  for (const wrong of ['', 'IMPORT', 'יבוא', 'import now', 'apply']) { await page.locator('#ce-confirmbox').fill(wrong); await submit(page).click(); await expect(page.locator('[data-field=confirmbox] .ce-fe')).toHaveText('כדי לאשר יש להקליד בדיוק: import'); }
  expect(writes.length).toBe(1); expect(await counts()).toEqual(before);   // only the preview was sent
  await page.locator('#ce-confirmbox').fill('import'); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await expect(page.locator('.cip-done')).toBeVisible();
  expect(writes.length).toBe(2); expect(writes[1]).toMatchObject({ method: 'POST', path: '/catalog/imports/apply', csrf: '1' }); expect(Object.keys(writes[1].body).sort()).toEqual(['approvals', 'csv', 'previewId']); expect(writes[1].body.csv).toBe(DEMO_TEXT); expect(Object.keys(writes[1].body.approvals.rows).sort()).toEqual(['12', '2', '3']);
  await expect(page.locator('.cip-done')).toContainText('הייבוא נשמר'); await expect(page.locator('.cip-done')).toContainText('3 שורות נשמרו, בעסקה אחת'); await expect(page.locator('.cip-done')).toContainText('שום דבר לא הופעל'); const result = await page.locator('.cip-done .cip-sum').innerText(); expect(result).toBe(shown);   // the screen said what the server then did
  const after = await counts(); expect(after).toMatchObject({ services: before.services + 2, providers: before.providers + 3, engagements: before.engagements + 3, imports: before.imports + 1, pricing: before.pricing }); expect(after.layers).toBe(before.layers + 3);
  expect((await q("SELECT name, active FROM services WHERE name LIKE '[דמו] החזר מס לעצמאים' OR name LIKE '[דמו] עורך דין לדוגמה' ORDER BY name")).map((r) => r.active)).toEqual([false, false]);
  const imported = await q("SELECT activation FROM provider_services WHERE updated_by = 'import:yosi@example.test'"); expect(imported.length - importedBefore).toBe(3); expect(imported.every((r) => ['draft', 'pending'].includes(r.activation))).toBe(true); expect((await q("SELECT 1 FROM provider_services WHERE activation = 'active'")).length).toBe(0);
  expect((await q("SELECT kind, recorded_by FROM provider_service_prices WHERE recorded_by = 'import:yosi@example.test' ORDER BY kind")).every((r) => ['market', 'unclassified'].includes(r.kind))).toBe(true); expect((await q("SELECT 1 FROM provider_service_prices WHERE kind = 'provider_offer' AND recorded_by LIKE 'import:%'")).length).toBe(0);
  const log = await one('SELECT file_sha256, rows_total, rows_created, imported_by FROM catalog_imports ORDER BY id DESC LIMIT 1'); expect(log.imported_by).toBe('yosi@example.test'); expect(log.file_sha256).toMatch(/^[0-9a-f]{64}$/); expect(JSON.stringify(await q('SELECT * FROM catalog_imports ORDER BY id DESC LIMIT 1'))).not.toMatch(/גולן|מיכל|050-0000/);   // the log holds no cell of the file
  await shot(page, ti, 'done');
  // the data after the import, on the screens
  await page.locator('[data-cipgo=engagements]').click(); await ready(page); await expect(body(page)).toContainText('[דמו] החזר מס לעצמאים'); await expect(body(page)).toContainText('[דמו] גולן כהן');
  await page.locator('.ct-nav button', { hasText: 'מחירים' }).click(); await ready(page); await page.locator('#cp-q').fill('גולן'); const row = body(page).locator('table tbody tr'); await expect(row).toHaveCount(1); await expect(row).toContainText('1,800 ₪'); await expect(row).toContainText('לא מקושר');   // reported, not approved, not linked
  await page.locator('.ct-nav button', { hasText: 'היסטוריית ייבוא' }).click(); await ready(page); await expect(body(page)).toContainText('CSV');
});

test('FIX WITHOUT LOSING THE WORK: an unknown word is mapped on the screen, an unknown column is mapped, the text of the file is edited on the screen; each makes a new preview, the approvals of the rows that did not change are kept, and the ones that changed are dropped and named', async ({ page }) => {
  const writes = await open(page); await loadDemo(page); await previewIt(page);
  await approve(page, 2); await approve(page, 3); await approve(page, 5); await rowEl(page, 5).locator('input[data-use=new]').check();
  await expect(page.locator('.cip-vals')).toContainText('בדרך'); await page.locator('[data-cipval]').selectOption('contacted'); await act(page, 'apply-values').click();
  await expect(rowEl(page, 6)).toContainText('חדשה'); await expect(rowEl(page, 6).locator('[data-cipapply]')).toBeVisible(); expect(writes.length).toBe(2); expect(writes[1].body.mappings).toEqual({ contact: { 'בדרך': 'contacted' } });
  for (const n of [2, 3, 5]) await expect(rowEl(page, n).locator('[data-cipapply]')).toBeChecked(); await expect(rowEl(page, 5).locator('input[data-use=new]')).toBeChecked(); await expect(page.locator('.cip-review')).not.toContainText('האישור שלהן הוסר'); await expect(page.locator('.cip-vals')).toHaveCount(0);
  // edit the text: fix the phone of row 8; and change a cell of row 2 (approved): its approval goes, the others stay
  await act(page, 'edit').click(); const area = page.locator('#ce-text'); const text = await area.inputValue(); expect(text).toBe(DEMO_TEXT);
  await area.fill(text.replace('"abc"', '"050-0000106"').replace('050-0000101', '050-0000199')); await submit(page).click(); await expect(dlg(page)).toHaveCount(0); await expect(page.locator('.cip-row').first()).toBeVisible();
  expect(writes.length).toBe(3); expect(writes[2].body.csv).toContain('050-0000199'); expect(writes[2].body.mappings).toEqual({ contact: { 'בדרך': 'contacted' } });
  await expect(rowEl(page, 8)).toContainText('חדשה'); await expect(page.locator('.cip-review')).toContainText('שורה שאישרתם השתנתה (שורות 2)'); await expect(rowEl(page, 2).locator('[data-cipapply]')).not.toBeChecked(); await expect(rowEl(page, 3).locator('[data-cipapply]')).toBeChecked(); await expect(rowEl(page, 5).locator('[data-cipapply]')).toBeChecked();
  // an unknown column
  await act(page, 'reset').click(); await page.locator('#cip-file').setInputFiles({ name: 'cols.csv', mimeType: 'text/csv', buffer: Buffer.from('"תחום","השירות המדויק","מי","עוד"\r\n"מיסים","[דמו] שירות לדוגמה","[דמו] ספק לדוגמה","x"\r\n', 'utf8') }); await previewIt(page);
  await expect(page.locator('.cip-cols')).toContainText('עמודות שלא זוהו'); await expect(rowEl(page, 2)).not.toContainText('[דמו] ספק לדוגמה'); await page.locator('[data-cipcol="מי"]').selectOption('provider'); await act(page, 'apply-columns').click(); await expect(rowEl(page, 2)).toContainText('[דמו] ספק לדוגמה');
  expect(writes[writes.length - 1].body.columnMap).toEqual({ 'מי': 'provider' });
});

test('the world moved after the preview: the save is refused, nothing is written, the work is kept, a new preview is one click, and then the save goes through', async ({ page }) => {
  const writes = await open(page); await loadDemo(page); await previewIt(page); await approve(page, 2);
  await q("INSERT INTO services (id, name, topic, active) VALUES (500, '[דמו] שירות שנוסף מבחוץ', 'x', false)"); const before = await counts();
  await act(page, 'review').click(); await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await submit(page).click();
  const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('הקובץ או הנתונים במערכת השתנו מאז התצוגה המקדימה'); await expect(panel).toContainText('לא נשמר דבר'); await expect(submit(page)).toBeHidden(); expect(await counts()).toEqual(before); expect(writes.length).toBe(2);
  await panel.locator('[data-ce=refresh]').click(); await expect(dlg(page)).toHaveCount(0); await expect(page.locator('.cip-row').first()).toBeVisible(); expect(writes.length).toBe(3); expect(writes[2].path).toBe('/catalog/imports/preview'); await expect(rowEl(page, 2).locator('[data-cipapply]')).toBeChecked();
  await act(page, 'review').click(); await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await submit(page).click(); await expect(page.locator('.cip-done')).toContainText('הייבוא נשמר'); expect((await counts()).engagements).toBe(before.engagements + 1);
});

test('the result of the save is unknown (the answer was lost but the save happened): nothing is sent again; the check of the state is a new preview, which shows the rows as "no change"', async ({ page }) => {
  const writes = await open(page); const importsBefore = Number((await one('SELECT count(*)::int AS n FROM catalog_imports')).n); await loadDemo(page); await previewIt(page); await approve(page, 2); await approve(page, 12);
  await page.route(API + 'imports/apply', async (route) => { await route.fetch(); await route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>Bad gateway</body></html>' }); });   // the server answered and saved; the page is told "bad gateway" (an aborted connection could be retried by the browser itself)
  await act(page, 'review').click(); await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await submit(page).click();
  const panel = dlg(page).locator('.ce-panel'); await expect(panel).toContainText('לא ידוע אם נשמר'); await expect(panel).toContainText('אל תשלחו שוב'); await expect(panel).toContainText('הפיקו תצוגה מקדימה חדשה'); await expect(panel.locator('[data-ce=again]')).toHaveCount(0); await expect(submit(page)).toBeHidden();
  await page.waitForTimeout(1200); expect(writes.filter((w) => w.path === '/catalog/imports/apply').length).toBe(1);
  await panel.locator('[data-ce=refresh]').click(); await expect(dlg(page)).toHaveCount(0); await expect(page.locator('.cip-row').first()).toBeVisible(); await expect(rowEl(page, 2)).toContainText('ללא שינוי'); await expect(rowEl(page, 12)).toContainText('ללא שינוי');
  expect(writes.filter((w) => w.path === '/catalog/imports/apply').length).toBe(1); expect(Number((await one('SELECT count(*)::int AS n FROM catalog_imports')).n)).toBe(importsBefore + 1);   // it was saved once, and it was not sent again
});

test('refused rows (a decision or a confirmation the server finds missing) are said row by row in words; the work is kept; nothing is written. A double click on the save makes one request; a busy server leaves the dialog as it was', async ({ page }) => {
  const writes = await open(page); await loadDemo(page); await previewIt(page); await approve(page, 2); const before = await counts();
  await page.route(API + 'imports/apply', (route) => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'rows_refused', message: 'SELECT secret', refused: [{ row: 5, reason: 'decision_missing', entity: 'service' }], codes: ['r5:decision_missing:service', 'r7:confirmation_missing', 'r9:change_blocked:service_has_public_price'] }) }));
  await act(page, 'review').click(); await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await submit(page).click(); const panel = dlg(page).locator('.ce-panel');
  await expect(panel).toContainText('חלק מהשורות שאושרו אינן ניתנות לשמירה, ולכן לא נשמר דבר'); await expect(panel).toContainText('שורה 5: חסרה החלטה על שם דומה'); await expect(panel).toContainText('שורה 7: חסר אישור על הערה שדורשת אישור'); await expect(panel).toContainText('שורה 9: שינוי חסום אושר'); await expect(panel).not.toContainText(/decision_missing|rows_refused|SELECT/); expect(await counts()).toEqual(before);
  await panel.locator('[data-ce=refresh]').click(); await expect(rowEl(page, 2).locator('[data-cipapply]')).toBeChecked(); await page.unroute(API + 'imports/apply');
  // busy, then a double click that goes through
  let n = 0; await page.route(API + 'imports/apply', async (route) => { n++; if (n === 1) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'busy_retry', message: 'SELECT secret' }) }); await new Promise((r) => setTimeout(r, 800)); return route.continue(); });
  await act(page, 'review').click(); await page.locator('#ce-ack').check(); await page.locator('#ce-confirmbox').fill('import'); await submit(page).click(); await expect(dlg(page).locator('.ce-status')).toContainText('המערכת עסוקה'); await expect(dlg(page).locator('.ce-status')).toContainText('לא נשמר דבר'); expect(await counts()).toEqual(before);
  const applies = () => writes.filter((w) => w.path === '/catalog/imports/apply').length, base = applies(); await page.waitForTimeout(1200); expect(applies()).toBe(base);   // nothing was sent again by itself after "busy"
  await submit(page).dblclick(); await page.locator('#ce-confirmbox').evaluate((el) => { el.form.requestSubmit(); el.form.requestSubmit(); }); await expect(page.locator('.cip-done')).toBeVisible({ timeout: 10000 }); expect(applies()).toBe(base + 1); expect((await counts()).engagements).toBe(before.engagements + 1);
});

test('text from the file is shown as text, never as markup; a file that is not UTF-8 and a file without the header row say so in words; every request of this screen is the preview or the save', async ({ page }) => {
  const writes = await open(page); const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const csv = '"תחום","השירות המדויק","שם הספק","הערות וקישור להסכם"\r\n"מיסים","[דמו] ' + evil.replace(/"/g, '""') + '","[דמו] <b>ספק</b>","' + evil.replace(/"/g, '""') + '"\r\n';
  await page.locator('#cip-file').setInputFiles({ name: 'evil.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await previewIt(page);
  await expect(body(page)).toContainText('<img src=x'); await expect(body(page).locator('img, script')).toHaveCount(0); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await act(page, 'edit').click(); expect(await page.locator('#ce-text').inputValue()).toBe(csv.replace(/\r\n/g, '\n')); await expect(dlg(page).locator('img, script')).toHaveCount(0); await page.keyboard.press('Escape');   // a text box keeps line breaks as \n
  await act(page, 'reset').click();
  await page.locator('#cip-file').setInputFiles({ name: 'win1255.csv', mimeType: 'text/csv', buffer: Buffer.from([0x22, 0xFA, 0xE7, 0xE5, 0xED, 0x22, 0x2C, 0x22, 0xF9, 0xE9, 0xF8, 0xE5, 0xFA, 0x22, 0x0D, 0x0A, 0x22, 0xE0, 0x22, 0x2C, 0x22, 0xE1, 0x22]) }); await previewIt2(page);
  await expect(body(page)).toContainText('הקובץ אינו בקידוד UTF-8'); await expect(page.locator('.cip-row')).toHaveCount(0);
  await act(page, 'reset').click(); await page.locator('#cip-file').setInputFiles({ name: 'noheader.csv', mimeType: 'text/csv', buffer: Buffer.from('"א","ב"\r\n"1","2"\r\n', 'utf8') }); await previewIt2(page); await expect(body(page)).toContainText('לא נמצאה שורת כותרות עם העמודות ״תחום״ ו״השירות המדויק״');
  for (const w of writes) { expect(ALLOWED.some((re) => re.test(w.method + ' ' + w.path))).toBe(true); expect(w.csrf).toBe('1'); }
});
async function previewIt2(page) { await act(page, 'preview').click(); await expect(page.locator('.cip-review')).toBeVisible(); }

test('the screen is accessible and fits every width: labels, a described file box, a dialog with focus kept inside, error messages announced, big enough buttons, no sideways scroll, rows as cards', async ({ page }) => {
  await open(page); const importsBefore = Number((await one('SELECT count(*)::int AS n FROM catalog_imports')).n); await loadDemo(page); await previewIt(page);
  await expect(page.locator('#cip-file')).toHaveAttribute('type', 'file'); await expect(page.locator('label[for=cip-q]')).toBeVisible(); await expect(page.locator('label[for=cip-f]')).toBeVisible(); await expect(page.locator('.cip-counts')).toHaveAttribute('role', 'status'); await expect(page.locator('.cip-rows .cip-row').first().locator('h4')).toBeVisible();
  for (const box of await rowEl(page, 5).locator('input').all()) { const id = await box.getAttribute('id'); void id; }
  await expect(page.locator('#cip-review-h')).toBeFocused({ timeout: 2000 }).catch(() => {}); const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, wide: [...document.querySelectorAll('.cip-row, .cip-bottom, .cip-review')].filter((e) => e.scrollWidth > e.clientWidth + 1).length })); expect(m.sw).toBeLessThanOrEqual(m.w); expect(m.wide).toBe(0);
  for (const b of await page.locator('.cip .btn').all()) { const box = await b.boundingBox(); if (box) expect(box.height).toBeGreaterThanOrEqual(40); }
  await approve(page, 2); await act(page, 'review').click(); await expect(dlg(page)).toHaveAttribute('role', 'dialog'); await expect(dlg(page)).toHaveAttribute('aria-modal', 'true'); await expect(page.locator('label[for=ce-confirmbox]')).toContainText('import'); await expect(page.locator('#ce-confirmbox')).toHaveAttribute('aria-describedby', /ce-confirmbox-h/);
  for (let i = 0; i < 14; i++) await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.closest('.ce-modal') !== null)).toBe(true);
  await submit(page).click(); await expect(page.locator('#ce-ack')).toHaveAttribute('aria-invalid', 'true'); await expect(dlg(page).locator('.ce-status')).toHaveAttribute('role', 'alert');
  const f = await page.evaluate(() => { const r = document.querySelector('.ce-form').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth, b: r.bottom, h: innerHeight }; }); expect(f.l).toBeGreaterThanOrEqual(0); expect(f.r).toBeLessThanOrEqual(f.w + 1); expect(f.b).toBeLessThanOrEqual(f.h + 1);
  await page.keyboard.press('Escape'); await expect(dlg(page)).toHaveCount(0); expect(Number((await one('SELECT count(*)::int AS n FROM catalog_imports')).n)).toBe(importsBefore);
});
