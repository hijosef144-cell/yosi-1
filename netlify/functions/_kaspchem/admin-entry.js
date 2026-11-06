'use strict';
// Shared by the Netlify v2 function (real Identity getUser) and the local test server (fake getUser).
const { authorizeAdmin } = require('./auth');
const { handle } = require('./admin-router');
const { HttpError, fail, sameOrigin } = require('./http');
const { opsAlert } = require('./ops-alert');

async function run(req, getUser) {
  try {
    const url = new URL(req.url);
    const headers = Object.fromEntries(req.headers);
    if (!headers.host) headers.host = url.host;

    // Cookie-based session ⇒ protect state-changing calls from cross-site requests: same origin + a custom header browsers won't send cross-site.
    if (req.method !== 'GET') {
      if (!sameOrigin({ headers }) || headers['x-kaspchem'] !== '1') throw new HttpError(403, 'csrf');
    }

    const user = await getUser();
    let me;
    try { me = authorizeAdmin(user && { email: user.email, roles: user.roles || [] }); }
    catch (e) { if (user && e instanceof HttpError && e.status === 403) await opsAlert('ניסיון כניסה של משתמש לא מורשה', 'משתמש מחובר ל־Identity שאינו ברשימת המנהלים ניסה לפתוח את הדשבורד. אם זה לא צפוי, בדקו את רשימת המשתמשים ב־Netlify Identity.'); throw e; }

    const event = {
      httpMethod: req.method, path: url.pathname, headers,
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: req.method === 'GET' ? '' : await req.text(), isBase64Encoded: false
    };
    const out = await handle(event, me);
    return new Response(out.body, { status: out.statusCode, headers: out.headers });
  } catch (e) {
    const out = e instanceof HttpError ? fail(e.status, e.code) : fail(500, 'server_error');
    return new Response(out.body, { status: out.statusCode, headers: out.headers });
  }
}

module.exports = { run };
