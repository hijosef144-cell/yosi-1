'use strict';
// "Do not bypass or change what exists": the server files that decide who may do what, and everything the public site runs, are byte-identical (line-ending style aside) to the version that
// went live (the launch merge 9797346), except exactly two files, and in those only the places named here. A change to any of them, on purpose, must update the pin in the same commit.
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
  'netlify/functions/_kaspchem/admin-entry.js': '6fcac9a291a5ba53', 'netlify/functions/_kaspchem/auth.js': 'ac744f1d0dc81193', 'netlify/functions/_kaspchem/content.js': '847d6dcd0e23412d', 'netlify/functions/_kaspchem/http.js': '9077cf8b68724bc0',
  'netlify/functions/_kaspchem/impact.js': '6e72a820f7440b68', 'netlify/functions/_kaspchem/ops-alert.js': 'd5784b3bb3596db4', 'netlify/functions/_kaspchem/validate.js': '3262d3021cce1315',
  'netlify/functions/kaspchem-admin.mjs': '7da5363373286015', 'netlify/functions/kaspchem-config.js': 'aaacf32b448772cc', 'netlify/functions/kaspchem-impact.js': 'bdb8cf9a179b116b', 'netlify/functions/kaspchem-lead.js': '2bdaab845876fbde', 'netlify/functions/send-results.js': 'b254c4664be5303d',
};

test('authentication, the allow-list, the public configuration, the lead and impact functions, the questionnaires, the alerts and the Netlify settings are exactly as they went live', () => {
  for (const [f, pin] of Object.entries(IDENTICAL)) assert.equal(sha(read(f)), pin, f + ' changed: if that is on purpose, the pin and the review belong in the same commit');
});

test('admin-router.js differs from the live version in exactly three places: the catalog hook, the service-guard require, and the PATCH /services handler (the owner-approved block)', () => {
  let lines = read('netlify/functions/_kaspchem/admin-router.js').split('\n');
  const catalogLines = lines.filter((l) => /catalog/.test(l)).map((l) => l.trim().replace(/\s*\/\/.*$/, ''));
  assert.deepEqual(catalogLines, ["const catalog = require('./admin-catalog-router');", 'if (catalog.isCatalogPath(path)) return await catalog.handle(event, me, path);']);
  lines = lines.filter((l) => !/catalog/.test(l) && !/serviceGuard\s*=\s*require/.test(l));
  const a = lines.findIndex((l) => l.startsWith("on('PATCH', '/services/(\\\\d+)'")); assert.ok(a > 0); let b = a; while (lines[b] !== '});') b++;
  const handler = lines.splice(a, b - a + 1).join('\n');
  assert.equal(sha(lines.join('\n')), 'a49f772a5a8dcb3d', 'everything else in the existing admin router is as it went live');
  assert.match(handler, /serviceGuard\.allowsChange\(/); assert.match(handler, /serviceGuard\.isBlocked\(/); assert.match(handler, /throw new HttpError\(409, 'service_has_public_price'/);
  assert.equal((handler.match(/db\.query\(/g) || []).length, 1, 'one UPDATE, through the same layer as before; the follow-up read is inside the guard and the audit row goes through the existing audit()');
  assert.match(handler, /await audit\(c\.me\.email, 'service\.update', 'service', id, \{\}\);/); assert.match(handler, /return \{ ok: true \};/);
});

test('db.js: what existed in production (setDriver, query, configured) is unchanged; the rest is new and additive', () => {
  const src = read('netlify/functions/_kaspchem/db.js');
  const part = (start, end) => src.slice(src.indexOf(start), end === null ? src.indexOf('\n', src.indexOf(start)) : src.indexOf(end, src.indexOf(start)) + end.length);
  assert.equal(sha(part('function setDriver', null)), '4635ab4dfc1f5f52'); assert.equal(sha(part('async function query', '\n}\n')), '23e4df3fbb807afa'); assert.equal(sha(part('const configured', null)), 'c3ad7f67de502d3f');
});
