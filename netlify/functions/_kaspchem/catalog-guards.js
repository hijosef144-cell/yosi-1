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

// The older routes that WRITE services and professionals (admin-router.js) are closed while the catalog is open: the catalog is then the one place that changes them, with its own checks.
// Exactly the same test as the gate (the switch must be exactly JSON true) and the same answer when the switch cannot be read: closed for writing, never open by accident.
// While the switch is closed or absent this function does nothing but read it: the older routes behave exactly as they always did.
async function refuseOldWrite() {
  let open;
  try { open = await isOpen(); } catch (e) { logError('catalog.switch', e); throw new HttpError(503, 'catalog_unavailable'); }
  if (open) throw new HttpError(409, 'managed_in_catalog', 'הנתון הזה מנוהל עכשיו בקטלוג הספקים ואי אפשר לשנות אותו מכאן.');
}

// THE WINDOW OF OPENING THE SWITCH. refuseOldWrite() looks at the switch once, before the older route starts; an older write that passed that look a moment before the owner opened the catalog could still land after the catalog
// started to write the same rows. The older statements therefore carry this condition INSIDE their own SQL: it reads the switch row with FOR SHARE, so (1) the owner's UPDATE that opens the catalog WAITS for every older write in flight
// and no older write can commit after the opening, and (2) a statement that starts after the opening reads "open" and changes nothing. It needs the switch row to exist (created closed, by the owner, before the first opening);
// while the row does not exist the condition is true and the older routes behave exactly as they always did.
const OLD_WRITE_CLOSED = "NOT COALESCE((SELECT value = 'true'::jsonb FROM settings WHERE key = '" + SWITCH_KEY + "' FOR SHARE), false)";

// The two catalog switches change only by a separate decision of the owners, never through the general settings route. The whole namespace "private.catalog_" is kept for the catalog, and the check
// looks at the WHOLE request body (the key, the value, any other field, any nesting), so a request that mentions a switch anywhere, alone or together with other settings, is refused before anything is
// saved. It does not look at the switch itself, so it works while the catalog is closed.
const SWITCH_NAMESPACE = /private\.catalog_/i;
function touchesSwitch(body) { try { return SWITCH_NAMESPACE.test(JSON.stringify(body)); } catch (e) { return true; } }   // a body that cannot even be written out is refused too

module.exports = { gate, requireOwner, isOpen, activationOpen, assertNoSecrets, refuseOldWrite, touchesSwitch, OLD_WRITE_CLOSED, SWITCH_KEY, ACTIVATION_KEY };
