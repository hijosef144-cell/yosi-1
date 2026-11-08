'use strict';
// Catalog server, WRITE side, low level (stage 4b): turns what the application decided into ONE transaction and runs it. It decides nothing itself.
//   * Every write is a single batch for the Neon HTTP driver (sql.transaction): the statements run between BEGIN and COMMIT in one request. The change and its audit row are in the same batch,
//     so there is never a change without its record, nor a record without its change. Any failing statement rolls the whole batch back (tests inject a failure at EVERY position).
//   * An import is the strict case. Its batch starts with: a lock timeout, a table lock on the five catalog tables (SHARE ROW EXCLUSIVE: nobody else can write them until commit, readers are
//     not blocked), then the fingerprint of what the import READ at preview time is compared with the fingerprint of the data NOW, inside the lock (a constant guard block). If anything moved,
//     the guard raises and nothing is written. READ COMMITTED is used on purpose: with a stricter level the snapshot would be taken before the wait for the lock and the guard would look at
//     older data than the lock protects.
//   * Single-record writes use compare-and-set: the UPDATE only matches if the fields being changed still hold the values the caller saw. "No row matched" is turned into a failure by a second
//     constant guard block, so the audit row after it is never written either.
//   * Everything dynamic is a $n parameter. The only text built from names is a column name taken from a fixed list in this file, never from the request.
const db = require('./db');
const { HttpError, logError } = require('./http');
const store = require('./catalog-store');
const serviceGuard = require('./service-guard');

const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '4000ms'";
const TABLE_LOCK = 'LOCK TABLE services, professionals, provider_profiles, provider_services, provider_service_prices IN SHARE ROW EXCLUSIVE MODE';
const GUARD_SNAPSHOT = 'DO $guard$ BEGIN IF (SELECT ' + store.FINGERPRINT_EXPR + ") IS DISTINCT FROM current_setting('kaspchem.expect', true) THEN RAISE EXCEPTION 'snapshot_changed' USING ERRCODE = 'P0001'; END IF; END $guard$";
const GUARD_ROWS = "DO $guard$ BEGIN IF coalesce(nullif(current_setting('kaspchem.rows', true), ''), '0')::int < 1 THEN RAISE EXCEPTION 'no_rows' USING ERRCODE = 'P0001'; END IF; END $guard$";
const AUDIT = 'INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5::jsonb)';
const LOG = 'INSERT INTO catalog_imports (source, file_sha256, rows_total, rows_created, rows_updated, rows_skipped, problems, imported_by) VALUES ($1, $2, $3::int, $4::int, $5::int, $6::int, $7::jsonb, $8)';

const audit = (actor, action, entity, entityId, detail) => ({ text: AUDIT, params: [actor, action, entity, String(entityId == null ? '' : entityId), JSON.stringify(detail || {})] });
// a statement that must change at least one row: the second statement fails the whole batch when it changed none
const counted = (dml, params) => [{ text: 'WITH u AS (' + dml + ' RETURNING 1) SELECT set_config(\'kaspchem.rows\', (SELECT count(*) FROM u)::text, true)', params }, { text: GUARD_ROWS }];

// ---- running a batch and understanding what went wrong ------------------------------------------------------------------------------------------------------------------
function mapError(e) {
  if (e instanceof HttpError) return e;
  const code = e && e.code, msg = String((e && e.message) || '');
  let out;
  if (code === 'P0001' && /snapshot_changed/.test(msg)) out = new HttpError(409, 'preview_stale', 'הנתונים השתנו מאז התצוגה המקדימה. יש להפיק תצוגה חדשה.');
  else if (code === 'P0001' && /no_rows/.test(msg)) { out = new HttpError(409, 'conflict', 'הרשומה השתנתה או אינה מתאימה. יש לרענן ולנסות שוב.'); out.noRows = true; }
  else if (code === '55P03') out = new HttpError(409, 'busy_retry', 'המערכת עסוקה כרגע. יש לנסות שוב בעוד רגע.');
  else if (code === '40001' || code === '40P01') out = new HttpError(409, 'conflict_retry', 'הפעולה התנגשה בפעולה אחרת. יש לרענן ולנסות שוב.');
  else if (code === '23505') { out = new HttpError(409, 'duplicate'); out.constraint = e.constraint; }
  else if (code === '23503') out = new HttpError(422, 'bad_reference');
  else if (code === '23514') { out = new HttpError(422, 'rule_violation', 'הפעולה מפרה כלל מובנה של מסד הנתונים (למשל התקשרות פעילה דורשת הסכם חתום, שיתוף פעולה פעיל ומחיר קבוע מקושר).'); out.constraint = e.constraint; }
  else { logError('catalog.write', e); out = new HttpError(500, 'server_error'); }
  return out;
}
async function run(statements) {
  try { return await db.writeTransaction(statements); } catch (e) { throw mapError(e); }
}

