'use strict';
// Catalog server, access control (stage 4a). Runs for EVERY catalog request, before routing and before any catalog data is read.
//   1. who: the caller was already authenticated by Netlify Identity and checked against the allow-list of administrators (admin-entry.js, unchanged). Here the catalog adds the OWNER role:
//      every administrator on the existing list is an owner (both owners are equal); a caller that carries another role is refused. No new list, no new environment variable.
//   2. the switch: the setting `private.catalog_enabled` must be exactly JSON true. Missing, false, a string, a number, anything else: closed. If the setting cannot be read the catalog
//      stays closed (503), never open. The switch is read on every request (no cache), so closing it takes effect immediately.
const db = require('./db');
const { HttpError, logError } = require('./http');

const SWITCH_KEY = 'private.catalog_enabled';

function requireOwner(me) {
  if (!me || !me.email) throw new HttpError(401, 'unauthenticated');
  if (me.role !== undefined && me.role !== 'owner') throw new HttpError(403, 'forbidden');
  return me;
}

async function isOpen() {
  const rows = await db.query('SELECT value FROM settings WHERE key = $1', [SWITCH_KEY]);
  return rows.length === 1 && rows[0].value === true;
}

// The second switch (stage 4b): `private.catalog_activation_enabled`. Closed unless exactly JSON true, like the first, and it is closed by default. While it is closed no engagement can become
// active (or return to active), whatever else is true. The write itself repeats this check inside its own SQL statement, so a switch closed a moment ago cannot be overtaken.
const ACTIVATION_KEY = 'private.catalog_activation_enabled';
async function activationOpen() {
  const rows = await db.query('SELECT value FROM settings WHERE key = $1', [ACTIVATION_KEY]);
  return rows.length === 1 && rows[0].value === true;
}

// Resolves when the caller may use the catalog; otherwise throws the HttpError that is sent back. Nothing about the catalog is revealed while it is closed (same answer for every path).
async function gate(me) {
  requireOwner(me);
  let open;
  try { open = await isOpen(); } catch (e) { logError('catalog.switch', e); throw new HttpError(503, 'catalog_unavailable'); }
  if (!open) throw new HttpError(403, 'catalog_disabled');
}

// A last line of defence on every answer: no key that could carry commission, compensation, cost, a payer, a credential or a token may appear anywhere in a catalog response, however it
// got there. Such an answer is replaced by a plain server error (the code, never the content, is logged).
const SECRET_KEY = /commission|compensation|payer|(^|_)cost($|_)|password|secret|token|authorization|connection/i;
function assertNoSecrets(value, depth) {
  const d = depth || 0;
  if (d > 10) throw new Error('response_too_deep');
  if (Array.isArray(value)) { value.forEach((x) => assertNoSecrets(x, d + 1)); return; }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const k of Object.keys(value)) { if (SECRET_KEY.test(k)) throw new Error('secret_in_response'); assertNoSecrets(value[k], d + 1); }
  }
}

module.exports = { gate, requireOwner, isOpen, activationOpen, assertNoSecrets, SWITCH_KEY, ACTIVATION_KEY };
