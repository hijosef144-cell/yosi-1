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
let srv = null, base = '', content = null, origSeed = null;
async function serve(ti, slot, set, flag) {
  process.env.TOPICS_FILE = set === 'v6' ? V6F : '';
  if (!process.env.TOPICS_FILE) delete process.env.TOPICS_FILE;
  content = require(path.join(ROOT, 'netlify', 'functions', '_kaspchem', 'content'));
  if (origSeed === null) origSeed = content.seed;
  content.setSeed(origSeed); // the published ten, unless the dev server swaps in the V6 draft below
  const { start } = require(path.join(ROOT, 'tests', 'dev-server'));
  srv = await start(PORT0[ti.project.name] + slot);
  base = 'http://localhost:' + srv.server.address().port;
  delete process.env.TOPICS_FILE;
  if (flag !== undefined) await setFlag(flag);
}
async function stop() { if (srv) { srv.server.close(); srv = null; } if (content && origSeed) content.setSeed(origSeed); delete process.env.TOPICS_FILE; }
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

// =====================================================================================================================
// The published ten, switched on: the content that is live today. The deep check must work (degraded but valid).
// =====================================================================================================================
test.describe('deep check on the published ten', () => {
  test.beforeAll(async ({}, ti) => { await serve(ti, 0, 'ten', true); });
  test.afterAll(stop);

  test('home page: the deep tile appears only because the switch is on, beside (wide) or under (phone) the quick tile, and works by keyboard', async ({ page }) => {
    await page.goto(base + '/kaspchem');
    const tile = page.locator('#dp-tile');
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute('href', '/kaspchem/check/deep');
    await expect(tile).toContainText('תבדקו אותי לעומק');
    await expect(tile).toContainText('15 דקות');
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

  test('flow on the published ten: phases, progress that never goes down, the profile once, results before the form, a request of topic deep', async ({ page }) => {
    const { cfg } = await configOf();
    await recordProgress(page);
    await openDeep(page);
    // three phases, the first one current; three segments; the profile is only the questions that are used (home, mortgage, work)
    await expect(page.locator('.dp-phases .dp-ph')).toHaveText(['1פרופיל', '2תחומים', '3סיכום']);
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
    await expect(page.locator('.dp-seg')).toHaveCount(3);
    await expect(page.locator('.q')).toContainText('בדיקה מקיפה של');                      // the intro on the first screen
    expect(cfg.questions.filter((q) => q.topicId === 'profile').map((q) => q.id)).toEqual(['profile.home', 'profile.mortgage', 'profile.worknow']);
    const run = await drive(page, cfg, (q) => firstPick(q));
    expect(nonDecreasing(run.bars)).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__ring))).toBe(true);
    expect(nonDecreasing(await page.evaluate(() => window.__coins))).toBe(true);
    // facts: derived questions were never asked (the profile answered them)
    expect(run.asked).not.toContain('housing.status'); expect(run.asked).not.toContain('mortgage.has'); expect(run.asked).not.toContain('payslip-rights.emp');
    await expect(page.locator('.dp-ph-cur')).toHaveText('3סיכום');
    expect(Number(await page.locator('.dp-segs').getAttribute('data-frac'))).toBe(1);
    // results first, then the form
    const res = E.evaluateDeep(cfg, run.answers), c = await counts(page);
    expect(c.high).toBe(res.counts.highCards); expect(c.missing).toBe(res.counts.missingItems); expect(c.low).toBe(res.counts.lowCards);
    await expect(page.locator('#lead')).toHaveCount(0);
    const y = (sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    expect(await y('#result h1')).toBeLessThan(await y('#cta'));
    await expect(page.locator('#result')).toContainText('תוצאות ראשוניות בלבד');
    await nothingSticksOut(page); await noHScroll(page);
    // the form: refusals, then success
    await page.locator('#cta').click(); await expect(page.locator('#lead')).toBeVisible();
    await page.locator('#send').click();
    await expect(page.locator('#e-name')).not.toBeEmpty(); await expect(page.locator('#e-phone')).not.toBeEmpty(); await expect(page.locator('#e-consent')).not.toBeEmpty();
    await page.locator('#f-name').fill('בדיקת עומק'); await page.locator('#f-phone').fill('12345'); await page.locator('#send').click();
    await expect(page.locator('#e-phone')).not.toBeEmpty(); await expect(page.locator('#e-name')).toBeEmpty();
    await page.locator('#f-phone').fill(phone()); await page.locator('#send').click();
    await expect(page.locator('#e-consent')).not.toBeEmpty();
    await page.locator('#c-contact').check(); await page.locator('#send').click();
    await expect(page.locator('#done')).toBeVisible();
    const list = (await adminGet('/requests?topic=deep')).requests;
    expect(list.length).toBe(1); expect(list[0].topic).toBe('deep');
    const d = (await adminGet('/requests/' + list[0].id)).request;
    expect(d.findings).toEqual(E.deepFindingIds(res));
    expect(await page.evaluate(() => sessionStorage.getItem('kaspchem:deep'))).toBeNull(); // cleared after sending
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

  test('a declined personal question is "missing information", never a finding, and the card says which answer is missing and lets the visitor complete it', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['pna'] : q.id === 'profile.worknow' ? 'retired' : q.id === 'profile.workhist' ? ['none'] : nonePick(q));
    const run = await drive(page, cfg, policy);
    const res = E.evaluateDeep(cfg, run.answers);
    expect(res.counts.missing).toBeGreaterThan(0);
    expect(res.high.some((f) => f.topicId === 'national-insurance')).toBe(false);
    const sec = page.locator('#dp-sec-missing');
    await expect(sec.locator('h2')).toContainText('חסר מידע — כדאי להמשיך לבדיקה');
    await expect(sec.locator('.dp-card').first()).toContainText('חסר מידע:');
    await expect(sec.locator('.dp-card').first()).toContainText('מה מתאים למשפחה שלכם');
    // no claim about the visitor in a missing-information card: the reason text of the rule is not shown
    const f0 = res.missingCards[0]; expect(f0.why || (f0.parts && f0.parts[0].why)).toBeTruthy();
    expect(await sec.innerText()).not.toContain((f0.why || f0.parts[0].why).slice(0, 40));
    // everything that waits for the same declined question is ONE item (a wall of identical cards helps nobody), and nothing is lost: it lists every dependent topic
    expect(res.counts.missingItems).toBeLessThan(res.counts.missingCards);
    await expect(sec.locator('.dp-group-card').first()).toContainText('נושאים תלויים בתשובה שחסרה');
    await sec.locator('.dp-group-card').first().locator('summary').click();
    expect(await sec.locator('.dp-group-card').first().locator('.dp-dep li').count()).toBe(res.missingItems.find((x) => x.folded).cards.length);
    // complete the answer: back to the profile question, with the later answers that depended on it re-asked
    await sec.locator('.dp-fill').first().click();
    await expect(page.locator('.q h1')).toHaveText(cfg.questions.find((x) => x.id === 'profile.family').text);
    await expect(page.locator('.dp-ph-cur')).toHaveText('1פרופיל');
    await page.getByRole('checkbox', { name: 'אף אחד מאלה', exact: true }).click(); await page.locator('#mgo').click();
    await page.locator('#result h1').waitFor({ timeout: 8000 });
    expect((await counts(page)).missing).toBe(E.evaluateDeep(cfg, Object.assign({}, run.answers, { 'profile.family': ['none'] })).counts.missingItems);
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

  test('result: three tiers in order, four cards first with an expander, three-part cards, low likelihood collapsed, results before the form', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    // a long result (many high-likelihood topics), a missing one (an unknown answer) and a weak one (senior-management overtime)
    const policy = (q, a) => {
      if (q.id === 'profile.worknow') return 'employee';
      if (q.id === 'profile.workhist') return ['emp'];
      if (q.id === 'payslip-rights.hours') return ['ot', 'mgr'];
      if (q.id === 'payslip-rights.lines') return ['none'];
      if (q.id === 'tax-refunds.letters') return 'unk';
      if (q.id === 'banking-loans.overdraft') return 'some';
      if (q.id === 'banking-loans.credit') return ['bank'];
      if (q.id === 'profile.family') return ['none'];
      return firstPick(q);
    };
    const run = await drive(page, cfg, policy);
    const res = E.evaluateDeep(cfg, run.answers), c = await counts(page);
    expect(res.counts.highCards).toBeGreaterThan(4); expect(res.counts.missingItems).toBeGreaterThan(0); expect(res.counts.lowCards).toBeGreaterThan(0);
    expect(c).toEqual({ high: res.counts.highCards, missing: res.counts.missingItems, low: res.counts.lowCards });
    await expect(page.locator('#result h1')).toHaveText('זיהינו ' + res.counts.highCards + ' נושאים בסבירות גבוהה שכדאי לבדוק');
    // order: high, missing, low, then the call to action
    const y = (sel) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().top + scrollY);
    expect(await y('#dp-sec-high')).toBeLessThan(await y('#dp-sec-missing')); expect(await y('#dp-sec-missing')).toBeLessThan(await y('#dp-low')); expect(await y('#dp-low')).toBeLessThan(await y('#cta'));
    await expect(page.locator('#dp-sec-high h2')).toContainText('סבירות גבוהה'); await expect(page.locator('#dp-sec-high h2')).toContainText('(' + res.counts.highCards + ')');
    await expect(page.locator('#dp-sec-missing h2')).toContainText('חסר מידע — כדאי להמשיך לבדיקה');
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
    await expect(card.locator('.dp-pt')).toHaveText('מה אפשר לקבל');
    await expect(card.locator('summary')).toHaveText(['איך זה עובד', 'מי יכול לעזור']);
    await expect(card.locator('details').nth(1).locator('a[href^="https://"]').first()).toBeHidden();
    await card.locator('details').nth(1).locator('summary').click();
    await expect(card.locator('details').nth(1).locator('a[href^="https://"]').first()).toBeVisible();
    // low likelihood: collapsed by default, only weak rules, with the reason the sign is weak
    const low = page.locator('#dp-low');
    expect(await low.evaluate((e) => e.open)).toBe(false);
    await low.locator('summary').click();
    await expect(low.locator('.dp-card').first()).toContainText('החוק אינו חל על חלק מהתפקידים האלה');
    await expect(low.locator('.dp-weak').first()).toBeVisible();
    // wording: the single caveat, no claim of entitlement anywhere on the page
    const text = await page.locator('#result').innerText();
    expect((text.match(/תוצאות ראשוניות בלבד/g) || []).length).toBe(1);
    const frame = (await page.locator('#result .head, #result .dp-tier-h, #result .dp-tier-sub').allInnerTexts()).join(' ');   // the wording of this screen (not the rule texts, which are the topics' own)
    expect(frame).not.toMatch(/מגיע(ים|ות)? לכם|זכאים|זכאי|זכיתם|הוענק|בוודאות|אושר/);
    await expect(page.locator('#lead')).toHaveCount(0);                                     // results first; the form only on request
    await nothingSticksOut(page); await noHScroll(page);
  });

  test('keyboard only: the whole first screens, the expander and the form can be used without a mouse', async ({ page }) => {
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

  test('a request from the V6 draft is stored with topic deep and its findings by tier, and the dashboard shows them', async ({ page }) => {
    const { cfg } = await configOf();
    await openDeep(page);
    const policy = (q) => (q.id === 'profile.family' ? ['pna'] : firstPick(q));
    const run = await drive(page, cfg, policy);
    await page.locator('#cta').click();
    await page.locator('#f-name').fill('בדיקת טיוטה'); await page.locator('#f-phone').fill(phone()); await page.locator('#c-contact').check();
    await page.locator('#send').click(); await expect(page.locator('#done')).toBeVisible();
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
  test.beforeAll(async ({}, ti) => { await serve(ti, 2, 'ten', undefined); });
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
    await page.goto(base + '/kaspchem');
    await expect(page.locator('#dp-tile')).toBeVisible();
    await page.waitForLoadState('load'); await page.waitForTimeout(300);
    const first = await page.evaluate(() => window.__mine);
    expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBe('1');
    // returning visit (this browser remembers): the place is reserved before the answer arrives, nothing moves
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dp-expect'))).toBe(true);
    await expect(page.locator('#dp-tile')).toBeVisible();
    await page.waitForLoadState('load'); await page.waitForTimeout(300);
    const second = await page.evaluate(() => window.__mine);
    test.info().annotations.push({ type: 'cls', description: 'deep tile: first visit ' + first.toFixed(4) + ', returning visit ' + second.toFixed(4) });
    console.log(test.info().project.name, 'CLS of the tiles area: first visit', first.toFixed(4), ', returning visit', second.toFixed(4));
    expect(second).toBeLessThan(0.01);
    expect(first).toBeLessThan(0.2);
    // switching it off again: the next visitor sees nothing and the reservation is forgotten
    await setFlag(false);
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/api/kaspchem/config')), page.reload()]);
    await expect(page.locator('#dp-tile')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.classList.contains('dp-expect'))).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('kasp:dp'))).toBeNull();
  });
});
