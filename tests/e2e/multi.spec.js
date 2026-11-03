// Multi-select questions + result extras, on a throwaway server that serves tests/fixtures/multi-topics.json (never the published seed).
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

let srv, base;
test.beforeAll(async ({}, ti) => {
  process.env.TOPICS_FILE = path.join(__dirname, '..', 'fixtures', 'multi-topics.json');
  const { start } = require('../dev-server');
  srv = await start(4211 + (ti.workerIndex % 5) + (ti.project.name.length % 7));
  base = 'http://localhost:' + srv.server.address().port;
});
test.afterAll(async () => { if (srv) srv.server.close(); delete process.env.TOPICS_FILE; });
test.beforeEach(({}, ti) => { test.skip(!process.env.ALL_WIDTHS && !/desktop|mobile-390/.test(ti.project.name), 'checked on desktop and one phone width'); });

test('multi-select: explicit continue, exclusive option, several findings with step/official/referral, inactive rule silent', async ({ page }, ti) => {
  await page.goto(base + '/kaspchem/check/lost-funds');
  await expect(page.locator('.multihint')).toContainText('יותר מתשובה אחת');
  const go = page.locator('#mgo');
  await expect(go).toBeDisabled();
  await page.getByRole('checkbox', { name: 'קרוב משפחה נפטר בשנים האחרונות' }).click();
  await page.getByRole('checkbox', { name: 'עבדתי בכמה מקומות עבודה' }).click();
  await page.getByRole('checkbox', { name: 'יש פוליסה ישנה' }).click();
  await expect(go).toBeEnabled();
  // exclusive option clears the others
  await page.getByRole('checkbox', { name: 'אף אחד מאלה' }).click();
  await expect(page.getByRole('checkbox', { name: 'יש פוליסה ישנה' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('checkbox', { name: 'אף אחד מאלה' }).click();            // toggle off
  await expect(go).toBeDisabled();
  await page.getByRole('checkbox', { name: 'קרוב משפחה נפטר בשנים האחרונות' }).click();
  await page.getByRole('checkbox', { name: 'עבדתי בכמה מקומות עבודה' }).click();
  await page.getByRole('checkbox', { name: 'יש פוליסה ישנה' }).click();
  await go.click();
  await expect(page.locator('.q h1')).toContainText('מתי הייתה הפטירה');       // branch from the multi answer
  await page.getByRole('radio', { name: 'בשנתיים האחרונות', exact: true }).click();
  await expect(page.locator('#result h1')).toContainText('2 נושאים', { timeout: 8000 });
  await expect(page.locator('.find')).toHaveCount(2);                            // inactive draft rule did not fire
  await expect(page.locator('#result')).not.toContainText('כלל טיוטה');
  await expect(page.locator('#cta, #lead')).toHaveCount(0);                       // no help button or contact form on the result
  const first = page.locator('.find').first();
  await expect(first).toContainText('הצעד הבא');
  await expect(first.locator('.fx', { hasText: 'הצעד הבא:' })).toHaveCount(1);
  await expect(first.locator('.fx', { hasText: 'איפה:' }).locator('a[href="https://itur.mof.gov.il/"]')).toHaveAttribute('target', '_blank');   // "where:" label, then the official link
  await expect(first).toContainText('הקישור נבדק 01.11.2026');
  await expect(first.locator('details summary')).toContainText('להמשך טיפול');
  await page.waitForTimeout(1500);
  fs.mkdirSync('tests/shots', { recursive: true });
  await page.screenshot({ path: `tests/shots/${ti.project.name}-multi-result.png`, fullPage: true });
});

test('the server accepts valid multi-select answers in a lead and rejects invalid ones', async ({ page, request }) => {
  await page.goto(base + '/kaspchem/check/lost-funds');
  await page.getByRole('checkbox', { name: 'עבדתי בכמה מקומות עבודה' }).click();
  await page.locator('#mgo').click();
  await expect(page.locator('#result h1')).toContainText('נושא אחד', { timeout: 8000 });
  const r = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'lost-funds', answers: { sit: ['jobs', 'old'] }, name: 'נבדק מרובה', phone: '0531230777', consentContact: true } });
  expect((await r.json()).ok).toBe(true);
  const bad = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'lost-funds', answers: { sit: ['none', 'jobs'] }, name: 'נבדק מרובה', phone: '0531230778', consentContact: true } });
  expect((await bad.json()).error).toBe('bad_answers');
});
