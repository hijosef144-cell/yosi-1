'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../kaspchem/assets/engine.js');
const T = require('./fixtures/multi-topics.json').topics[0];

test('multi-select: any selected option satisfies a condition; several tracks fire together', () => {
  const r = E.evaluate(T, { sit: ['inh', 'jobs'], when: 'recent' });
  assert.deepEqual(r.findings.map((f) => f.id).sort(), ['f-inh', 'f-jobs']);
  assert.equal(r.outcome, 'found');
});

test('inactive rules never fire unless asked (drafts stay drafts)', () => {
  assert.deepEqual(E.evaluate(T, { sit: ['old'] }).findings, []);
  assert.deepEqual(E.evaluate(T, { sit: ['old'] }, { includeInactive: true }).findings.map((f) => f.id), ['f-draft']);
  assert.equal(E.evaluate(T, { sit: ['old'] }).outcome, 'none');
});

test('finding extras (step, official link, referral) are carried to the result', () => {
  const f = E.evaluate(T, { sit: ['inh'], when: 'older' }).findings[0];
  assert.equal(f.step, 'בדקו בהר הכסף.'); assert.equal(f.official.url, 'https://itur.mof.gov.il/'); assert.ok(f.refer);
});

test('"not sure" on a multi question yields insufficient; "none of these" yields none', () => {
  assert.equal(E.evaluate(T, { sit: ['unk'] }).outcome, 'insufficient');
  assert.equal(E.evaluate(T, { sit: ['none'] }).outcome, 'none');
});

test('validation: exclusive options must stand alone; arrays only for multi; no empty or duplicate picks', () => {
  assert.ok(E.validateAnswers(T, { sit: ['none'] }));
  assert.ok(E.validateAnswers(T, { sit: ['jobs', 'old'] }));
  assert.ok(E.validateAnswers(T, { sit: ['inh'], when: 'recent' }));
  assert.ok(!E.validateAnswers(T, { sit: ['none', 'jobs'] }), 'exclusive + other');
  assert.ok(!E.validateAnswers(T, { sit: [] }), 'empty');
  assert.ok(!E.validateAnswers(T, { sit: ['jobs', 'jobs'] }), 'duplicate');
  assert.ok(!E.validateAnswers(T, { sit: 'jobs' }), 'string for multi');
  assert.ok(!E.validateAnswers(T, { sit: ['bogus'] }), 'unknown option');
  assert.ok(!E.validateAnswers(T, { sit: ['inh'] }), 'follow-up missing');
  assert.ok(!E.validateAnswers(T, { sit: ['jobs'], when: 'recent' }), 'follow-up not visible');
});

test('branching follows the multi answer; going back and changing it prunes the follow-up', () => {
  assert.equal(E.nextQuestion(T, { sit: ['inh', 'jobs'] }).id, 'when');
  assert.equal(E.nextQuestion(T, { sit: ['jobs'] }), null);
  assert.deepEqual(E.pruneAnswers(T, { sit: ['jobs'], when: 'recent' }), { sit: ['jobs'] });
});

test('lint: a multi question needs an exclusive option', () => {
  const bad = JSON.parse(JSON.stringify(T)); bad.questions[0].options.forEach((o) => { delete o.exclusive; });
  assert.ok(E.lint(bad).some((m) => /בלעדית/.test(m)));
  assert.deepEqual(E.lint(T), []);
});

test('published questionnaires are untouched by the engine upgrade (single-select behaviour identical)', () => {
  const pub = require('../kaspchem/content/topics.json').topics.find((t) => t.id === 'mortgage');
  const r = E.evaluate(pub, { has: 'yes', when: 'old', reviewed: 'no', know: 'yes' });
  assert.deepEqual(r.findings.map((f) => f.id), ['mg-refi']);
});
