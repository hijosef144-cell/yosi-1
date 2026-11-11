'use strict';
// Catalog import, pure pricing logic: what a row's price cell and pricing wording mean, as price LAYERS (market / unclassified; the importer never creates a provider offer, an
// approved client price or a commission). A price is never invented, rounded, defaulted or promoted: a missing price stays missing and a wording that is not understood is kept
// word for word with no numbers. validateLayer mirrors the database checks of the layers table, so a layer that passes here is one the database accepts.
const { normText, verbatim, parseMoney, parseSourceDate } = require('./text.js');

const MODELS = ['fixed', 'percent_of_result', 'percent_with_minimum', 'variable', 'quote', 'tbd'];
const KINDS = ['market', 'provider_offer', 'unclassified'];
const STATUSES = ['recorded', 'awaiting_response', 'received', 'declined'];
const MAX_TEXT = 600;

const NUM = '(\\d+(?:[.,]\\d+)?)';
const PERCENT_TOKEN = new RegExp(NUM + '\\s*%', 'g');
const RANGE = new RegExp(NUM + '\\s*%?\\s*[-\\u2013\\u2014\\u05BE]\\s*' + NUM + '\\s*%');
const WITH_MINIMUM = new RegExp(NUM + '\\s*%\\D{0,40}?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(?:\\u20AA|ש"ח|ש״ח|שח)');   // a percent, a few words (not digits), then an amount in shekels; the code below also needs the word minimum / at least / the higher
const asNumber = (s) => Number(String(s).replace(',', '.'));

// ---- the database's own checks, in code -----------------------------------------------------------------------------------------------------------------------
function validateLayer(l) {
  const p = [], has = (v) => v !== null && v !== undefined;
  if (!MODELS.includes(l.model)) p.push('model_unknown');
  if (!KINDS.includes(l.kind)) p.push('kind_unknown');
  if (!STATUSES.includes(l.status || 'recorded')) p.push('status_unknown');
  if (l.kind !== 'provider_offer' && (l.status || 'recorded') !== 'recorded') p.push('only_an_offer_can_wait_for_an_answer');
  if (has(l.amount) && !(l.amount >= 0)) p.push('amount_negative');
  for (const f of ['percent_low', 'percent_high']) if (has(l[f]) && !(l[f] > 0 && l[f] <= 100)) p.push(f + '_out_of_range');
  if (has(l.minimum_amount) && !(l.minimum_amount >= 0)) p.push('minimum_negative');
  if (has(l.percent_low) && has(l.percent_high) && l.percent_high < l.percent_low) p.push('percent_range_reversed');
  if (has(l.terms_text) && l.terms_text.length > MAX_TEXT) p.push('terms_text_too_long');
  if (has(l.source_note) && l.source_note.length > MAX_TEXT) p.push('source_note_too_long');
  if (l.model === 'fixed' && !(has(l.amount) && !has(l.percent_low) && !has(l.percent_high) && !has(l.minimum_amount))) p.push('fixed_needs_an_amount_and_nothing_else');
  if ((l.model === 'percent_of_result' || l.model === 'percent_with_minimum') && !(has(l.percent_low) && !has(l.amount))) p.push('percent_model_needs_a_percent_and_no_amount');
  if (l.model === 'percent_with_minimum' && !has(l.minimum_amount)) p.push('minimum_needed');
  if (['variable', 'quote', 'tbd'].includes(l.model) && (has(l.amount) || has(l.percent_low) || has(l.percent_high) || has(l.minimum_amount))) p.push('no_numbers_allowed_for_this_model');
  return p;
}

