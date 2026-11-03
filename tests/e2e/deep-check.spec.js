const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

// Stage 5: the deep check ("תבדקו אותי לעומק"). Runs at 360 / 390 / 768 / 1440 against throwaway servers started HERE (in-memory database, nothing real is touched),
// one per content set and per project, so the shared test server and the other specs are never affected by the deep-check switch.
//   - the published ten (the content that is live today): the deep check works, degraded but valid
//   - the V6 draft (unpublished, local research folder only): the real content of the deep check; skipped with a reason when the folder is not linked
//   - switched off (the default): nothing about the check is shown
const ROOT = process.cwd();
const E = require(path.join(ROOT, 'kaspchem', 'assets', 'engine.js'));
const V6F = path.join(ROOT, 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
const HAS_V6 = fs.existsSync(V6F);
const ADM = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1', 'content-type': 'application/json' };
const PORT0 = { 'mobile-360': 4310, 'mobile-390': 4320, 'tablet-768': 4330, 'desktop-1440': 4340 };

const noHScroll = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(2);
// Edge's phone emulation can report a layout viewport 2px wider than the page, so "nothing sticks out" is checked per element (tolerance 2.5px); the honeypot is parked off-screen on purpose.
const nothingSticksOut = async (page) => expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('body *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 2.5 || r.left < -2.5) && !e.closest('#kp-defs') && !e.closest('.hp'); }).map((e) => e.tagName + '.' + String(e.className && e.className.baseVal !== undefined ? e.className.baseVal : e.className)); })).toEqual([]);

// ---- servers ----
let srv = null, base = '', content = null, origSeed = null, REAL_REQUIRES = null, REAL_READY = null;
// `degrade` = TEST-ONLY reduced mode: the dev server serves the route without `requires`, so the check runs against the ten published topics. realMode() puts the requirements back.
async function serve(ti, slot, set, flag, degrade) {
  process.env.TOPICS_FILE = set === 'v6' ? V6F : '';
  if (!process.env.TOPICS_FILE) delete process.env.TOPICS_FILE;
  content = require(path.join(ROOT, 'netlify', 'functions', '_kaspchem', 'content'));
  if (origSeed === null) { const rt = content.routes.topics.find((t) => t.kind === 'deep'); REAL_READY = { unverified: rt.unverified, approved: rt.approved }; origSeed = content.seed; REAL_REQUIRES = JSON.parse(JSON.stringify(content.routes.topics.find((t) => t.kind === 'deep').requires)); }
  content.setSeed(origSeed); // the published ten, unless the dev server swaps in the V6 draft below
  const { start } = require(path.join(ROOT, 'tests', 'dev-server'));
  setReady(true); // TEST FIXTURE: the real route is not approved and lists unverified rules; the readiness gate is tested on its own below
  srv = await start(PORT0[ti.project.name] + slot, { degradeDeep: !!degrade });
  base = 'http://localhost:' + srv.server.address().port;
  delete process.env.TOPICS_FILE;
  if (flag !== undefined) await setFlag(flag);
}
const realMode = (on) => { const r = content.routes.topics.find((t) => t.kind === 'deep'); r.requires = on ? REAL_REQUIRES : []; };
const setReady = (on) => { const r = content.routes.topics.find((t) => t.kind === 'deep'); r.unverified = on ? [] : REAL_READY.unverified; r.approved = on ? true : REAL_READY.approved; };
async function stop() { if (content && REAL_READY) setReady(false); if (srv) { srv.server.close(); srv = null; } if (content && origSeed) content.setSeed(origSeed); delete process.env.TOPICS_FILE; }
const setFlag = async (v) => { const r = await fetch(base + '/api/kaspchem/admin/settings', { method: 'PUT', headers: ADM, body: JSON.stringify({ key: 'public.deep_enabled', value: v }) }); expect(r.ok).toBe(true); };
const adminGet = async (p) => (await fetch(base + '/api/kaspchem/admin' + p, { headers: ADM })).json();
const configOf = async () => { const j = await (await fetch(base + '/api/kaspchem/config')).json(); const route = j.topics.find((t) => t.kind === 'deep'); return { json: j, route, cfg: route ? E.buildDeep(route, j.topics) : null }; };

// ---- progress recorder: events, not polling ----
const recordProgress = (page) => page.addInitScript(() => {
  window.__ring = []; window.__coins = [];
  new MutationObserver((ms) => ms.forEach((m) => {
    const t = m.target;
    if (m.attributeName === 'data-frac' && t.classList && t.classList.contains('kp-ring') && !t.classList.contains('mini-ring')) window.__ring.push(Number(t.getAttribute('data-frac')));
    if (m.attributeName === 'data-coins' && t.classList && t.classList.contains('kp-jar') && !t.classList.contains('mini-jar')) window.__coins.push(Number(t.getAttribute('data-coins')));
  })).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-frac', 'data-coins'] });
});
const nonDecreasing = (a) => a.every((v, i) => i === 0 || v >= a[i - 1] - 1e-9);

// ---- driving the flow in lockstep with the engine ----
const plain = (q) => q.options.filter((o) => !o.unknown);
function firstPick(q) { const p = plain(q); return q.multi ? [(p.filter((o) => !o.exclusive)[0] || p[0]).id] : p[0].id; }
function nonePick(q) { const ex = q.options.filter((o) => o.exclusive && !o.unknown)[0]; return q.multi ? [(ex || plain(q)[0]).id] : plain(q)[0].id; }
async function openDeep(page, url) {
  await page.goto((url || base) + '/kaspchem/check/deep');
  await page.evaluate(() => sessionStorage.clear()); await page.reload();
  await page.locator('.opt').first().waitFor();
}
async function answerOne(page, q, val) {
  const ids = [].concat(val);
  for (const id of ids) {
    const label = q.options.find((o) => o.id === id).label;
    await page.getByRole(q.multi ? 'checkbox' : 'radio', { name: label, exact: true }).click();
  }
  if (q.multi) await page.locator('#mgo').click();
}
// Answers question after question with `policy(q, answers)`; before each one it checks that the screen asks exactly what the engine says is next.
async function drive(page, cfg, policy, opt) {
  opt = opt || {};
  const answers = Object.assign({}, opt.answers || {}), asked = [], bars = [];
  for (let i = 0; i < 100; i++) {
    const q = E.deepNext(cfg, answers);
    if (!q) break;
    await expect(page.locator('.q h1')).toHaveText(q.text);
    bars.push(Number(await page.locator('.dp-segs').getAttribute('data-frac')));
    if (opt.stopAt && opt.stopAt(q, asked.length)) return { answers, asked, bars, stoppedAt: q };
    const val = policy(q, answers); answers[q.id] = val; asked.push(q.id);
    await answerOne(page, q, val);
  }
  await page.locator('#result h1').waitFor({ timeout: 8000 });
  return { answers, asked, bars };
}
const cardsIn = (page, tier) => page.locator('#result .dp-' + tier + ' .dp-card');
async function counts(page) { return { high: await cardsIn(page, 'high').count(), missing: await cardsIn(page, 'missing').count(), low: await cardsIn(page, 'low').count() }; }
const phone = () => '0505' + String(Math.floor(Math.random() * 900000) + 100000);
// Version 1.0: a result screen has no call to action and no contact form; the only way on is the link "לבדוק תחום אחר" (at least 44px tall).
const noHelpOffer = async (page) => {
  for (const sel of ['#cta', '#lead', '#lead-slot', '#send', '#f-name', '#f-phone', '#f-email', '#c-contact', '#c-mkt', '#done', '#result .more']) await expect(page.locator(sel), sel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'אני רוצה עזרה בבדיקה' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'אני רוצה עזרה בבדיקה' })).toHaveCount(0);
  const text = await page.locator('#app').innerText();
  expect(text).not.toContain('נחזור'); expect(text).not.toContain('השארת פרטים');
  const other = page.getByRole('link', { name: 'לבדוק תחום אחר', exact: true });
  await expect(other).toBeVisible();
  await expect(other).toHaveAttribute('href', '/kaspchem');
  expect((await other.boundingBox()).height).toBeGreaterThanOrEqual(44);
};

