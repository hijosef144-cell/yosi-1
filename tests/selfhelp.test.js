'use strict';
// Version 1.0 has no contact form and no personal help: a family that gets a finding must be able to act by itself. These tests pin that:
// every rule of the ten topics carries a next step and an official link, no text promises help from Kaspchem, no text asserts an entitlement,
// the public pages carry no help button or form, and the main site does not link to Kaspchem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const topics = JSON.parse(read('kaspchem/content/topics.json')).topics;
const routes = JSON.parse(read('kaspchem/content/routes.json')).topics;
const rules = [];
topics.forEach((t) => t.rules.forEach((r) => rules.push({ topic: t.id, id: r.id, f: r.finding })));

// Rules for which no official page exists (the step is then the whole help). Keep this list empty unless the owner approved an exception.
const NO_LINK_ALLOWED = ['hh-bills', 'hh-mobile']; // no government comparison tool for telecom or electricity prices exists; the step alone is the help
const HOST_OK = (h) => h === 'gov.il' || h.endsWith('.gov.il') || h === 'boi.org.il' || h.endsWith('.boi.org.il') || h === 'che.org.il'; // che.org.il: the Council for Higher Education, a statutory body
const strings = (x, out, p) => {
  if (typeof x === 'string') out.push([p, x]);
  else if (Array.isArray(x)) x.forEach((v, i) => strings(v, out, p + '[' + i + ']'));
  else if (x && typeof x === 'object') Object.keys(x).forEach((k) => strings(x[k], out, p + '.' + k));
  return out;
};

test('all 40 rules: a next step in plain Hebrew and an official https link on a government or Bank of Israel domain, with the date it was checked', () => {
  assert.equal(rules.length, 40);
  const checkLink = (id, o) => {
    assert.ok(o && typeof o === 'object', id + ' official');
    const u = new URL(o.url);
    assert.equal(u.protocol, 'https:', id + ' https');
    assert.ok(HOST_OK(u.hostname), id + ' host ' + u.hostname);
    assert.ok(typeof o.label === 'string' && o.label.length >= 6 && o.label.length <= 110, id + ' label');
    assert.match(o.checked, /^2026-11-\d\d$/, id + ' checked date');
  };
  rules.forEach(({ id, f }) => {
    assert.equal(typeof f.step, 'string', id + ' step');
    // one paragraph per situation (employee / self-employed, illness / work injury, ...), separated by a line break
    const paras = f.step.split(String.fromCharCode(10));
    assert.ok(paras.length <= 3 && f.step.length <= 720, id + ' step size');
    paras.forEach((p) => { assert.ok(p.length >= 25 && p.length <= 300, id + ' paragraph length ' + p.length); assert.match(p, /^[\u0590-\u05ff]/, id + ' paragraph starts with a Hebrew word'); });
    if (NO_LINK_ALLOWED.includes(id)) { assert.ok(!f.official && !f.officialMore, id + ' has no link by decision'); return; }
    checkLink(id, f.official);
    const more = f.officialMore || [];
    assert.ok(Array.isArray(more) && more.length <= 4, id + ' officialMore');
    more.forEach((o) => checkLink(id + ' more', o));
    const labels = [f.official].concat(more).map((o) => o.label); assert.equal(new Set(labels).size, labels.length, id + ' links must have different labels, each saying what it is or who it is for');
  });
});

test('no text on the public pages promises help, a call back or personal advice from Kaspchem', () => {
  const BAD = /נעזור|נחזור אליכם|נטפל|נסייע|נלווה|נשמח|אשמח|להשאיר פרטים|השארת פרטים|יחזרו אליכם|נציג(ה|י)? (כספכם|שלנו|מטעמנו)|ייעוץ אישי|הכוונה אישית|אני רוצה עזרה/;
  const all = strings(topics, [], 'topics').concat(strings(routes, [], 'routes'));
  all.forEach(([p, s]) => assert.doesNotMatch(s, BAD, p + ': ' + s.slice(0, 80)));
  ['kaspchem/index.html', 'kaspchem/check.html', 'kaspchem/assets/wizard.js', 'kaspchem/assets/deep.js', 'kaspchem/assets/landing.js', 'kaspchem/assets/headline.js'].forEach((f) => {
    assert.doesNotMatch(read(f), BAD, f);
  });
});

test('no finding asserts an entitlement or promises a result', () => {
  const BAD = /(מגיע|מגיעים|מגיעות) (לכם|לך)|אתם זכאים|את\/ה זכאי|(?<![֐-׿])(תקבלו|תקבל\/י|בוודאות|מובטח|ללא ספק)/;
  const fields = [];
  rules.forEach(({ id, f }) => { fields.push([id + '.title', f.title], [id + '.why', f.why], [id + '.step', f.step || ''], [id + '.label', (f.official && f.official.label) || '']); });
  strings(routes.find((r) => r.id === 'quick').rules, fields, 'quick');
  fields.forEach(([p, s]) => assert.doesNotMatch(s, BAD, p + ': ' + s));
});

test('the result screens and the landing page have no help button, contact form or call-back wording', () => {
  const wiz = read('kaspchem/assets/wizard.js') + read('kaspchem/assets/deep.js');
  ['id="cta"', 'lead-slot', '/api/kaspchem/lead', 'openForm', 'c-contact', 'f-phone'].forEach((s) => assert.ok(!wiz.includes(s), 'still in the result code: ' + s));
  const home = read('kaspchem/index.html');
  assert.ok(!home.includes('נחזור'), 'landing page promises a call back');
  assert.ok(!/שם וטלפון/.test(home), 'landing page asks for name and phone');
});

test('the main site home page has no link, nav item or card pointing to Kaspchem (until the owner decides otherwise)', () => {
  const home = read('index.html');
  // the temporary invite redirect that production already has (kc-invite-redirect, a script and not a link) may stay; links, nav items and cards may not
  assert.ok(!/href="[^"]*kaspchem/i.test(home), 'index.html links to kaspchem');
  assert.ok(!/kc-cta/.test(home), 'index.html has the Kaspchem entry card'); assert.equal((home.match(/kc-identity-shim/g) || []).length, 1, 'exactly one Identity link handler (owner approved, 4.11.2026)'); assert.ok(!home.includes('kc-invite-redirect'), 'the temporary invite redirect must be gone');
  const map = fs.existsSync(path.join(root, 'sitemap.xml')) ? read('sitemap.xml') : '';
  assert.ok(!/kaspchem/i.test(map), 'sitemap.xml lists kaspchem');
});
