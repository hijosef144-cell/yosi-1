'use strict';
// Catalog admin screens, stage 5b-1 (EDIT: providers and services). The pure parts of admin/kaspchem/catalog-edit.js run in a sandbox without a browser; the file itself is also checked as text:
// the only requests it may send, the words it shows for every answer the server can give, and the facts it relies on in the server code. The browser behaviour (forms, double clicks, conflicts,
// unknown results, phone width) is covered by tests/e2e/catalog-edit.spec.js. No network, no database, no Neon.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').split('\r\n').join('\n');   // the admin files may carry Windows line endings
const SRC = read('admin', 'kaspchem', 'catalog-edit.js'), CATALOG = read('admin', 'kaspchem', 'catalog.js'), ADMIN = read('admin', 'kaspchem', 'admin.js'), INDEX = read('admin', 'kaspchem', 'index.html');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '');   // without the header comment, which says in words what the file never does
const sandbox = { window: {}, console };
vm.createContext(sandbox); vm.runInContext(CATALOG, sandbox); vm.runInContext(SRC, sandbox);
const RAW = sandbox.window.KaspchemCatalogEdit._t;
// what the sandbox returns is made of that realm's own objects; a JSON round trip makes them comparable with deepStrictEqual
const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const T = new Proxy(RAW, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => plain(t[k](...a)) : t[k]) });
const server = (...p) => read('netlify', 'functions', '_kaspchem', ...p);
const HEBREW = /[֐-׿]/;

test('the editing module is wired: it loads after the catalog screens and before admin.js, and does nothing at all if the screens are missing', () => {
  const i = (f) => INDEX.indexOf('/admin/kaspchem/' + f);
  assert.ok(i('catalog.js') > 0 && i('catalog.js') < i('catalog-edit.js') && i('catalog-edit.js') < i('admin.js'), 'catalog.js, then catalog-edit.js, then admin.js');
  assert.doesNotMatch(INDEX, /<script>[^<]|onclick=/, 'still no inline script');
  assert.match(CODE, /var C = root\.KaspchemCatalog;\s*if \(!C \|\| typeof C\.extend !== 'function'\) return;/);
  const lone = { window: {}, console }; vm.createContext(lone); vm.runInContext(SRC, lone);   // without catalog.js: no error, nothing registered
  assert.equal(lone.window.KaspchemCatalogEdit, undefined);
  assert.equal(typeof sandbox.window.KaspchemCatalog.extend, 'function');
});

test('the ONLY requests it can send are the ten editing routes (providers, services, engagements); of the engagement actions only "submit"; everything else is refused before it leaves the page', () => {
  assert.equal(T.ROUTES.length, 10);
  const ok = [['POST', '/catalog/providers'], ['PATCH', '/catalog/providers/12'], ['POST', '/catalog/providers/12/pause'], ['POST', '/catalog/providers/12/resume'], ['POST', '/catalog/providers/12/archive'], ['POST', '/catalog/providers/12/unarchive'],
    ['POST', '/catalog/services'], ['PATCH', '/catalog/services/3'], ['PUT', '/catalog/services/3/settings'], ['POST', '/catalog/services/3/clearance'],
    ['POST', '/catalog/engagements'], ['PATCH', '/catalog/engagements/11/2'], ['POST', '/catalog/engagements/11/2/actions/submit']];
  for (const [m, p] of ok) assert.equal(T.allowed(m, p), true, m + ' ' + p);
  const refused = [['DELETE', '/catalog/providers/12'], ['DELETE', '/catalog/services/3'], ['GET', '/catalog/providers'], ['POST', '/catalog/engagements/1/2/activate'],
    ['POST', '/catalog/engagements/1/2/submit'], ['POST', '/catalog/engagements/1/2/resume'], ['PUT', '/catalog/engagements/1/2/prices/market'], ['POST', '/catalog/imports/apply'], ['POST', '/catalog/imports/preview'], ['PUT', '/settings'], ['POST', '/services'],
    ['PATCH', '/services/3'], ['POST', '/professionals'], ['PUT', '/catalog/providers/12'], ['POST', '/catalog/providers/12/activate'], ['POST', '/catalog/providers/12/pause/extra'], ['PATCH', '/catalog/services/3/settings'],
    ['PUT', '/catalog/services/3'], ['POST', '/catalog/services/3/offer'], ['POST', '/catalog/services/3/clearance?x=1'], ['POST', '/catalog/providers/../services'], ['POST', '/catalog/providers/abc'], ['POST', '//catalog/providers'], ['POST', '/catalog/providers/'], ['post', '/catalog/providers'],
    ...['activate', 'resume', 'withdraw', 'pause', 'retire', 'reopen', 'return_to_review', 'Submit', 'SUBMIT', 'submit/', 'submit/x', ''].map((a) => ['POST', '/catalog/engagements/1/2/actions/' + a]), ['DELETE', '/catalog/engagements/1/2'], ['PUT', '/catalog/engagements/1/2'], ['GET', '/catalog/engagements'], ['POST', '/catalog/engagements/1/2'],
    ['PATCH', '/catalog/engagements/1'], ['PATCH', '/catalog/engagements/a/2'], ['POST', '/catalog/engagements/a/2/actions/submit'], ['POST', '/catalog/engagements/1/2/actions/submit?x=1'], ['POST', '/catalog/engagements/'], ['POST', '/catalog/engagements/1/2/actions'],
    ['PUT', '/catalog/engagements/1/2/prices/market'], ['POST', '/catalog/engagements/1/2/price-link']];
  for (const [m, p] of refused) assert.equal(T.allowed(m, p), false, m + ' ' + p);
});