// =====================================================================================================================
// The published ten, switched on: the content that is live today. The deep check must work (degraded but valid).
// =====================================================================================================================
test.describe('deep check on the published ten', () => {
  test.describe.configure({ timeout: 180000 }); // a whole check is 25 to 45 clicks: it must not depend on the machine being fast
  test.beforeAll(async ({}, ti) => { await serve(ti, 0, 'ten', true, true); });
  test.afterAll(stop);

  test('home page: the deep tile appears only because the switch is on, beside (wide) or under (phone) the quick tile, and works by keyboard', async ({ page }) => {
    await page.goto(base + '/kaspchem');
    const tile = page.locator('#dp-tile');
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('href', '/kaspchem/check/deep');
    await expect(tile).toContainText('תבדקו אותי לעומק');
    await expect(tile).toContainText('בדיקה מקיפה ומעמיקה יותר, עם שאלות המשך לפי התשובות שלכם');
    expect(await tile.innerText()).not.toMatch(/דקות/);   // no time is promised anywhere
    await expect(page.locator('a.qk-tile')).toHaveCount(1); await expect(page.locator('a.qk-tile')).toBeVisible(); // the quick tile is exactly as before
    await expect(page.locator('.tile')).toHaveCount(10);
    const r = await page.evaluate(() => { const b = (s) => { const x = document.querySelector(s).getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height, r: x.right, b: x.bottom }; }; return { q: b('a.qk-tile'), d: b('#dp-tile'), g: b('#tiles'), vw: document.documentElement.clientWidth }; });
    if (r.vw >= 900) { expect(Math.abs(r.q.y - r.d.y)).toBeLessThanOrEqual(2); expect(r.q.w).toBeLessThan(r.vw * 0.6); expect(Math.abs(r.q.h - r.d.h)).toBeLessThanOrEqual(2); } // side by side, same height
    else { expect(r.d.y).toBeGreaterThan(r.q.b - 2); expect(Math.abs(r.q.x - r.d.x)).toBeLessThanOrEqual(2); expect(Math.abs(r.q.w - r.d.w)).toBeLessThanOrEqual(2); } // stacked, same width
    expect(Math.max(r.q.b, r.d.b)).toBeLessThanOrEqual(r.g.y);                              // both above the ten cubes
    expect(r.d.h).toBeGreaterThanOrEqual(44);
    await nothingSticksOut(page); await noHScroll(page);
    let reached = false;
    for (let i = 0; i < 14 && !reached; i++) { await page.keyboard.press('Tab'); reached = await page.evaluate(() => document.activeElement && document.activeElement.id === 'dp-tile'); }
    expect(reached, 'Tab reaches the deep tile').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/kaspchem\/check\/deep$/);
    await expect(page.locator('.crumb')).toContainText('בדיקה מעמיקה');
  });

  test('flow on the published ten: phases, progress that never goes down, the profile once, a result with no help button or contact form, a request of topic deep stored through the API', async ({ page, request }) => {
    const { cfg } = await configOf();
    await recordProgress(page);
    await openDeep(page);
    // three phases, the first one current; three segments; the profile is only the questions that are used (home, mortgage, work)
    await expect(page.locator('.dp-phases .dp-ph')).toHaveText(['1פרופיל', '2תחומים', '3סיכום']);
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
    await expect(page.locator('.dp-seg')).toHaveCount(3);
    await expect(page.locator('.q')).toContainText('בדיקה מקיפה ומעמיקה יותר');                      // the intro on the first screen
    expect(cfg.questions.filter((q) => q.topicId === 'profile').map((q) => q.id)).toEqual(['profile.home', 'profile.mortgage', 'profile.worknow']);
    const run = await drive(page, cfg, (q) => firstPick(q));
    expect(nonDecreasing(run.bars)).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__ring))).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__coins))).toBe(true);
    // facts: derived questions were never asked (the profile answered them)
    expect(run.asked).not.toContain('housing.status'); expect(run.asked).not.toContain('mortgage.has'); expect(run.asked).not.toContain('payslip-rights.emp');
    await expect(page.locator('.dp-ph-cur')).toHaveText('3סיכום');
    expect(Number(await page.locator('.dp-segs').getAttribute('data-frac'))).toBe(1);
    // the result: the counts the engine gives, and no help button or contact form
    const res = E.evaluateDeep(cfg, run.answers), c = await counts(page);
    expect(c.high).toBe(res.counts.highCards); expect(c.missing).toBe(res.counts.missingItems); expect(c.low).toBe(res.counts.lowCards);
    await noHelpOffer(page);
    const y = (sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    expect(await y('#result h1')).toBeLessThan(await y('.dp-cta'));
    await expect(page.locator('#result')).toContainText('תוצאות ראשוניות בלבד');
    await nothingSticksOut(page); await noHScroll(page);
    // the backend is unchanged: the request the form used to send is posted directly. Refusals first (they store nothing), then success.
    const badPhone = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'deep', answers: run.answers, name: 'בדיקת עומק', phone: '12345', email: '', website: '', consentContact: true, consentMarketing: false } });
    expect(badPhone.status()).toBe(400); expect((await badPhone.json()).error).toBe('bad_phone');
    const noConsent = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'deep', answers: run.answers, name: 'בדיקת עומק', phone: phone(), email: '', website: '', consentContact: false, consentMarketing: false } });
    expect(noConsent.status()).toBe(400); expect((await noConsent.json()).error).toBe('consent_required');
    expect((await adminGet('/requests?topic=deep')).requests.length).toBe(0);
    const sent = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'deep', answers: run.answers, name: 'בדיקת עומק', phone: phone(), email: '', website: '', consentContact: true, consentMarketing: false } });
    expect(sent.status()).toBe(200); expect((await sent.json()).ok).toBe(true);
    const list = (await adminGet('/requests?topic=deep')).requests;
    expect(list.length).toBe(1); expect(list[0].topic).toBe('deep');
    const d = (await adminGet('/requests/' + list[0].id)).request;
    expect(d.findings).toEqual(E.deepFindingIds(res));
  });

  test('back goes to the previous question and may lower the progress; a reload resumes where the visitor was; stale saved answers are dropped', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const run = await drive(page, cfg, (q) => firstPick(q), { stopAt: (q, n) => n === 6 });
    const before = Number(await page.locator('.dp-segs').getAttribute('data-frac'));
    await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
    const prev = run.asked[run.asked.length - 1], pq = cfg.questions.find((q) => q.id === prev);
    await expect(page.locator('.q h1')).toHaveText(pq.text);
    expect(Number(await page.locator('.dp-segs').getAttribute('data-frac'))).toBeLessThanOrEqual(before);
    // reload: the same question again, with the earlier answers kept
    await page.reload();
    await expect(page.locator('.q h1')).toHaveText(pq.text);
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('kaspchem:deep')));
    expect(Object.keys(saved.a).length).toBe(run.asked.length - 1);
    // a stale shape (a removed option, an array for a single question, an answer to a question that is not shown) is dropped, the valid answer is kept, the flow still runs
    await page.evaluate(() => sessionStorage.setItem('kaspchem:deep', JSON.stringify({ a: { 'profile.home': 'gone', 'profile.mortgage': 'no', 'profile.worknow': ['employee'], 'housing.rentaid': 'yes' }, o: ['profile.home', 'profile.mortgage', 'profile.worknow', 'housing.rentaid'] })));
    await page.reload();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((q) => q.id === 'profile.home').text);
    await page.locator('.opt').first().click();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((q) => q.id === 'profile.worknow').text); // the mortgage answer survived, the work answer (wrong shape) did not
  });

});

