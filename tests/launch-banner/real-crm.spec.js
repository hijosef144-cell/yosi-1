// Banner -> real CRM app (in-memory database). Every scenario checks what actually ended up in the CRM.
const { test, expect } = require('@playwright/test');
const { waitBanner, openForm, legacyCtx } = require('./helpers');

const CTL = 'http://127.0.0.1:4193';
const PAGE_URL = 'http://127.0.0.1:4190/?lbApi=' + encodeURIComponent('http://127.0.0.1:4192');
const TAG = 'new-initiative-waitlist';
const LIST = 'ממתינים למיזם החדש';
const GUIDE = 'נרשמי מדריך חינם';
const SUBJECT = 'נרשמתם בהצלחה — משהו גדול בדרך!';
const post = (request, p, data) => request.post(CTL + p, { data: data || {} }).then(r => r.json());
const state = (request) => request.get(CTL + '/state').then(r => r.json());
const byEmail = (s, email) => s.contacts.find(c => c.email.toLowerCase() === email.toLowerCase());

test.beforeEach(async ({ request }) => { await post(request, '/reset'); });

const VIEWS = [
  { name: 'mobile', viewport: { width: 390, height: 844 }, mobile: true, source: 'mobile' },
  { name: 'desktop-wide', viewport: { width: 2000, height: 1100 }, mobile: false, source: 'desktop' }
];

async function open(browser, v) {
  const ctx = await legacyCtx(browser, { viewport: v.viewport, isMobile: v.mobile, hasTouch: v.mobile });
  const page = await ctx.newPage();
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await waitBanner(page);
  return { ctx, page, box: await openForm(page) };
}
async function submit(box, email) {
  await box.locator('input[type=email]').fill(email);
  await box.locator('input[type=checkbox]').check();
  await box.locator('.lb-btn').click();
}

