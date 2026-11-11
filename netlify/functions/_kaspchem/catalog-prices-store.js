'use strict';
// Catalog server, READ side of the prices (stage 5b-3). Two reads, both only SELECTs with $n parameters and listed columns:
//   * prices.list   one line per engagement: its three layers (market, the provider's offer, a value not yet classified), the approved price that is linked to it and whether that price fits (the rule of the linking route and of the activation)
//   * pricing.rows  the rows of the older pricing table that can be linked: label, price, approved, public, who they belong to, how many engagements link them; and, when the engagement is named, whether each one fits it
// `pricing.cost`, `pricing.commission` and `pricing.notes` are never selected, and nothing here writes (a test scans for it). Approving or publishing a price stays in the older "תמחור" tab.
const db = require('./db');

const rd = (text, params) => { if (!/^\s*(select|with)\b/i.test(text)) throw new Error('read_only_statements_only'); return db.query(text, params || []); };
const num = (v) => (v === null || v === undefined ? null : Number(v));
const like = (s) => (s ? '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%' : null);   // the user's text is a literal, never a pattern

// the very rule of PRICE_FITS (admin-catalog-writes.js), with the engagement named by `ps`; a test keeps the two equal on every case
const FITS = 'pr.approved AND pr.price IS NOT NULL AND pr.service_id = ps.service_id AND (pr.professional_id IS NULL OR pr.professional_id = ps.professional_id)';
const LAYER_OF = (kind) => 'EXISTS (SELECT 1 FROM provider_service_prices l WHERE l.professional_id = ps.professional_id AND l.service_id = ps.service_id AND l.kind = ' + kind + ')';
const FILTERS = ['no_price', 'unclassified', 'offer', 'awaiting_answer', 'linked', 'linked_problem'];

const PRICES_LIST = 'SELECT ps.professional_id::text AS provider_id, p.name AS provider_name, ps.service_id::text AS service_id, s.name AS service_name, ps.activation, ps.pricing_model, ps.pricing_id::text AS pricing_id, ' +
  'pr.label AS price_label, pr.price::float8 AS price_value, pr.approved AS price_approved, pr.public AS price_public, (pr.id IS NOT NULL AND ' + FITS + ') AS price_fits, ' +
  "(SELECT jsonb_object_agg(l.kind, jsonb_build_object('model', l.model, 'amount', l.amount::float8, 'percent_low', l.percent_low::float8, 'percent_high', l.percent_high::float8, 'minimum_amount', l.minimum_amount::float8, 'status', l.status, 'basis_missing', l.basis_missing)) " +
  'FROM provider_service_prices l WHERE l.professional_id = ps.professional_id AND l.service_id = ps.service_id) AS layers, (count(*) OVER ())::int AS total ' +
  'FROM provider_services ps JOIN professionals p ON p.id = ps.professional_id JOIN services s ON s.id = ps.service_id LEFT JOIN pricing pr ON pr.id = ps.pricing_id ' +
  'WHERE ($1::bigint IS NULL OR ps.professional_id = $1) AND ($2::bigint IS NULL OR ps.service_id = $2) AND ($3::text IS NULL OR p.name ILIKE $3 OR s.name ILIKE $3) AND ($4::text IS NULL ' +
  "OR ($4 = 'no_price' AND ps.pricing_id IS NULL AND NOT EXISTS (SELECT 1 FROM provider_service_prices l WHERE l.professional_id = ps.professional_id AND l.service_id = ps.service_id)) " +
  "OR ($4 = 'unclassified' AND " + LAYER_OF("'unclassified'") + ") OR ($4 = 'offer' AND " + LAYER_OF("'provider_offer'") + ') ' +
  "OR ($4 = 'awaiting_answer' AND EXISTS (SELECT 1 FROM provider_service_prices l WHERE l.professional_id = ps.professional_id AND l.service_id = ps.service_id AND l.kind = 'provider_offer' AND l.status = 'awaiting_response')) " +
  "OR ($4 = 'linked' AND ps.pricing_id IS NOT NULL) OR ($4 = 'linked_problem' AND ps.pricing_id IS NOT NULL AND NOT (pr.id IS NOT NULL AND " + FITS + '))) ' +
  'ORDER BY p.name, s.name, ps.professional_id, ps.service_id LIMIT $5 OFFSET $6';
async function listPrices(q) {
  const rows = await rd(PRICES_LIST, [q.provider_id === undefined ? null : q.provider_id, q.service_id === undefined ? null : q.service_id, like(q.q), q.filter || null, q.limit, q.offset]);
  return {
    prices: rows.map((r) => ({
      provider_id: num(r.provider_id), provider_name: r.provider_name, service_id: num(r.service_id), service_name: r.service_name, activation: r.activation, pricing_model: r.pricing_model,
      layers: r.layers || {}, linked: r.pricing_id === null ? null : { id: num(r.pricing_id), label: r.price_label, price: r.price_value, approved: r.price_approved === true, public: r.price_public === true, fits: r.price_fits === true },
    })),
    total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset,
  };
}

const PRICING_ROWS = 'SELECT pr.id::text AS id, pr.label, pr.price::float8 AS price, pr.approved, pr.public, pr.service_id::text AS service_id, s.name AS service_name, pr.professional_id::text AS provider_id, p.name AS provider_name, ' +
  '(SELECT count(*)::int FROM provider_services ps WHERE ps.pricing_id = pr.id) AS linked_count, (SELECT count(*)::int FROM provider_services ps WHERE ps.pricing_id = pr.id AND ps.activation = \'active\') AS linked_working, ' +
  'CASE WHEN $3::bigint IS NULL OR $4::bigint IS NULL THEN NULL ELSE (pr.approved AND pr.price IS NOT NULL AND pr.service_id = $4::bigint AND (pr.professional_id IS NULL OR pr.professional_id = $3::bigint)) END AS fits_engagement, (count(*) OVER ())::int AS total ' +
  'FROM pricing pr LEFT JOIN services s ON s.id = pr.service_id LEFT JOIN professionals p ON p.id = pr.professional_id ' +
  'WHERE ($1::bigint IS NULL OR pr.service_id = $1) AND ($2::text IS NULL OR pr.label ILIKE $2) ORDER BY pr.id DESC LIMIT $5 OFFSET $6';
async function listPricingRows(q) {
  const rows = await rd(PRICING_ROWS, [q.service_id === undefined ? null : q.service_id, like(q.q), q.for_provider_id === undefined ? null : q.for_provider_id, q.for_service_id === undefined ? null : q.for_service_id, q.limit, q.offset]);
  return {
    pricing_rows: rows.map((r) => ({ id: num(r.id), label: r.label, price: r.price, approved: r.approved === true, public: r.public === true, service_id: num(r.service_id), service_name: r.service_name, provider_id: num(r.provider_id), provider_name: r.provider_name,
      linked_count: r.linked_count, linked_working: r.linked_working, fits_engagement: r.fits_engagement === null || r.fits_engagement === undefined ? null : r.fits_engagement === true })),
    total: rows[0] ? rows[0].total : 0, limit: q.limit, offset: q.offset,
  };
}

module.exports = { listPrices, listPricingRows, FILTERS, FITS, PRICES_LIST, PRICING_ROWS };