// =====================================================================================================================
// The V6 draft: the real content of the deep check. Local only (the research folder is private and is never committed).
// =====================================================================================================================
test.describe('deep check on the V6 draft', () => {
  test.describe.configure({ timeout: 180000 }); // a whole check is 25 to 45 clicks: it must not depend on the machine being fast
  test.beforeAll(async ({}, ti) => { if (HAS_V6) await serve(ti, 1, 'v6', true); });
  test.afterAll(stop);
  test.beforeEach(() => { test.skip(!HAS_V6, 'V6 draft not available in this checkout (the private research folder is not linked)'); });

  test('questions: a grouped multi-select with hints, the reason for a personal question, "prefer not to answer", skip and back', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    // up to the family question
    const run = await drive(page, cfg, (q) => firstPick(q), { stopAt: (q) => q.id === 'profile.family' });
    expect(run.stoppedAt.id).toBe('profile.family');
    const q = page.locator('.q');
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
    // grouped options with group labels
    await expect(q.locator('.dp-group')).toHaveCount(3);
    await expect(q.locator('.dp-gl')).toHaveText(['ילדים ומשפחה', 'עבודה והכנסה', 'בריאות, גיל ועזרה']);
    // a hint beside an option, connected to it for screen readers (and not part of its name)
    const care = page.getByRole('checkbox', { name: /זקוק לעזרה של אדם אחר/ });
    await expect(care).toContainText('כולל הורים מבוגרים שבאחריותכם');
    const hid = await care.getAttribute('aria-describedby');
    expect(await page.locator('#' + hid).textContent()).toContain('כולל הורים מבוגרים');
    expect(await care.getAttribute('aria-label')).toBeNull();
    // the neutral reason, and the optional answer
    await expect(q.locator('.dp-why')).toContainText('למה שואלים');
    await expect(q.locator('.dp-why')).toContainText('מעדיפ/ה לא לענות');
    const pna = page.getByRole('checkbox', { name: 'מעדיפ/ה לא לענות', exact: true });
    await expect(pna).toBeVisible();
    // exclusive: choosing it clears the others, and choosing another clears it
    await page.getByRole('checkbox', { name: 'יש ילדים מתחת לגיל 18 במשפחה', exact: true }).click();
    await pna.click();
    await expect(pna).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('checkbox', { name: 'יש ילדים מתחת לגיל 18 במשפחה', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('checkbox', { name: 'אף אחד מאלה', exact: true }).click();
    await expect(pna).toHaveAttribute('aria-checked', 'false');
    await nothingSticksOut(page); await noHScroll(page);
    // skip: answers with "prefer not to answer" and moves on
    await page.locator('#dp-skip').click();
    const next = E.deepNext(cfg, Object.assign({}, run.answers, { 'profile.family': ['pna'] }));
    await expect(page.locator('.q h1')).toHaveText(next.text);
    // back returns to the family question, with nothing selected (the skipped answer was taken back)
    await page.getByRole('button', { name: 'חזרה לשאלה הקודמת' }).click();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.family').text);
  });

  test('a declined personal question is "missing information", never a finding: ONE calm card (no list of rights), operated by keyboard, and the result is re-evaluated with the new answer', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['pna'] : q.id === 'profile.worknow' ? 'retired' : q.id === 'profile.workhist' ? ['none'] : nonePick(q));
    const run = await drive(page, cfg, policy);
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.counts.missingCards).toBeGreaterThan(10);                                      // many rights wait for this one answer ...
    expect(res.high.some((f) => f.topicId === 'national-insurance')).toBe(false);
    const sec = page.locator('#dp-sec-missing');
    await expect(sec.locator('h2')).toContainText('חסר מידע — כדאי להשלים בדיקה');
    expect(res.counts.missingItems).toBeLessThanOrEqual(3);
    await expect(sec.locator('.dp-group-card')).toHaveCount(1);                              // ... and the visitor sees exactly ONE card for them
    const card = sec.locator('.dp-group-card');
    await expect(card).toContainText('חסרה תשובה אחת, והיא משפיעה על כמה תחומים בבדיקה');
    await expect(card).toContainText('חסר מידע: מה מתאים למשפחה שלכם');
    await expect(card).toContainText('תשובה זו משפיעה על כמה תחומים בבדיקה.');
    await expect(card.locator('li')).toHaveCount(0);                                         // no list of rights
    await expect(card.locator('details')).toHaveCount(0);
    const f0 = res.missingCards[0]; expect(f0.why || (f0.parts && f0.parts[0].why)).toBeTruthy();
    expect(await sec.innerText()).not.toContain((f0.why || f0.parts[0].why).slice(0, 40));      // no claim about the visitor
    expect(await sec.innerText()).not.toContain(f0.title);                                      // none of the 15 titles is listed
    const action = card.getByRole('button', { name: 'להשלמת התשובה' });
    expect((await action.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await nothingSticksOut(page); await noHScroll(page);
    // keyboard: focus the action, Enter takes the visitor to that very question
    await action.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.family').text);
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
    // answer it, and the visitor is back at the RESULT (nothing else is asked again), now evaluated with the new answer
    await page.getByRole('checkbox', { name: 'אף אחד מאלה', exact: true }).focus(); await page.keyboard.press('Space');
    await page.locator('#mgo').focus(); await page.keyboard.press('Enter');
    await page.locator('#result h1').waitFor({ timeout: 8000 });
    const after = E.evaluateDeep(cfg, Object.assign({}, run.answers, { 'profile.family': ['none'] }));
    expect(after.counts.missingCards).toBeLessThan(res.counts.missingCards);
    expect((await counts(page)).missing).toBe(after.counts.missingItems);
    await expect(sec.locator('.dp-group-card')).toHaveCount(0);                              // the folded card is gone: its answer was given
  });

  test('per person: the spouse meets a rule\'s conditions and the respondent does not → the question is asked FOR THE SPOUSE, a HIGH card is labelled for the spouse, nothing for the respondent', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['retire'] : q.id === 'profile.who_retire' ? ['spouse'] : q.id === 'national-insurance.retirefacts@spouse' ? ['nopension'] : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : nonePick(q));
    const run = await drive(page, cfg, policy, { stopAt: (q) => q.id === 'profile.who_retire' });
    const who = cfg.questions.find((x) => x.id === 'profile.who_retire');
    await expect(page.locator('.q h1')).toHaveText(who.text);
    await expect(page.locator('.q .help')).toContainText('יש במשפחה אדם שהגיע לגיל הפרישה');
    await expect(page.getByRole('checkbox')).toHaveText(['אני', 'בן/בת הזוג', 'הורה', 'מעדיפ/ה לא לענות']);
    await expect(page.locator('#dp-skip')).toBeVisible();
    expect(run.asked.filter((id) => /^profile\.who_/.test(id))).toEqual([]);                   // the minimal flow: no "whom" screen before it is needed
    const done = await drive(page, cfg, policy, { answers: Object.assign({}, run.answers) });
    // the per-person fact question: the person is named in the question, and in a chip above it
    const spouseQ = cfg.questions.find((x) => x.id === 'national-insurance.retirefacts@spouse');
    expect(done.asked).toContain('national-insurance.retirefacts@spouse'); expect(done.asked).not.toContain('national-insurance.retirefacts'); // asked for the spouse only
    expect(spouseQ.text.indexOf('עבור בן/בת הזוג: ')).toBe(0);
    const res = E.evaluateDeep(cfg, done.answers);
    expect(res.high.some((f) => f.base === 'national-insurance.ni-oldage' && f.subject === 'spouse')).toBe(true);
    expect(res.high.some((f) => f.subject === 'me')).toBe(false);
    const card = page.locator('#dp-sec-high .dp-card', { hasText: 'כדאי להגיש תביעה לקצבת זקנה' });
    await expect(card).toHaveCount(1);
    await expect(card.locator('.dp-chip')).toHaveText('עבור: בן/בת הזוג');
    await expect(card.locator('.dp-subjnote')).toHaveText('ההתאמה נבדקה לפי התשובות שלכם על בן/בת הזוג, ולא לפי מצבכם.');
    await expect(page.locator('#result .dp-chip', { hasText: 'עבור: אני' })).toHaveCount(0);   // nothing for the respondent
    await nothingSticksOut(page); await noHScroll(page);
  });

  test('per person: me and the spouse both chosen → both sets of questions (the person is named), two separately labelled cards, the facts of one are never used for the other', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['stopped'] : q.id === 'profile.who_stopped' ? ['me', 'spouse'] : q.id === 'national-insurance.stopfacts' ? ['ok'] : q.id === 'national-insurance.stopfacts@spouse' ? ['emp_noreg'] : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : q.id === 'payslip-rights.emp@spouse' ? 'other' : nonePick(q));
    const run = await drive(page, cfg, policy);
    const mine = run.asked.indexOf('national-insurance.stopfacts'), his = run.asked.indexOf('national-insurance.stopfacts@spouse');
    expect(mine).toBeGreaterThan(-1); expect(his).toBeGreaterThan(mine);                       // the respondent's questions, then the spouse's
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.high.filter((f) => f.base === 'national-insurance.ni-unemp').map((f) => f.subject)).toEqual(['spouse']); // only the spouse meets it; the respondent said "ok"
    await expect(page.locator('#dp-sec-high .dp-card', { hasText: 'כדאי להירשם בשירות התעסוקה' }).locator('.dp-chip')).toHaveText('עבור: בן/בת הזוג');
  });

  test('per person: a child stopped working and a parent served in the reserves → each is asked about separately (the person is named), each gets a card labelled for that person, nothing is attributed to the respondent', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['stopped', 'reserve'] : q.id === 'profile.who_stopped' ? ['child'] : q.id === 'profile.who_reserve' ? ['parent'] : q.id === 'national-insurance.stopfacts@child' ? ['emp_noreg'] : q.id === 'national-insurance.reservefacts@parent' ? ['emp_unpaid'] : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : nonePick(q));
    const run = await drive(page, cfg, policy);
    expect(run.asked).toEqual(expect.arrayContaining(['national-insurance.stopfacts@child', 'national-insurance.reservefacts@parent', 'tax-refunds.kind@parent']));
    for (const own of ['national-insurance.stopfacts', 'national-insurance.reservefacts', 'tax-refunds.kind']) expect(run.asked).not.toContain(own);   // nothing is asked about the respondent's own situation
    expect(run.asked).not.toContain('national-insurance.stopfacts@parent'); expect(run.asked).not.toContain('national-insurance.reservefacts@child');
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.high.filter((f) => f.subject).map((f) => f.base + '@' + f.subject).sort()).toEqual(['national-insurance.ni-reserve-emp@parent', 'national-insurance.ni-unemp@child']);
    expect(res.high.some((f) => f.subject === 'me')).toBe(false);
    const child = page.locator('#dp-sec-high .dp-card', { hasText: 'כדאי להירשם בשירות התעסוקה' });
    await expect(child.locator('.dp-chip')).toHaveText('עבור: ילד/ה');
    await expect(child.locator('.dp-subjnote')).toHaveText('ההתאמה נבדקה לפי התשובות שלכם על הילד/ה, ולא לפי מצבכם.');
    const parent = page.locator('#dp-sec-high .dp-card', { hasText: 'כדאי לבדוק תגמולי מילואים שלא שולמו (שכירים)' });
    await expect(parent.locator('.dp-chip')).toHaveText('עבור: הורה');
    await expect(parent.locator('.dp-subjnote')).toHaveText('ההתאמה נבדקה לפי התשובות שלכם על ההורה, ולא לפי מצבכם.');
    await expect(page.locator('#result .dp-chip', { hasText: 'עבור: אני' })).toHaveCount(0);
    await nothingSticksOut(page); await noHScroll(page);
  });

  test('per person: "prefer not to answer" on the whom question and on a person\'s fact question is unknown → missing information naming the question and the person, never high', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['retire', 'health'] : q.id === 'profile.who_retire' ? ['me', 'spouse'] : q.id === 'profile.who_health' ? ['pna'] : q.id === 'national-insurance.retirefacts' ? ['nopension'] : q.id === 'national-insurance.retirefacts@spouse' ? ['pna'] : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : nonePick(q));
    const run = await drive(page, cfg, policy);
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.high.filter((f) => f.base === 'national-insurance.ni-oldage').map((f) => f.subject)).toEqual(['me']);
    const miss = page.locator('#dp-sec-missing');
    await expect(miss).toContainText('עבור בן/בת הזוג: ');                                       // the missing answer names the person
    await expect(miss).toContainText('חסר מידע: עבור בן/בת הזוג');
    // the spouse's retirement card is NOT in the high tier
    await expect(page.locator('#dp-sec-high .dp-chip', { hasText: 'עבור: בן/בת הזוג' })).toHaveCount(0);
    // the whom question declined: one calm card (several rights wait for this one answer)
    await expect(miss.locator('.dp-group-card')).toHaveCount(1);
    await expect(miss.locator('.dp-group-card')).toContainText('מי נפגע או חולה');
    await miss.locator('.dp-group-card').getByRole('button', { name: 'להשלמת התשובה' }).focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.who_health').text);
  });

  test('per person: the spouse stopped working → the final-slip and vacation questions are asked for the spouse (named), and the findings are for the spouse', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['stopped'] : q.id === 'profile.who_stopped' ? ['spouse'] : q.id === 'national-insurance.stopfacts@spouse' ? ['ok'] : q.id === 'payslip-rights.emp@spouse' ? 'past' : q.id === 'payslip-rights.lastslip@spouse' ? 'no' : q.id === 'payslip-rights.unused@spouse' ? 'no' : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : nonePick(q));
    const run = await drive(page, cfg, policy);
    expect(run.asked).toEqual(expect.arrayContaining(['payslip-rights.emp@spouse', 'payslip-rights.lastslip@spouse', 'payslip-rights.unused@spouse']));
    expect(run.asked).not.toContain('payslip-rights.finpay@spouse');                                         // not asked: nothing was left unused
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.high.filter((f) => f.subject === 'spouse').map((f) => f.base)).toEqual(['payslip-rights.ps-lastslip']);
    await expect(page.locator('#dp-sec-high .dp-card', { hasText: 'כדאי לבקש תלוש אחרון וחישוב סופי' }).locator('.dp-chip')).toHaveText('עבור: בן/בת הזוג');
  });

  test('the running count: "now N topics worth checking" follows the answers, in words that promise nothing; progress of ring, jar and segments never goes down', async ({ page }) => {
    const { cfg } = await configOf();
    await recordProgress(page);
    await openDeep(page);
    await expect(page.locator('#dp-count')).toHaveText('עוד לא זיהינו נושא לבדיקה');
    // lost funds: "an old bank account" is enough for one topic
    const policy = (q) => (q.id === 'lost-funds.events' ? ['bank'] : q.id === 'profile.family' ? ['none'] : q.id === 'profile.workhist' ? ['none'] : q.id === 'profile.worknow' ? 'retired' : firstPick(q));
    const run = await drive(page, cfg, policy, { stopAt: (q) => q.topicId === 'housing' });
    await expect(page.locator('#dp-count')).toHaveText('כרגע נושא אחד שכדאי לבדוק');
    expect(await page.locator('#dp-count').innerText()).not.toMatch(/₪|שקל|כסף|תקבלו|מגיע/);
    const all = await drive(page, cfg, policy, { answers: run.answers });
    expect(nonDecreasing(all.bars)).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__ring))).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__coins))).toBe(true);
    expect((await page.evaluate(() => window.__ring)).pop()).toBe(1);
  });

  test('result: high and missing-information sections in order with the approved headings, four cards first with an expander, three-part cards, no low tier, no help button or contact form', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    // a long result (many high-likelihood topics) and a missing one (an unknown answer)
    const policy = (q, a) => {
      if (q.id === 'profile.worknow') return 'employee';
      if (q.id === 'profile.workhist') return ['emp'];
      if (q.id === 'tax-refunds.letters') return 'unk';
      if (q.id === 'profile.family') return ['none'];
      return firstPick(q);
    };
    const run = await drive(page, cfg, policy);
    const res = E.evaluateDeep(cfg, run.answers), c = await counts(page);
    expect(res.counts.highCards).toBeGreaterThan(4); expect(res.counts.missingItems).toBeGreaterThan(0); expect(res.counts.lowCards).toBe(0);
    expect(c).toEqual({ high: res.counts.highCards, missing: res.counts.missingItems, low: 0 });
    await expect(page.locator('#result h1')).toHaveText('תוצאות הבדיקה המעמיקה');                              // a neutral page heading: the tier names are the section titles
    await expect(page.locator('#result .dp-resultsub')).toHaveText(res.counts.highCards + ' נושאים בסבירות גבוהה שכדאי לבדוק');
    await expect(page.locator('#dp-low')).toHaveCount(0);                                   // the low tier is off: it never appears
    await expect(page.locator('#result')).not.toContainText('סבירות נמוכה');
    const y = (sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    expect(await y('#dp-sec-high')).toBeLessThan(await y('#dp-sec-missing')); expect(await y('#dp-sec-missing')).toBeLessThan(await y('.dp-cta'));
    await expect(page.locator('#dp-sec-high h2')).toHaveText('סבירות גבוהה');                                  // the EXACT tier title, no other words
    await expect(page.locator('#dp-sec-high .dp-tier-sub')).toHaveText('התאמה גבוהה לתנאי הסינון שנבדקו. זו אינה קביעה סופית של זכאות.');
    await expect(page.locator('#dp-sec-high .dp-n')).toHaveText('(' + res.counts.highCards + ')');
    await expect(page.locator('#dp-sec-missing h2')).toHaveText('חסר מידע — כדאי להשלים בדיקה');
    // four cards first, the rest behind an expander that works by keyboard; nothing is deleted
    await expect(page.locator('#dp-sec-high .dp-top .dp-card')).toHaveCount(4);
    await expect(page.locator('#dp-sec-high .dp-card:visible')).toHaveCount(4);
    const tog = page.locator('#dp-high-tog'); await expect(tog).toHaveText('הצגת כל הנושאים (' + (res.counts.highCards - 4) + ')');
    await tog.focus(); await page.keyboard.press('Enter');
    await expect(tog).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#dp-sec-high .dp-card:visible')).toHaveCount(res.counts.highCards);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('dp-high-tog');
    await page.keyboard.press('Space'); await expect(tog).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#dp-sec-high .dp-card')).toHaveCount(res.counts.highCards);
    // each high card: what you can get / how it works / who can help (with an official link)
    const card = page.locator('#dp-sec-high .dp-card').filter({ has: page.locator('a[href^="https://"]') }).first();
    await expect(card.locator('.dp-pt')).toHaveText('מה כדאי לבדוק');
    await expect(card.locator('summary')).toHaveText(['איך זה עובד', 'מי יכול לעזור']);
    await card.locator('details').nth(1).locator('summary').click();
    await expect(card.locator('details').nth(1).locator('a[href^="https://"]').first()).toBeVisible();
    // wording: the single caveat, nothing that claims an entitlement or a time, on the frame of this screen
    const text = await page.locator('#result').innerText();
    expect((text.match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
    const APPROVED_LINE = 'התאמה גבוהה לתנאי הסינון שנבדקו. זו אינה קביעה סופית של זכאות.';   // the one sentence the owner approved under the high tier (it says what the tier is NOT)
    const frame = (await page.locator('#result .head, #result .dp-tier-h, #result .dp-tier-sub, #result .dp-cta').allInnerTexts()).join(' ');
    expect(frame).toContain(APPROVED_LINE);
    expect(frame.replace(APPROVED_LINE, '')).not.toMatch(/מגיע(ים|ות)? לכם|זכאים|זכאי\b|זכאות|זכיתם|הוענק|בוודאות|אושר|דקות/);
    await noHelpOffer(page);                                                                // no help button, no contact form, only "check another topic"
    await nothingSticksOut(page); await noHScroll(page);
  });

  test('the three newly sensitive questions are optional: the reason line, "prefer not to answer", and skipping is unknown (a missing-information item), never "no"', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['death'] : q.id === 'profile.worknow' ? 'employee' : q.id === 'profile.workhist' ? ['emp'] : firstPick(q));
    const run = await drive(page, cfg, policy, { stopAt: (q) => q.id === 'national-insurance.survclaim' });
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'national-insurance.survclaim').text);
    await expect(page.locator('.q .dp-why')).toContainText('למה שואלים'); await expect(page.locator('.q .dp-why')).toContainText('קצבת שאירים');
    await expect(page.getByRole('radio', { name: 'מעדיפ/ה לא לענות', exact: true })).toBeVisible();
    await page.locator('#dp-skip').click();                                                    // skip = prefer not to answer
    const done = await drive(page, cfg, policy, { answers: Object.assign({}, run.answers, { 'national-insurance.survclaim': 'pna' }) });
    const res = E.evaluateDeep(cfg, done.answers);
    expect(res.missing.some((f) => f.localId === 'ni-survivors')).toBe(true); expect(res.high.some((f) => f.localId === 'ni-survivors')).toBe(false);
    await expect(page.locator('#dp-sec-missing')).toContainText('חסר מידע');
  });

  test('keyboard only: the first screens (a single and a multi-select question) can be used without a mouse', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    // first question (single): Tab to the first option, Enter picks it
    await page.locator('.opt').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.mortgage').text);
    await page.locator('.opt').first().focus(); await page.keyboard.press('Space');
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.worknow').text);
    await page.locator('.opt').nth(2).focus(); await page.keyboard.press('Enter');
    // a multi question: Space toggles, Tab reaches "continue", Enter commits
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.workhist').text);
    await page.locator('.opt').first().focus(); await page.keyboard.press('Space');
    await expect(page.locator('.opt').first()).toHaveAttribute('aria-checked', 'true');
    await page.locator('#mgo').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.family').text);
  });

  test('reduced motion: no waiting for animations, no count highlight, everything still works and nothing is cut off', async ({ browser }, ti) => {
    const { cfg } = await configOf();
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: ti.project.use.viewport, locale: 'he-IL' });
    const page = await ctx.newPage();
    await openDeep(page);
    const run = await drive(page, cfg, (q) => firstPick(q), { stopAt: (q, n) => n === 8 });
    expect(await page.locator('.q').evaluate((e) => e.classList.contains('slide-in'))).toBe(false);
    expect(await page.locator('#dp-count').evaluate((e) => e.classList.contains('dp-bump'))).toBe(false);
    await drive(page, cfg, (q) => firstPick(q), { answers: run.answers });
    await page.locator('#result h1').waitFor({ timeout: 1500 });                          // no "summing up" pause
    expect(parseFloat(await page.locator('#result .find').first().evaluate((e) => getComputedStyle(e).animationDuration))).toBeLessThan(0.01);
    await nothingSticksOut(page);
    await ctx.close();
  });

  test('a request from the V6 draft, posted to the API, is stored with topic deep and its findings by tier, and the dashboard shows them', async ({ page, request }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['pna'] : firstPick(q));
    const run = await drive(page, cfg, policy);
    await noHelpOffer(page);                                                                // the result has nothing to press; the request is posted directly
    const sent = await request.post(base + '/api/kaspchem/lead', { data: { topic: 'deep', answers: run.answers, name: 'בדיקת טיוטה', phone: phone(), email: '', website: '', consentContact: true, consentMarketing: false } });
    expect(sent.status()).toBe(200); expect((await sent.json()).ok).toBe(true);
    const res = E.evaluateDeep(cfg, run.answers);
    const list = (await adminGet('/requests?topic=deep')).requests; const mine = list[0];
    const d = (await adminGet('/requests/' + mine.id)).request;
    expect(d.findings).toEqual(E.deepFindingIds(res));
    expect(d.findingDetails.some((x) => x.tier === 'missing')).toBe(true);
    expect(d.readable.length).toBeGreaterThan(5);
  });
});

