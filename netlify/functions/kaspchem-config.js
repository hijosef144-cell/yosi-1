'use strict';
const { json, fail, logError } = require('./_kaspchem/http');
const content = require('./_kaspchem/content');
const db = require('./_kaspchem/db');

// Public, read-only. Returns only published questionnaires, public settings, and prices that are BOTH approved and public.
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return fail(405, 'method_not_allowed');
  try {
    const topics = await content.loadTopics();
    let settings = {}, prices = [];
    if (db.configured()) {
      try {
        (await db.query("SELECT key, value FROM settings WHERE key LIKE 'public.%'")).forEach((r) => { settings[r.key.slice(7)] = r.value; });
        prices = await db.query("SELECT p.id, p.label, p.price, s.topic FROM pricing p LEFT JOIN services s ON s.id = p.service_id WHERE p.approved AND p.public AND p.price IS NOT NULL");
      } catch (e) { logError('config', e); }
    }
    return json(200, { ok: true, topics, settings, prices }, { 'Cache-Control': 'public, max-age=60' });
  } catch (e) { logError('config', e); return fail(500, 'server_error'); }
};