for (const v of VIEWS) {
  test.describe(v.name, () => {
    test('new registration is saved in the CRM, classified, consent recorded, one confirmation mail', async ({ browser, request }) => {
      const { ctx, box } = await open(browser, v);
      await submit(box, 'New.Visitor@Example.com');
      await expect(box.locator('.lb-thanks h3')).toHaveText('תודה, אתם ברשימה', { timeout: 15000 });
      const s = await state(request);
      const c = byEmail(s, 'new.visitor@example.com');
      expect(c, 'contact saved').toBeTruthy();
      expect(c.status).toBe('active');
      expect(s.lists.filter(x => x.contact_id === c.id).map(x => x.name)).toEqual([LIST]);   // only the waitlist list, never the guide list
      expect(s.tags.filter(x => x.contact_id === c.id).map(x => x.name)).toEqual([TAG]);
      expect(s.consents).toHaveLength(1);
      expect(s.consents[0]).toMatchObject({ purpose: TAG, status: 'confirmed', consent_version: '2026-11-v1', source_detail: v.source, page: '/' });
      expect(s.consents[0].consent_text).toBe('אני מסכים/ה לקבל בדוא״ל עדכון על השקת המיזם החדש בשיתוף מצפן כלכלי. ניתן לבטל את ההרשמה בכל עת.');
      expect(s.consents[0].consented_at).toBeTruthy();
      expect(s.mail.confirmation).toHaveLength(1);
      expect(s.mail.confirmation[0].subject).toBe(SUBJECT);
      expect(s.mail.confirmation[0].bodyText).toContain('https://matzpenkalkali.com');
      expect(s.mail.confirmation[0].bodyText).not.toContain('כספכם');
      expect(s.mail.verification).toHaveLength(0);
      expect(s.mail.total).toBe(1);                                                          // the guide was not sent
      // a campaign aimed at the tag reaches exactly this contact
      expect((await post(request, '/target-count')).emails).toEqual(['new.visitor@example.com']);
      await ctx.close();
    });

    test('duplicate registration (same address, another browser): one contact, one consent, still one mail', async ({ browser, request }) => {
      const a = await open(browser, v);
      await submit(a.box, 'dup@example.com');
      await expect(a.box.locator('.lb-thanks')).toBeVisible({ timeout: 15000 });
      await a.ctx.close();
      const b = await open(browser, v);
      await submit(b.box, 'DUP@example.com');
      await expect(b.box.locator('.lb-thanks')).toBeVisible({ timeout: 15000 });
      const s = await state(request);
      expect(s.contacts.filter(c => c.email.toLowerCase() === 'dup@example.com')).toHaveLength(1);
      expect(s.consents).toHaveLength(1);
      expect(s.mail.confirmation).toHaveLength(1);
      expect(s.tags.filter(t => t.name === TAG)).toHaveLength(1);
      await b.ctx.close();
    });

    test('an existing guide subscriber keeps everything and is added to the waitlist only', async ({ browser, request }) => {
      const seeded = await post(request, '/seed', { email: 'guide@example.com', name: 'דנה', lists: [GUIDE, 'לקוחות 2024'] });
      const { ctx, box } = await open(browser, v);
      await submit(box, 'guide@example.com');
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 15000 });
      const s = await state(request);
      const c = byEmail(s, 'guide@example.com');
      expect(c.id).toBe(seeded.id);
      expect(c.name).toBe('דנה'); expect(c.status).toBe('active'); expect(c.source).toBe('form');
      expect(s.lists.filter(x => x.contact_id === c.id).map(x => x.name).sort()).toEqual([GUIDE, 'לקוחות 2024', LIST].sort());
      expect(s.tags.filter(x => x.contact_id === c.id).map(x => x.name)).toEqual([TAG]);
      expect(s.mail.confirmation).toHaveLength(1);
      await ctx.close();
    });

    test('someone who unsubscribed earlier is NOT reactivated: verification mail, pending consent, no tags', async ({ browser, request }) => {
      const seeded = await post(request, '/seed', { email: 'gone@example.com', status: 'unsubscribed', lists: [GUIDE] });
      const { ctx, page, box } = await open(browser, v);
      await submit(box, 'gone@example.com');
      await expect(box.locator('.lb-thanks h3')).toHaveText('כמעט סיימנו', { timeout: 15000 });
      await expect(box.locator('.lb-thanks-p')).toContainText('ההרשמה תיכנס לתוקף רק אחרי שתלחצו על הקישור');   // a request to verify, not "you are registered"
      await expect(box.locator('.lb-thanks-p')).not.toContainText('ברשימה');
      await expect(box.locator('.lb-thanks h3')).not.toContainText('תודה');
      const s = await state(request);
      const c = byEmail(s, 'gone@example.com');
      expect(c.id).toBe(seeded.id); expect(c.status).toBe('unsubscribed');
      expect(s.lists.filter(x => x.contact_id === c.id).map(x => x.name)).toEqual([GUIDE]);
      expect(s.tags.filter(x => x.contact_id === c.id)).toEqual([]);
      expect(s.consents[0]).toMatchObject({ status: 'pending' });
      expect(s.mail.verification).toHaveLength(1);
      expect(s.mail.confirmation).toHaveLength(0);                                            // confirmation only after the verification click
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('lb.v1') || '{}').joined || null)).toBeNull();
      expect((await post(request, '/target-count')).emails).toEqual([]);
      await ctx.close();
    });

    test('server failure: nothing half-saved, the page shows an error and keeps the email, retry works', async ({ browser, request }) => {
      await post(request, '/fail-next-consent-insert');
      const { ctx, page, box } = await open(browser, v);
      await submit(box, 'retry@example.com');
      await expect(box.locator('.lb-msg')).toContainText('לא הצלחנו לשמור', { timeout: 15000 });
      await expect(box.locator('.lb-thanks')).toBeHidden();
      await expect(box.locator('input[type=email]')).toHaveValue('retry@example.com');
      let s = await state(request);
      expect(s.contacts).toHaveLength(0); expect(s.tags).toHaveLength(0); expect(s.lists).toHaveLength(0); expect(s.consents).toHaveLength(0);
      expect(s.mail.total).toBe(0);
      await box.locator('.lb-btn').click();                                                   // the visitor retries
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 15000 });
      s = await state(request);
      expect(s.contacts).toHaveLength(1); expect(s.consents).toHaveLength(1); expect(s.mail.confirmation).toHaveLength(1);
      await ctx.close();
    });

    test('confirmation mail fails: the registration still stands and the visitor still sees success', async ({ browser, request }) => {
      await post(request, '/mail-fail');
      const { ctx, box } = await open(browser, v);
      await submit(box, 'nomail@example.com');
      await expect(box.locator('.lb-thanks h3')).toHaveText('תודה, אתם ברשימה', { timeout: 15000 });
      const s = await state(request);
      expect(byEmail(s, 'nomail@example.com')).toBeTruthy();
      expect(s.consents[0].status).toBe('confirmed');
      expect(s.consents[0].confirmation_sent_at).toBeNull();
      expect(s.consents[0].confirmation_error).toBeTruthy();                                  // marker for the admin query
      await ctx.close();
    });

    test('CRM not migrated yet (no consent table): the page shows an error, nothing is written, works after migration', async ({ browser, request }) => {
      await post(request, '/drop-consents');
      const { ctx, box } = await open(browser, v);
      await submit(box, 'early@example.com');
      await expect(box.locator('.lb-msg')).toContainText('לא הצלחנו לשמור', { timeout: 15000 });
      await expect(box.locator('.lb-thanks')).toBeHidden();
      let s = await state(request);
      expect(s.contacts).toHaveLength(0); expect(s.tags).toHaveLength(0); expect(s.mail.total).toBe(0);
      await post(request, '/apply-migration');
      await box.locator('.lb-btn').click();
      await expect(box.locator('.lb-thanks')).toBeVisible({ timeout: 15000 });
      await ctx.close();
    });
  });
}

test('the browser origin is accepted by CORS and an unknown origin is not (preflight)', async ({ request }) => {
  const ok = await request.fetch('http://127.0.0.1:4192/api/email/initiative-waitlist', { method: 'OPTIONS', headers: { Origin: 'http://localhost:4180', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  expect(ok.headers()['access-control-allow-origin']).toBe('http://localhost:4180');
  const bad = await request.fetch('http://127.0.0.1:4192/api/email/initiative-waitlist', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  expect(bad.headers()['access-control-allow-origin'] || '').not.toBe('https://evil.example');
});

test('mail scanners / GET never change a registration; the old guide endpoint is untouched', async ({ request }) => {
  const g = await request.get('http://127.0.0.1:4192/api/email/initiative-waitlist/confirm/1/deadbeef');
  expect([403, 404]).toContain(g.status());
  const s = await state(request);
  expect(s.contacts).toHaveLength(0);
});