test('the file itself: one request helper, no fetch of its own, no storage, no timers except the toast, nothing about prices, imports, activation, pausing, retiring or deleting', () => {
  assert.equal((CODE.match(/ctx\.api\(/g) || []).length, 1, 'ctx.api is called in exactly one place (send)');
  assert.match(CODE, /function send\(ctx, method, path, body\) \{\s*if \(!allowed\(method, path\)\)/);
  assert.equal((CODE.match(/\bsend\(/g) || []).length - 1, (CODE.match(/[^.\w]send\(h\.ctx/g) || []).length, 'every use of send goes through the allowed-list helper');
  assert.doesNotMatch(CODE, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|\beval\(|new Function|document\.write|insertAdjacentHTML\([^)]*\+/);
  assert.doesNotMatch(CODE, /setInterval|requestAnimationFrame|autosave|auto-save|retry\(/i);
  const timers = CODE.match(/setTimeout\([^;]*;/g) || []; assert.equal(timers.length, 1, 'one timer: the toast fading away'); assert.match(timers[0], /classList\.remove\('show'\)/);
  const paths = [...CODE.matchAll(/'(\/catalog\/[^']*)'/g)].map((m) => m[1]);
  for (const p of paths) assert.doesNotMatch(p, /imports|prices|activate|resume|withdraw|retire|similar/, p);
  assert.doesNotMatch(CODE.replace(/'DELETE'/g, ''), /DELETE/);
  assert.match(CODE, /h\.get\('\/catalog\/(history\?entity=|providers\/|services\/)/, 'the reads it makes are the history and the two cards');
  // writes are made only after a click: the one place that calls the helper for a write is `write()` / the settings step, both reached from a submit handler or a panel button
  assert.equal((CODE.match(/addEventListener\('submit'/g) || []).length, 1);
  assert.doesNotMatch(CODE, /addEventListener\('(blur|focusout|input|change|keyup|keydown)'[^)]*\)[^;]*\b(send|write)\(/, 'no field event sends anything');
});

test('every answer the server can give to these seven routes has plain Hebrew words (no code is ever shown), and every word is escaped or fixed text', () => {
  const writes = server('admin-catalog-writes.js'), upto = writes.slice(0, writes.indexOf('// ===== price layers'));   // helpers, field rules, services, providers and engagements
  const found = new Set();
  const add = (src, re) => { for (const m of src.matchAll(re)) found.add(m[1]); };
  for (const src of [upto, server('catalog-writes.js'), server('admin-catalog-router.js'), server('catalog-guards.js'), server('http.js'), server('admin-entry.js')]) {
    add(src, /\bbad\(\s*'([a-z_]+)'/g); add(src, /HttpError\(\s*\d+,\s*'([a-z_]+)'/g); add(src, /\brefusal\(\s*\d+,\s*'([a-z_]+)'/g); add(src, /\bdup\(\s*'([a-z_]+)'/g); add(src, /\b(?:req|opt|boolean|oneOf|intIn|idBody|tags)\([^()]*?,\s*'([a-z_]+)'\)/g);
  }
  for (const other of ['use_catalog_switch', 'managed_in_catalog', 'bad_query']) found.delete(other);   // answers of the older routes and of the reads, never of these writes
  assert.ok(found.size > 40, 'the scan found the codes: ' + found.size);
  for (const need of ['bad_name', 'similar_service_exists', 'similar_provider_exists', 'service_has_public_price', 'active_engagements_exist', 'code_in_use', 'settings_exist', 'busy_retry', 'write_timeout', 'result_unknown', 'catalog_disabled', 'conflict', 'csrf']) assert.ok(found.has(need), 'the scan sees ' + need);
  const missing = [...found].filter((c) => !Object.prototype.hasOwnProperty.call(T.MSG, c));
  assert.deepEqual(missing, [], 'codes without words: ' + missing.join(', '));
  for (const [code, text] of Object.entries(T.MSG)) { assert.match(text, HEBREW, code); assert.doesNotMatch(text, /[a-z]_[a-z]|SQL|allow_duplicate|expected|undefined|null/, code + ': ' + text); }
  assert.match(T.msg('never_heard_of_it'), HEBREW);
  // the validation answers point at a field that exists in a form
  for (const [code, field] of Object.entries(T.FIELD_OF)) assert.ok(T.MSG[code] && CODE.includes("'" + field + "'") || CODE.includes('"' + field + '"') || CODE.includes(field), code + ' -> ' + field);
});

test('describe(): what each failed request means for the screen (nothing saved / may have been saved / take another look), and the server\'s own words are never used', () => {
  const E = (message, status, userMessage) => ({ message, status, userMessage });
  const kind = (e) => T.describe(e).kind;
  assert.equal(kind(E('unauthenticated', 401)), 'auth');
  for (const [c, s] of [['busy_retry', 409], ['conflict_retry', 409], ['write_timeout', 503], ['catalog_unavailable', 503]]) assert.equal(kind(E(c, s)), 'busy', c);
  // possibly saved: no answer at all, a gateway page, a server fault, the server's own "unknown"
  assert.equal(kind(E('Failed to fetch', undefined)), 'unknown'); assert.equal(kind({ message: 'x' }), 'unknown');
  for (const s of [500, 502, 503, 504]) assert.equal(kind(E('error', s)), 'unknown', 'status ' + s + ' without a known code');
  assert.equal(kind(E('result_unknown', 502)), 'unknown'); assert.equal(kind(E('server_error', 500)), 'unknown');
  assert.equal(kind(E('catalog_disabled', 403)), 'closed'); assert.equal(kind(E('forbidden', 403)), 'forbidden'); assert.equal(kind(E('csrf', 403)), 'forbidden'); assert.equal(kind(E('not_found', 404)), 'notfound');
  assert.equal(kind(E('conflict', 409)), 'conflict');
  assert.equal(kind(E('similar_service_exists', 409)), 'duplicate'); assert.equal(kind(E('similar_provider_exists', 409)), 'duplicate');
  assert.deepEqual({ kind: T.describe(E('bad_phone', 400)).kind, field: T.describe(E('bad_phone', 400)).field }, { kind: 'validation', field: 'contact_phone' });
  assert.equal(T.describe(E('reason_required', 400)).field, 'reason'); assert.equal(T.describe(E('bad_until', 400)).field, 'until'); assert.equal(T.describe(E('bad_tags', 400)).field, 'finding_tags');
  for (const c of ['service_has_public_price', 'active_engagements_exist', 'code_in_use', 'settings_exist', 'already_archived', 'not_paused', 'not_archived', 'provider_archived', 'settings_required']) assert.equal(kind(E(c, 409)), 'state', c);
  assert.equal(kind(E('some_future_code', 400)), 'state'); assert.equal(T.describe(E('some_future_code', 400)).message, 'הפעולה לא הושלמה. לא נשמר דבר.');
  assert.equal(kind({ message: 'route_not_allowed', internal: true }), 'form');
  // the server's sentence is never shown, whatever it says, for every kind of answer
  const poison = 'SELECT password FROM secrets; host=db.internal; stack at /var/task/x.js';
  for (const [c, s] of [['unauthenticated', 401], ['busy_retry', 409], ['write_timeout', 503], ['result_unknown', 502], ['server_error', 500], ['catalog_disabled', 403], ['forbidden', 403], ['not_found', 404], ['conflict', 409], ['similar_service_exists', 409], ['bad_name', 400], ['code_in_use', 409], ['whatever', 400], ['error', 504]]) {
    const d = T.describe(E(c, s, poison)); assert.doesNotMatch(JSON.stringify(d), /SELECT|password|db\.internal|var\/task/, c);
    if (d.message) assert.match(d.message, HEBREW, c);
  }
  // "not saved" is only said where the server said so; "unknown" never says "nothing was saved"
  assert.match(T.describe(E('busy_retry', 409)).message, /לא נשמר דבר/); assert.match(T.describe(E('write_timeout', 503)).message, /לא נשמר דבר/);
  assert.doesNotMatch(T.describe(E('result_unknown', 502)).message, /לא נשמר דבר\./); assert.match(T.describe(E('result_unknown', 502)).message, /אל תשלחו שוב/);
});

test('a similar-name answer is read for the names and numbers it holds, nothing else', () => {
  const real = 'כבר קיימת רשומה דומה: [דמו] נותן שירות ה׳ (מספר 15), [דמו] משרד, בע״מ (מספר 7), שלישי (מספר 123). כדי ליצור בכל זאת יש לשלוח allow_duplicate.';
  assert.deepEqual(T.dupItems(real), [{ id: 15, name: '[דמו] נותן שירות ה׳' }, { id: 7, name: '[דמו] משרד, בע״מ' }, { id: 123, name: 'שלישי' }]);
  assert.deepEqual(T.dupItems('כבר קיימת רשומה דומה: א (מספר 1). כדי'), [{ id: 1, name: 'א' }]);
  for (const bad of [undefined, null, '', 'no colon (מספר 1)', 'x: nothing here', 42]) assert.deepEqual(T.dupItems(bad), [], String(bad));
  assert.ok(T.dupItems('x: ' + Array.from({ length: 9 }, (_, i) => 'n' + i + ' (מספר ' + (i + 1) + ')').join(', ') + '.').length <= 3);
  // the sentence the real server writes has this shape (read from its source, so a change there is noticed here)
  assert.match(server('admin-catalog-writes.js'), /'כבר קיימת רשומה דומה: ' \+ rows\.slice\(0, 3\)\.map\(\(r\) => r\.name \+ ' \(מספר ' \+ r\.id \+ '\)'\)\.join\(', '\)/);
});

test('only the fields that CHANGED are sent, each with the value that was seen (compare-and-set); "no change" is detected before anything is sent', () => {
  const p = { name: 'א', business_name: null, contact_phone: '050-1', contact_email: 'a@b.test', capacity_open: 5, delivery_method: 'portal', internal_notes: 'n' };
  const same = (over) => T.diffFields(['name', 'business_name', 'contact_phone', 'contact_email', 'capacity_open', 'delivery_method', 'internal_notes'], p, Object.assign({ name: 'א', business_name: '', contact_phone: '050-1', contact_email: 'a@b.test', capacity_open: '5', delivery_method: 'portal', internal_notes: 'n' }, over));
  assert.equal(same({}).count, 0, 'null and an empty box, 5 and "5": no change');
  assert.deepEqual(same({ contact_phone: '052-2', capacity_open: '' }), { changes: { contact_phone: '052-2', capacity_open: null }, expected: { contact_phone: '050-1', capacity_open: 5 }, count: 2 });
  assert.deepEqual(same({ name: ' ב ', business_name: ' עסק ' }).changes, { name: 'ב', business_name: 'עסק' });
  assert.deepEqual(same({ business_name: 'עסק' }).expected, { business_name: null }, 'the old value is the one that was SEEN, null stays null');
  assert.deepEqual(same({ internal_notes: '   ' }).changes, { internal_notes: null }, 'blank text clears a note, it is not saved as spaces');
  assert.equal(same({ capacity_open: '0' }).changes.capacity_open, 0);
  const s = { name: 'ש', topic: null, description: 'ת', active: false };
  const d = T.diffFields(['name', 'topic', 'description', 'active'], s, { name: 'ש', topic: '', description: 'ת', active: true });
  assert.deepEqual(d, { changes: { active: true }, expected: { active: false }, count: 1 });
  assert.equal(T.diffFields(['name', 'topic', 'description', 'active'], s, { name: 'ש', topic: '', description: 'ת', active: false }).count, 0);
  const st = { finding_tags: ['b', 'a'], topics: ['x'] };
  assert.equal(T.diffFields(['finding_tags', 'topics'], st, { finding_tags: ['a', 'b'], topics: ['x'] }).count, 0, 'the same tags in another order are not a change');
  assert.deepEqual(T.diffFields(['finding_tags', 'topics'], st, { finding_tags: ['a', 'b', 'c'], topics: ['x'] }), { changes: { finding_tags: ['a', 'b', 'c'] }, expected: { finding_tags: ['b', 'a'] }, count: 1 });
  assert.deepEqual(T.diffFields(['finding_tags'], {}, { finding_tags: ['q'] }).expected, { finding_tags: null });
});

test('tags: split on commas and spaces, lower case, no repeats, at most twelve, only letters, digits and a dash; the code of a new service is svc-<number> and fits the server rule', () => {
  assert.deepEqual(T.parseTags('Payslip, new-tag;  second-tag\nnew-tag ,,'), ['payslip', 'new-tag', 'second-tag']); assert.deepEqual(T.parseTags(''), []); assert.deepEqual(T.parseTags(null), []);
  assert.equal(T.tagsProblem(['a-1', 'b']), null); assert.equal(T.tagsProblem(['bad_tag']), 'bad_tags'); assert.equal(T.tagsProblem(['Ünï']), 'bad_tags'); assert.equal(T.tagsProblem(['x'.repeat(41)]), 'bad_tags'); assert.equal(T.tagsProblem(Array.from({ length: 13 }, (_, i) => 't' + i)), 'bad_tags'); assert.equal(T.tagsProblem(Array.from({ length: 12 }, (_, i) => 't' + i)), null);
  const rule = /^[a-z0-9-]{2,40}$/;   // the server rule for a code (admin-catalog-writes.js)
  assert.match(server('admin-catalog-writes.js'), /\/\^\[a-z0-9-\]\{2,40\}\$\//);
  assert.equal(T.serviceCode(12, 0), 'svc-12'); assert.equal(T.serviceCode(12, 1), 'svc-12-1'); assert.equal(T.serviceCode(1, 0), 'svc-1');
  for (const id of [1, 9, 1000, 123456789012]) for (const a of [0, 1, 7]) assert.match(T.serviceCode(id, a), rule);
  assert.notEqual(T.serviceCode(5, 0), T.serviceCode(6, 0));
  assert.match(CODE, /code: code, finding_tags: \[\], topics: \[\]/, 'a new service gets its code and nothing else (no tags, no topics, no clearance, no offer)');
});

test('the report of a legal clearance holds only what the owner typed: the kind and short source, the day of the approval, a remark; nothing is made up; it is a report, not a verification; the reporter is the server\'s record, not a field', () => {
  assert.equal(T.clearanceNote('', '', '', ''), null); assert.equal(T.clearanceNote(undefined, '  ', null, undefined), null);
  assert.equal(T.clearanceNote('written_opinion', 'מכתב עו״ד', '2026-11-05', 'להפניה'), 'מקור: חוות דעת משפטית בכתב — מכתב עו״ד · תאריך האישור: 05.11.2026 · הערה: להפניה');
  assert.equal(T.clearanceNote('', ' מכתב ', '', ''), 'מקור: מכתב'); assert.equal(T.clearanceNote('email', '', '', ''), 'מקור: אישור בדוא״ל'); assert.equal(T.clearanceNote('', '', '2026-01-02', ''), 'תאריך האישור: 02.01.2026'); assert.equal(T.clearanceNote('bogus', '', '', ''), null, 'an unknown kind adds nothing');
  assert.doesNotMatch(String(T.clearanceNote('', '', '', '')), /אושר|approved|auto/);
  // the longest note this form can make fits the 600 characters of the row
  assert.ok(T.clearanceNote('written_opinion', 'א'.repeat(200), '2026-11-05', 'ב'.repeat(300)).length <= 600);
  // the three lists of kinds agree: this form, the read screens and the server
  const serverKinds = /const SOURCE_KINDS = \[([^\]]*)\]/.exec(server('admin-catalog-writes.js'))[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(plain(T.SOURCE_KINDS.map((k) => k[0])), serverKinds); assert.deepEqual(plain(Object.keys(sandbox.window.KaspchemCatalog._t.SOURCE_KIND)), serverKinds);
  for (const [k, label] of T.SOURCE_KINDS) assert.equal(sandbox.window.KaspchemCatalog._t.SOURCE_KIND[k], label, k);
  // the dialog says that it records a REPORT, that nothing is verified, asks for an explicit tick (never pre-ticked), and names the limits of what is kept
  assert.match(CODE, /רישום של דיווח/); assert.match(CODE, /לא בקשת אישור ולא הפעלה/); assert.match(CODE, /ואינה מאמתת שהאישור התקבל/); assert.match(CODE, /יש לסמן שהאישור התקבל/); assert.match(CODE, /אני מדווח שהתקבל אישור משפטי בכתב/);
  assert.match(CODE, /רישום או ביטול נוספים לא מוחקים את הקודמים/); assert.match(CODE, /נשמרת בכרטיס בלבד, לא ביומן/); assert.match(CODE, /אלה נדחים/);
  assert.doesNotMatch(CODE, /id="ce-confirm"[^>]*\bchecked/, 'the confirmation is never pre-ticked');
  // what is sent: the structured facts next to the row note; a cancellation sends its reason; neither names who reports it
  assert.ok(CODE.includes("var body = { cleared: true, expected_cleared: false }, note = clearanceNote(v.source_kind, v.source, v.approved_on, v.note);"));
  assert.ok(CODE.includes("if (v.source_kind) body.source_kind = v.source_kind; if (v.source && v.source.trim()) body.source = v.source.trim(); if (v.approved_on) body.approved_on = v.approved_on; if (note) body.note = note;"));
  assert.ok(CODE.includes("{ cleared: false, expected_cleared: true, reason: reason, note: 'ביטול הרישום: ' + reason }"));
  assert.doesNotMatch(CODE, /legal_cleared_by|legal_cleared_at|by:|actor:/, 'the form never names who registered it');
  // and the server does what the dialog says
  const w = server('admin-catalog-writes.js');
  assert.match(w, /legal_cleared_by = CASE WHEN \$1::boolean THEN \$2::text ELSE NULL END/); assert.match(w, /W\.counted\(dml, \[cleared, c\.me\.email, note/); assert.match(w, /WHERE service_id = \$4::bigint AND legal_cleared = \$5::boolean/);
  assert.match(w, /W\.audit\(c\.me\.email, 'catalog\.service\.clearance', 'service', id, detail\)/, 'every event is a journal row of its own');
});

test('a cancellation sends its reason and a short row note; the history of what was reported is the journal\'s (no old note is carried inside the new one, nothing is cut)', () => {
  assert.doesNotMatch(CODE, /withdrawNote|NOTE_MAX|הרישום שבוטל/); assert.equal(T.withdrawNote, undefined);
  assert.match(CODE, /ההיסטוריה נשמרת ביומן ואינה נמחקת: מי דיווח ומתי, המקור והתאריך שדווחו, ומי ביטל, מתי ומדוע/);
  assert.match(CODE, /ביטול רישום האישור המדווח/); assert.match(CODE, /רישום דיווח על אישור משפטי/);
  assert.doesNotMatch(CODE, /אישור משפטי שהתקבל'/, 'the button no longer reads as if an approval were given');
});

test('the date of a pause: a local date becomes the start of that day; nonsense becomes nothing', () => {
  assert.equal(T.pauseUntilIso('2030-01-15'), new Date('2030-01-15T00:00:00').toISOString());
  for (const bad of ['', 'abc', '2030-13-45', undefined]) assert.equal(T.pauseUntilIso(bad), null, String(bad));
  assert.match(server('admin-catalog-writes.js'), /t\.getTime\(\) <= now \|\| t\.getTime\(\) > now \+ 366 \* 86400000/, 'the server window the form relies on: in the future, within 366 days');
  assert.match(CODE, /min: dateInput\(tomorrow\), maxv: dateInput\(limit\)/);
});

test('the "active" mark of a service is internal: nothing in the public site or the referral code reads it, the form says so, and a new service cannot be created active', () => {
  // 1. no code outside the catalog and the older admin screen reads or writes services.active
  const dir = path.join(ROOT, 'netlify', 'functions'); const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(f.name)) files.push(p); } })(dir);
  assert.ok(files.length > 15);
  const hits = [];
  for (const f of files) {
    const base = path.basename(f); if (/^(admin-catalog|catalog)/.test(base) || /^catalog$/.test(path.basename(path.dirname(f)))) continue;
    read(path.relative(ROOT, f)).split('\n').forEach((line, i) => { if (/^\s*\/\//.test(line)) return; if (/\bactive\b/.test(line.replace(/\/\/.*$/, ''))) hits.push(base + ':' + (i + 1)); });
  }
  const adminHits = hits.filter((h) => h.startsWith('admin-router.js')).length;
  assert.deepEqual(hits.filter((h) => !h.startsWith('admin-router.js')), [], 'nothing but the older admin router mentions "active": ' + hits.join(', '));
  assert.equal(adminHits, 2, 'the older admin router: the line that builds the update and the update itself');
  // the public config and the referral assignment read only the topic of a service
  assert.match(read('netlify', 'functions', 'kaspchem-config.js'), /SELECT p\.id, p\.label, p\.price, s\.topic FROM pricing p LEFT JOIN services s/);
  assert.match(server('admin-router.js'), /SELECT topic FROM services WHERE id = \$1/);
  // 2. the form says so in words, and a new service has no way to be made active
  assert.match(CODE, /var ACTIVE_NOTE = 'סימון פנימי בלבד: אינו משפיע על האתר הציבורי ולא על תהליכי ההפניה\.';/);
  assert.match(CODE, /field\('active', 'שירות פעיל \(פנימי\)'/); assert.match(CODE, /\(isNew \? '' : field\('active'/);
  assert.doesNotMatch(CODE.slice(CODE.indexOf('function createService'), CODE.indexOf('function settingsStep')), /active/, 'creating a service never mentions "active"');
  assert.match(server('admin-catalog-writes.js'), /INSERT INTO services \(id, name, topic, description, active\) VALUES \(\$1::bigint, \$2, \$3, \$4, false\)/);
  assert.doesNotMatch(CATALOG, /שירות פעיל\b(?! \(פנימי\))/, 'the read screens do not call it "active service" without saying internal');
});

test('the change log under a card: views are left out, at most ten rows, the reason of a pause or archive is shown as text, every action has a Hebrew name', () => {
  const rows = [{ created_at: '2026-11-09T10:00:00Z', actor: 'a@x.test', action: 'catalog.provider.view', detail: {} }, { created_at: '2026-11-09T11:00:00Z', actor: 'avi@x.test', action: 'catalog.provider.archive', detail: { reason: '<b>פרש</b>' } },
    { created_at: '2026-11-09T12:00:00Z', actor: 'y@x.test', action: 'catalog.service.clearance', detail: { cleared: true } }, { created_at: '2026-11-09T13:00:00Z', actor: 'y@x.test', action: 'catalog.provider.update', detail: { fields: ['contact_phone', 'internal_notes'] } }];
  const html = sandbox.window.KaspchemCatalog._t.changeLogHtml(rows);
  assert.doesNotMatch(html, /צפייה בכרטיס/); assert.match(html, /ארכוב נותן שירות/); assert.match(html, /&lt;b&gt;פרש&lt;\/b&gt;/); assert.doesNotMatch(html, /<b>פרש/); assert.match(html, /אישור מדווח נרשם/); assert.match(html, /contact_phone, internal_notes/);
  assert.match(sandbox.window.KaspchemCatalog._t.changeLogHtml([]), /אין שינויים רשומים/);
  // when the server holds more records than were fetched (the 200 newest, views included), the page never says "no changes": it says what it looked at
  const L = sandbox.window.KaspchemCatalog._t.changeLogHtml, views = Array.from({ length: 200 }, () => ({ created_at: '2026-11-09T10:00:00Z', actor: 'a', action: 'catalog.provider.view', detail: {} }));
  assert.doesNotMatch(L(views, true), /אין שינויים רשומים/); assert.match(L(views, true), /לא נמצאו שינויים בין 200 הרישומים האחרונים/); assert.match(L(views, true), /ייתכן שיש שינויים ישנים יותר/);
  assert.match(L([], true), /לא נמצאו שינויים בין 200/, 'an empty answer that is only the visible part is not "no changes" either');
  const some = L(views.concat(rows.slice(1, 2)), true); assert.match(some, /מוצגים רק שינויים מתוך 200 הרישומים האחרונים/); assert.match(some, /ארכוב נותן שירות/); assert.doesNotMatch(some, /אין שינויים רשומים/);
  assert.match(L(views, false), /אין שינויים רשומים/, 'nothing was left out, so "no changes" is true');
  assert.match(L(Array.from({ length: 12 }, () => ({ created_at: '2026-11-09T10:00:00Z', actor: 'a', action: 'catalog.provider.update', detail: {} })), false), /מוצגים 10 השינויים האחרונים/);
  assert.match(CATALOG, /var LOG_FETCH = 200;/); assert.ok(CATALOG.includes('limit: LOG_FETCH'), 'the fetch uses the constant'); assert.ok(CATALOG.includes('var cut = r.total > (r.history || []).length;') && CATALOG.includes('changeLogHtml(r.history, cut)'), 'the page tells the function whether records were left out');
  assert.equal((sandbox.window.KaspchemCatalog._t.changeLogHtml(Array.from({ length: 30 }, () => ({ created_at: '2026-11-09T10:00:00Z', actor: 'a', action: 'catalog.provider.update', detail: {} }))).match(/<tr>/g) || []).length, 11, 'a header row and ten rows');
  // every action the seven routes write has a name, so the log never shows a raw code
  const w = server('admin-catalog-writes.js'); const upto = w.slice(0, w.indexOf('// ===== engagements'));
  const actions = new Set([...upto.matchAll(/'(catalog\.(?:service|provider)\.[a-z.]+)'/g)].map((m) => m[1]));
  for (const a of ['catalog.provider.' + 'pause', 'catalog.provider.resume', 'catalog.provider.archive', 'catalog.provider.unarchive']) actions.add(a);   // built as 'catalog.provider.' + action
  assert.ok(actions.size >= 10, [...actions].join(', '));
  for (const a of actions) assert.ok(CATALOG.includes("'" + a + "':"), 'catalog.js has a name for ' + a);
});

test('the clearance history of a service lists every report and cancellation from the journal, as text, newest first as given; it says what it could not see, and calls itself a report, not a verification', () => {
  const H = sandbox.window.KaspchemCatalog._t.clearanceHistoryHtml;
  const rows = [
    { created_at: '2026-11-12T10:00:00Z', actor: 'yosi@x.test', action: 'catalog.service.clearance', detail: { cleared: false, was_cleared: true, reason: 'נמצא פגם <b>בנוסח</b>' } },
    { created_at: '2026-11-11T10:00:00Z', actor: 'avi@x.test', action: 'catalog.service.update', detail: { fields: ['name'] } },
    { created_at: '2026-11-10T10:00:00Z', actor: 'avi@x.test', action: 'catalog.service.clearance', detail: { cleared: true, was_cleared: false, basis: 'reported', source_kind: 'written_opinion', source: 'מכתב <img src=x> מיום 05.11.2026', approved_on: '2026-11-05' } },
    { created_at: '2026-11-01T10:00:00Z', actor: 'yosi@x.test', action: 'catalog.service.clearance', detail: { fields: ['legal_cleared'] } }];
  const html = H(rows, false);
  assert.equal((html.match(/<tr>/g) || []).length, 4, 'a header and the three clearance events, not the other update');
  assert.match(html, /אישור מדווח/); assert.match(html, /הרישום בוטל/); assert.match(html, /חוות דעת משפטית בכתב — מכתב &lt;img src=x&gt; מיום 05\.11\.2026/); assert.match(html, /05\.11\.2026/); assert.match(html, /נמצא פגם &lt;b&gt;בנוסח&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img|<b>/, 'typed text is shown as text'); assert.doesNotMatch(html, /עדכון שירות/);
  assert.match(html, /לא אימות משפטי/); assert.match(html, /ואינם נמחקים/);
  assert.ok(html.indexOf('נמצא פגם') < html.indexOf('חוות דעת'), 'the order of the answer is kept (newest first)');
  assert.match(html, /לא צוין/, 'what was not given is said, not left empty or invented'); assert.doesNotMatch(html, /\bundefined\b|\bnull\b|NaN/);
  assert.match(H([], false), /לא דווח אישור משפטי על השירות הזה/); assert.match(H([], true), /לא נמצאו דיווחים בין 200 הרישומים האחרונים[^]*ייתכן שיש ישנים יותר/);
  assert.match(H(rows, true), /מוצגים רק דיווחים מתוך 200 הרישומים האחרונים של השירות/); assert.doesNotMatch(H(rows, false), /מוצגים רק דיווחים/);
  // the card says "reported", never "approved", wherever the state of the clearance is shown
  const C = sandbox.window.KaspchemCatalog._t, card = C.serviceHtml({ service: { id: 1, name: 'ש', active: false, created_at: '2026-11-01T00:00:00Z' }, settings: { code: 'c', legal_cleared: true, legal_cleared_by: 'yosi@x.test', legal_cleared_at: '2026-11-10T10:00:00Z', legal_note: 'מקור: מכתב' }, engagements: [], similar_services: [] }, (t) => t);
  // the checklist of an engagement (its wording comes from the server) never says "approved legally" as a verified fact
  const chk = C.checklistHtml({ items: [{ key: 'service_cleared', label: 'השירות מאושר משפטית ומתואם לממצא או לתחום', ok: true, blocking: true, enforced: 'server' }, { key: 'agreement_signed', label: 'הסכם חתום', ok: false, blocking: true, enforced: 'database' }], missing: ['agreement_signed'], can_activate: false });
  assert.match(chk, /לשירות יש אישור משפטי מדווח, והוא מתואם לממצא או לתחום/); assert.doesNotMatch(chk, /מאושר משפטית/); assert.match(chk, /הסכם חתום/, 'the other items keep the server wording');
  assert.deepEqual(Object.keys(plain(C.CHECK_LABELS)), ['service_cleared']);
  assert.match(card, /אישור מדווח/); assert.match(card, /דווח על ידי/); assert.match(card, /המערכת אינה מאמתת את האישור/); assert.doesNotMatch(card, /pill[^>]*>אושר</); assert.doesNotMatch(card, />אושר</);
  const none = C.serviceHtml({ service: { id: 2, name: 'ש', active: false, created_at: '2026-11-01T00:00:00Z' }, settings: { code: 'c', legal_cleared: false }, engagements: [], similar_services: [] }, (t) => t); assert.match(none, /לא דווח אישור/); assert.doesNotMatch(none, />לא אושר</);
  assert.ok(CATALOG.includes("clr.id = 'ct-clr'") && CATALOG.includes("if (entity === 'service')"), 'only a service card gets the clearance history');
});

test('engagements, stage 5b-2a: one is made PENDING by ONE request (nothing half-made), only draft and pending ones are edited, and there is no way to pause, retire, withdraw, activate or resume one from here', () => {
  const sec = CODE.slice(CODE.indexOf('var ENGAGEMENT_FIELDS'), CODE.indexOf('function engagementBar') + 700);
  assert.ok(sec.length > 4000 && sec.includes('function submitStep') && sec.includes('function saveEngagement'), 'the engagement section was found');
  assert.doesNotMatch(sec, /\/actions\/(?!submit)|button\('(pause|retire|withdraw|resume|activate)|(pause|retire|withdraw|resume|activate)(Engagement|Step|Only)|confirm: 'activate'/i, 'no route, button or function for pausing, retiring, withdrawing, activating or resuming');
  assert.match(sec, /var EDITABLE_STATES = \['draft', 'pending'\];/);
  // ONE request that ends pending: the creation has no second request, so there is nothing half-made to recover
  const create = sec.slice(sec.indexOf('function createEngagement'), sec.indexOf('function submitStep'));
  assert.ok(create.includes("var body = { provider_id: p, service_id: s, activation: 'pending' };") && create.includes("write(h, ctl, 'POST', '/catalog/engagements', body, {"));
  assert.doesNotMatch(create, /submitStep|seal\(|\/actions\//);
  assert.ok(sec.includes("'/actions/submit', { expected_activation: 'draft' }"), 'the step that remains is for a draft that already exists, and it says which state it saw');
  assert.equal((sec.match(/\/actions\//g) || []).length, 1, 'exactly one engagement action path in the whole section');
  // one attempt per click: the retry button exists only for "the server was busy", and nothing calls the step by itself
  assert.ok(sec.includes("retry = dd.kind === 'busy'")); assert.doesNotMatch(sec, /setTimeout|setInterval/);
  // the buttons of an engagement card: draft gets "update" and "move to pending"; pending gets "update"; the other states get a sentence and no button
  const bar = sec.slice(sec.indexOf('function engagementBar'));
  assert.ok(bar.includes("if (editable) { html += button('edit', 'עדכון מעקב', '');") && bar.includes("if (act === 'draft') { html += button('submit', 'העברה למצב ממתין לאישור');"));
  assert.equal((bar.match(/button\('/g) || []).length, 2, 'two buttons exist in the whole bar');
  for (const [state, sentence] of [['paused', /מושהית/], ['active', /פעילה/], ['retired', /הוצאה משימוש/]]) assert.match(CODE.match(new RegExp(state + ": '([^']*)'", 'g')).join(' '), sentence);
  // the words: not an activation, pending, a reported "signed", where a note is kept
  for (const text of ['ההפעלה אינה זמינה בשלב זה', 'ממתין לאישור', 'רישום ״חתום״ הוא דיווח שלכם', 'המערכת אינה מאמתת', 'נשמרת בכרטיס בלבד, לא ביומן', 'סדר תצוגה בלבד']) assert.ok(sec.includes(text), text);
  // exactly the editable fields of the server, no others (above all not the activation, the price model or the price)
  const defs = /const ENGAGEMENT = \{([\s\S]*?)\n\};/.exec(server('admin-catalog-writes.js'))[1];
  assert.deepEqual([...defs.matchAll(/\b([a-z_]+): \{ type:/g)].map((m) => m[1]).sort(), plain(T.ENGAGEMENT_FIELDS).sort());
  assert.deepEqual(plain(T.EDITABLE_STATES), ['draft', 'pending']);
  // the pickers: pairs that exist and providers in the archive are not offered
  assert.ok(sec.includes("!taken[String(x.id)] && (fromProvider || x.state === 'available')"), 'only available providers are offered (the server refuses the others as well)');
  // the cards: a provider in the archive gets no "new engagement" button, a service and the others get one
  assert.ok(CODE.includes("if (st === 'available') { html += button('engage', 'התקשרות חדשה');") && CODE.includes("html2 += button('engage', 'התקשרות חדשה');"));
  assert.ok(CODE.includes('נותן שירות מושהה: אי אפשר להוסיף לו התקשרות חדשה עד שיחזור לזמינות.') && CODE.includes('לנותן שירות בארכיון אי אפשר להוסיף התקשרות.'), 'a provider that is not available says why there is no button');
});

test('a refused change of state is explained in words, one sentence per reason; the codes of the server are never shown; an engagement that exists and an external id that is taken are answers of their own', () => {
  const R = T.refusalReasons;
  assert.deepEqual(R({ errors: ['not_allowed_from_pending'] }), ['הפעולה אינה מותרת ממצב ״ממתין לאישור״.']);
  assert.deepEqual(R({ errors: ['transition_not_allowed:retired->active'] }), ['המעבר ממצב ״הוצא משימוש״ למצב ״פעיל״ אינו מותר.']);
  assert.deepEqual(R({ errors: ['reason_required', 'checklist_incomplete', 'reason_required'] }), ['חובה לכתוב סיבה.', 'חסרים תנאים להפעלה.']);
  assert.deepEqual(R({ errors: ['active_needs_signed_agreement_and_fixed_price', 'whatever:x'] }), ['ההתקשרות אינה עומדת בכלל מובנה של המערכת.']);
  for (const bad of [undefined, null, {}, { errors: 'x' }, { errors: [] }]) assert.deepEqual(R(bad), [], String(JSON.stringify(bad)));
  const E = (message, status, details, userMessage) => ({ message, status, details, userMessage });
  const d = T.describe(E('transition_refused', 422, { errors: ['not_allowed_from_draft'], missing: [], documented_only: false }, 'SELECT secret'));
  assert.equal(d.kind, 'state'); assert.match(d.message, /המעבר אינו מותר במצב הנוכחי\./); assert.match(d.message, /הפעולה אינה מותרת ממצב ״טיוטה״/); assert.doesNotMatch(JSON.stringify(d), /not_allowed|SELECT|secret/);
  assert.deepEqual(plain(T.describe(E('engagement_exists', 409))), { kind: 'exists', message: 'ההתקשרות כבר קיימת.' });
  const ext = T.describe(E('external_ref_in_use', 409)); assert.deepEqual([ext.kind, ext.field], ['validation', 'external_ref']);
  assert.equal(T.describe(E('duplicate', 409)).field, 'external_ref'); assert.equal(T.describe(E('bad_priority', 400)).field, 'priority'); assert.equal(T.describe(E('bad_contact_state', 400)).field, 'contact_state'); assert.equal(T.describe(E('bad_agreement_state', 400)).field, 'agreement_state'); assert.equal(T.describe(E('bad_terms_note', 400)).field, 'terms_note');
  assert.equal(T.describe(E('provider_or_service_not_found', 404)).kind, 'notfound');
});

test('the answers of the server for an unavailable provider are said in words, and a service that is not ready for activation is marked on the engagement card (a marker only)', () => {
  const E = (message, status) => ({ message, status });
  for (const [code, re] of [['provider_archived', /בארכיון/], ['provider_paused', /מושהה[^]*עד שיחזור לזמינות/], ['bad_activation', /לא נשלח דבר/]]) { const d = T.describe(E(code, code === 'bad_activation' ? 400 : 409)); assert.equal(d.kind, 'state', code); assert.match(d.message, re, code); assert.match(d.message, HEBREW); }
  const N = sandbox.window.KaspchemCatalog._t.serviceNotReady;
  assert.equal(N({}), '', 'an older answer without the field shows nothing'); assert.equal(N({ service_ready: true, service_missing: [] }), '');
  const none = N({ service_ready: false, service_missing: ['settings'] }); assert.match(none, /השירות אינו מוכן להפעלה/); assert.match(none, /אין לשירות הגדרות \(קוד שירות\)/); assert.match(none, /סימון בלבד/); assert.match(none, /ההפעלה אינה זמינה/);
  assert.match(N({ service_ready: false, service_missing: ['matching'] }), /אין תגי ממצאים או תחומי שאלון/); assert.match(N({ service_ready: false, service_missing: ['settings', 'matching'] }), /אין לשירות הגדרות[^]*תגי ממצאים/);
  assert.match(N({ service_ready: false }), /השירות אינו מוכן להפעלה/); assert.doesNotMatch(N({ service_ready: false, service_missing: ['x<b>y'] }), /<b>/, 'an unknown reason is escaped, never markup');
  const card = sandbox.window.KaspchemCatalog._t.engagementHtml({ engagement: { provider_id: 1, service_id: 2, provider_name: 'א', service_name: 'ב', activation: 'pending', contact_state: 'none', agreement_state: 'not_discussed', pricing_model: 'tbd', service_ready: false, service_missing: ['settings'] }, checklist: { items: [], missing: [] }, price_layers: {}, approved_price: null });
  assert.match(card, /השירות אינו מוכן להפעלה/); assert.ok(CATALOG.includes('serviceNotReady(e) +'), 'the card shows it right under the links');
});

test('the tracking of an engagement: only the changed fields are sent with what was seen; the priority is a whole number; "no change" is detected before anything is sent', () => {
  const e = { contact_state: 'none', agreement_state: 'not_discussed', terms_note: null, priority: 100, external_ref: 'TX-01' };
  const F = (over) => T.diffFields(T.ENGAGEMENT_FIELDS, e, Object.assign({ contact_state: 'none', agreement_state: 'not_discussed', terms_note: '', priority: '100', external_ref: 'TX-01' }, over));
  assert.equal(F({}).count, 0, 'null and an empty box, 100 and "100": no change');
  assert.deepEqual(F({ contact_state: 'contacted', priority: '90' }), { changes: { contact_state: 'contacted', priority: 90 }, expected: { contact_state: 'none', priority: 100 }, count: 2 });
  assert.deepEqual(F({ agreement_state: 'signed', terms_note: ' שוחחנו ' }), { changes: { agreement_state: 'signed', terms_note: 'שוחחנו' }, expected: { agreement_state: 'not_discussed', terms_note: null }, count: 2 });
  assert.deepEqual(F({ external_ref: '' }).changes, { external_ref: null }, 'clearing the sheet id sends null'); assert.deepEqual(F({ priority: '0' }).changes, { priority: 0 });
  assert.equal(F({ agreement_state: 'signed' }).changes.activation, undefined, 'the activation is never part of it');
});

test('the history of an engagement says what moved: the fields of an update (what they were -> what they are) and the state of a step, in words, escaped; a note is never shown because it is never in the journal', () => {
  const L = sandbox.window.KaspchemCatalog._t.changeLogHtml;
  const rows = [
    { created_at: '2026-11-11T10:00:00Z', actor: 'y@x.test', action: 'catalog.engagement.update', detail: { fields: ['contact_state', 'agreement_state', 'priority'], from: { contact_state: 'none', agreement_state: 'draft', priority: 100 }, to: { contact_state: 'negotiating', agreement_state: 'signed', priority: 90 } } },
    { created_at: '2026-11-11T09:00:00Z', actor: 'y@x.test', action: 'catalog.engagement.submit', detail: { from: 'draft', to: 'pending' } },
    { created_at: '2026-11-11T08:00:00Z', actor: 'y@x.test', action: 'catalog.engagement.create', detail: {} },
    { created_at: '2026-11-11T07:00:00Z', actor: 'a@x.test', action: 'catalog.engagement.update', detail: { fields: ['external_ref'], from: { external_ref: null }, to: { external_ref: '<b>X</b>' } } }];
  const html = L(rows, false);
  assert.match(html, /מצב קשר: אין קשר ← במשא ומתן/); assert.match(html, /מצב הסכם: טיוטת הסכם ← חתום/); assert.match(html, /עדיפות: 100 ← 90/); assert.match(html, /מצב: טיוטה ← ממתין לאישור/);
  assert.match(html, /מזהה מהגיליון: ריק ← &lt;b&gt;X&lt;\/b&gt;/); assert.doesNotMatch(html, /<b>X/); assert.match(html, /שליחת התקשרות לאישור/); assert.match(html, /יצירת התקשרות/);
  // an update of a provider (only the new value is known) and of a service (what it was and is), with the same machinery
  const p = L([{ created_at: '2026-11-11T10:00:00Z', actor: 'y@x.test', action: 'catalog.provider.update', detail: { fields: ['capacity_open'], to: { capacity_open: 4 } } }], false); assert.match(p, /קיבולת פתוחה: 4/); assert.doesNotMatch(p, /ריק ←/);
  const s = L([{ created_at: '2026-11-11T10:00:00Z', actor: 'y@x.test', action: 'catalog.service.update', detail: { fields: ['active'], from: { active: false }, to: { active: true } } }], false); assert.match(s, /פעיל \(פנימי\): לא ← כן/);
  assert.doesNotMatch(html, /\bundefined\b|\bnull\b|NaN/);
  // the engagement card asks for its history under the id "provider/service", encoded
  assert.ok(CATALOG.includes("loadChangeLog('engagement', d.engagement.provider_id + '/' + d.engagement.service_id)") && CATALOG.includes("tell('engagement', d)"));
});

test('admin.js passes on only codes, messages and fields from a short safe list: no SQL, connection detail, personal detail or raw body reaches the screens', () => {
  const m = /var SAFE_CODE_LISTS[\s\S]*?function apiError\(status, j\) \{[\s\S]*?\n  \}\n/.exec(ADMIN);
  assert.ok(m, 'the helpers are in admin.js');
  const sb = { }; vm.createContext(sb); vm.runInContext(m[0] + '\nthis.apiError = apiError; this.safeDetails = safeDetails;', sb);
  const apiError = (status, j) => { const e = sb.apiError(status, j); return { message: e.message, status: e.status, userMessage: e.userMessage, details: plain(e.details), own: Object.keys(e).sort() }; };
  const keys = (o) => Object.keys(o).sort();
  const e1 = apiError(409, { error: 'conflict', message: 'שונה', sql: 'SELECT 1', stack: 'at x', detail: 'row (a@b.test)', connection: 'postgres://u:p@h/db', email: 'a@b.test', phone: '050', body: { x: 1 }, errors: ['bad_name', 'bad_phone'], missing: ['agreement'], codes: ['a>b'], documented_only: true });
  assert.equal(e1.message, 'conflict'); assert.equal(e1.status, 409); assert.equal(e1.userMessage, 'שונה');
  assert.deepEqual(keys(e1.details), ['codes', 'documented_only', 'errors', 'missing']); assert.deepEqual(e1.details.errors, ['bad_name', 'bad_phone']);
  assert.doesNotMatch(JSON.stringify(e1), /SELECT|at x|a@b\.test|postgres:|050|"x":1/);
  assert.deepEqual(e1.own.filter((k) => !['status', 'userMessage', 'details'].includes(k)), [], 'no other property on the error');
  // lists with anything but short codes are dropped whole; flags only if boolean
  assert.deepEqual(apiError(400, { errors: ['bad name with spaces'] }).details, {}); assert.deepEqual(apiError(400, { errors: ['a@b.test'] }).details, {}); assert.deepEqual(apiError(400, { errors: [{ code: 'x' }] }).details, {});
  assert.deepEqual(apiError(400, { errors: Array.from({ length: 31 }, () => 'a') }).details, {}); assert.deepEqual(apiError(400, { errors: 'bad_name' }).details, {}); assert.deepEqual(apiError(400, { documented_only: 'yes' }).details, {});
  // the code itself: only a short code, otherwise "error"; the message is cut; odd bodies (a page, null, an array, a string) are survived
  assert.equal(apiError(500, { error: 'select * from users' }).message, 'error'); assert.equal(apiError(500, { error: 'x'.repeat(81) }).message, 'error'); assert.equal(apiError(500, { error: 7 }).message, 'error');
  assert.equal(apiError(500, { message: 'x'.repeat(5000) }).userMessage.length, 600); assert.equal(apiError(500, { message: 42 }).userMessage, undefined);
  for (const odd of [null, undefined, [], 'html', 7]) { const e = apiError(502, odd); assert.equal(e.message, 'error'); assert.equal(e.status, 502); assert.deepEqual(e.details, {}); }
  // the request helper uses it, for every failed request
  assert.match(ADMIN, /if \(!r\.ok\) throw apiError\(r\.status, j\);/);
  assert.match(ADMIN, /if \(method !== 'GET'\) h\['X-Kaspchem'\] = '1'; \/\/ CSRF guard checked by the server/);
});

test('the editing buttons are added by the read-only screens only through one small hook, and the read-only file still never sends anything but GET', () => {
  assert.match(CATALOG, /function extend\(e\) \{ EXT = e; \}/); assert.match(CATALOG, /EXT\.afterDraw\(kind, data, hooks\(\)\)/);
  assert.match(CATALOG, /try \{ EXT\.afterDraw[\s\S]*?catch \(x\)/, 'a failure of the editing module never breaks the read-only screens');
  assert.equal((CATALOG.match(/ctx\.api\(/g) || []).length, 1); assert.match(CATALOG, /function get\(path\) \{ return ctx\.api\('GET', path\); \}/);
  assert.doesNotMatch(CATALOG, /ctx\.api\('(POST|PUT|PATCH|DELETE)'/);
  assert.match(CATALOG, /modeLabel\(\) \{ return EXT \? 'צפייה ועריכה' : 'לקריאה בלבד'; \}/, 'the badge tells the truth in both situations');
});