// ---- the classifier --------------------------------------------------------------------------------------------------------------------------------------------
// cells: { price, pricingMode, priceTerms, priceSource, priceDate }. A cell is undefined when the file has no such column. Returns
//   { layer | null, engagementModel | null, problems: [{code, field?}] (the row cannot be applied), warnings: [codes] (it can, with the owner's eyes on them), flags: [codes] }
function classifyPricing(cells) {
  const c = cells || {}, problems = [], warnings = [], flags = [];
  const mode = verbatim(c.pricingMode), text = normText(c.pricingMode);
  const has = (v) => v !== undefined;
  const price = has(c.price) ? parseMoney(c.price) : { ok: true, empty: true };
  if (!price.ok) problems.push({ code: price.problem, field: 'price' });
  const priceGiven = price.ok && !price.empty;

  const terms = [mode, verbatim(c.priceTerms)].filter(Boolean).join('\n');
  if (terms.length > MAX_TEXT) problems.push({ code: 'text_too_long', field: 'terms_text', length: terms.length, max: MAX_TEXT });
  const source = verbatim(c.priceSource);
  if (source.length > MAX_TEXT) problems.push({ code: 'text_too_long', field: 'source_note', length: source.length, max: MAX_TEXT });
  const date = has(c.priceDate) ? parseSourceDate(c.priceDate) : { ok: true, empty: true, value: null };
  if (!date.ok) problems.push({ code: date.problem, field: 'source_date' });

  let model = null, percentLow = null, percentHigh = null, minimum = null, basisMissing = false;
  const conflict = () => { if (priceGiven) problems.push({ code: 'price_conflicts_with_mode', field: 'price' }); };
  const percents = []; for (const m of text.matchAll(PERCENT_TOKEN)) percents.push(asNumber(m[1]));
  const withMin = WITH_MINIMUM.exec(text), range = RANGE.exec(text);
  const otherNumbers = (m) => /\d/.test(text.replace(m[0], ' '));   // a number in the wording that the pattern does not account for: the wording is not understood, nothing is picked out of it

  if (!text) {
    if (priceGiven) { model = 'fixed'; flags.push('price_without_wording'); }
  } else if (/טרם נקבע|לא נקבע|ללא מחיר|אין מחיר/.test(text)) { model = 'tbd'; conflict(); }
  else if (withMin && /הגבוה|מינימום|לפחות/.test(text) && !otherNumbers(withMin)) {
    model = 'percent_with_minimum'; percentLow = asNumber(withMin[1]); const m = parseMoney(withMin[2]);
    if (m.ok && !m.empty) minimum = m.value; else problems.push({ code: 'minimum_not_numeric', field: 'terms_text' });
    conflict();
  } else if (range && !otherNumbers(range)) {
    model = 'percent_of_result'; percentLow = asNumber(range[1]); percentHigh = asNumber(range[2]);
    if (percentHigh < percentLow) problems.push({ code: 'percent_range_reversed', field: 'terms_text' });
    conflict();
  } else if (percents.length === 1 && !/קבוע/.test(text) && !/\d/.test(text.replace(PERCENT_TOKEN, ' '))) {
    model = 'percent_of_result'; percentLow = percents[0];
    basisMissing = /בסיס/.test(text) && /לא פורט|חסר|לא מוגדר|לא צוין|לא ידוע/.test(text);
    if (!basisMissing && normText(text.replace(PERCENT_TOKEN, ' ').replace(/[^֐-׿a-z]/gi, ' ')).length < 2) basisMissing = true;   // a bare percentage names no base
    conflict();
  } else if (/הצעת מחיר|הצעה|לפי מקרה|בהתאם למקרה/.test(text) && !/קבוע/.test(text)) { model = 'quote'; conflict(); }
  else if (/מורכבות|משתנה|בהתאם|לפי היקף|לפי התיק/.test(text)) { model = 'variable'; conflict(); }
  else if (/קבוע/.test(text)) { model = 'fixed'; if (!priceGiven) warnings.push('fixed_price_missing'); }
  else { model = 'variable'; flags.push('unrecognized_pricing_text'); conflict(); }   // not understood: kept word for word, with no numbers

  if (percentLow !== null && !(percentLow > 0 && percentLow <= 100)) problems.push({ code: 'percent_out_of_range', field: 'terms_text' });
  if (percentHigh !== null && !(percentHigh > 0 && percentHigh <= 100)) problems.push({ code: 'percent_out_of_range', field: 'terms_text' });
  if (basisMissing) flags.push('basis_missing');

  let layer = null;
  const wantsLayer = model !== null && !(model === 'fixed' && !priceGiven);
  if (wantsLayer) {
    layer = {
      kind: /שוק/.test(text) ? 'market' : 'unclassified', model, status: 'recorded',
      amount: model === 'fixed' ? (priceGiven ? price.value : null) : null,
      percent_low: percentLow, percent_high: percentHigh, minimum_amount: minimum,
      terms_text: terms || null, basis_missing: basisMissing, source_note: source || null, source_date: date.ok ? (date.value || null) : null,
    };
    if (layer.kind === 'unclassified' && model === 'fixed') flags.push('price_unclassified');
    validateLayer(layer).forEach((code) => problems.push({ code: 'layer_invalid:' + code }));   // never expected; a safety net that mirrors the database
  }
  // the model recorded on the engagement itself: descriptive for every model except a fixed one, whose CLIENT price the importer cannot know (the column mixes market and client prices)
  const engagementModel = model === null ? null : model === 'fixed' ? 'tbd' : model;
  if (problems.length) return { layer: null, engagementModel: null, problems, warnings, flags };
  return { layer, engagementModel, problems, warnings, flags };
}

module.exports = { classifyPricing, validateLayer, MODELS, KINDS, STATUSES, MAX_TEXT };
