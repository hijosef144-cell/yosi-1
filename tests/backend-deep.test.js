'use strict';
// Stage 5: the deep check on the server. Gated off by default (public.deep_enabled): off → not in the config, not accepted as a lead. On → same endpoint, same
// table, topic "deep", findings stored by tier. No new table. The published ten are served by default; the V6 draft (private, unpublished) is used when present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { start } = require('./dev-server');
const ops = require('../netlify/functions/_kaspchem/ops-alert');
const content = require('../netlify/functions/_kaspchem/content');
const E = require('../kaspchem/assets/engine.js');

const V6F = path.join(__dirname, '..', 'docs', 'research', 'drafts-v6', 'PUBLISHABLE-v6.draft.json');
const SKIP_V6 = fs.existsSync(V6F) ? false : 'V6 draft not available in this checkout (the private research folder is not linked)';
const origSeed = content.seed;
// The real route requires V6 shapes. The published ten run it only in the TEST-ONLY reduced mode (the dev server serves the route without `requires`); `realMode(true)` switches back.
const ROUTE_DEEP = content.routes.topics.find((t) => t.kind === 'deep'), REAL_REQUIRES = JSON.parse(JSON.stringify(ROUTE_DEEP.requires));
const realMode = (on) => { ROUTE_DEEP.requires = on ? REAL_REQUIRES : []; };
let srv, base; const sent = [];
const ADMIN = { 'x-test-user': 'yosi@example.test|admin', 'x-kaspchem': '1' };
const A = '/api/kaspchem/admin';
const call = async (method, url, body, headers) => {
  const r = await fetch(base + url, { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const lead = (over) => Object.assign({ topic: 'deep', name: 'רונית סודית', phone: '0504440001', email: 'ronit@example.test', consentContact: true, consentMarketing: false }, over || {});
const setFlag = (v) => call('PUT', A + '/settings', { key: 'public.deep_enabled', value: v }, ADMIN);
const rows = async () => (await srv.pg.query("SELECT topic, outcome, findings, answers, questionnaire_ver FROM treatment_requests WHERE topic = 'deep' ORDER BY id")).rows;

// a complete path: take the first listed option of every question that is asked, with overrides by question id
async function path_(overrides, pick) {
  const cfg = await content.loadDeepConfig();
  const a = {}; let q;
  while ((q = E.deepNext(cfg, a))) {
    const o = (overrides || {})[q.id];
    a[q.id] = o !== undefined ? o : (pick ? pick(q) : (q.multi ? [q.options.filter((x) => x.exclusive)[0].id] : q.options[0].id));
  }
  return a;
}

test.before(async () => { srv = await start(0, { degradeDeep: true }); base = 'http://localhost:' + srv.server.address().port; ops.setSender(async (m) => { sent.push(m); }); });
test.after(async () => { ops.setSender(null); content.setSeed(origSeed); srv.server.close(); });

test('switched off (the default): the deep route and the flag are not in the public config, and a lead for it is refused like an unknown topic; nothing is stored', async () => {
  const cfg = (await call('GET', '/api/kaspchem/config')).body;
  assert.ok(!cfg.topics.some((t) => t.id === 'deep' || t.kind === 'deep'));
  assert.ok(!('deep_enabled' in cfg.settings));
  assert.ok(cfg.topics.some((t) => t.id === 'quick'), 'the quick check is untouched');
  const cfgText = JSON.stringify(cfg);
  assert.ok(!/בדיקה מעמיקה|f-family-ni|profile\./.test(cfgText), 'nothing about the deep check is sent while it is off');
  const answers = await path_({});
  const r = await call('POST', '/api/kaspchem/lead', lead({ answers }));
  assert.equal(r.status, 400); assert.equal(r.body.error, 'bad_topic');
  assert.equal((await rows()).length, 0);
  // an explicit false behaves the same as absent
  await setFlag(false);
  assert.ok(!(await call('GET', '/api/kaspchem/config')).body.topics.some((t) => t.kind === 'deep'));
  assert.equal((await call('POST', '/api/kaspchem/lead', lead({ answers, phone: '0504440002' }))).body.error, 'bad_topic');
  // the other flags and the old routes are unaffected: the ten topics are still served in full
  assert.equal((await call('GET', '/api/kaspchem/config')).body.topics.filter((t) => !t.kind).length, 10);
});

test('switched on but the content lacks what the route requires (the real route against the published ten): nothing is served, the flag is not revealed, the lead is refused, nothing is stored', async () => {
  realMode(true);
  try {
    assert.equal((await setFlag(true)).status, 200);
    const cfg = (await call('GET', '/api/kaspchem/config')).body;
    assert.ok(!cfg.topics.some((t) => t.kind === 'deep')); assert.ok(!('deep_enabled' in cfg.settings));
    assert.equal((await content.loadDeepConfig()).unavailable, true);
    const before = (await rows()).length;
    const r = await call('POST', '/api/kaspchem/lead', lead({ answers: {}, phone: '0504440011' }));
    assert.equal(r.body.error, 'bad_topic'); assert.equal((await rows()).length, before);
  } finally { realMode(false); await setFlag(false); }
});

test('switched on: the route (profile, facts, gates) is served with the flag; the questions of the sections are the served topics', async () => {
  assert.equal((await setFlag(true)).status, 200);
  const cfg = (await call('GET', '/api/kaspchem/config')).body;
  assert.equal(cfg.settings.deep_enabled, true);
  const deep = cfg.topics.find((t) => t.id === 'deep');
  assert.ok(deep && deep.kind === 'deep' && deep.name === 'בדיקה מעמיקה');
  assert.ok(deep.profile.questions.length >= 3 && deep.facts.length > 0);
  // the browser composes the same config from this route and the served topics: it is the config the server validates against
  const a = E.buildDeep(deep, cfg.topics), b = await content.loadDeepConfig();
  assert.deepEqual(a.questions.map((q) => q.id), b.questions.map((q) => q.id));
});

test('a deep lead is stored in the existing table: topic deep, the outcome and the findings by tier, and the answers as typed (profile + asked questions only)', async () => {
  const a = await path_({ 'profile.home': 'other', 'profile.mortgage': 'no', 'profile.worknow': 'retired' });
  const r = await call('POST', '/api/kaspchem/lead', lead({ answers: a, phone: '0504440003' }));
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  const [row] = (await srv.pg.query('SELECT topic, outcome, findings, answers, consent_contact, consent_marketing, questionnaire_id, questionnaire_ver FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
  assert.equal(row.topic, 'deep');
  const cfg = await content.loadDeepConfig(), expect = E.evaluateDeep(cfg, a);
  assert.equal(row.outcome, expect.outcome);
  assert.deepEqual([...row.findings], E.deepFindingIds(expect));
  assert.ok(row.findings.every((f) => /^(high|missing|low):[a-z-]+\.[A-Za-z0-9_-]+$/.test(f)));
  assert.deepEqual(row.answers, a);
  assert.ok(!Object.keys(row.answers).includes('housing.status'), 'derived answers are not stored as typed');
  assert.equal(row.consent_contact, true); assert.equal(row.consent_marketing, false);
  assert.equal(row.questionnaire_id, null); assert.match(row.questionnaire_ver, /^deep:/);
  const tables = (await srv.pg.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((x) => x.table_name);
  assert.ok(!tables.some((t) => /deep/.test(t)), 'no new table');
});

test('the outcome comes from the server; answers that are not valid for the deep check are refused', async () => {
  const good = await path_({});
  const rr = await call('POST', '/api/kaspchem/lead', lead({ answers: good, phone: '0504440004', outcome: 'found', findings: ['high:housing.hs-disc'] }));
  assert.equal(rr.status, 200);
  const [row] = (await srv.pg.query('SELECT outcome, findings FROM treatment_requests WHERE id = $1', [rr.body.ref])).rows;
  assert.deepEqual([...row.findings], E.deepFindingIds(E.evaluateDeep(await content.loadDeepConfig(), good)));
  const bad = async (answers, why) => assert.equal((await call('POST', '/api/kaspchem/lead', lead({ phone: '0504440005', answers }))).body.error, 'bad_answers', why);
  await bad(Object.assign({}, good, { 'profile.home': 'nope' }), 'unknown option');
  const miss = Object.assign({}, good); delete miss['profile.home']; await bad(miss, 'a question that is asked was not answered');
  await bad(Object.assign({}, good, { 'housing.status': 'owner' }), 'a derived question must not be sent');
  await bad(Object.assign({}, good, { 'profile.zzz': 'a' }), 'unknown question');
  await bad({}, 'empty');
  await bad(null, 'no answers');
  await bad('x', 'not an object');
  await bad(Object.assign({}, good, { 'profile.worknow': ['employee'] }), 'array for a single question');
});

test('the alert for a deep lead carries the topic name and request number, and no personal data, answers or findings', async () => {
  sent.length = 0;
  const r = await call('POST', '/api/kaspchem/lead', lead({ answers: await path_({}), phone: '0504440006' }));
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1); assert.equal(sent[0].subject, 'כספכם: התקבלה פנייה חדשה');
  assert.ok(sent[0].text.includes('"בדיקה מעמיקה"') && sent[0].text.includes(String(r.body.ref)));
  assert.ok(!/רונית|סודית|0504440|ronit@|high:|missing:|profile\.|housing|שכיר/.test(sent[0].subject + sent[0].text));
});

test('the admin list names the topic "בדיקה מעמיקה", filters on it, and the request shows the answers and the findings by tier', async () => {
  const qs = (await call('GET', A + '/questionnaires', null, ADMIN)).body.topics;
  assert.equal(qs.find((t) => t.id === 'deep').name, 'בדיקה מעמיקה'); assert.equal(qs.find((t) => t.id === 'deep').kind, 'deep');
  const list = (await call('GET', A + '/requests?topic=deep', null, ADMIN)).body.requests;
  assert.ok(list.length >= 3); assert.ok(list.every((x) => x.topic === 'deep'));
  const found = list.find((x) => x.outcome === 'found') || list[0];
  const d = (await call('GET', A + '/requests/' + found.id, null, ADMIN)).body.request;
  assert.ok(d.readable.length >= 3 && d.readable.every((x) => x.question && x.answer));
  assert.ok(d.readable.some((x) => /מצב המגורים/.test(x.question)));
  assert.equal(d.findingDetails.length, d.findings.length);
  d.findingDetails.forEach((x) => { assert.ok(['high', 'missing', 'low'].includes(x.tier)); assert.ok(x.tierLabel && x.title && !/^[a-z-]+\.[a-z-]+$/.test(x.title)); });
  assert.deepEqual(d.findingTitles, d.findingDetails.map((x) => x.tierLabel + ': ' + x.title));
  const stats = (await call('GET', A + '/stats', null, ADMIN)).body;
  assert.ok(stats.byTopic.some((t) => t.topic === 'deep' && t.n >= 3));
  // the deep route is not editable in the questionnaire editor (it is edited in the content file)
  assert.equal((await call('GET', A + '/questionnaires/deep', null, ADMIN)).status, 404);
  assert.equal((await call('PUT', A + '/questionnaires/deep/draft', { content: { questions: [], rules: [] } }, ADMIN)).status, 404);
});

test('the lead gate still applies to the deep check (closed gate: not_open, nothing stored); other topics are not affected by the deep flag', async () => {
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: false }, ADMIN);
  const before = (await srv.pg.query('SELECT count(*)::int AS n FROM treatment_requests')).rows[0].n;
  const r = await call('POST', '/api/kaspchem/lead', lead({ answers: await path_({}), phone: '0504440007' }));
  await call('PUT', A + '/settings', { key: 'public.legal_approved', value: true }, ADMIN);
  assert.equal(r.status, 403); assert.equal(r.body.error, 'not_open');
  assert.equal((await srv.pg.query('SELECT count(*)::int AS n FROM treatment_requests')).rows[0].n, before);
});

test('switching it off again closes it at once: config without the route, lead refused; requests already stored stay readable in the dashboard', async () => {
  const stored = (await rows()).length; assert.ok(stored >= 3);
  assert.equal((await setFlag(false)).status, 200);
  assert.ok(!(await call('GET', '/api/kaspchem/config')).body.topics.some((t) => t.kind === 'deep'));
  assert.equal((await call('POST', '/api/kaspchem/lead', lead({ answers: await path_({}), phone: '0504440008' }))).body.error, 'bad_topic');
  assert.equal((await rows()).length, stored);
  const list = (await call('GET', A + '/requests?topic=deep', null, ADMIN)).body.requests;
  assert.equal(list.length, stored);
  const d = (await call('GET', A + '/requests/' + list[0].id, null, ADMIN)).body.request;
  assert.ok(d.readable.length > 0);
  await setFlag(true);
});

test('the setting cannot be turned on by a visitor (admin only, CSRF header needed)', async () => {
  const anon = await call('PUT', A + '/settings', { key: 'public.deep_enabled', value: true });
  assert.ok([401, 403].includes(anon.status));
  const noCsrf = await call('PUT', A + '/settings', { key: 'public.deep_enabled', value: true }, { 'x-test-user': 'yosi@example.test|admin' });
  assert.ok([400, 401, 403].includes(noCsrf.status));
});

test('V6 content served (draft, local only): the REAL route is available, the lead is evaluated against the composed V6 config, two tiers stored (the low tier is off)', { skip: SKIP_V6 }, async () => {
  const v6 = JSON.parse(fs.readFileSync(V6F, 'utf8'));
  content.setSeed(v6); realMode(true);
  try {
    await setFlag(true);
    const cfg = await content.loadDeepConfig();
    assert.ok(cfg.questions.length > 50);
    // retired, on a family that declined to say: the retirement-age rule is open (missing information), never high
    const a = await path_({ 'profile.home': 'other', 'profile.mortgage': 'no', 'profile.worknow': 'retired', 'profile.workhist': ['none'], 'profile.family': ['pna'] });
    const r = await call('POST', '/api/kaspchem/lead', lead({ answers: a, phone: '0504440009' }));
    assert.equal(r.status, 200);
    const [row] = (await srv.pg.query('SELECT outcome, findings FROM treatment_requests WHERE id = $1', [r.body.ref])).rows;
    assert.ok(row.findings.some((f) => f.startsWith('missing:national-insurance.')));
    assert.ok(!row.findings.some((f) => f.startsWith('high:national-insurance.')));
    const d = (await call('GET', A + '/requests/' + r.body.ref, null, ADMIN)).body.request;
    assert.ok(d.findingDetails.some((x) => x.tier === 'missing' && x.tierLabel === 'חסר מידע'));
    // a derived question may not be sent, an asked one may not be missing
    assert.equal((await call('POST', '/api/kaspchem/lead', lead({ answers: Object.assign({}, a, { 'national-insurance.now': ['none'] }), phone: '0504440010' }))).body.error, 'bad_answers');
    assert.equal(row.outcome, E.evaluateDeep(cfg, a).outcome);
    assert.ok(!row.findings.some((f) => f.startsWith('low:')));
    assert.equal((await call('GET', '/api/kaspchem/config')).body.topics.some((t) => t.kind === 'deep'), true);
  } finally { content.setSeed(origSeed); realMode(false); }
});
