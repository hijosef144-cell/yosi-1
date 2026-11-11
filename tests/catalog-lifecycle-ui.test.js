'use strict';
// Stage 5b-2b-2: the screens of the three life cycle actions (pause, return to review, reopen) and of what the engagement card says about them. The pure parts of admin/kaspchem/catalog.js and catalog-edit.js run in a
// sandbox without a browser; the file is also read as text, and the screens are fed with what the REAL server code answers (in-memory Postgres, synthetic data). The behaviour in a browser (dialogs, double clicks, conflicts,
// unknown results, four widths) is covered by tests/e2e/catalog-lifecycle.spec.js. No network, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const States = require('../netlify/functions/_kaspchem/catalog/states.js');
const { world, closeAll, YOSI, AVI } = require('./fixtures/catalog-world.js');
test.after(closeAll);

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').split('\r\n').join('\n');
const CATALOG = read('admin', 'kaspchem', 'catalog.js'), EDIT = read('admin', 'kaspchem', 'catalog-edit.js'), WRITES = read('netlify', 'functions', '_kaspchem', 'admin-catalog-writes.js');
const CODE = EDIT.replace(/\/\*[\s\S]*?\*\//g, '');
const sandbox = { window: {}, console }; vm.createContext(sandbox); vm.runInContext(CATALOG, sandbox); vm.runInContext(EDIT, sandbox);
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const RAW = sandbox.window.KaspchemCatalogEdit._t, C = sandbox.window.KaspchemCatalog._t;
const T = new Proxy(RAW, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => plain(t[k](...a)) : t[k]) });
const HEBREW = /[֐-׿]/;
const ACTIONS = ['pause', 'return_to_review', 'reopen'];
const CTX = { service: { legal_cleared: true, finding_tags: ['t'], topics: [] }, provider: { paused_until: null, archived_at: null }, pricing: { approved: true, fits: true }, now: '2026-11-08T10:00:00Z' };

