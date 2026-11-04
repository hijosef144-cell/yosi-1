// A stand-in for the CRM that implements only the waitlist contract, for front-end tests.
// Modes are switched with POST /__mode {"mode": "ok|server_error|slow|hold|abort|mismatch|bad_email|rate|verify"}.
const http = require('http');
let mode = 'ok';
let log = [];
let held = []; // responses waiting for /__release (mode 'hold')
const seen = new Set();
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
function send(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); }
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.url === '/__health') return send(res, 200, { ok: true });
  if (req.url === '/__log') return send(res, 200, log);
  let raw = '';
  req.on('data', d => raw += d);
  req.on('end', () => {
    if (req.url === '/__mode') { mode = JSON.parse(raw).mode; return send(res, 200, { mode }); }
    if (req.url === '/__reset') { log = []; seen.clear(); mode = 'ok'; held.forEach(f => f()); held = []; return send(res, 200, { ok: true }); }
    if (req.url === '/__release') { const n = held.length; held.forEach(f => f()); held = []; return send(res, 200, { released: n }); }
    if (req.url === '/__held') return send(res, 200, { held: held.length });
    if (req.url === '/api/email/initiative-waitlist' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(raw); } catch (e) {}
      log.push({ body, ts: Date.now(), origin: req.headers.origin || null });
      const reply = () => {
        if (mode === 'abort') return req.socket.destroy();
        if (mode === 'server_error') return send(res, 500, { error: 'server error' });
        if (mode === 'mismatch') return send(res, 400, { error: 'consent_mismatch' });
        if (mode === 'bad_email') return send(res, 400, { error: 'invalid_email' });
        if (mode === 'rate') return send(res, 429, { error: 'too many' });
        if (mode === 'verify') return send(res, 201, { ok: true, status: 'verification_sent' });
        if (!body.consent) return send(res, 400, { error: 'consent_required' });
        seen.add(String(body.email || '').toLowerCase());
        return send(res, 201, { ok: true, status: 'registered' }); // duplicates look identical
      };
      if (mode === 'slow') return setTimeout(reply, 1500);
      if (mode === 'hold') { held.push(() => { mode = 'ok'; reply(); }); return; }  // answered only when the test says so
      return reply();
    }
    send(res, 404, { error: 'not found' });
  });
}).listen(Number(process.env.PORT) || 4191, '127.0.0.1', () => console.log('fake crm on ' + (process.env.PORT || 4191)));
