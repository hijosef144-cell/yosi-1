'use strict';
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

const json = (status, body, extra) => ({ statusCode: status, headers: Object.assign({}, HEADERS, extra || {}), body: JSON.stringify(body) });
const fail = (status, code, message) => json(status, { ok: false, error: code, message: message || undefined });

class HttpError extends Error {
  constructor(status, code, message) { super(code); this.status = status; this.code = code; this.userMessage = message; }
}

function parseBody(event, maxBytes) {
  const raw = event.body || '';
  if (Buffer.byteLength(raw, event.isBase64Encoded ? 'base64' : 'utf8') > (maxBytes || 32768)) throw new HttpError(413, 'too_large');
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new HttpError(400, 'bad_json'); }
}

function header(event, name) {
  const h = event.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

// Same-origin only: browsers always send Origin on cross-site POSTs.
function sameOrigin(event) {
  const origin = header(event, 'origin');
  if (!origin) return true;
  const host = header(event, 'x-forwarded-host') || header(event, 'host');
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

function clientIp(event) {
  return header(event, 'x-nf-client-connection-ip') || (header(event, 'x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// >>> M1 log hygiene: the only change to this file. tests/production-files-pinned.test.js puts the original three lines of logError back and checks that everything else is byte-identical to the live version.
// Never log request bodies or personal fields; log only code + route. What is logged is also CLEANED first: the text of a driver error can carry the connection string (the Neon driver puts the
// WHOLE string into its message when it is not a valid URL), and a log line must never hold a secret, an address, a link or a second line.
const SECRET_ENV = /(?:DATABASE_URL|POSTGRES_URL|_PASSWORD|_SECRET|_TOKEN)$/i;
function cleanForLog(value) {
  let s = String(value);
  for (const [k, v] of Object.entries(process.env)) {   // the secrets this process holds, wherever they appear in a message, and the password inside a connection string
    if (!SECRET_ENV.test(k) || typeof v !== 'string' || v.length < 6) continue;
    s = s.split(v).join('<secret>');
    try { const pw = decodeURIComponent(new URL(v).password); if (pw.length >= 4) s = s.split(pw).join('<secret>'); } catch (e) { /* not a URL */ }
  }
  return s.replace(/\bconnection string:[\s\S]*$/i, 'connection string: <redacted>').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\bnpg_[A-Za-z0-9_]{6,}/g, '<token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <token>').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function logError(route, err) {
  console.error('[kaspchem]', route, err && (err.code || err.message) ? cleanForLog(err.code || err.message) : 'error');
}
// <<< M1 log hygiene

module.exports = { json, fail, HttpError, parseBody, header, sameOrigin, clientIp, logError, cleanForLog };