test('which action each state offers: pending or active -> pause, paused -> return to review, retired -> reopen, a draft none; the offer is exactly what the state machine of the server accepts, and there is never an activation, a resume, a retirement or a withdrawal', () => {
  assert.deepEqual(plain(T.LIFE_FROM), { pending: ['pause'], active: ['pause'], paused: ['return_to_review'], retired: ['reopen'] });
  assert.deepEqual(Object.keys(plain(T.LIFE)).sort(), [...ACTIONS].sort());
  assert.deepEqual(plain(T.NEEDS_PROVIDER), { return_to_review: true, reopen: true }, 'the two that bring an engagement back need an available provider; a pause does not');
  for (const state of States.ACTIVATION) {
    const e = { activation: state, agreement_state: state === 'active' ? 'signed' : 'draft', contact_state: state === 'active' ? 'active' : 'contacted', pricing_model: state === 'active' ? 'fixed' : 'tbd', pricing_id: state === 'active' ? 5 : null, retired_at: '2026-11-01T00:00:00Z' };
    const accepted = ACTIONS.filter((a) => States.act(e, a, { reason: 'סיבה' }, CTX).ok);
    assert.deepEqual(accepted.sort(), [...((plain(T.LIFE_FROM))[state] || [])].sort(), 'what the screen offers in the state ' + state + ' is what the server accepts');
  }
  // the dialog and the bar contain no way to the other actions
  const engSection = CODE.slice(CODE.indexOf('var ENGAGEMENT_FIELDS'), CODE.indexOf('function bar(h, html, handlers)'));
  assert.ok(engSection.includes('function lifecycle(') && engSection.includes('function engagementBar'), 'the engagement section was found');
  assert.doesNotMatch(engSection, /actions\/(activate|resume|withdraw|retire)|confirm: 'activate'|button\('(activate|resume|retire|withdraw)'|'activate'|'resume'|'retire'|'withdraw'/, 'no activation, resume, retirement or withdrawal anywhere in the engagement part of the editing module');
  assert.doesNotMatch(CODE, /actions\/(activate|resume|withdraw|retire)|confirm: 'activate'/, 'and nowhere else either');
  for (const a of ['activate', 'resume', 'withdraw', 'retire']) assert.equal(T.allowed('POST', '/catalog/engagements/1/2/actions/' + a), false, a);
  for (const a of ACTIONS) { assert.equal(T.allowed('POST', '/catalog/engagements/1/2/actions/' + a), true, a); assert.equal(T.allowed('GET', '/catalog/engagements/1/2/actions/' + a), false); assert.equal(T.allowed('PATCH', '/catalog/engagements/1/2/actions/' + a), false); assert.equal(T.allowed('POST', '/catalog/engagements/1/2/actions/' + a + '/'), false); assert.equal(T.allowed('POST', '/catalog/engagements/x/2/actions/' + a), false); }
  assert.equal(T.ROUTES.length, 17, 'the eleven of the editing and the six of the prices and the import (tests/catalog-edit.test.js lists them all)');
});

test('the table of the dialog says what the server does, for EVERY combination of state, agreement and contact (one rule, not two): the screen and the state machine agree', () => {
  let n = 0;
  for (const action of ACTIONS) {
    for (const from of States.ACTIVATION) {
      const active = from === 'active';
      for (const agreement of active ? ['signed'] : States.AGREEMENT) for (const contact of active ? ['active'] : States.CONTACT) {
        const e = { activation: from, agreement_state: agreement, contact_state: contact, pricing_model: active ? 'fixed' : 'tbd', pricing_id: active ? 5 : null, retired_at: '2026-11-01T00:00:00Z' };
        const res = States.act(e, action, { reason: 'סיבה' }, CTX); if (!res.ok) continue;
        const a = T.lifecycleAfter(e, action); n++;
        assert.deepEqual([a.activation, a.agreement_state, a.contact_state], [res.next.activation, res.next.agreement_state, res.next.contact_state], action + ' from ' + from + ' / ' + agreement + ' / ' + contact);
      }
    }
  }
  assert.ok(n >= 3 * 5 + 20 + 20, 'many combinations were compared: ' + n);
  // and in words: the signature and the active collaboration of before come back as a draft and as "a contact was made", nothing else is touched
  assert.deepEqual(T.lifecycleAfter({ activation: 'retired', agreement_state: 'signed', contact_state: 'active' }, 'reopen'), { activation: 'draft', agreement_state: 'draft', contact_state: 'contacted' });
  assert.deepEqual(T.lifecycleAfter({ activation: 'retired', agreement_state: 'ended', contact_state: 'stopped' }, 'reopen'), { activation: 'draft', agreement_state: 'ended', contact_state: 'stopped' });
});

test('the dialog sends exactly what the server reads, once, by hand: the reason, its own typed confirmation, the view it saw and the state it saw; the typed word is the very word of the server', () => {
  const life = CODE.slice(CODE.indexOf('function lifecycle('), CODE.indexOf('function engagementBar'));
  assert.ok(life.length > 1500, 'the section was found');
  assert.ok(life.includes("{ expected_activation: e.activation, reason: v.reason.trim(), confirm: v.confirm.trim(), seen: seen }"), 'the body');
  assert.ok(WRITES.includes("fields(c, ['expected_activation', 'reason', 'confirm', 'seen'])"), 'the route reads those four fields and no others');
  const controlled = /const CONTROLLED = \[([^\]]*)\]/.exec(WRITES)[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1)).sort();
  assert.deepEqual(controlled, [...ACTIONS].sort(), 'the actions of the screen are exactly the controlled actions of the server'); assert.ok(WRITES.includes('b.confirm !== action'), 'the server compares the confirmation with the name of the action');
  assert.ok(life.includes("String(v.confirm || '').trim() === action") && life.includes("'כדי לאשר יש להקליד בדיוק: ' + action"), 'the typed word is the action name, compared before anything is sent');
  assert.equal((life.match(/write\(h, ctl, 'POST', path,/g) || []).length, 1, 'one request, in one place');
  assert.equal((life.match(/addEventListener|setTimeout|setInterval|\bretry\b|again\(/g) || []).length, 0, 'no timer, no automatic repeat, no extra listener');
  assert.ok(life.includes("path = '/catalog/engagements/' + e.provider_id + '/' + e.service_id + '/actions/' + action"));
  // the reason is held to the same rule as the server says, the warning is on the screen, the reason is mandatory and bounded
  for (const text of ['אל תכתבו בסיבה טלפון, דוא״ל, מספר זיהוי, קישור או פרטים אישיים', 'נשמרת ביומן לצמיתות ואי אפשר למחוק אותה', 'חובה לכתוב סיבה.']) assert.ok(CODE.includes(text), text);
  assert.ok(life.includes("textarea('reason', '', 300, REASON_HINT)") && life.includes('reason.length > 300'));
  // the busy form cannot send twice (the one submit handler of the shared dialog refuses while busy) and nothing is sent when the form is closed
  assert.ok(/if \(busy \|\| closed \|\| !panel\.hidden\) return;/.test(CODE), 'a second click or Enter while sending does nothing');
  // every action has a button name, a title, a submit text and a sentence of what it does
  for (const a of ACTIONS) { const spec = plain(T.LIFE)[a]; for (const k of ['title', 'button', 'submit', 'ok']) assert.match(spec[k], HEBREW, a + '.' + k); assert.ok(CODE.includes(a + ': function'), 'an introduction for ' + a); }
});

test('the answers of the three actions are said in words: a stale view and a conflict are panels with a refresh and no way back to the form, a provider that is not available is said with what to do, a reason with a contact detail stays at its field, an unknown result says what to check', () => {
  const E = (message, status, details, userMessage) => ({ message, status, details, userMessage });
  const refine = (e) => T.lifeRefine(e, T.describe(e));
  assert.equal(T.describe(E('conflict', 409)).kind, 'conflict');
  assert.deepEqual(plain(refine(E('seen_changed', 409, undefined, 'SELECT secret'))), { kind: 'stale', message: 'המצב השתנה מאז שצפיתם בו.' });
  for (const code of ['provider_archived', 'provider_paused']) {
    const a = refine(E(code, 409)), b = refine(E('transition_refused', 422, { errors: [code] }));
    assert.deepEqual([a.kind, b.kind], ['blocked', 'blocked'], code); assert.equal(a.message, b.message, 'the same words as a conflict and as a refusal'); assert.match(a.message, HEBREW); assert.doesNotMatch(a.message, /provider_|_/);
  }
  assert.match(refine(E('provider_archived', 409)).message, /יש לבטל קודם את הארכוב/); assert.match(refine(E('provider_paused', 409)).message, /עד שיחזור לזמינות/); assert.match(refine(E('provider_paused', 409)).message, /להחזיר לבדיקה או לפתוח מחדש/, 'not the sentence about creating a new engagement');
  const v = refine(E('reason_has_contact_detail', 400)); assert.deepEqual([v.kind, v.field], ['validation', 'reason']); assert.equal(refine(E('bad_reason', 400)).field, 'reason');
  const conf = refine(E('confirmation_required', 400)); assert.deepEqual([conf.kind, conf.field], ['validation', 'confirm']);
  const nor = refine(E('transition_refused', 422, { errors: ['reason_required'] })); assert.deepEqual([nor.kind, nor.field], ['validation', 'reason']);
  const refused = refine(E('transition_refused', 422, { errors: ['not_allowed_from_active', 'whatever_new'] })); assert.equal(refused.kind, 'state'); assert.match(refused.message, /הפעולה אינה מותרת ממצב ״פעיל״/); assert.doesNotMatch(refused.message, /not_allowed|whatever/);
  for (const [code, status] of [['result_unknown', 502], ['server_error', 500], ['Failed to fetch', undefined]]) { const u = refine(E(code, status)); assert.equal(u.kind, 'unknown', code); assert.match(u.message, /אל תשלחו שוב/); assert.match(u.message, /רעננו את הכרטיס ובדקו/); assert.doesNotMatch(u.message, /לא נשמר דבר\./); }
  for (const [code, status] of [['busy_retry', 409], ['write_timeout', 503]]) assert.match(refine(E(code, status)).message, /לא נשמר דבר/, code);
  // nothing the server says in its own words reaches the screen
  const poison = 'SELECT password FROM secrets; host=db.internal';
  for (const [c, s, d] of [['seen_changed', 409], ['provider_paused', 409], ['conflict', 409], ['transition_refused', 422, { errors: ['provider_archived'] }], ['reason_has_contact_detail', 400], ['activation_disabled', 403], ['expected_required', 400]]) assert.doesNotMatch(JSON.stringify(refine(E(c, s, d, poison))), /SELECT|password|db\.internal/, c);
  assert.deepEqual(Object.keys(plain(T.PROVIDER_BLOCK)).sort(), ['provider_archived', 'provider_paused']);
  assert.deepEqual(plain(T.refusalReasons({ errors: ['provider_archived', 'provider_paused'] })), [T.PROVIDER_BLOCK.provider_archived, T.PROVIDER_BLOCK.provider_paused]);
  // the stale panel and the blocked panel can never go back to the form (it would send the same stale view again)
  const life = CODE.slice(CODE.indexOf('function lifeStale'), CODE.indexOf('function engagementBar'));
  assert.equal((life.match(/ctl\.seal\(ctl\.onRefresh\)/g) || []).length, 2, 'the stale panel and the blocked panel are both sealed');
});

// ---------- the engagement card: what is shown, from what the read model gives ----------
const eng = (over) => Object.assign({ provider_id: 21, service_id: 11, provider_name: 'דנה', service_name: 'בדיקה', activation: 'draft', contact_state: 'contacted', agreement_state: 'draft', pricing_model: 'fixed', priority: 100, paused_reason: null, retired_reason: null, retired_at: null,
  last_retired_reason: null, last_retired_at: null, last_reopened_at: null, updated_by: 'a@x.test', updated_at: '2026-11-11T10:00:00Z', service_ready: true, service_missing: [] }, over);
const item = (key, ok) => ({ key, label: key, ok, blocking: true, enforced: 'server' });
const card = (e, over) => Object.assign({ engagement: e, price_layers: {}, approved_price: null, checklist: { items: [item('price_approved', true), item('provider_available', true)], missing: [], can_activate: false, documented_only: false, seen: 'x' } }, over);
const row = (action, at, actor, detail) => ({ id: 1, actor, action: 'catalog.engagement.' + action, entity: 'engagement', entity_id: '21/11', detail, created_at: at });
const price = (over) => Object.assign({ id: 7, label: 'בדיקת החזר', price: 1200, approved: true, public: false }, over);
const H = C.lifecycleHistoryHtml;
const NO_RAW = /catalog\.engagement\.|\b(return_to_review|previous_retired_at|agreement_state|contact_state|expected_activation|undefined|NaN)\b|\bnull\b/;

test('the history keeps the past apart from the present: a reopened engagement shows its last retirement as the past, with who reopened it, when, why, and what was set back; nothing historical reads as the current state', () => {
  const reopened = eng({ activation: 'draft', last_retired_at: '2026-11-02T09:00:00Z', last_retired_reason: 'הספק עזב', last_reopened_at: '2026-11-10T09:00:00Z' });
  const rows = [row('reopen', '2026-11-10T09:00:00Z', 'avi@x.test', { from: 'retired', to: 'draft', reason: 'חזרנו לעבוד יחד', previous_retired_at: '2026-11-02T09:00:00.000Z', reset: { agreement_state: ['signed', 'draft'], contact_state: ['active', 'contacted'] } }),
    row('update', '2026-11-09T09:00:00Z', 'a@x.test', { fields: ['terms_note'] }), row('retire', '2026-11-02T09:00:00Z', 'yosi@x.test', { from: 'pending', to: 'retired', reason: 'הספק עזב' }), row('pause', '2026-11-01T09:00:00Z', 'yosi@x.test', { from: 'pending', to: 'paused', reason: 'ממתינים לספק' }),
    row('return_to_review', '2026-11-01T12:00:00Z', 'avi@x.test', { from: 'paused', to: 'pending', reason: 'הספק חזר' })];
  const html = H(reopened, rows, false);
  assert.match(html, /אירועים שקרו בעבר/); assert.match(html, /המצב הנוכחי של ההתקשרות מוצג בלוח ״מצב ההתקשרות״ למעלה/);
  assert.match(html, /הוצאה משימוש<\/dt><dd>[^]*בעבר: ההתקשרות אינה מוצאת משימוש כעת/); assert.doesNotMatch(html, /<strong>המצב הנוכחי:<\/strong> הוצאה משימוש/, 'a past retirement is not the current state');
  assert.match(html, /הספק עזב/); assert.match(html, /avi@x\.test/); assert.match(html, /חזרנו לעבוד יחד/); assert.match(html, /אופס · הסכם: חתום ← טיוטת הסכם/); assert.match(html, /אופס · מצב קשר: שיתוף פעולה פעיל ← נוצר קשר/);
  assert.match(html, /ההוצאה משימוש הקודמת \(נשמרה כהיסטוריה\)/); assert.match(html, /ממתינים לספק/); assert.match(html, /הספק חזר/);
  assert.match(html, /בעבר: ההתקשרות אינה מושהית כעת/, 'an old pause is not "paused"'); assert.doesNotMatch(html, /ההשהיה הנוכחית/);
  assert.equal((html.match(/<tr>/g) || []).length, 5, 'a header and the four events of the life cycle; the tracking update is not one of them');
  assert.doesNotMatch(html, /עדכון התקשרות/); for (const name of ['הוצאה משימוש', 'נפתחה מחדש', 'הושהתה', 'הוחזרה לבדיקה']) assert.ok(html.includes('>' + name + '<'), name);
  assert.doesNotMatch(html, NO_RAW);
  // the whole line of the table reads "who, when, what, why, what was set back" in this order
  const tbody = html.slice(html.indexOf('<tbody>')); assert.ok(tbody.indexOf('חזרנו לעבוד יחד') < tbody.indexOf('הספק עזב') && tbody.indexOf('הספק עזב') < tbody.indexOf('ממתינים לספק'), 'the order of the answer (newest first) is kept');
});

test('the history says what it knows and what it cannot: never reopened, never retired, never paused say so; a paused engagement without a record says that; a window that may be cut never says "none"; a reopening without a reset says that nothing was reset', () => {
  const plainCard = H(eng({ activation: 'pending' }), [], false);
  for (const text of ['לא נפתחה מחדש', 'לא הוצאה משימוש', 'לא נרשמה השהיה', 'לא נרשמה החזרה לבדיקה', 'לא נרשמו אירועי מחזור חיים']) assert.match(plainCard, new RegExp(text), text);
  assert.doesNotMatch(plainCard, /מה אופס בפתיחה מחדש/);
  assert.match(H(eng({ activation: 'paused', paused_reason: 'חופשה' }), [], false), /ההתקשרות מושהית כעת, אך ההשהיה לא נרשמה ביומן הזה/);
  const paused = H(eng({ activation: 'paused', paused_reason: 'חופשה' }), [row('pause', '2026-11-08T09:00:00Z', 'yosi@x.test', { from: 'active', to: 'paused', reason: 'חופשה' })], false);
  assert.match(paused, /ההשהיה הנוכחית/); assert.match(paused, /סיבה: חופשה/); assert.match(paused, /המצב הנוכחי<\/dt><dd>[^]*מושהה[^]*סיבה: חופשה/);
  const retiredNow = H(eng({ activation: 'retired', retired_at: '2026-11-02T09:00:00Z', retired_reason: 'הספק עזב' }), [row('retire', '2026-11-02T09:00:00Z', 'yosi@x.test', { from: 'pending', to: 'retired', reason: 'הספק עזב' })], false);
  assert.match(retiredNow, /<strong>המצב הנוכחי:<\/strong> הוצאה משימוש ב־/); assert.doesNotMatch(retiredNow, /בעבר: ההתקשרות אינה מוצאת משימוש כעת/);
  // a cut window: not "none", and a cut warning
  const cut = H(eng({ activation: 'pending' }), [row('update', '2026-11-08T09:00:00Z', 'a@x.test', { fields: ['priority'] })], true);
  assert.doesNotMatch(cut, /לא נרשמה השהיה|לא נרשמה החזרה לבדיקה|לא נרשמו אירועי מחזור חיים\./); assert.match(cut, /לא נמצא בין 200 הרישומים האחרונים של ההתקשרות/); assert.match(cut, /לא נמצאו אירועי מחזור חיים בין 200/);
  const cutSome = H(eng({ activation: 'pending' }), [row('pause', '2026-11-08T09:00:00Z', 'a@x.test', { from: 'pending', to: 'paused', reason: 'ר' })], true); assert.match(cutSome, /מוצגים רק אירועים מתוך 200 הרישומים האחרונים/);
  // reopened, but the row of the reopening is outside the window: the date is the engagement's own, the details are said to be missing
  const far = H(eng({ activation: 'draft', last_reopened_at: '2026-11-10T09:00:00Z' }), [], true); assert.match(far, /נפתחה מחדש \(לאחרונה\)<\/dt><dd>[^]*10/); assert.match(far, /פרטי האיפוס אינם מוצגים כאן/);
  assert.match(H(eng({ activation: 'draft', last_reopened_at: '2026-11-10T09:00:00Z' }), [row('reopen', '2026-11-10T09:00:00Z', 'a@x.test', { from: 'retired', to: 'draft', reason: 'חזרה', previous_retired_at: null })], false), /לא אופס דבר: ההסכם לא היה חתום ושיתוף הפעולה לא היה פעיל/);
  // more than fifteen events: the newest fifteen, and it says so
  const many = Array.from({ length: 20 }, (_, i) => row('pause', '2026-11-08T09:00:00Z', 'a@x.test', { from: 'pending', to: 'paused', reason: 'ר' + i })); const long = H(eng({ activation: 'paused' }), many, false);
  assert.equal((long.match(/<tr>/g) || []).length, 16); assert.match(long, /מוצגים 15 האירועים האחרונים/);
});

test('what the journal holds is shown as text, never as markup, and the screens never show a raw code', () => {
  const evil = '<img src=x onerror=alert(1)>', e = eng({ activation: 'retired', retired_at: '2026-11-02T09:00:00Z', retired_reason: evil, paused_reason: evil });
  const html = H(e, [row('retire', '2026-11-02T09:00:00Z', evil, { from: 'pending', to: 'retired', reason: evil }), row('reopen', '2026-11-10T09:00:00Z', evil, { from: 'retired', to: 'draft', reason: '<b>x</b>', reset: { agreement_state: ['<i>', 'draft'], contact_state: ['active', 'contacted'] } }),
    row('pause', '2026-11-01T09:00:00Z', '<u>pa</u>@x.test', { from: 'pending', to: 'paused', reason: '<s>pause</s>' }), row('return_to_review', '2026-11-01T12:00:00Z', '<u>rr</u>@x.test', { from: 'paused', to: 'pending', reason: '<s>return</s>' })], false);
  assert.doesNotMatch(html, /<img|<b>|<i>|<u>|<s>/); assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/); assert.match(html, /&lt;s&gt;pause&lt;\/s&gt;/); assert.match(html, /&lt;s&gt;return&lt;\/s&gt;/); assert.match(html, /&lt;u&gt;pa&lt;\/u&gt;@x\.test/);
  const log = C.changeLogHtml([row('reopen', '2026-11-10T09:00:00Z', 'avi@x.test', { from: 'retired', to: 'draft', reason: 'חזרה', previous_retired_at: '2026-11-02T09:00:00.000Z', reset: { agreement_state: ['signed', 'draft'] } }), row('return_to_review', '2026-11-09T09:00:00Z', 'avi@x.test', { from: 'paused', to: 'pending', reason: 'חזר' })], false);
  assert.match(log, /פתיחה מחדש של התקשרות/); assert.match(log, /החזרת התקשרות לבדיקה/); assert.match(log, /מצב: הוצא משימוש ← טיוטה/); assert.match(log, /מצב: מושהה ← ממתין לאישור/); assert.match(log, /אופס · הסכם: חתום ← טיוטת הסכם/); assert.doesNotMatch(log, NO_RAW);
  // every action the server writes for an engagement has a name in the log and in the events table
  const written = new Set([...WRITES.matchAll(/'catalog\.engagement\.([a-z_]+)'/g)].map((m) => m[1])); for (const a of ACTIONS) written.add(a);   // the three are built as 'catalog.engagement.' + action
  const names = plain(C.labels.ACTIONS); for (const a of written) assert.ok(names['catalog.engagement.' + a], 'a name for catalog.engagement.' + a);
  for (const a of plain(C.LIFE_EVENTS)) assert.ok(plain(C.LIFE_NAME)[a], 'an event name for ' + a);
});

