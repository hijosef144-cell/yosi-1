'use strict';
// Catalog import, pure core: the text of a CSV file and a snapshot of what already exists go in; a PREVIEW (what is new, what changes, what is a problem) comes out; and, only for
// what a person approved, a PLAN of operations (plain data) comes out. This module writes nothing, reads nothing, sends nothing: it has no database, file or network access, and it
// never changes what it is given. Rules R1-R11 of the M1 plan are enforced here and re-checked by assertSafe().
//
//   R1  never makes an engagement "active"                      R7  never deletes (what is not in the file is only reported)
//   R2  never sets "agreement signed" or "collaboration active"  R8  a value edited by hand is not overwritten without an explicit OK
//   R3  prices word for word, in separate layers, none invented   R9  duplicates are errors; similar names are questions, never merged
//   R4  clarifications copied word for word, never cut            R10 an unknown value blocks its row until it is mapped
//   R5  a percentage is kept as a percentage, with its wording    R11 nothing of the file is kept: the log holds hashes, counts and codes
//   R6  commission: NOT imported in M1 (deferred to M1.1); the commission columns are read only to say that they were ignored
const crypto = require('crypto');
const T = require('./text.js');
const CSV = require('./csv.js');
const P = require('./pricing.js');
const Sim = require('./similarity.js');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function stable(v) { // JSON with sorted keys, so two equal snapshots always give the same text
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const digest = (v) => sha256(stable(v));
// The digest of "what exists": the same data in any order gives the same digest (a database may return rows in any order), and anything else that differs gives another one.
const num = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
function snapshotDigest(ex) {
  const s = ex || {};
  return digest({
    services: (s.services || []).slice().sort((a, b) => num(a.id, b.id)),
    providers: (s.providers || []).slice().sort((a, b) => num(a.id, b.id)),
    engagements: (s.engagements || []).map((e) => Object.assign({}, e, { layers: (e.layers || []).slice().sort((a, b) => num(a.kind, b.kind)) })).sort((a, b) => num(a.professional_id, b.professional_id) || num(a.service_id, b.service_id)),
  });
}

// ---- value mapping (R1, R2, R10) ----------------------------------------------------------------------------------------------------------------------------
// valueKey of the file's text -> value in the system. `manual` = the file says something the importer is not allowed to set: it is imported as the safe value and reported.
const CONTACT = { 'יצרתיקשר': 'contacted', 'במומ': 'negotiating', 'לאנוצרקשר': 'none', 'טרםנוצרקשר': 'none' };
const CONTACT_MANUAL = { 'פעיל': 'negotiating', 'שיתוףפעולהפעיל': 'negotiating', 'שיתוףפעולה': 'negotiating' };
const AGREEMENT = { 'טרםנדון': 'not_discussed', 'טיוטה': 'draft' };
const AGREEMENT_MANUAL = { 'חתום': 'draft', 'חתומה': 'draft', 'הסכםחתום': 'draft', 'נחתם': 'draft' };
const ACTIVATION = { 'ממתיןלאישורלהפניה': 'pending', 'ממתין': 'pending', 'טיוטה': 'draft' };
const ACTIVATION_MANUAL = { 'פעיל': 'pending', 'פעילבאתר': 'pending' };
const DIRECTION_OK = new Set(['כספכםמפנהלספק']);
const SAFE_TARGETS = { contact: ['none', 'contacted', 'negotiating'], agreement: ['not_discussed', 'draft'], activation: ['draft', 'pending'] };   // what an import may ever set (R1, R2)

function mapValue(kind, raw, table, manualTable, custom) {
  const k = T.valueKey(raw);
  if (!k) return { empty: true };
  const hit = custom ? Object.entries(custom).find(([word]) => T.valueKey(word) === k) : null;   // the owner's own mapping { "word in the file": "value in the system" }; only safe targets are allowed
  if (hit) return SAFE_TARGETS[kind].includes(hit[1]) ? { value: hit[1] } : { problem: 'mapping_not_allowed', value: String(raw).slice(0, 60) };
  if (table[k] !== undefined) return { value: table[k] };
  if (manualTable[k] !== undefined) return { value: manualTable[k], manual: true };
  return { problem: 'unknown_value', value: String(raw).slice(0, 60) };   // R10: stops this row until the owner maps the word
}

const MANUAL_FLAG = { contact: 'file_says_collaboration_active_needs_manual', agreement: 'file_says_signed_needs_manual', activation: 'file_says_active_needs_manual' };   // R1, R2: what the file says but only a person may set
const CONFIRM_FLAGS = ['phone_restored'].concat(Object.values(MANUAL_FLAG));   // the owner must say "yes, I looked" before a row carrying one is applied
const SENSITIVE = new Set(['contact_state', 'agreement_state', 'activation', 'pricing_model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'model', 'contact_phone', 'contact_email']);
const LIMITS = { name: 200, business: 200, note: 1000 };
const isImportActor = (who) => typeof who === 'string' && who.startsWith('import:');
const isManual = (who) => !isImportActor(who);   // unknown provenance is protected too

// ---- one row -------------------------------------------------------------------------------------------------------------------------------------------------
function parseRow(obj, mappings) {
  const c = obj.cells, problems = [], warnings = [], flags = [], has = (k) => c[k] !== undefined;
  const bad = (code, field, extra) => problems.push(Object.assign({ code, field }, extra || {}));
  if (obj.blank) return { rowNumber: obj.rowNumber, skip: 'blank' };
  const serviceName = T.normText(c.service), providerName = T.normText(c.provider);
  if (!serviceName && !providerName) return { rowNumber: obj.rowNumber, skip: 'placeholder' };
  if (obj.extra) warnings.push('extra_cells');
  if (!serviceName) bad('service_missing', 'service');
  if (serviceName.length > LIMITS.name) bad('name_too_long', 'service', { max: LIMITS.name });
  const record = { rowNumber: obj.rowNumber, externalRef: has('externalId') ? T.normText(c.externalId) : undefined, service: { name: serviceName, key: T.nameKey(serviceName), topic: has('domain') ? (T.normText(c.domain) || null) : undefined, description: has('description') ? (T.verbatim(c.description) || undefined) : undefined }, provider: null, engagement: null, layer: null, flags, ignored: [] };
  if (has('domain') && !T.normText(c.domain)) warnings.push('domain_missing');

  if (providerName) {
    if (providerName.length > LIMITS.name) bad('name_too_long', 'provider', { max: LIMITS.name });
    const business = has('business') ? T.normText(c.business) : '';
    if (business.length > LIMITS.business) bad('name_too_long', 'business', { max: LIMITS.business });
    const prov = { name: providerName, business, key: T.nameKey(providerName) + '|' + T.nameKey(business) };
    if (has('phone')) { const ph = T.normalizePhone(c.phone); if (!ph.ok) bad(ph.problem, 'phone'); else if (!ph.empty) { prov.phone = ph.value; if (ph.restored) flags.push('phone_restored'); } }
    if (has('email')) { const em = T.normalizeEmail(c.email); if (!em.ok) bad(em.problem, 'email'); else if (!em.empty) prov.email = em.value; }
    record.provider = prov;
    const eng = {};
    const set = (kind, key, table, manualTable, label) => {
      if (!has(key)) return; const m = mapValue(kind, c[key], table, manualTable, mappings && mappings[kind]);
      if (m.empty) return; if (m.problem) return bad(m.problem, label, { value: m.value });
      eng[label] = m.value; if (m.manual) flags.push(MANUAL_FLAG[kind]);
    };
    set('contact', 'contact', CONTACT, CONTACT_MANUAL, 'contact_state'); set('agreement', 'agreement', AGREEMENT, AGREEMENT_MANUAL, 'agreement_state'); set('activation', 'activation', ACTIVATION, ACTIVATION_MANUAL, 'activation');
    if (has('activation') && !T.valueKey(c.activation) && !('activation' in eng)) eng.activation = 'draft';   // R1: an empty status is a draft
    if (has('direction') && T.valueKey(c.direction) && !DIRECTION_OK.has(T.valueKey(c.direction))) bad('unsupported_direction', 'direction', { value: String(c.direction).slice(0, 60) });
    if (has('notes') && T.verbatim(c.notes)) { eng.terms_note = T.verbatim(c.notes); if (eng.terms_note.length > LIMITS.note) bad('text_too_long', 'terms_note', { length: eng.terms_note.length, max: LIMITS.note }); }   // R4: word for word, never cut: too long is a problem
    const pr = P.classifyPricing({ price: has('price') ? c.price : undefined, pricingMode: has('pricingMode') ? c.pricingMode : undefined, priceTerms: has('priceTerms') ? c.priceTerms : undefined, priceSource: has('priceSource') ? c.priceSource : undefined, priceDate: has('priceDate') ? c.priceDate : undefined });
    pr.problems.forEach((p) => problems.push(Object.assign({}, p)));
    pr.warnings.forEach((w) => warnings.push(w)); pr.flags.forEach((f) => flags.push(f));
    record.layer = pr.layer; if (pr.engagementModel) eng.pricing_model = pr.engagementModel;
    if (record.externalRef) eng.external_ref = record.externalRef; else if (has('externalId')) warnings.push('external_ref_missing');
    record.engagement = eng;
  } else {
    const priced = ['price', 'pricingMode', 'priceTerms', 'priceSource', 'priceDate'].some((k) => has(k) && T.normText(c[k]));
    if (priced) bad('price_without_provider', 'price');
  }
  // columns the importer reads only to say that it ignored them (R6 and the questionnaire mapping)
  if (['commissionModel', 'commissionPercent', 'commissionFixed', 'commissionPayer'].some((k) => has(k) && T.normText(c[k]))) record.ignored.push('commission');
  if (has('questionnaire') && T.normText(c.questionnaire)) record.ignored.push('questionnaire_mapping');
  return { rowNumber: obj.rowNumber, record, problems, warnings, flags };
}

// ---- matching and differences ---------------------------------------------------------------------------------------------------------------------------------
const eqText = (a, b) => T.verbatim(a == null ? '' : a) === T.verbatim(b == null ? '' : b);
const eqNum = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
const eqKey = (a, b) => T.nameKey(a == null ? '' : a) === T.nameKey(b == null ? '' : b);
const PRICE_FIELDS = ['model', 'amount', 'percent_low', 'percent_high', 'minimum_amount', 'terms_text', 'basis_missing'];   // one statement: replaced together or not at all, so the row always satisfies the database checks
const SOURCE_FIELDS = ['source_note', 'source_date'];                                                                       // replaced only when the file has a value; never blanked
const layerFieldEq =(f, a, b) => (['amount', 'percent_low', 'percent_high', 'minimum_amount'].includes(f) ? eqNum(a, b) : f === 'basis_missing' ? !!a === !!b : f === 'source_date' ? String(a || '') === String(b || '').slice(0, 10) : eqText(a, b));
const sameLayerContent = (x, y) => x.model === y.model && eqNum(x.amount, y.amount) && eqNum(x.percent_low, y.percent_low) && eqNum(x.percent_high, y.percent_high) && eqNum(x.minimum_amount, y.minimum_amount);

function change(entity, field, oldV, newV, meta, extra) {
  return Object.assign({ id: entity + '.' + (extra && extra.kind ? extra.kind + '.' : '') + field, entity, field, old: oldV === undefined ? null : oldV, new: newV, sensitive: entity === 'layer' || SENSITIVE.has(field), manual: !!(meta && meta.manual) }, extra || {});
}

function diffEngagement(rec, ex, flags) {
  const out = [], meta = { manual: isManual(ex.updated_by) }, e = rec.engagement || {};
  const take = (field, eq) => { if (e[field] === undefined) return; if (!eq(ex[field], e[field])) out.push(change('engagement', field, ex[field], e[field], meta)); };
  // states the owner moved beyond the sheet are not for the file to move back (R1, R2)
  if (e.contact_state !== undefined) { if (['active', 'stopped'].includes(ex.contact_state) && ex.contact_state !== e.contact_state) flags.push('contact_state_managed_in_system'); else take('contact_state', (a, b) => a === b); }
  if (e.agreement_state !== undefined) { if (['signed', 'ended'].includes(ex.agreement_state) && ex.agreement_state !== e.agreement_state) flags.push('agreement_state_managed_in_system'); else take('agreement_state', (a, b) => a === b); }
  if (e.activation !== undefined) { if (!['draft', 'pending'].includes(ex.activation) && ex.activation !== e.activation) flags.push('activation_managed_in_system'); else take('activation', (a, b) => a === b); }
  if (e.pricing_model !== undefined) { if (ex.pricing_model === 'fixed' && ex.pricing_id) flags.push('pricing_model_managed_in_system'); else take('pricing_model', (a, b) => a === b); }
  take('terms_note', eqText); take('external_ref', (a, b) => String(a || '') === String(b || ''));
  return out;
}
function diffLayer(file, exLayers) {
  const sameKind = exLayers.find((l) => l.kind === file.kind);
  const classified = !sameKind && file.kind === 'unclassified' ? exLayers.find((l) => l.kind !== 'unclassified' && sameLayerContent(l, file)) : null;   // the owner already classified this price
  if (classified) return { action: 'none', changes: [] };
  if (!sameKind) return { action: 'create', changes: [change('layer', 'create', null, file, { manual: false }, { kind: file.kind, sensitive: true })] };
  const val = (f) => (file[f] === undefined ? null : file[f]);
  const differs = PRICE_FIELDS.some((f) => !layerFieldEq(f, sameKind[f], val(f))) || SOURCE_FIELDS.some((f) => val(f) !== null && !layerFieldEq(f, sameKind[f], val(f)));
  if (!differs) return { action: 'none', changes: [] };
  const next = {}; PRICE_FIELDS.forEach((f) => { next[f] = val(f); }); next.basis_missing = !!file.basis_missing; SOURCE_FIELDS.forEach((f) => { if (val(f) !== null) next[f] = val(f); });
  const was = {}; PRICE_FIELDS.concat(SOURCE_FIELDS).forEach((f) => { was[f] = sameKind[f] === undefined ? null : sameKind[f]; });
  return { action: 'update', changes: [change('layer', 'replace', was, next, { manual: isManual(sameKind.recorded_by) }, { kind: file.kind })] };
}

// ---- the preview ----------------------------------------------------------------------------------------------------------------------------------------------
// input: { csv (text or Buffer), existing: { services[], providers[], engagements[] }, mappings?, columnMap? }. Returns the preview; nothing is stored.
function buildPreview(input) {
  const csvIn = input.csv, existing = { services: [], providers: [], engagements: [], ...(input.existing || {}) };
  const fileBytes = Buffer.isBuffer(csvIn) ? csvIn : Buffer.from(String(csvIn == null ? '' : csvIn), 'utf8');
  const fileSha256 = sha256(fileBytes);
  const parsed = CSV.parseCsv(csvIn);
  const fatalCodes = ['file_too_large', 'bad_encoding', 'too_many_rows', 'unterminated_quote'];
  const base = { fileSha256, rows: [], notInFile: [], fileProblems: parsed.problems.slice(), warnings: [], decisionsNeeded: 0, summary: null, existingDigest: snapshotDigest(existing) };
  const finish = (p) => Object.assign(p, { previewId: sha256(p.fileSha256 + '|' + p.existingDigest + '|' + stable(input.mappings || {}) + '|' + stable(input.columnMap || {})) });
  if (parsed.problems.some((p) => fatalCodes.includes(p.code))) return finish(Object.assign(base, { ok: false, summary: emptySummary() }));
  const header = CSV.detectHeader(parsed.rows, { columnMap: input.columnMap });
  base.fileProblems.push(...header.problems); base.warnings.push(...header.warnings); base.unknownColumns = header.unknown; base.headerNumber = header.headerNumber;
  if (header.problems.length) return finish(Object.assign(base, { ok: false, summary: emptySummary() }));
  const objs = CSV.rowObjects(parsed.rows, header);
  // a limit on the work one import may ask for (rows with something in them; trailing empty rows of a spreadsheet export do not count); checked before any row is looked at
  const filled = objs.filter((o) => !o.blank).length;
  if (input.maxRows !== undefined && filled > input.maxRows) { base.fileProblems.push({ code: 'too_many_rows', rows: filled, max: input.maxRows }); return finish(Object.assign(base, { ok: false, summary: emptySummary() })); }

  const parsedRows = objs.map((o) => parseRow(o, input.mappings));
  // R9: the same sheet id twice, or the same provider and service twice, are errors on every row involved
  const refCount = {}, pairCount = {};
  parsedRows.forEach((r) => { if (!r.record) return; const ref = r.record.externalRef; if (ref) (refCount[T.nameKey(ref)] = refCount[T.nameKey(ref)] || []).push(r); if (r.record.provider) (pairCount[r.record.provider.key + '||' + r.record.service.key] = pairCount[r.record.provider.key + '||' + r.record.service.key] || []).push(r); });
  Object.values(refCount).filter((l) => l.length > 1).forEach((l) => l.forEach((r) => { r.problems.push({ code: 'duplicate_external_ref', field: 'externalId', rows: l.map((x) => x.rowNumber) }); }));
  Object.values(pairCount).filter((l) => l.length > 1).forEach((l) => l.forEach((r) => { r.problems.push({ code: 'duplicate_engagement', field: 'provider', rows: l.map((x) => x.rowNumber) }); }));

  const rows = [], newServices = [], newProviders = [], seenRefs = new Set();
  for (const pr of parsedRows) {
    if (pr.skip) { rows.push({ rowNumber: pr.rowNumber, status: 'skipped', reason: pr.skip, problems: [], warnings: [], flags: [], changes: [] }); continue; }
    const rec = pr.record, problems = pr.problems.slice(), warnings = pr.warnings.slice(), flags = pr.flags.slice(), changes = [], decisions = [];
    const row = { rowNumber: pr.rowNumber, record: rec, problems, warnings, flags, changes, decisions, service: null, provider: null, engagement: null, layer: null, ignored: rec.ignored };
    // -- service (R9): same normalised name is the same service; a near name is a question, never a merge
    const svcMatch = Sim.matchName(rec.service.name, existing.services);
    if (svcMatch.exact.length > 1) problems.push({ code: 'ambiguous_existing_service', field: 'service' });
    if (svcMatch.exact.length === 1) { const ex = svcMatch.exact[0]; row.service = { action: 'existing', id: ex.id };
      if (rec.service.topic !== undefined && rec.service.topic !== null && !eqKey(ex.topic, rec.service.topic)) {
        const ch = change('service', 'topic', ex.topic, rec.service.topic, { manual: isManual(ex.updated_by) });
        if (ex.public_price === true) ch.blocked = 'service_has_public_price';   // a service tied to a price the public site shows keeps its name and topic: the change is shown but cannot be approved
        changes.push(ch);
      }
      if (rec.service.description !== undefined && !eqText(ex.description, rec.service.description)) changes.push(change('service', 'description', ex.description, rec.service.description, { manual: isManual(ex.updated_by) })); }
    else {
      const earlier = newServices.find((s) => s.key === rec.service.key);
      if (earlier) row.service = { action: 'same_as_row', row: earlier.row };
      else {
        const near = Sim.matchName(rec.service.name, existing.services.concat(newServices.map((s) => ({ id: 'row:' + s.row, name: s.name }))));
        if (near.similar.length && !svcMatch.exact.length) { decisions.push({ entity: 'service', type: 'similar_service', candidates: near.similar.map((s) => ({ id: s.item.id, name: s.item.name, score: s.score })) }); row.service = { action: 'decision' }; }
        else row.service = { action: 'new' };
        newServices.push({ key: rec.service.key, row: pr.rowNumber, name: rec.service.name });
      }
    }
    // -- provider (R9)
    let providerId = null;
    if (rec.provider) {
      const pm = Sim.matchProvider(rec.provider, existing.providers.concat(newProviders.map((p) => ({ id: 'row:' + p.row, name: p.name, business_name: p.business }))));
      if (pm.exact.length > 1) problems.push({ code: 'ambiguous_existing_provider', field: 'provider' });
      if (pm.exact.length === 1) {
        const ex = pm.exact[0];
        if (String(ex.id).startsWith('row:')) row.provider = { action: 'same_as_row', row: Number(String(ex.id).slice(4)) };
        else { providerId = ex.id; row.provider = { action: 'existing', id: ex.id };
          const meta = { manual: isManual(ex.updated_by) };
          if (rec.provider.business && !eqKey(ex.business_name, rec.provider.business)) changes.push(change('provider', 'business_name', ex.business_name, rec.provider.business, meta));
          if (rec.provider.phone !== undefined && String(ex.contact_phone || '') !== rec.provider.phone) changes.push(change('provider', 'contact_phone', ex.contact_phone, rec.provider.phone, meta));
          if (rec.provider.email !== undefined && String(ex.contact_email || '').toLowerCase() !== rec.provider.email) changes.push(change('provider', 'contact_email', ex.contact_email, rec.provider.email, meta)); }
      } else if (pm.sameNameOtherBusiness.length || pm.similar.length) {
        decisions.push({ entity: 'provider', type: pm.sameNameOtherBusiness.length ? 'same_name_other_business' : 'similar_provider', candidates: pm.sameNameOtherBusiness.map((p) => ({ id: p.id, name: p.name, business: p.business_name })).concat(pm.similar.map((s) => ({ id: s.item.id, name: s.item.name, business: s.item.business_name, score: s.score }))) });
        row.provider = { action: 'decision' }; newProviders.push({ row: pr.rowNumber, name: rec.provider.name, business: rec.provider.business });
      } else { row.provider = { action: 'new' }; newProviders.push({ row: pr.rowNumber, name: rec.provider.name, business: rec.provider.business }); }
    }
    // -- engagement
    if (rec.provider) {
      const serviceId = row.service.action === 'existing' ? row.service.id : null;
      const byRef = rec.externalRef ? existing.engagements.filter((e) => String(e.external_ref || '') !== '' && T.nameKey(e.external_ref) === T.nameKey(rec.externalRef)) : [];
      const byPair = providerId !== null && serviceId !== null ? existing.engagements.filter((e) => String(e.professional_id) === String(providerId) && String(e.service_id) === String(serviceId)) : [];
      let ex = null;
      if (byRef.length > 1) problems.push({ code: 'ambiguous_existing_engagement', field: 'externalId' });
      else if (byRef.length === 1) {
        ex = byRef[0];   // the sheet id names an engagement; the provider and the service in the row must be exactly that engagement's, or the row stops (R9)
        if (providerId === null || serviceId === null || String(ex.professional_id) !== String(providerId) || String(ex.service_id) !== String(serviceId)) { problems.push({ code: 'external_ref_belongs_to_another_engagement', field: 'externalId' }); ex = null; }
      } else if (byPair.length === 1) ex = byPair[0];
      else if (byPair.length > 1) problems.push({ code: 'ambiguous_existing_engagement', field: 'provider' });
      if (rec.externalRef) seenRefs.add(T.nameKey(rec.externalRef));
      if (ex) {
        row.engagement = { action: 'existing', key: { professional_id: ex.professional_id, service_id: ex.service_id } };
        if (!problems.length) changes.push(...diffEngagement(rec, ex, flags));
        if (rec.layer) { const d = diffLayer(rec.layer, ex.layers || []); row.layer = { action: d.action }; changes.push(...d.changes); }
      } else if (!problems.some((p) => p.code === 'external_ref_belongs_to_another_engagement' || p.code.startsWith('ambiguous'))) {
        row.engagement = { action: 'new' }; if (rec.layer) row.layer = { action: 'create' };
      }
    }
    if (rec.ignored.includes('commission')) flags.push('commission_not_imported');
    if (rec.ignored.includes('questionnaire_mapping')) flags.push('questionnaire_mapping_not_imported');
    // -- status
    const createsSomething = ['service', 'provider', 'engagement'].some((k) => row[k] && ['new', 'decision'].includes(row[k].action));
    row.status = problems.length ? 'problem' : createsSomething ? 'new' : changes.length ? 'changed' : 'unchanged';
    row.needsConfirmation = CONFIRM_FLAGS.filter((f) => flags.includes(f));
    if (problems.length) { row.changes = []; row.decisions = []; }
    rows.push(row);
  }
  // R7: engagements the file does not mention are listed, never touched
  const notInFile = existing.engagements.filter((e) => String(e.external_ref || '') !== '' && !seenRefs.has(T.nameKey(e.external_ref))).map((e) => ({ professional_id: e.professional_id, service_id: e.service_id, external_ref: e.external_ref, activation: e.activation }));
  const summary = emptySummary(); summary.rows_total = rows.length;
  rows.forEach((r) => { summary[r.status] = (summary[r.status] || 0) + 1; });
  const decisionsNeeded = rows.reduce((n, r) => n + (r.decisions || []).length, 0);
  return finish(Object.assign(base, { ok: true, rows, notInFile, summary, decisionsNeeded }));
}
function emptySummary() { return { rows_total: 0, new: 0, changed: 0, unchanged: 0, skipped: 0, problem: 0 }; }

// ---- the plan ------------------------------------------------------------------------------------------------------------------------------------------------
// approvals: { rows: { [rowNumber]: { apply: true, decisions?: { service?: {use:'existing',id}|{use:'new'}, provider?: ... }, accept?: [change id], acceptManual?: [change id], confirmed?: [flag] } } }
// All or nothing: if any approved row cannot be applied, NO operation is returned. Operations are plain data; whoever runs them must run them in one transaction.
function planApply(preview, approvals, existingNow, opts) {
  const refused = [], ops = [], stamp = 'import:' + ((opts && opts.actor) || 'import');
  const now = { services: [], providers: [], engagements: [], ...(existingNow || {}) };
  if (!preview || !preview.ok) return { ok: false, reason: 'preview_not_usable', operations: [] };
  if (snapshotDigest(now) !== preview.existingDigest) return { ok: false, reason: 'snapshot_changed', operations: [] };   // the data moved since the preview: nothing is applied
  if (opts && opts.previewId && opts.previewId !== preview.previewId) return { ok: false, reason: 'preview_mismatch', operations: [] };
  const wanted = (approvals && approvals.rows) || {}, byNumber = new Map(preview.rows.map((r) => [String(r.rowNumber), r]));
  const approved = Object.keys(wanted).filter((n) => wanted[n] && wanted[n].apply === true).sort((a, b) => Number(a) - Number(b));
  const known = { service: new Set(now.services.map((s) => String(s.id))), provider: new Set(now.providers.map((p) => String(p.id))) };
  const created = { service: new Map(), provider: new Map() };           // name key -> ref of what an earlier approved row of this plan creates
  const usedPairs = new Set(now.engagements.map((e) => e.professional_id + ':' + e.service_id));
  const usedRefs = new Set(now.engagements.filter((e) => e.external_ref).map((e) => String(e.external_ref)));
  const planned = new Set();
  for (const n of approved) {
    const row = byNumber.get(n);
    if (!row) { refused.push({ row: Number(n), reason: 'no_such_row' }); continue; }
    const a = wanted[n], rec = row.record, myOps = [], no = (reason, extra) => refused.push(Object.assign({ row: row.rowNumber, reason }, extra || {}));
    if (row.status === 'problem' || row.status === 'skipped') { no('row_is_' + row.status); continue; }
    if (row.status === 'unchanged') continue;
    const missingConfirm = (row.needsConfirmation || []).filter((f) => !(a.confirmed || []).includes(f));
    if (missingConfirm.length) { no('confirmation_missing', { flags: missingConfirm }); continue; }
    // R9: a similar name needs an explicit answer: use the existing one (by id) or create a new one. Nothing is ever merged.
    let svc = null, prov = null, bad = false;
    const dec = a.decisions || {};
    for (const d of row.decisions || []) {
      const ans = dec[d.entity];
      if (!ans || !['existing', 'new'].includes(ans.use)) { no('decision_missing', { entity: d.entity }); bad = true; continue; }
      if (ans.use === 'existing') {
        if (!known[d.entity].has(String(ans.id))) { no('decision_unknown_id', { entity: d.entity }); bad = true; continue; }
        if (d.entity === 'service') svc = { id: ans.id }; else prov = { id: ans.id };
      }
    }
    if (bad) continue;
    const ensure = (entity, key, make) => {   // a reference to a record this plan creates, created once
      if (!created[entity].has(key)) { const ref = entity + ':row' + row.rowNumber; created[entity].set(key, ref); myOps.push(make(ref)); }
      return { ref: created[entity].get(key) };
    };
    if (!svc) svc = row.service.action === 'existing' ? { id: row.service.id } : ensure('service', rec.service.key, (ref) => ({ op: 'create_service', ref, name: rec.service.name, topic: rec.service.topic || null, description: rec.service.description || null, active: false, source_row: row.rowNumber }));
    if (rec.provider && !prov) prov = row.provider.action === 'existing' ? { id: row.provider.id } : ensure('provider', rec.provider.key, (ref) => ({ op: 'create_provider', ref, name: rec.provider.name, business_name: rec.provider.business || null, contact_phone: rec.provider.phone || null, contact_email: rec.provider.email || null, source_row: row.rowNumber }));
    // R8: a change to something that exists is applied only when this row's approval lists it; a hand-edited value needs its own, separate OK
    const accept = new Set(a.accept || []), acceptManual = new Set(a.acceptManual || []);
    for (const ch of row.changes) {
      if (ch.entity === 'layer' && ch.field === 'create') continue;   // handled with the engagement below
      if (ch.manual ? !acceptManual.has(ch.id) : !accept.has(ch.id)) continue;
      if (ch.blocked) { no('change_blocked', { id: ch.id, why: ch.blocked }); continue; }   // approving a blocked change refuses the whole plan
      if (ch.entity === 'service') { if ('id' in svc) myOps.push({ op: 'update_service', id: svc.id, set: { [ch.field]: ch.new }, source_row: row.rowNumber }); }
      else if (ch.entity === 'provider') { if (prov && 'id' in prov) myOps.push({ op: 'update_provider', id: prov.id, set: { [ch.field]: ch.new }, source_row: row.rowNumber }); }
      else if (ch.entity === 'engagement') myOps.push({ op: 'update_engagement', key: row.engagement.key, set: { [ch.field]: ch.new }, updated_by: stamp, source_row: row.rowNumber });
      else if (ch.entity === 'layer') myOps.push({ op: 'update_layer', engagement: row.engagement.key, kind: ch.kind, set: Object.assign({}, ch.new), recorded_by: stamp, source_row: row.rowNumber });
    }
    if (rec.provider && row.engagement && row.engagement.action === 'new') {
      const pk = ('id' in prov ? 'id:' + prov.id : prov.ref) + '|' + ('id' in svc ? 'id:' + svc.id : svc.ref), ext = rec.engagement.external_ref;
      if ('id' in prov && 'id' in svc && usedPairs.has(prov.id + ':' + svc.id)) { no('engagement_already_exists'); continue; }   // the answer given points at a pair that already has an engagement
      if (planned.has(pk)) { no('engagement_twice_in_plan'); continue; }
      if (ext && usedRefs.has(String(ext))) { no('external_ref_in_use'); continue; }
      planned.add(pk); if (ext) usedRefs.add(String(ext));
      myOps.push({ op: 'create_engagement', provider: prov, service: svc, set: defaults(rec.engagement), updated_by: stamp, source_row: row.rowNumber });
      if (rec.layer) myOps.push({ op: 'create_layer', engagement: { provider: prov, service: svc }, layer: Object.assign({}, rec.layer, { status: 'recorded' }), recorded_by: stamp, source_row: row.rowNumber });
    } else if (rec.provider && row.engagement && row.engagement.action === 'existing' && rec.layer && accept.has('layer.' + rec.layer.kind + '.create') && row.changes.some((c) => c.id === 'layer.' + rec.layer.kind + '.create')) {
      myOps.push({ op: 'create_layer', engagement: row.engagement.key, layer: Object.assign({}, rec.layer, { status: 'recorded' }), recorded_by: stamp, source_row: row.rowNumber });
    }
    ops.push(...myOps);
  }
  if (refused.length) return { ok: false, reason: 'rows_refused', refused, operations: [] };   // atomic: not one operation unless every approved row is good
  assertSafe(ops);
  return { ok: true, operations: ops, rows_applied: approved.length, summary: summarizeOps(ops) };
}
function defaults(e) { // a new engagement starts from the file's safe values, with everything else at its safe default
  return { activation: e.activation || 'draft', contact_state: e.contact_state || 'none', agreement_state: e.agreement_state || 'not_discussed', pricing_model: e.pricing_model || 'tbd', external_ref: e.external_ref || null, terms_note: e.terms_note || null };
}
function summarizeOps(ops) { const s = {}; ops.forEach((o) => { s[o.op] = (s[o.op] || 0) + 1; }); return s; }

// The invariants the importer must never break, checked on the operations themselves (R1, R2, R3, R6, R7). Throws on the first violation.
// Whitelist: an operation may only have these keys, and only these fields in `set`; anything else (a delete, a pricing row, a commission field, a state change) is refused.
const ENGAGEMENT_FIELDS = ['activation', 'contact_state', 'agreement_state', 'pricing_model', 'external_ref', 'terms_note'];
const SHAPES = {
  create_service: { keys: ['op', 'ref', 'name', 'topic', 'description', 'active', 'source_row'] },
  update_service: { keys: ['op', 'id', 'set', 'source_row'], set: ['topic', 'description'] },
  create_provider: { keys: ['op', 'ref', 'name', 'business_name', 'contact_phone', 'contact_email', 'source_row'] },
  update_provider: { keys: ['op', 'id', 'set', 'source_row'], set: ['business_name', 'contact_phone', 'contact_email'] },
  create_engagement: { keys: ['op', 'provider', 'service', 'set', 'updated_by', 'source_row'], set: ENGAGEMENT_FIELDS },
  update_engagement: { keys: ['op', 'key', 'set', 'updated_by', 'source_row'], set: ENGAGEMENT_FIELDS },
  create_layer: { keys: ['op', 'engagement', 'layer', 'recorded_by', 'source_row'] },
  update_layer: { keys: ['op', 'engagement', 'kind', 'set', 'recorded_by', 'source_row'], set: PRICE_FIELDS.concat(SOURCE_FIELDS) },
};
function assertSafe(ops) {
  const fail = (m, o) => { const e = new Error('unsafe import operation: ' + m); e.operation = o; throw e; };
  if (!Array.isArray(ops)) fail('operations is not a list', ops);
  for (const o of ops) {
    const shape = SHAPES[o && o.op];
    if (!shape) fail('operation not allowed: ' + (o && o.op), o);                                          // no delete, no pricing row, no commission operation exists
    for (const k of Object.keys(o)) if (!shape.keys.includes(k)) fail('field ' + k + ' is not part of ' + o.op, o);
    if (shape.set) for (const k of Object.keys(o.set || {})) if (!shape.set.includes(k)) fail('field ' + k + ' may not be set by an import', o);
    const f = Object.assign({}, o.set || {}, o.layer || {});
    if ('activation' in f && !SAFE_TARGETS.activation.includes(f.activation)) fail('activation ' + f.activation, o);                    // R1
    if ('contact_state' in f && !SAFE_TARGETS.contact.includes(f.contact_state)) fail('contact_state ' + f.contact_state, o);          // R2
    if ('agreement_state' in f && !SAFE_TARGETS.agreement.includes(f.agreement_state)) fail('agreement_state ' + f.agreement_state, o);
    if ('pricing_model' in f && !(P.MODELS.includes(f.pricing_model) && f.pricing_model !== 'fixed')) fail('pricing_model ' + f.pricing_model, o);   // D15: a client price is the owner's
    if (Object.keys(o).concat(Object.keys(f)).some((k) => /pricing_id|commission|compensation|percent_recorded|fixed_recorded|payer/i.test(k))) fail('pricing link or commission data', o);   // R3, R6
    if (o.op === 'create_service' && o.active !== false) fail('an imported service starts inactive', o);
    if (o.op === 'create_layer') {
      if (!o.layer || !['market', 'unclassified'].includes(o.layer.kind)) fail('a layer kind the importer may not create', o);
      if (o.layer.status !== 'recorded') fail('layer status', o);
      if (P.validateLayer(o.layer).length) fail('layer does not satisfy the database checks', o);
    }
    if (o.op === 'update_layer') {
      if (!['market', 'unclassified'].includes(o.kind)) fail('a layer kind the importer may not change', o);
      if (P.validateLayer(Object.assign({ kind: o.kind, status: 'recorded' }, o.set)).length) fail('layer does not satisfy the database checks', o);
      if (!isImportActor(o.recorded_by)) fail('layer written without the import actor', o);
    }
    if (o.op === 'create_layer' && !isImportActor(o.recorded_by)) fail('layer written without the import actor', o);
    if ((o.op === 'create_engagement' || o.op === 'update_engagement') && !isImportActor(o.updated_by)) fail('engagement written without the import actor', o);
  }
  return true;
}

// R11: what is kept about an import. Hashes, counts and codes; never a cell of the file, never a name or a number. Same columns as the import-log table of the catalog migration.
function importLog(preview, plan, importedBy) {
  const ops = (plan && plan.operations) || [], total = preview.summary ? preview.summary.rows_total : 0;
  const created = new Set(ops.filter((o) => /^create_(service|provider|engagement)$/.test(o.op)).map((o) => o.source_row)), touched = new Set(ops.map((o) => o.source_row));
  const problems = preview.fileProblems.map((p) => ({ row: p.row || 0, code: p.code })).concat(preview.rows.flatMap((r) => (r.problems || []).map((p) => ({ row: r.rowNumber, code: p.code }))));
  return {
    source: 'csv', file_sha256: preview.fileSha256, rows_total: total,
    rows_created: created.size, rows_updated: [...touched].filter((r) => !created.has(r)).length, rows_skipped: total - touched.size,
    problems: problems.slice(0, 500), imported_by: String(importedBy || '').slice(0, 200),
  };
}

module.exports = { buildPreview, planApply, assertSafe, importLog, parseRow, mapValue, digest, snapshotDigest, stable, SAFE_TARGETS, CONFIRM_FLAGS, SENSITIVE, SHAPES };
