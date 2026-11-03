'use strict';
// The config checks of scripts/launch-smoke.js, without a network: they must be right for the CURRENT preview (ten topics, no quick check yet) and for the new build.
const test = require('node:test');
const assert = require('node:assert');
const { configChecks, CORE } = require('../scripts/launch-smoke.js');
const content = require('../netlify/functions/_kaspchem/content');

const fails = (cs) => cs.filter((c) => c.pass === false).map((c) => c.msg);
const infos = (cs) => cs.filter((c) => c.pass === null).map((c) => c.msg);

test('the new build (ten topics + quick): every check passes, no information line', async () => {
  const topics = await content.loadTopics();
  const cs = configChecks({ ok: true, topics });
  assert.deepEqual(fails(cs), []); assert.deepEqual(infos(cs), []);
  assert.ok(cs.some((c) => c.pass === true && /quick check is present/.test(c.msg)));
});

test('the current preview (ten topics, no quick): no failure, one informational line', async () => {
  const topics = (await content.loadTopics()).filter((t) => t.id !== 'quick');
  assert.equal(topics.length, 10);
  const cs = configChecks({ ok: true, topics });
  assert.deepEqual(fails(cs), []); assert.equal(infos(cs).length, 1); assert.match(infos(cs)[0], /not in this deployment/);
});

test('a missing core topic, a malformed quick check, or a broken answer is a failure', async () => {
  const all = await content.loadTopics();
  assert.match(fails(configChecks({ ok: true, topics: all.filter((t) => t.id !== 'housing') }))[0], /missing: housing/);
  const badQuick = JSON.parse(JSON.stringify(all)); badQuick.find((t) => t.id === 'quick').rules[0].finding.topic = 'not-a-topic';
  assert.match(fails(configChecks({ ok: true, topics: badQuick }))[0], /not one of the ten|not-a-topic/);
  const notRouter = JSON.parse(JSON.stringify(all)); delete notRouter.find((t) => t.id === 'quick').kind;
  assert.equal(fails(configChecks({ ok: true, topics: notRouter })).length, 1);
  assert.equal(fails(configChecks({ ok: false })).length, 1); assert.equal(fails(configChecks(null)).length, 1);
  assert.equal(CORE.length, 10);
});