// =====================================================================================================================
// Switched off (the default): nothing about the deep check is shown, reserved or computed for visitors.
// =====================================================================================================================
const watchShifts = (page) => page.addInitScript(() => {
  window.__all = 0; window.__mine = 0;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) {
    window.__all += e.value;
    // shifts of the featured tiles, the ten cubes or anything after them (a web-font swap in the hero is a different matter)
    const mine = (e.sources || []).some((x) => { const n = x.node; return n && n.closest && n.closest('#dp-feat, #tiles, #pick'); });
    if (mine) window.__mine += e.value;
  } }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
});

test.describe('deep check switched off (the default)', () => {
  test.beforeAll(async ({}, ti) => { await serve(ti, 2, 'ten', undefined, true); });
  test.afterAll(stop);

  test('home page: no deep tile, nothing reserved, the layout is exactly the one without the wrapper, and nothing shifts', async ({ page }) => {
    await watchShifts(page);
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/kaspchem/config')), page.goto(base + '/kaspchem')]); // the config answer is what would have shown the tile
    await expect(page.locator('a.qk-tile')).toBeVisible();
    await expect(page.locator('#dp-tile')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dp-expect'))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBeNull();
    expect(await page.evaluate(() => document.querySelector('#dp-tile').getBoundingClientRect().height)).toBe(0);
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('dp-feat')).display)).toBe('block');
    // layout-neutral wrapper: take the quick tile out of it and nothing below moves
    const pos = () => page.evaluate(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100); }; return { q: r('a.qk-tile'), pick: r('#pick'), tiles: r('#tiles'), how: r('#how') }; });
    const withWrapper = await pos();
    await page.evaluate(() => { const w = document.getElementById('dp-feat'); w.replaceWith(...w.childNodes); });
    expect(await pos()).toEqual(withWrapper);
    // no shifts caused by the deep check's switch (the page settles with the same layout when the config arrives)
    await page.waitForLoadState('load'); await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__mine)).toBeLessThan(0.01);
  });

  test('the config has no trace of the check, and /kaspchem/check/deep shows a friendly "coming soon" page with the other ways to check', async ({ page }) => {
    const j = await (await fetch(base + '/api/kaspchem/config')).json();
    expect(j.topics.some((t) => t.id === 'deep' || t.kind === 'deep')).toBe(false); expect('deep_enabled' in j.settings).toBe(false);
    expect(JSON.stringify(j)).not.toMatch(/בדיקה מעמיקה|profile\./);
    await page.goto(base + '/kaspchem/check/deep');
    await expect(page.locator('h1')).toHaveText('הבדיקה המעמיקה תיפתח בקרוב');
    await expect(page.locator('a[href="/kaspchem/check/quick"]')).toBeVisible();
    await expect(page.locator('a[href="/kaspchem"]').last()).toBeVisible();
    await expect(page.locator('.opt')).toHaveCount(0); await expect(page.locator('.q')).toHaveCount(0); await expect(page.locator('.dp-phases')).toHaveCount(0);
    expect(await page.evaluate(() => [].map.call(document.scripts, (s) => s.src).filter((s) => /deep\.js/.test(s)))).toEqual([]); // the check's code is not even loaded
    await nothingSticksOut(page); await noHScroll(page);
    // the lead endpoint refuses it too
    const r = await fetch(base + '/api/kaspchem/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'deep', answers: {}, name: 'אין כזה', phone: phone(), consentContact: true }) });
    expect((await r.json()).error).toBe('bad_topic');
    expect((await adminGet('/requests?topic=deep')).requests.length).toBe(0);
    // a stale link to a saved answer of a closed check does nothing
    await page.evaluate(() => sessionStorage.setItem('kaspchem:deep', JSON.stringify({ a: { 'profile.home': 'owner' }, o: ['profile.home'] })));
    await page.reload();
    await expect(page.locator('h1')).toHaveText('הבדיקה המעמיקה תיפתח בקרוב');
  });

  test('switching it on later is seen by the next visitor: the tile appears, and a returning visitor gets its place reserved with no shift at all', async ({ page }) => {
    await setFlag(true);
    await watchShifts(page);
    await page.addInitScript(() => { window.__sawExpect = false; new MutationObserver(() => { if (document.documentElement && document.documentElement.classList.contains('dp-expect')) window.__sawExpect = true; }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] }); });
    await page.goto(base + '/kaspchem');
    await expect(page.locator('#dp-tile')).toBeVisible();
    expect(await page.evaluate(() => window.__sawExpect)).toBe(false); // first visit: nothing is remembered yet
    await page.waitForLoadState('load'); await page.waitForTimeout(300);
    const first = await page.evaluate(() => window.__mine);
    expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBe('1');
    // returning visit (this browser remembers): the place is reserved before the answer arrives, nothing moves
    await page.reload();
    await expect(page.locator('#dp-tile')).toBeVisible();
    expect(await page.evaluate(() => window.__sawExpect)).toBe(true); // the place was reserved before the answer arrived (recorded as an event, not polled)
    expect(await page.evaluate(() => document.documentElement.classList.contains('dp-expect'))).toBe(false); // and handed back once the real tile is shown
    await page.waitForLoadState('load'); await page.waitForTimeout(300);
    const second = await page.evaluate(() => window.__mine);
    test.info().annotations.push({ type: 'cls', description: 'deep tile: first visit ' + first.toFixed(4) + ', returning visit ' + second.toFixed(4) });
    console.log(test.info().project.name, 'CLS of the tiles area: first visit', first.toFixed(4), ', returning visit', second.toFixed(4));
    expect(second).toBeLessThan(0.01);
    expect(first).toBeLessThan(0.2);
    // switching it off again: the next visitor sees nothing and the reservation is forgotten
    await setFlag(false);
    // the config answer may be cached by the browser for up to 60 s (public, max-age=60) like every config read: this visitor asks again explicitly
    await page.route('**/api/kaspchem/config', (r) => r.continue({ headers: Object.assign({}, r.request().headers(), { 'cache-control': 'no-cache' }) }));
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/kaspchem/config')), page.reload()]);
    await expect(page.locator('#dp-tile')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dp-expect'))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBeNull();
  });
});

