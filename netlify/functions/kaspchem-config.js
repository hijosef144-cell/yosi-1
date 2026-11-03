'use strict';
const { json, fail, logError } = require('./_kaspchem/http');
const content = require('./_kaspchem/content');
const db = require('./_kaspchem/db');

// Public, read-only. Returns only published questionnaires, public settings, and prices that are BOTH approved and public.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'method_not_allowed');
  if ((event.queryStringParameters || {}).health === '1') { // for the uptime monitor: no data in the answer
    try { if (!db.configured()) return json(503, { ok: false }, { 'Cache-Control': 'no-store' }); await db.query('SELECT 1'); return json(200, { ok: true }, { 'Cache-Control': 'no-store' }); }
    catch (e) { logError('health', e); return json(503, { ok: false }, { 'Cache-Control': 'no-store' }); } // only ok/not ok: no reason, no configuration state
  }
  try {
    let topics = await content.loadTopics();
    let settings = {}, prices = [];
    if (db.configured()) {
      try {
        (await db.query("SELECT key, value FROM settings WHERE key LIKE 'public.%'")).forEach((r) => { settings[r.key.slice(7)] = r.value; });
        prices = await db.query("SELECT p.id, p.label, p.price, s.topic FROM pricing p LEFT JOIN services s ON s.id = p.service_id WHERE p.approved AND p.public AND p.price IS NOT NULL");
      } catch (e) { logError('config', e); }
    }
    // The deep check is served only when switched on (public.deep_enabled === true). Off: the route is not in the answer at all, and neither is the flag.
    // Switched on but not runnable (a part the route requires is not served): the same as off for visitors, nothing about it is revealed.
    let deepOn = settings.deep_enabled === true;
    if (deepOn) { try { const d = await content.loadDeepConfig(); deepOn = !!d && !d.unavailable; } catch (e) { deepOn = false; } }
    if (!deepOn) { topics = topics.filter((t) => t.kind !== 'deep'); delete settings.deep_enabled; }
    return json(200, { ok: true, topics, settings, prices }, { 'Cache-Control': 'public, max-age=60' });
  } catch (e) { logError('config', e); return fail(500, 'server_error'); }
};
