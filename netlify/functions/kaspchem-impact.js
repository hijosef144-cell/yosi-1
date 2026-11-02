'use strict';
const { json, fail, logError } = require('./_kaspchem/http');
const db = require('./_kaspchem/db');
const impact = require('./_kaspchem/impact');

// Public, read-only. Returns ONLY aggregates (an amount per kind, the number of families helped, the number with an active ongoing saving,
// and when it was computed). Never a combined total, never a name, a request number or a single record.
// Nothing is returned unless the owners switched the counter on (settings key public.counter_enabled, default off) AND, if opening data exists,
// approved it. Any problem answers with a minimal failure and no detail; the page then simply shows nothing.
// Never cached (not at the edge, not in the browser): the owners' on/off switch and the approval must take effect for the very next visitor.
// The answer is a few small queries; it is computed on every request and carries the time it was computed.
const NO_STORE = { 'Cache-Control': 'no-store' };
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'method_not_allowed');
  try {
    if (!db.configured()) return json(503, { ok: false }, NO_STORE);
    const out = await impact.publicSummary(new Date());
    if (!out.enabled) return json(200, { ok: true, enabled: false }, NO_STORE);
    return json(200, { ok: true, enabled: true, amounts: out.amounts, families_helped: out.families_helped, active_now: out.active_now, as_of: out.as_of }, NO_STORE);
  } catch (e) {
    logError('impact', { code: (e && e.code) || 'error' }); // route + code only: never the message (it can carry connection details)
    return json(503, { ok: false }, NO_STORE); // no reason, no detail
  }
};