test('after a reopening the card says that what was signed or active before is not valid by that fact, and the linked price is kept, not approved again, and re-checked before an activation; what the price lacks is named', () => {
  const reopened = eng({ activation: 'draft', last_reopened_at: '2026-11-10T09:00:00Z' });
  const note = C.reopenNote(reopened); assert.match(note, /נפתחה מחדש ב־/); assert.match(note, /הסכם שהיה חתום חוזר לטיוטה/); assert.match(note, /שיתוף פעולה שהיה פעיל חוזר ל״נוצר קשר״/); assert.match(note, /אינו תקף מעצם הפתיחה מחדש/); assert.match(note, /המצב הנוכחי; הערכים הקודמים נשמרו ביומן/);
  assert.equal(C.reopenNote(eng({ activation: 'draft' })), '', 'an engagement that was never reopened has no such note'); assert.equal(C.reopenNote(eng({ activation: 'active', last_reopened_at: '2026-11-10T09:00:00Z' })), '', 'nor one that is active again');
  const P = (e, ap, over) => C.priceLinkNote(card(e, Object.assign({ approved_price: ap }, over || {})));
  assert.equal(P(reopened, null), '', 'no linked price, nothing to say');
  const fine = P(reopened, price(), {}); assert.match(fine, /המחיר המקושר כפוף לבדיקה מחדש לפני הפעלה/); assert.match(fine, /אינו אישור של ההתקשרות/); assert.match(fine, /פתיחה מחדש לא מחקה את הקישור ולא אישרה אותו מחדש/); assert.match(fine, /בבדיקה של הרגע המחיר המקושר עומד בכללי השיוך והאישור/); assert.match(fine, /זו אינה הפעלה ואינה אישור חדש/);
  assert.doesNotMatch(fine, /המחיר המקושר אינו עומד|חסר/); assert.doesNotMatch(P(eng({ activation: 'pending' }), price()), /פתיחה מחדש לא מחקה/, 'the sentence about a reopening only where there was one');
  const lacks = (ap, ok) => P(reopened, ap, { checklist: { items: [item('price_approved', ok), item('provider_available', true)], missing: [], can_activate: false, seen: 'x' } });
  const unapproved = lacks(price({ approved: false }), false); assert.match(unapproved, /המחיר המקושר אינו מאושר בלשונית ״תמחור״/); assert.match(unapproved, /אינו עומד כעת בכללי השיוך והאישור, ולכן חסר/); assert.doesNotMatch(unapproved, /בבדיקה של הרגע/);
  assert.match(lacks(price({ price: null }), false), /למחיר המקושר אין סכום/);
  const moved = lacks(price(), false); assert.match(moved, /מאושר ויש לו סכום, אך אינו שייך לשירות הזה או לנותן השירות הזה/); assert.doesNotMatch(moved, /אינו מאושר בלשונית|אין סכום/);
  const section = C.priceSection(card(reopened, { approved_price: price(), checklist: { items: [item('price_approved', false)], missing: [], seen: 'x' } })); assert.match(section, /מאושר, אך אינו מתאים להתקשרות/);
  assert.doesNotMatch(C.priceSection(card(reopened, { approved_price: price() })), /אינו מתאים להתקשרות/); assert.match(C.priceSection(card(reopened, { approved_price: price() })), />מאושר</);
  // an ACTIVE engagement whose price no longer fits (the older pricing screen did it): said clearly, with what to do; one whose price fits says nothing
  const active = eng({ activation: 'active', agreement_state: 'signed', contact_state: 'active' });
  const bad = P(active, price(), { checklist: { items: [item('price_approved', false)], missing: [], seen: 'x' } }); assert.match(bad, /ההתקשרות פעילה, אך המחיר המקושר אינו עומד בכללי השיוך והאישור/); assert.match(bad, /אפשר להשהות את ההתקשרות/); assert.doesNotMatch(bad, /כפוף לבדיקה מחדש לפני הפעלה/);
  assert.equal(P(active, price()), '');
  // never an approval that was not given
  for (const html of [fine, unapproved, moved, bad]) assert.doesNotMatch(html, /אושר מחדש|מאושר מחדש|אושרה מחדש|אישור מחודש/);
  assert.deepEqual(plain(C.priceLacks(card(reopened, { approved_price: price({ approved: false, price: null }) }))), ['המחיר המקושר אינו מאושר בלשונית ״תמחור״.', 'למחיר המקושר אין סכום.']);
});