// =====================================================================================================================
// Switched on, but the content lacks what the route requires: for a visitor it is the same as off (nothing is shown, nothing is reserved).
// =====================================================================================================================
test.describe('deep check switched on but not runnable (a required part is not served)', () => {
  test.beforeAll(async ({}, ti) => { await serve(ti, 4, 'ten', undefined, true); });
  test.afterAll(stop);

  test('nothing about it is shown: no tile, the "coming soon" page, the lead refused, the code never loaded; the real requirements are what decides', async ({ page }) => {
    // the switch was turned on while the content satisfied the route (the readiness gate refuses it otherwise); then the content no longer does
    await setFlag(true);
    realMode(true);
    try {
      const j = await (await fetch(base + '/api/kaspchem/config')).json();
      expect(j.topics.some((t) => t.kind === 'deep')).toBe(false); expect('deep_enabled' in j.settings).toBe(false);
      await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/kaspchem/config')), page.goto(base + '/kaspchem')]);
      await expect(page.locator('#dp-tile')).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBeNull();
      await page.goto(base + '/kaspchem/check/deep');
      await expect(page.locator('h1')).toHaveText('הבדיקה המעמיקה תיפתח בקרוב');
      expect(await page.evaluate(() => [].map.call(document.scripts, (s) => s.src).filter((s) => /deep\.js/.test(s)))).toEqual([]);
      const r = await fetch(base + '/api/kaspchem/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'deep', answers: {}, name: 'אין כזה', phone: phone(), consentContact: true }) });
      expect((await r.json()).error).toBe('bad_topic');
      expect((await adminGet('/requests?topic=deep')).requests.length).toBe(0);
    } finally { realMode(false); await setFlag(false); }
  });
});

// =====================================================================================================================
// The content does not load: a clear message with a retry button and a way home; never partial content or a partial result.
// =====================================================================================================================
test.describe('content does not load: a clear message and a retry, never partial content', () => {
  test.describe.configure({ timeout: 120000 });
  test.beforeAll(async ({}, ti) => { await serve(ti, 3, 'ten', true, true); });
  test.afterAll(stop);
  const CFG = '**/api/kaspchem/config';
  const failState = async (page, title) => {
    await expect(page.locator('#load-fail h1')).toHaveText(title);
    await expect(page.locator('#retry')).toBeVisible(); await expect(page.locator('#retry')).toHaveText('נסו שוב');
    await expect(page.locator('#load-fail a[href="/kaspchem"]')).toBeVisible();
    // nothing partial: no question, no option, no phases, no result, no form
    for (const sel of ['.opt', '.q', '#result', '.dp-phases', '.dp-segs', '#lead', '.find']) await expect(page.locator(sel)).toHaveCount(0);
    expect((await page.locator('#retry').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await nothingSticksOut(page); await noHScroll(page);
  };
  const FAIL_DEEP = 'לא הצלחנו לטעון את הבדיקה';

  test('the config answers with an error (500): message + retry; no partial content; retry works once the failure clears, also by keyboard', async ({ page }) => {
    await page.route(CFG, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' }));
    await page.goto(base + '/kaspchem/check/deep');
    await failState(page, FAIL_DEEP);
    await page.unroute(CFG);
    await page.locator('#retry').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toBeVisible(); await expect(page.locator('#load-fail')).toHaveCount(0);
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
  });

  test('the config never answers (timeout): message + retry after the wait, nothing shown meanwhile except the loading line; retry works', async ({ page }) => {
    await page.clock.install();
    await page.route(CFG, () => {});                                                          // the request hangs
    await page.goto(base + '/kaspchem/check/deep');
    await expect(page.locator('#app')).toContainText('טוענים את השאלון');
    for (const sel of ['.opt', '.q', '#result']) await expect(page.locator(sel)).toHaveCount(0);
    await page.clock.fastForward(16000);                                                       // the load gives up after 15 s
    await failState(page, FAIL_DEEP);
    await page.unroute(CFG);
    await page.locator('#retry').click();
    await expect(page.locator('.q h1')).toBeVisible();
  });

  test('a malformed answer (not JSON, JSON without topics, a route without its profile) is a load failure, never a partial check; retry works', async ({ page }) => {
    await page.route(CFG, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"topics":' }));
    await page.goto(base + '/kaspchem/check/deep'); await failState(page, FAIL_DEEP);
    await page.unroute(CFG);
    await page.route(CFG, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"settings":{"deep_enabled":true}}' }));
    await page.locator('#retry').click(); await failState(page, FAIL_DEEP);
    await page.unroute(CFG);
    await page.route(CFG, async (r) => { const j = await (await r.fetch()).json(); j.topics.find((t) => t.kind === 'deep').profile = null; await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) }); });
    await page.locator('#retry').click(); await failState(page, FAIL_DEEP);
    await page.unroute(CFG);
    await page.locator('#retry').click(); await expect(page.locator('.q h1')).toBeVisible();
  });

  test('a topic the route REQUIRES is missing from the answer: "not available right now" + retry, the check is not run in a reduced form; retry works when it is back', async ({ page }) => {
    await page.route(CFG, async (r) => {
      const j = await (await r.fetch()).json();
      j.topics.find((t) => t.kind === 'deep').requires = ['housing', 'mortgage'];
      j.topics = j.topics.filter((t) => t.id !== 'housing');
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
    });
    await page.goto(base + '/kaspchem/check/deep');
    await failState(page, 'הבדיקה המעמיקה אינה זמינה כרגע');
    await expect(page.locator('#load-fail')).toContainText('לא נריץ אותה בצורה חלקית');
    await expect(page.locator('#load-fail a[href="/kaspchem/check/quick"]')).toBeVisible();
    expect(await page.evaluate(() => [].map.call(document.scripts, (s) => s.src).filter((s) => /deep\.js/.test(s)))).toEqual([]); // the check's own code is not even loaded
    await page.unroute(CFG);
    await page.locator('#retry').click(); await expect(page.locator('.q h1')).toBeVisible();
  });

  test('every other check has the same retry state when nothing loads (config and the static fallback both fail); with only the config broken it still works from the static files', async ({ page }) => {
    await page.route(CFG, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: 'not json' }));
    await page.goto(base + '/kaspchem/check/mortgage');
    await expect(page.locator('.q h1')).toBeVisible();                                         // the static fallback keeps the ten topics working, as before
    await page.route('**/kaspchem/content/topics.json', (r) => r.abort());
    await page.reload();
    await failState(page, 'לא הצלחנו לטעון את השאלון');
    await page.unroute(CFG); await page.unroute('**/kaspchem/content/topics.json');
    await page.locator('#retry').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('.q h1')).toBeVisible(); await expect(page.locator('.opt').first()).toBeVisible();
  });

  test('a result is never computed from a stale or partial answers shape: saved answers that do not fit are dropped and the questions are asked again', async ({ page }) => {
    const { cfg } = await configOf();
    await page.goto(base + '/kaspchem/check/deep');
    await page.evaluate(() => sessionStorage.setItem('kaspchem:deep', JSON.stringify({ a: { 'profile.home': 'gone', 'profile.mortgage': ['no'], 'profile.worknow': 'nope', 'zzz.q': 'a' }, o: ['profile.home', 'profile.mortgage', 'profile.worknow', 'zzz.q'] })));
    await page.reload();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((q) => q.id === 'profile.home').text);
    await expect(page.locator('#result')).toHaveCount(0);
    await page.evaluate(() => sessionStorage.setItem('kaspchem:deep', '{not json'));
    await page.reload();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((q) => q.id === 'profile.home').text);
  });
});

