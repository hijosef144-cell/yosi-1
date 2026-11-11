'use strict';
// "Do not bypass or change what exists": the server files that decide who may do what, and everything the public site runs, are byte-identical (line-ending style aside) to the version that
// went live (the launch merge 9797346), except exactly three files (admin-router.js, db.js and, for the log only, http.js), and in those only the places named here. A change to any of them, on purpose, must update the pin in the same commit.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const norm = (b) => b.toString('utf8').split('\r\n').join('\n');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (f) => norm(fs.readFileSync(path.join(ROOT, f)));

const IDENTICAL = {
  'kaspchem/assets/engine.js': '98c7330dac2d24c2', 'netlify.toml': 'aa15a4ded5fea38d',
  'netlify/functions/_kaspchem/admin-entry.js': '6fcac9a291a5ba53', 'netlify/functions/_kaspchem/auth.js': 'ac744f1d0dc81193', 'netlify/functions/_kaspchem/content.js': '847d6dcd0e23412d',   // http.js is not here: it has its own test below (exactly one function changed, on purpose)
  'netlify/functions/_kaspchem/impact.js': '6e72a820f7440b68', 'netlify/functions/_kaspchem/ops-alert.js': 'd5784b3bb3596db4', 'netlify/functions/_kaspchem/validate.js': '3262d3021cce1315',
  'netlify/functions/kaspchem-admin.mjs': '7da5363373286015', 'netlify/functions/kaspchem-config.js': 'aaacf32b448772cc', 'netlify/functions/kaspchem-impact.js': 'bdb8cf9a179b116b', 'netlify/functions/kaspchem-lead.js': '2bdaab845876fbde', 'netlify/functions/send-results.js': 'b254c4664be5303d',
};

test('authentication, the allow-list, the public configuration, the lead and impact functions, the questionnaires, the alerts and the Netlify settings are exactly as they went live', () => {
  for (const [f, pin] of Object.entries(IDENTICAL)) assert.equal(sha(read(f)), pin, f + ' changed: if that is on purpose, the pin and the review belong in the same commit');
});

// The older PATCH /pricing/:id as it went live (P1, owner-approved, replaces it with the guarded version below): the test puts it back in place of the guarded block before comparing everything else.
const PRICING_LIVE = ["on('PATCH', '/pricing/(\\\\d+)', async (c, id) => {", '  await assertCompensationAllowed(c.body);', "  await db.query('UPDATE pricing SET service_id=$1, professional_id=$2, label=$3, price=$4, cost=$5, commission=$6, notes=$7, approved=false, approved_by=NULL, approved_at=NULL, public=false WHERE id=$8',",
  '    priceFields(c.body).concat([idOf(id)]));', "  await audit(c.me.email, 'pricing.update', 'pricing', id, {});", '  return { ok: true };', '});'].join('\n');