test('the engagement card has its history container, filled by the same one request as the change log; a failed history says so; the older card functions are untouched', () => {
  const html = C.engagementHtml(card(eng({ activation: 'pending' })));
  assert.match(html, /id="ct-life"/); assert.match(html, /id="ct-life-body"/); assert.match(html, /היסטוריית מחזור החיים/); assert.ok(html.indexOf('ct-life') > html.indexOf('ארבע שכבות מחיר'), 'under the prices');
  assert.ok(CATALOG.includes("loadChangeLog('engagement', d.engagement.provider_id + '/' + d.engagement.service_id, d.engagement)") && CATALOG.includes("tell('engagement', d)"));
  assert.ok(CATALOG.includes("if (entity === 'engagement' && eng) paintLife(function () { return lifecycleHistoryHtml(eng, r.history, cut); });"), 'the same answer fills both blocks');
  assert.equal((CATALOG.match(/ctx\.api\(/g) || []).length, 1, 'the read-only file still has one request helper'); assert.doesNotMatch(CATALOG, /ctx\.api\('(POST|PUT|PATCH|DELETE)'/);
  assert.match(CATALOG, /function paintLife\(fn\) \{[^}]*try \{ b\.innerHTML = fn\(\); \} catch/, 'a bug while drawing never leaves the card loading');
});

test('the buttons of the card follow the state and the provider: a paused or archived provider hides the two that bring an engagement back, and says why', () => {
  const bar = CODE.slice(CODE.indexOf('function engagementBar'), CODE.indexOf('function bar(h, html, handlers)'));
  assert.ok(bar.includes("(LIFE_FROM[act] || []).forEach(function (a) {") && bar.includes('NEEDS_PROVIDER[a] && !providerOk(d)'));
  assert.equal(T.providerOk({ checklist: { items: [{ key: 'provider_available', ok: false }] } }), false); assert.equal(T.providerOk({ checklist: { items: [{ key: 'provider_available', ok: true }] } }), true);
  assert.equal(T.providerOk({}), true, 'an older answer without the item shows the button (the server still decides)');
  for (const [state, re] of [['paused', /מושהית[^]*אפשר להחזיר אותה לבדיקה \(ממתינה לאישור\)/], ['active', /פעילה[^]*אפשר להשהות אותה/], ['retired', /הוצאה משימוש[^]*אפשר לפתוח אותה מחדש כטיוטה/]]) assert.ok(CODE.includes(state + ": '"), state);
  assert.match(CODE, /LIFE_NO_PROVIDER = \{ return_to_review: 'נותן השירות מושהה או בארכיון[^']*עד שיחזור לזמינות\.', reopen: 'נותן השירות מושהה או בארכיון[^']*עד שיחזור לזמינות\.' \}/);
});

// ---------- the screens fed with what the real server answers ----------
const E = (p, s) => '/catalog/engagements/' + p + '/' + s;
const seenOf = async (w, p, s) => (await w.call('GET', E(p, s), YOSI)).body.checklist.seen;
const act = async (w, p, s, action, expected, who, reason) => w.call('POST', E(p, s) + '/actions/' + action, who || YOSI, { body: { expected_activation: expected, confirm: action, seen: await seenOf(w, p, s), reason: reason || 'סיבה לבדיקה' } });
const history = async (w, p, s) => (await w.call('GET', '/catalog/history?entity=engagement&entity_id=' + encodeURIComponent(p + '/' + s) + '&limit=200', YOSI)).body;
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('INTEGRATION server -> screen: retire and reopen an engagement for real, then draw its card and its history from the real answers', async () => {
  const w = await world(); await w.open();
  await w.owner("UPDATE provider_services SET agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11");
  assert.equal((await act(w, 21, 11, 'retire', 'pending', YOSI, 'הספק עזב')).status, 200);
  const retired = (await w.call('GET', E(21, 11), YOSI)).body, hist1 = await history(w, 21, 11);
  // the card of a retired engagement: the retirement is the current state
  const page1 = text(C.engagementHtml(retired)) + text(H(retired.engagement, hist1.history, hist1.total > hist1.history.length));
  assert.match(page1, /הוצא משימוש/); assert.match(page1, /המצב הנוכחי: הוצאה משימוש ב־/); assert.doesNotMatch(page1, /נפתחה מחדש ב־/);
  assert.equal((await act(w, 21, 11, 'reopen', 'retired', AVI, 'חזרנו לעבוד יחד')).status, 200);
  const card2 = (await w.call('GET', E(21, 11), YOSI)).body, hist2 = await history(w, 21, 11), cut = hist2.total > hist2.history.length;
  const page = C.engagementHtml(card2) + C.priceLinkNote(card2) + H(card2.engagement, hist2.history, cut);
  const t = text(page);
  assert.match(t, /טיוטה/); assert.match(t, /נפתחה מחדש ב־/); assert.match(t, /הסכם שהיה חתום חוזר לטיוטה/); assert.match(t, /בעבר: ההתקשרות אינה מוצאת משימוש כעת/); assert.match(t, /הספק עזב/); assert.match(t, /חזרנו לעבוד יחד/);
  assert.match(t, /avi@example\.test/); assert.match(t, /yosi@example\.test/); assert.match(t, /אופס · הסכם: חתום ← טיוטת הסכם/); assert.match(t, /אופס · מצב קשר: שיתוף פעולה פעיל ← נוצר קשר/); assert.match(t, /ההוצאה משימוש הקודמת \(נשמרה כהיסטוריה\)/);
  assert.doesNotMatch(t, /המצב הנוכחי: הוצאה משימוש/, 'after the reopening the retirement is the past'); assert.doesNotMatch(t, NO_RAW);
  // the price that was linked stays, is not approved again, and is said to need a new check
  assert.match(t, /המחיר המקושר כפוף לבדיקה מחדש לפני הפעלה/); assert.match(t, /פתיחה מחדש לא מחקה את הקישור ולא אישרה אותו מחדש/); assert.equal(card2.approved_price.id, 7);
  // the dialog says exactly what the server did: the same table, from the same card
  const after = T.lifecycleAfter(retired.engagement, 'reopen'), row = (await w.owner('SELECT activation, agreement_state, contact_state FROM provider_services WHERE professional_id = 21 AND service_id = 11'))[0];
  assert.deepEqual([after.activation, after.agreement_state, after.contact_state], [row.activation, row.agreement_state, row.contact_state], 'the table of the dialog was true');
});

test('INTEGRATION server -> screen: the card of a paused engagement, a pause by hand, a return to review, and a linked price that the older pricing screen moved', async () => {
  const w = await world(); await w.open();
  assert.equal((await act(w, 21, 11, 'pause', 'pending', YOSI, 'ממתינים להבהרה')).status, 200);
  const paused = (await w.call('GET', E(21, 11), YOSI)).body, h1 = await history(w, 21, 11);
  const tp = text(C.engagementHtml(paused)) + text(H(paused.engagement, h1.history, false));
  assert.match(tp, /סיבת השהיה ממתינים להבהרה/); assert.match(tp, /ההשהיה הנוכחית/); assert.match(tp, /yosi@example\.test/); assert.deepEqual(paused.checklist.items.filter((i) => i.key === 'provider_available').map((i) => i.ok), [true]);
  assert.equal((await act(w, 21, 11, 'return_to_review', 'paused', AVI, 'ההבהרה התקבלה')).status, 200);
  const back = (await w.call('GET', E(21, 11), YOSI)).body, h2 = await history(w, 21, 11), tb = text(H(back.engagement, h2.history, false));
  assert.match(tb, /ההבהרה התקבלה/); assert.match(tb, /בעבר: ההתקשרות אינה מושהית כעת/); assert.match(tb, /מצב: מושהה ← ממתין לאישור/); assert.equal(back.engagement.activation, 'pending'); assert.equal(back.engagement.paused_reason, null);
  // the older pricing screen moves the linked (approved) price to another service: the card names the lack, and the price block says the approval does not fit
  await w.owner('UPDATE pricing SET service_id = 12 WHERE id = 7');
  const moved = (await w.call('GET', E(21, 11), YOSI)).body, note = text(C.priceLinkNote(moved)), section = text(C.priceSection(moved));
  assert.equal(moved.approved_price.approved, true); assert.match(note, /אינו שייך לשירות הזה או לנותן השירות הזה/); assert.match(note, /כפוף לבדיקה מחדש לפני הפעלה/); assert.match(section, /מאושר, אך אינו מתאים להתקשרות/);
  await w.owner('UPDATE pricing SET service_id = 11, price = NULL WHERE id = 7');
  assert.match(text(C.priceLinkNote((await w.call('GET', E(21, 11), YOSI)).body)), /למחיר המקושר אין סכום/);
  await w.owner('UPDATE pricing SET price = 1200, approved = false, approved_by = NULL, approved_at = NULL, public = false WHERE id = 7');
  assert.match(text(C.priceLinkNote((await w.call('GET', E(21, 11), YOSI)).body)), /המחיר המקושר אינו מאושר בלשונית ״תמחור״/);
  await w.owner("UPDATE pricing SET approved = true, approved_by = 'yosi@example.test', approved_at = now() WHERE id = 7");
  const fits = text(C.priceLinkNote((await w.call('GET', E(21, 11), YOSI)).body)); assert.match(fits, /בבדיקה של הרגע המחיר המקושר עומד בכללי השיוך והאישור/); assert.doesNotMatch(fits, /אינו עומד/);
  // an active engagement whose price was moved (the known risk of the older pricing screen) is said plainly
  await w.owner("UPDATE provider_services SET activation = 'active', agreement_state = 'signed', contact_state = 'active' WHERE professional_id = 21 AND service_id = 11"); await w.owner('UPDATE pricing SET service_id = 12 WHERE id = 7');
  assert.match(text(C.priceLinkNote((await w.call('GET', E(21, 11), YOSI)).body)), /ההתקשרות פעילה, אך המחיר המקושר אינו עומד בכללי השיוך והאישור/);
});

test('SAFE TEXT, every field: whatever a name, a reason, a note, an actor, a label, a state, a date, a list entry or a reset value holds, every block of the engagement card shows it as text and never as a tag (the ids are numbers made by the server)', () => {
  const P = '"><img src=x onerror=window.__x=1><script>window.__x=2</script>\'', A = '\'><svg onload=window.__x=3></svg>';
  const e = eng({ provider_name: P, service_name: A, activation: 'paused', paused_reason: P, retired_reason: A, retired_at: P, last_retired_reason: P, last_retired_at: A, last_reopened_at: P, updated_by: A, updated_at: P, external_ref: P, terms_note: A, contact_state: P, agreement_state: A, pricing_model: P, service_ready: false, service_missing: [P, A] });
  const d = card(e, { approved_price: price({ label: P, price: 1200 }), price_layers: { market: { model: P, amount: 1, terms_text: P, source_note: A, status: P, source_date: A }, provider_offer: { model: 'fixed', amount: 2, terms_text: A, status: A }, unclassified: null },
    checklist: { items: [{ key: P, label: P, ok: false, blocking: true, enforced: A }, item('price_approved', false), item('provider_available', true)], missing: [P], can_activate: false, documented_only: true, seen: P } });
  const rows = plain(C.LIFE_EVENTS).concat(['update']).map((a) => row(a, P, P, { from: P, to: A, reason: P, previous_retired_at: A, fields: [P, A], reset: { agreement_state: [P, A], contact_state: [A, P] }, cleared: true, source: P, source_kind: A, approved_on: P }));
  const blocks = { card: C.engagementHtml(d), price: C.priceLinkNote(d), priceSection: C.priceSection(d), reopened: C.reopenNote(e), life: H(e, rows, false), lifeCut: H(e, rows, true), lifeEmpty: H(e, [], true), log: C.changeLogHtml(rows, false), logCut: C.changeLogHtml(rows, true), checklist: C.checklistHtml(d.checklist), notReady: C.serviceNotReady(e) };
  for (const [name, html] of Object.entries(blocks)) assert.doesNotMatch(html, /<(img|script|svg)\b/i, 'no tag from a stored text in the block "' + name + '"');
  for (const name of ['card', 'life', 'log']) assert.match(blocks[name], /&lt;img src=x/, 'the text itself is shown, escaped, in the block "' + name + '"');
  assert.match(blocks.card, /&lt;svg onload/); assert.match(blocks.life, /&#39;&gt;&lt;svg/); assert.doesNotMatch(blocks.life + blocks.log, /"><img/);
  // the dialogs are made from the same card: the names that reach them are escaped by the one helper (a browser test opens them with such names)
  const life = CODE.slice(CODE.indexOf('function consequences'), CODE.indexOf('function engagementBar'));
  const raw = [...life.matchAll(/(?<!esc\()\b(?:e|d\.engagement)\.(?:provider_name|service_name|paused_reason|retired_reason|external_ref|terms_note)\b|(?<!esc\()\bwho\.actor\b|(?<!esc\()\bdd\.message\b/g)].map((m) => m[0]);
  assert.deepEqual(raw, [], 'no stored text is put into a dialog without esc(): ' + raw.join(' | '));
  assert.ok((life.match(/esc\(e\.provider_name\)/g) || []).length === 1 && (life.match(/esc\(e\.service_name\)/g) || []).length === 1 && life.includes('esc(who.actor)') && life.includes('esc(dd.message)'), 'the dialog does escape the two names, the other admin and the message');
});