// =====================================================================================================================
// The dashboard: the deep check is not ready, so it cannot be switched on; the server refuses too.
// =====================================================================================================================
test.describe('dashboard readiness gate', () => {
  test.beforeAll(async ({}, ti) => { await serve(ti, 5, 'v6', undefined, false); });
  test.afterAll(stop);
  test.beforeEach(() => { test.skip(!HAS_V6, 'V6 draft not available in this checkout (the private research folder is not linked)'); });
  const AS_ADMIN = () => base + '/admin/kaspchem/?test=' + encodeURIComponent('yosi@example.test|admin');
  const openSettings = async (page) => { await page.goto(AS_ADMIN()); await page.locator('#tabs button[data-t="settings"]').click(); await page.locator('#dp-panel').waitFor(); };

  test('not ready (the real route: 13 unverified rules, wording not approved): a checklist, the switch is disabled with the explanation, the server refuses with the unmet reasons and writes nothing; nothing leaks to visitors', async ({ page }) => {
    setReady(false);
    await openSettings(page);
    const panel = page.locator('#dp-panel');
    await expect(panel).toContainText('הבדיקה המעמיקה אינה מוכנה להפעלה');
    const items = panel.locator('.dp-check > li');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('תוכן V6 מפורסם והתחומים הנדרשים זמינים'); await expect(items.nth(0)).toContainText('מתקיים');
    await expect(items.nth(1)).toContainText('כל כללי V6 הרלוונטיים אומתו מקצועית'); await expect(items.nth(1)).toContainText('לא מתקיים'); await expect(items.nth(1)).toContainText('13 כללים');
    await expect(items.nth(2)).toContainText('נוסח הבדיקה אושר על ידי הבעלים'); await expect(items.nth(2)).toContainText('לא מתקיים');
    await expect(panel.locator('#dp-state')).toHaveText('כבוי');
    await expect(panel.locator('#dpe')).toBeDisabled();
    // nothing of the panel itself sticks out (the admin tab bar scrolls sideways by design, so the whole page is not measured)
    expect(await page.evaluate(() => { const vw = document.documentElement.clientWidth; return [].filter.call(document.querySelectorAll('#dp-panel, #dp-panel *'), (e) => { const r = e.getBoundingClientRect(); return r.width && (r.right > vw + 2.5 || r.left < -2.5); }).map((e) => e.tagName + '.' + e.className); })).toEqual([]);
    // the server refuses (409) and writes nothing
    const put = (v) => fetch(base + '/api/kaspchem/admin/settings', { method: 'PUT', headers: ADM, body: JSON.stringify({ key: 'public.deep_enabled', value: v }) });
    const r = await put(true);
    expect(r.status).toBe(409); const j = await r.json(); expect(j.error).toBe('deep_not_ready');
    expect(j.message).toContain('הבדיקה המעמיקה אינה מוכנה להפעלה'); expect(j.message).toContain('כל כללי V6 הרלוונטיים אומתו מקצועית'); expect(j.message).toContain('נוסח הבדיקה אושר על ידי הבעלים');
    const st = (await adminGet('/settings')).settings.filter((x) => x.key === 'public.deep_enabled'); expect(st.length).toBe(0);
    const cfgj = await (await fetch(base + '/api/kaspchem/config')).json();
    expect(cfgj.topics.some((t) => t.kind === 'deep')).toBe(false); expect('deep_enabled' in cfgj.settings).toBe(false);
    expect((await put('yes')).status).toBe(400);                                                  // only a real boolean
    // turning it OFF is always allowed
    expect((await put(false)).status).toBe(200);
  });

  test('ready (test fixture: verified + approved): the switch can be turned on with a confirmation, shows the state, and turning it off is immediate', async ({ page }) => {
    setReady(true);
    try {
      await openSettings(page);
      const panel = page.locator('#dp-panel');
      await expect(panel.locator('#dp-notready')).toHaveCount(0);
      await expect(panel.locator('.dp-check > li.ok')).toHaveCount(3);
      await expect(panel.locator('#dpe')).toBeEnabled();
      page.once('dialog', (d) => d.accept());
      await panel.locator('#dpe').check();
      await expect(panel.locator('#dp-state')).toHaveText('דלוק (מוצגת לציבור)');
      const cfgj = await (await fetch(base + '/api/kaspchem/config')).json();
      expect(cfgj.topics.some((t) => t.kind === 'deep')).toBe(true); expect(cfgj.settings.deep_enabled).toBe(true);
      await panel.locator('#dpe').uncheck();
      await expect(panel.locator('#dp-state')).toHaveText('כבוי');
      expect((await (await fetch(base + '/api/kaspchem/config')).json()).topics.some((t) => t.kind === 'deep')).toBe(false);
    } finally { await setFlag(false); setReady(false); }
  });

  test('already on but no longer ready: it can still be turned OFF from the screen', async ({ page }) => {
    setReady(true); await setFlag(true); setReady(false);
    try {
      await openSettings(page);
      await expect(page.locator('#dp-state')).toHaveText('דלוק (מוצגת לציבור)');
      await expect(page.locator('#dpe')).toBeEnabled();
      await page.locator('#dpe').uncheck();
      await expect(page.locator('#dp-state')).toHaveText('כבוי');
    } finally { await setFlag(false); }
  });
});
