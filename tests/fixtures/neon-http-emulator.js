'use strict';
// A stand-in for Neon's HTTP endpoint, over the in-memory Postgres (PGlite). It answers the way the real service does for the Neon serverless driver:
//   * a single request {query, params} -> one result; a batch {queries:[...]} -> BEGIN [ISOLATION LEVEL ..] [READ ONLY], every statement, COMMIT, or ROLLBACK on the first error;
//   * values come back as TEXT with the type id (the driver parses them), rows as arrays (Neon-Array-Mode);
//   * a failing statement is HTTP 400 with {message, severity, code, detail, hint, constraint ...} (the driver turns that into a NeonDbError with the SQLSTATE in `code`).
// No network: it is handed to the driver as neonConfig.fetchFunction (through the G2 guard in the tests of scripts/kaspchem-g2.js). What it CANNOT show: real timeouts, real lock waits, a second
// connection, or the exact bytes of the real service; those are what the G2 gate on the temporary branch is for.
const { types } = require('@electric-sql/pglite');
const asText = {}; for (const v of Object.values(types)) if (typeof v === 'number') asText[v] = (x) => x;
const toText = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? '{' + v.map((x) => JSON.stringify(String(x))).join(',') + '}' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v));
const LEVEL = { ReadCommitted: 'READ COMMITTED', RepeatableRead: 'REPEATABLE READ', Serializable: 'SERIALIZABLE' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// opts.leak: an extra text put into every error message (to prove the tool never shows what a driver might echo); opts.onRequest(body, headers): may throw to simulate a failure
function emulator(pg, opts) {
  const o = opts || {}, requests = [];
  async function one(q) {
    const r = await pg.query(q.query, q.params || [], { rowMode: 'array', parsers: asText });
    return { command: String(q.query).trim().split(/\s+/)[0].toUpperCase(), rowCount: r.affectedRows === undefined ? r.rows.length : r.affectedRows, rows: r.rows.map((row) => row.map(toText)), fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })) };
  }
  const failure = (e) => json(400, { message: e.message + (o.leak ? ' ' + o.leak : ''), severity: e.severity || 'ERROR', code: e.code, detail: e.detail, hint: e.hint, constraint: e.constraint, table: e.table, column: e.column });
  async function fetch(url, init) {
    const body = JSON.parse(init.body), h = init.headers || {};
    requests.push({ url: String(url), batch: Array.isArray(body.queries), readOnly: String(h['Neon-Batch-Read-Only']) === 'true', isolation: h['Neon-Batch-Isolation-Level'] || null, statements: (Array.isArray(body.queries) ? body.queries : [body]).map((q) => q.query) });
    if (o.onRequest) await o.onRequest(body, h);
    if (o.respond) { const forced = await o.respond(body, h); if (forced) return forced; }   // a test can make the service answer something it would not (a success where a failure is due, a wrong code)
    if (!Array.isArray(body.queries)) { try { return json(200, await one(body)); } catch (e) { return failure(e); } }
    await pg.exec('BEGIN ISOLATION LEVEL ' + (LEVEL[h['Neon-Batch-Isolation-Level']] || 'READ COMMITTED') + (String(h['Neon-Batch-Read-Only']) === 'true' ? ' READ ONLY' : ''));
    try { const results = []; for (const q of body.queries) results.push(await one(q)); await pg.exec('COMMIT'); return json(200, { results }); } catch (e) { await pg.exec('ROLLBACK').catch(() => {}); return failure(e); }
  }
  return { fetch, requests };
}
module.exports = { emulator, json };
