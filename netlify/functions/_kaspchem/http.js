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

// Never log request bodies or personal fields; log only code + route.
function logError(route, err) {
  console.error('[kaspchem]', route, err && (err.code || err.message) ? (err.code || err.message) : 'error');
}

module.exports = { json, fail, HttpError, parseBody, header, sameOrigin, clientIp, logError };