// ---- generic compare-and-set UPDATE -------------------------------------------------------------------------------------------------------------------------------------
// defs: { column: { type: 'text' | 'boolean' | 'int' | 'text[]' | 'numeric' | 'date', v: (raw) => normalised value (throws a 400) } }. `changes` and `expected` use the same column names;
// every changed column must have its expected value (what the caller saw). `key` is { column: id } matched as bigint. `extraSets` are constant fragments ("updated_at = now()").
function casUpdate({ table, alias, defs, key, changes, expected, extraSets, extra }) {
  const names = Object.keys(changes);
  if (!names.length) throw new HttpError(400, 'nothing_to_change');
  const params = [], ph = {}, p = (v, cast) => { params.push(v); return '$' + params.length + '::' + cast; };
  const sets = [], where = [];
  for (const col of names) {
    if (!Object.prototype.hasOwnProperty.call(defs, col)) throw new HttpError(400, 'unknown_field');
    if (!Object.prototype.hasOwnProperty.call(expected || {}, col)) throw new HttpError(400, 'expected_required');
    ph[col] = p(defs[col].v(changes[col]), defs[col].type); sets.push(col + ' = ' + ph[col]);
    where.push(col + ' IS NOT DISTINCT FROM ' + p(expectedValue(expected[col], defs[col].type), defs[col].type));
  }
  for (const col of Object.keys(key)) where.push((alias ? alias + '.' : '') + col + ' = ' + p(String(key[col]), 'bigint'));
  const more = extra ? extra({ p, ph }) : [];
  return { text: 'UPDATE ' + table + (alias ? ' ' + alias : '') + ' SET ' + sets.concat(extraSets || []).map((x) => (typeof x === 'function' ? x(p) : x)).join(', ') + ' WHERE ' + where.concat(more).join(' AND '), params, ph };
}
function expectedValue(v, type) {
  if (v === null || v === undefined) return null;
  if (type === 'text[]') { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HttpError(400, 'bad_expected'); return v; }
  if (!['string', 'number', 'boolean'].includes(typeof v)) throw new HttpError(400, 'bad_expected');
  return typeof v === 'string' ? v : String(v);
}

// ---- reserving ids for new rows -----------------------------------------------------------------------------------------------------------------------------------------
// A batch cannot use the result of an earlier statement, so ids of new rows are taken from the sequences first (gaps in a sequence are normal and harmless).
const SEQUENCES = { service: 'services_id_seq', provider: 'professionals_id_seq' };
async function reserve(kind, n) {
  if (!n) return [];
  const rows = await db.query("SELECT nextval('" + SEQUENCES[kind] + "') AS id FROM generate_series(1, $1::int)", [n]);
  return rows.map((r) => String(r.id));
}
async function reserveIds(ops) {
  const ids = new Map(), s = ops.filter((o) => o.op === 'create_service'), p = ops.filter((o) => o.op === 'create_provider');
  (await reserve('service', s.length)).forEach((id, i) => ids.set(s[i].ref, id)); (await reserve('provider', p.length)).forEach((id, i) => ids.set(p[i].ref, id));
  return ids;
}

// ---- the import: operations (already approved, already checked by planApply and assertSafe) -> statements ---------------------------------------------------------------------
const UPD_SERVICE = { topic: 'text', description: 'text' };
const UPD_PROVIDER = { business_name: 'text', contact_phone: 'text', contact_email: 'text' };
const UPD_ENGAGEMENT = { activation: 'text', contact_state: 'text', agreement_state: 'text', pricing_model: 'text', external_ref: 'text', terms_note: 'text' };
const UPD_LAYER = { model: 'text', amount: 'numeric', percent_low: 'numeric', percent_high: 'numeric', minimum_amount: 'numeric', terms_text: 'text', basis_missing: 'boolean', source_note: 'text', source_date: 'date' };
const listed = (set, allowed) => { for (const k of Object.keys(set)) if (!Object.prototype.hasOwnProperty.call(allowed, k)) throw new Error('import_field_not_allowed'); return Object.keys(set); };

