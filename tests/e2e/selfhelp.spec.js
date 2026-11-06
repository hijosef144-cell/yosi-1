// Version 1.0: a family that gets a finding must see what to do by itself. For every one of the 40 rules of the ten topics this opens the real result screen
// (answers seeded the way the wizard saves them) and checks that the card shows the next step and the official link(s) of THAT rule, and that the two rules
// without an official page still show a practical step. It also checks that the page offers no form or personal help.
const { test, expect } = require('@playwright/test');
const E = require('../../kaspchem/assets/engine.js');
const GM = require('../../scripts/golden-master.js');
const topics = require('../../kaspchem/content/topics.json').topics;

// Every complete answer path of a topic, then the fewest paths (greedy) that fire every rule of it at least once.
function coverPaths(t) {
  const paths = [];
  (function walk(ans, order) {
    const q = E.nextQuestion(t, ans);
    if (!q) { if (E.validateAnswers(t, ans)) paths.push({ answers: ans, order }); return; }
    GM.choices(q).forEach((c) => walk(Object.assign({}, ans, { [q.id]: c }), order.concat(q.id)));
  })({}, []);
  const fired = paths.map((p) => new Set(E.evaluate(t, p.answers).findings.map((f) => f.id)));
  const need = new Set(t.rules.map((r) => r.id)), picked = [];
  while (need.size) {
    let best = -1, gain = 0;
    fired.forEach((s, i) => { const g = [...need].filter((id) => s.has(id)).length; if (g > gain) { gain = g; best = i; } });
    if (best < 0) throw new Error(t.id + ': rules that no answer path fires: ' + [...need].join(','));
    picked.push(paths[best]); [...fired[best]].forEach((id) => need.delete(id));
  }
  return picked;
}

for (const t of topics) {
  test(t.id + ': every finding shows its next step and its official link, and nothing offers personal help', async ({ page }) => {
    test.setTimeout(120000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const seen = new Set();
    for (const p of coverPaths(t)) {
      await page.goto('/kaspchem/check/' + t.id);
      await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), ['kaspchem:' + t.id, JSON.stringify({ a: p.answers, o: p.order })]);
      await page.reload();
      await expect(page.locator('#result .find').first()).toBeVisible({ timeout: 10000 });
      const res = E.evaluate(t, p.answers);
      await expect(page.locator('#result .find')).toHaveCount(res.cards.length);
      for (const f of res.findings) {
        const rule = t.rules.find((r) => r.id === f.id), fin = rule.finding;
        // the card whose TITLE is exactly this finding's title (a title can appear inside another card's text, e.g. "דמי כרטיס")
        const card = page.locator('#result .find').filter({ has: page.getByText(fin.title, { exact: true }) });
        await expect(card).toBeVisible();
        await expect(card).toContainText('הצעד הבא');
        for (const para of fin.step.split('\n')) await expect(card).toContainText(para.slice(0, 40));
        if (fin.official) {
          await expect(card.getByRole('link', { name: fin.official.label })).toHaveAttribute('href', fin.official.url);
          await expect(card.getByRole('link', { name: fin.official.label })).toHaveAttribute('target', '_blank');
          await expect(card).toContainText('איפה');
        } else {
          await expect(card.locator('a[target=_blank]')).toHaveCount(0); // the two rules with no official page: the step alone is the help
        }
        for (const o of fin.officialMore || []) await expect(card.getByRole('link', { name: o.label })).toHaveAttribute('href', o.url);
        seen.add(f.id);
      }
      for (const sel of ['#cta', '#lead', '#send', '#f-name', '#f-phone', '#c-contact']) await expect(page.locator(sel)).toHaveCount(0);
      const text = await page.locator('#app').innerText();
      expect(text).not.toContain('נחזור'); expect(text).not.toContain('השארת פרטים'); expect(text).not.toContain('אני רוצה עזרה');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, 'horizontal overflow').toBeLessThanOrEqual(2); // Edge phone emulation can show a 2px quirk
    }
    expect([...seen].sort()).toEqual(t.rules.map((r) => r.id).sort()); // all rules of the topic were checked
  });
}