test('admin-router.js differs from the live version in exactly these places: the catalog hook, the service-guard require, the PATCH /services handler (the owner-approved block), the PATCH /pricing handler (P1, the owner-approved guard) and the catalog lock (the list of older write routes, the check before them, the refusal of the catalog switches at the start of the settings route)', () => {
  let src = read('netlify/functions/_kaspchem/admin-router.js');
  const p1s = src.indexOf('// P1: a price that the provider catalog links'), p1h = src.indexOf("on('PATCH', '/pricing/(\\\\d+)'", p1s), p1e = src.indexOf('\n});\n', p1h) + 5;
  assert.ok(p1s > 0 && p1h > p1s && p1e > p1h, 'the P1 block is there, once'); assert.equal(src.indexOf('// P1: a price that the provider catalog links', p1s + 1), -1);
  const p1 = src.slice(p1s, p1e); src = src.slice(0, p1s) + PRICING_LIVE + '\n' + src.slice(p1e);
  assert.match(p1, /priceGuard\.catalogTablesExist\(\)/); assert.match(p1, /' AND NOT ' \+ priceGuard\.ACTIVE_LINK : ''\) \+ ' RETURNING id'/); assert.match(p1, /throw new HttpError\(409, 'price_linked_to_active_engagement', priceGuard\.LINKED_TO_ACTIVE\)/);
  assert.ok(p1.indexOf('throw new HttpError(409') < p1.indexOf("await audit(c.me.email, 'pricing.update'"), 'the journal row only after a change'); assert.equal((p1.match(/db\.query\(/g) || []).length, 2, 'the UPDATE, and one read (is the price linked to a working engagement); whether the catalog exists is read in catalog-price-guard.js');
  assert.equal(sha(p1), '3a986770616537c6', 'the guarded handler is pinned: a change to it, on purpose, updates this pin and its review');
  let lines = src.split('\n');
  const catalogLines = lines.filter((l) => /catalog/.test(l)).map((l) => l.trim().replace(/\s*\/\/.*$/, ''));
  assert.deepEqual(catalogLines, ["const catalog = require('./admin-catalog-router');", "const catalogOwnedWrites = [['POST', /^\\/services$/], ['PATCH', /^\\/services\\/\\d+$/], ['POST', /^\\/professionals$/], ['PATCH', /^\\/professionals\\/\\d+$/]];", "const priceGuard = require('./catalog-price-guard');", "if (catalog.touchesSwitch(c.body)) throw new HttpError(400, 'use_catalog_switch', 'מתגי הקטלוג משתנים רק בהחלטה נפרדת של הבעלים, לא מכאן.');", "if (catalog.isCatalogPath(path)) return await catalog.handle(event, me, path);", "if (catalogOwnedWrites.some(([om, ore]) => om === method && ore.test(path.replace(/\\/$/, '') || '/'))) await catalog.refuseOldWrite();"]);
  lines = lines.filter((l) => !/catalog/.test(l) && !/serviceGuard\s*=\s*require/.test(l));
  const a = lines.findIndex((l) => l.startsWith("on('PATCH', '/services/(\\\\d+)'")); assert.ok(a > 0); let b = a; while (lines[b] !== '});') b++;
  const handler = lines.splice(a, b - a + 1).join('\n');
  assert.equal(sha(lines.join('\n')), 'a49f772a5a8dcb3d', 'everything else in the existing admin router is as it went live');
  assert.match(handler, /serviceGuard\.allowsChange\(/); assert.match(handler, /serviceGuard\.isBlocked\(/); assert.match(handler, /throw new HttpError\(409, 'service_has_public_price'/);
  assert.equal((handler.match(/db\.query\(/g) || []).length, 1, 'one UPDATE, through the same layer as before; the follow-up read is inside the guard and the audit row goes through the existing audit()');
  assert.match(handler, /await audit\(c\.me\.email, 'service\.update', 'service', id, \{\}\);/); assert.match(handler, /return \{ ok: true \};/);
});

// The only change to a live helper made for G2 (owner instruction): the error log no longer prints the text of a driver error as it is, because that text can hold the connection string.
// The original function is put back below, verbatim, in place of the marked block; the result must be byte-identical to the live http.js.
const HTTP_LIVE_LOGERROR = "// Never log request bodies or personal fields; log only code + route.\nfunction logError(route, err) {\n  console.error('[kaspchem]', route, err && (err.code || err.message) ? (err.code || err.message) : 'error');\n}\n";
test('http.js differs from the live version only in logError (the log hygiene block): put the original function back and the file is byte-identical to the one that went live', () => {
  const src = read('netlify/functions/_kaspchem/http.js'), start = src.indexOf('// >>> M1 log hygiene'), endMarker = '// <<< M1 log hygiene\n', end = src.indexOf(endMarker);
  assert.ok(start > 0 && end > start, 'the block is there, once'); assert.equal(src.indexOf('// >>> M1 log hygiene', start + 1), -1);
  const live = src.slice(0, start) + HTTP_LIVE_LOGERROR + src.slice(end + endMarker.length).replace(', logError, cleanForLog };', ', logError };');
  assert.equal(sha(live), '9077cf8b68724bc0', 'everything outside the log hygiene block is exactly as it went live');
  const block = src.slice(start, end);
  assert.ok(!/require\(|process\.exit|fetch\(|fs\./.test(block), 'the block loads nothing, sends nothing and writes nothing'); assert.equal((block.match(/console\.error\(/g) || []).length, 1, 'one log call, as before');
});

test('db.js: what existed in production (setDriver, query, configured) is unchanged; the rest is new and additive', () => {
  const src = read('netlify/functions/_kaspchem/db.js');
  const part = (start, end) => src.slice(src.indexOf(start), end === null ? src.indexOf('\n', src.indexOf(start)) : src.indexOf(end, src.indexOf(start)) + end.length);
  assert.equal(sha(part('function setDriver', null)), '4635ab4dfc1f5f52'); assert.equal(sha(part('async function query', '\n}\n')), '23e4df3fbb807afa'); assert.equal(sha(part('const configured', null)), 'c3ad7f67de502d3f');
});