function opStatements(o, ids) {
  const id = (r) => ('id' in r ? String(r.id) : ids.get(r.ref));
  const out = [];
  switch (o.op) {
    case 'create_service': out.push({ text: 'INSERT INTO services (id, name, topic, description, active) VALUES ($1::bigint, $2, $3, $4, $5::boolean)', params: [ids.get(o.ref), o.name, o.topic, o.description, o.active] }); break;
    case 'create_provider':
      out.push({ text: 'INSERT INTO professionals (id, name) VALUES ($1::bigint, $2)', params: [ids.get(o.ref), o.name] },
        { text: 'INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email) VALUES ($1::bigint, $2, $3, $4)', params: [ids.get(o.ref), o.business_name, o.contact_phone, o.contact_email] }); break;
    case 'update_service':
      for (const col of listed(o.set, UPD_SERVICE)) {
        if (col === 'topic') out.push(...counted('UPDATE services s SET topic = $1::text WHERE s.id = $2::bigint AND ' + serviceGuard.allowsChange(null, '$1::text'), [o.set.topic, String(o.id)]));   // a public price keeps its service's topic, here too
        else out.push({ text: 'UPDATE services SET description = $1::text WHERE id = $2::bigint', params: [o.set.description, String(o.id)] });
      } break;
    case 'update_provider':
      for (const col of listed(o.set, UPD_PROVIDER)) out.push({ text: 'INSERT INTO provider_profiles (professional_id, ' + col + ') VALUES ($1::bigint, $2) ON CONFLICT (professional_id) DO UPDATE SET ' + col + ' = EXCLUDED.' + col + ', updated_at = now()', params: [String(o.id), o.set[col]] }); break;
    case 'create_engagement': {
      const s = o.set;
      out.push({ text: 'INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, external_ref, terms_note, updated_by) VALUES ($1::bigint, $2::bigint, $3, $4, $5, $6, $7, $8, $9)',
        params: [id(o.provider), id(o.service), s.activation, s.contact_state, s.agreement_state, s.pricing_model, s.external_ref, s.terms_note, o.updated_by] }); break;
    }
    case 'update_engagement':
      for (const col of listed(o.set, UPD_ENGAGEMENT)) out.push({ text: 'UPDATE provider_services SET ' + col + ' = $1::text, updated_by = $2, updated_at = now() WHERE professional_id = $3::bigint AND service_id = $4::bigint', params: [o.set[col], o.updated_by, String(o.key.professional_id), String(o.key.service_id)] }); break;
    case 'create_layer': {
      const l = o.layer, key = o.engagement.provider ? [id(o.engagement.provider), id(o.engagement.service)] : [String(o.engagement.professional_id), String(o.engagement.service_id)];
      out.push({ text: 'INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, status, basis_missing, source_note, source_date, recorded_by) VALUES ($1::bigint, $2::bigint, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10, $11::boolean, $12, $13::date, $14)',
        params: [key[0], key[1], l.kind, l.model, l.amount, l.percent_low, l.percent_high, l.minimum_amount, l.terms_text, l.status, l.basis_missing, l.source_note, l.source_date, o.recorded_by] }); break;
    }
    case 'update_layer': {
      const cols = listed(o.set, UPD_LAYER), params = [];
      const sets = cols.map((c) => { params.push(o.set[c]); return c + ' = $' + params.length + '::' + UPD_LAYER[c]; });
      params.push(o.recorded_by, String(o.engagement.professional_id), String(o.engagement.service_id), o.kind);
      out.push({ text: 'UPDATE provider_service_prices SET ' + sets.join(', ') + ', recorded_by = $' + (params.length - 3) + ', updated_at = now() WHERE professional_id = $' + (params.length - 2) + '::bigint AND service_id = $' + (params.length - 1) + '::bigint AND kind = $' + params.length, params }); break;
    }
    default: throw new Error('import_operation_not_known');
  }
  return out;
}

// ctx: { expect (fingerprint of the data the preview was made from), actor, fileSha256, summary, rowsApplied, log (importLog) }
function importBatch(ops, ids, ctx) {
  const statements = [{ text: LOCK_TIMEOUT }, { text: TABLE_LOCK }, { text: "SELECT set_config('kaspchem.expect', $1, true)", params: [ctx.expect] }, { text: GUARD_SNAPSHOT }];
  for (const o of ops) statements.push(...opStatements(o, ids));
  statements.push(audit(ctx.actor, 'catalog.import.apply', 'catalog_import', ctx.fileSha256.slice(0, 12), { rows_total: ctx.log.rows_total, rows_applied: ctx.rowsApplied, operations: ctx.summary }));
  const L = ctx.log;
  statements.push({ text: LOG, params: [L.source, L.file_sha256, L.rows_total, L.rows_created, L.rows_updated, L.rows_skipped, JSON.stringify(L.problems), L.imported_by] });
  return statements;
}

module.exports = { run, mapError, audit, counted, casUpdate, reserve, reserveIds, importBatch, opStatements, GUARD_SNAPSHOT, GUARD_ROWS, AUDIT, LOG, LOCK_TIMEOUT, TABLE_LOCK, UPD_SERVICE, UPD_PROVIDER, UPD_ENGAGEMENT, UPD_LAYER };
