'use strict';
// The error log must never print a secret. The Neon driver puts the WHOLE connection string into the text of its error when the string is not a valid URL, and the shared helper logError used to print
// that text as it was. Everything here uses invented passwords and hosts, and the real driver against a fake fetch (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { logError, cleanForLog } = require('../netlify/functions/_kaspchem/http.js');

const PW = 'LOGTEST-pass-9z8y7x', HOST = 'ep-logtest-424242.c-2.us-east-1.aws.neon.tech';
function captured(fn) { const lines = [], orig = console.error; console.error = (...a) => { lines.push(a.map(String).join(' ')); }; try { fn(); } finally { console.error = orig; } return lines; }
const withEnv = (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; } try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };

test('what was logged before is logged the same: the code if there is one, else a plain label, else "error"; one line, route first', () => {
  assert.deepEqual(captured(() => logError('admin', { code: 'P0001', message: 'snapshot_changed' })), ['[kaspchem] admin P0001']);
  assert.deepEqual(captured(() => logError('config', new Error('db_not_configured'))), ['[kaspchem] config db_not_configured']);
  assert.deepEqual(captured(() => logError('lead', { code: 'EAUTH' })), ['[kaspchem] lead EAUTH']);
  assert.deepEqual(captured(() => logError('x', { code: 503 })), ['[kaspchem] x 503']);
  for (const nothing of [null, undefined, {}, '', { message: '' }, { code: '' }, 0]) assert.deepEqual(captured(() => logError('r', nothing)), ['[kaspchem] r error'], String(nothing));
  assert.equal(cleanForLog('canceling statement due to statement timeout'), 'canceling statement due to statement timeout', 'an ordinary message is left as it is');
});

test('the text of the REAL driver\'s error for a connection string that is not a URL (it contains the whole string) is not logged', async () => {
  const neon = require('@neondatabase/serverless'), cfg = neon.neonConfig, saved = cfg.fetchFunction; let thrown;
  cfg.fetchFunction = async () => { throw new Error('the network must not be touched'); };
  try { await neon.neon('this is not a url ' + PW).query('SELECT 1', []); } catch (e) { thrown = e; } finally { cfg.fetchFunction = saved; }
  assert.ok(thrown && thrown.message.includes(PW), 'the premise: the driver\'s own message really carries the string');
  const lines = captured(() => logError('config', thrown)); assert.equal(lines.length, 1); assert.ok(!lines[0].includes(PW) && !/this is not a url/.test(lines[0]), lines[0]); assert.match(lines[0], /connection string: <redacted>/);
});

test('secrets, links, tokens and addresses are cleaned, wherever they sit in a message, and the password held in the environment is cleaned even when the text is not a URL', () => {
  const url = 'postgresql://kaspchem_app:' + PW + '@' + HOST + '/neondb?sslmode=require';
  for (const msg of ['connect failed ' + url + ' retry', 'Error connecting to database: ' + url, 'password authentication failed for ' + PW, 'x ' + encodeURIComponent(PW) + ' y', 'token npg_AbCdEf123456 here', 'Authorization: Bearer eyJhbGciOi.abc-def_ghi', 'mail someone@gmail.com failed', 'see https://api.example.invalid/sql?key=abc',
    'Database connection string provided to neon() is not a valid URL (connection string: ' + PW + ')']) {
    const out = withEnv({ KASPCHEM_DATABASE_URL: url }, () => captured(() => logError('r', new Error(msg)))[0]);
    assert.ok(!out.includes(PW) && !out.includes(HOST) && !/npg_|eyJhbGci|someone@|api\.example|key=abc|postgres(ql)?:\/\//i.test(out), msg.slice(0, 40) + ' -> ' + out);
  }
  // a plain secret from the environment (a mail password, a token) is cleaned from any message
  const out = withEnv({ GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', SOME_API_TOKEN: 'tok-123456-zzz' }, () => cleanForLog('smtp said abcd efgh ijkl mnop and tok-123456-zzz'));
  assert.equal(out, 'smtp said <secret> and <secret>');
  // a short or unrelated variable never turns an ordinary word into "<secret>"
  assert.equal(withEnv({ NODE_ENV: 'production', MY_TOKEN: 'abc' }, () => cleanForLog('production abc ok')), 'production abc ok');
});

test('a log line stays ONE short line: no forged second line, no control characters, at most 200 characters', () => {
  const lines = captured(() => logError('r', new Error('first\n[kaspchem] admin forged line\r\n\tand more')));
  assert.equal(lines.length, 1); assert.ok(!/[\r\n\t]/.test(lines[0])); assert.equal(lines[0], '[kaspchem] r first [kaspchem] admin forged line and more');
  assert.equal(cleanForLog('x'.repeat(5000)).length, 200);
});
