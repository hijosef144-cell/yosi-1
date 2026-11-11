'use strict';
// Unit tests for netlify/functions/send-guide.js with a fake mail transport: nothing is sent and no network is used.
// Run: node --test tests/send-guide.test.js
const test = require('node:test');
const assert = require('node:assert');
const fn = require('../netlify/functions/send-guide.js');

const OK_ORIGIN = 'https://matzpenkalkali.com';
process.env.GMAIL_USER = 'owner@example.test'; process.env.GMAIL_APP_PASSWORD = 'x';

let sent;
function setup(opts) {
  sent = [];
  fn.__test.reset();
  fn.__test.setTransport(() => ({ sendMail: async (m) => { if (opts && opts.fail) throw Object.assign(new Error('smtp down'), { code: 'ECONN' }); sent.push(m); } }));
  global.fetch = async () => (opts && opts.noPdf ? { ok: false, headers: { get: () => '' } } : { ok: true, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer });
}
const call = (body, headers) => fn.handler({ httpMethod: 'POST', headers: Object.assign({ origin: OK_ORIGIN, 'x-nf-client-connection-ip': '1.2.3.4' }, headers || {}), body: JSON.stringify(body) });
const good = { userEmail: 'person@example.com', slug: 'buy-money-fund-pagi', consent: true };

test('a valid request sends the guide with the PDF attached to the visitor, and notifies the owner', async () => {
  setup();
  const r = await call(good);
  assert.equal(r.statusCode, 200); assert.deepEqual(JSON.parse(r.body), { ok: true, attached: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'person@example.com'); assert.equal(sent[0].attachments.length, 1); assert.equal(sent[0].attachments[0].filename, 'buy-money-fund-pagi.pdf');
  assert.match(sent[0].html, /knowledge\/guides\/buy-money-fund-pagi\//);
  assert.equal(sent[1].to, 'owner@example.test');
});

test('all four guides are accepted; any other slug is refused', async () => {
  setup();
  for (const s of ['buy-money-fund-pagi', 'buy-money-fund-poalim', 'sell-money-fund-pagi', 'standing-order-money-fund-poalim']) { fn.__test.reset(); assert.equal((await call(Object.assign({}, good, { slug: s }))).statusCode, 200, s); }
  for (const s of ['../etc/passwd', 'unknown', '', 'buy-money-fund-pagi/../x']) assert.equal((await call(Object.assign({}, good, { slug: s }))).statusCode, 400, s);
});

test('refused: wrong or missing origin, wrong method, bad JSON, bad email, no consent', async () => {
  setup();
  assert.equal((await call(good, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await call(good, { origin: undefined })).statusCode, 403);
  assert.equal((await fn.handler({ httpMethod: 'GET', headers: { origin: OK_ORIGIN } })).statusCode, 405);
  assert.equal((await fn.handler({ httpMethod: 'POST', headers: { origin: OK_ORIGIN }, body: '{' })).statusCode, 400);
  for (const e of ['', 'nope', 'a@b', 'a b@c.com', 'a@b.com\nBcc: x@y.com', '"x"@y.com', 'a@b.c', 'x'.repeat(250) + '@y.com']) { fn.__test.reset(); assert.equal((await call(Object.assign({}, good, { userEmail: e }))).statusCode, 400, JSON.stringify(e)); }
  assert.equal((await call(Object.assign({}, good, { consent: false }))).statusCode, 400);
  assert.equal(sent.length, 0, 'nothing may be sent for a refused request');
});

test('the Netlify preview origin of this site is accepted; a look-alike is not', async () => {
  setup();
  assert.equal((await call(good, { origin: 'https://deploy-preview-4--matzpenkalkali.netlify.app' })).statusCode, 200);
  assert.equal((await call(good, { origin: 'https://deploy-preview-4--matzpenkalkali.netlify.app.evil.example' })).statusCode, 403);
  assert.equal((await call(good, { origin: 'https://matzpenkalkali.com.evil.example' })).statusCode, 403);
});

test('honeypot: a filled hidden field looks successful but sends nothing', async () => {
  setup();
  const r = await call(Object.assign({}, good, { website: 'http://spam' }));
  assert.equal(r.statusCode, 200); assert.equal(sent.length, 0);
});

test('throttling: a fourth request for the same address, and a seventh from the same IP, are refused', async () => {
  setup();
  for (let i = 0; i < 3; i++) assert.equal((await call(good)).statusCode, 200);
  assert.equal((await call(good)).statusCode, 429);
  setup();
  for (let i = 0; i < 6; i++) assert.equal((await call(Object.assign({}, good, { userEmail: 'p' + i + '@example.com' }))).statusCode, 200);
  assert.equal((await call(Object.assign({}, good, { userEmail: 'p9@example.com' }))).statusCode, 429);
});

test('if the PDF cannot be fetched the visitor still gets a link, honestly marked as not attached', async () => {
  setup({ noPdf: true });
  const r = await call(good);
  assert.deepEqual(JSON.parse(r.body), { ok: true, attached: false });
  assert.equal(sent[0].attachments.length, 0); assert.match(sent[0].html, /לא הצלחנו לצרף/);
});

test('a mail failure returns a generic error and leaks nothing', async () => {
  setup({ fail: true });
  const r = await call(good);
  assert.equal(r.statusCode, 500); assert.deepEqual(JSON.parse(r.body), { ok: false, error: 'send_failed' });
});

test('the owner notification escapes what the visitor typed', async () => {
  setup();
  await call(Object.assign({}, good, { userEmail: 'a<b>@example.com' }));
  assert.equal(sent.length, 0, 'an address with angle brackets is refused outright');
  setup();
  await call(Object.assign({}, good, { userEmail: "o'brien+x@example.com" }));
  assert.match(sent[1].html, /o&#39;brien\+x@example\.com/);
});
