'use strict';
// Test helpers for the catalog import. Two ways to carry out the list of operations the importer produces, so the tests can look at the result:
//   applyOps(snapshot, ops)       in memory: returns the snapshot as it would be afterwards (never changes the one it is given)
//   runOps(pg, ops) / readSnapshot(pg)   on an in-memory Postgres (PGlite) with the real tables of migration 002: the database itself accepts or refuses every operation
// These helpers belong to the tests. The importer has no database code at all; the real executor is a later, separately approved step.

const clone = (v) => JSON.parse(JSON.stringify(v));

function applyOps(snapshot, ops) {
  const s = clone(snapshot), refs = new Map();
  let next = 100;
  const idOf = (r) => ('id' in r ? r.id : refs.get(r.ref));
  const eng = (key) => s.engagements.find((e) => String(e.professional_id) === String(key.professional_id) && String(e.service_id) === String(key.service_id));
  for (const o of ops) {
    switch (o.op) {
      case 'create_service': { const id = ++next; refs.set(o.ref, id); s.services.push({ id, name: o.name, topic: o.topic, description: o.description, active: o.active, updated_by: 'import:sim' }); break; }
      case 'create_provider': { const id = ++next; refs.set(o.ref, id); s.providers.push({ id, name: o.name, business_name: o.business_name, contact_phone: o.contact_phone, contact_email: o.contact_email, updated_by: 'import:sim' }); break; }
      case 'update_service': Object.assign(s.services.find((x) => String(x.id) === String(o.id)), o.set); break;
      case 'update_provider': Object.assign(s.providers.find((x) => String(x.id) === String(o.id)), o.set); break;
      case 'create_engagement': s.engagements.push(Object.assign({ professional_id: idOf(o.provider), service_id: idOf(o.service), pricing_id: null, layers: [], updated_by: o.updated_by }, o.set)); break;
      case 'update_engagement': Object.assign(eng(o.key), o.set, { updated_by: o.updated_by }); break;
      case 'create_layer': { const key = o.engagement.provider ? { professional_id: idOf(o.engagement.provider), service_id: idOf(o.engagement.service) } : o.engagement; eng(key).layers.push(Object.assign({}, o.layer, { recorded_by: o.recorded_by })); break; }
      case 'update_layer': { const l = eng(o.engagement).layers.find((x) => x.kind === o.kind); Object.assign(l, o.set, { recorded_by: o.recorded_by }); break; }
      default: throw new Error('the simulator does not know ' + o.op);
    }
  }
  return s;
}

// ---- Postgres (PGlite) ---------------------------------------------------------------------------------------------------------------------------------------
async function runOps(pg, ops) {
  const ids = new Map();
  await pg.transaction(async (tx) => {
    const idOf = (r) => ('id' in r ? r.id : ids.get(r.ref));
    const one = async (sql, params) => (await tx.query(sql, params)).rows[0];
    const keyOf = (e) => (e.provider ? [idOf(e.provider), idOf(e.service)] : [e.professional_id, e.service_id]);
    for (const o of ops) {
      switch (o.op) {
        case 'create_service': ids.set(o.ref, String((await one('INSERT INTO services (name, topic, description, active) VALUES ($1,$2,$3,$4) RETURNING id', [o.name, o.topic, o.description, o.active])).id)); break;
        case 'create_provider': {
          const id = String((await one('INSERT INTO professionals (name) VALUES ($1) RETURNING id', [o.name])).id); ids.set(o.ref, id);
          await tx.query('INSERT INTO provider_profiles (professional_id, business_name, contact_phone, contact_email) VALUES ($1,$2,$3,$4)', [id, o.business_name, o.contact_phone, o.contact_email]); break;
        }
        case 'update_service': for (const [k, v] of Object.entries(o.set)) await tx.query(`UPDATE services SET ${k} = $1 WHERE id = $2`, [v, o.id]); break;
        case 'update_provider': for (const [k, v] of Object.entries(o.set)) await tx.query(`INSERT INTO provider_profiles (professional_id, ${k}) VALUES ($1, $2) ON CONFLICT (professional_id) DO UPDATE SET ${k} = EXCLUDED.${k}, updated_at = now()`, [o.id, v]); break;
        case 'create_engagement': {
          const s = o.set;
          await tx.query('INSERT INTO provider_services (professional_id, service_id, activation, contact_state, agreement_state, pricing_model, external_ref, terms_note, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [idOf(o.provider), idOf(o.service), s.activation, s.contact_state, s.agreement_state, s.pricing_model, s.external_ref, s.terms_note, o.updated_by]); break;
        }
        case 'update_engagement': { const k = keyOf({ professional_id: o.key.professional_id, service_id: o.key.service_id }); for (const [f, v] of Object.entries(o.set)) await tx.query(`UPDATE provider_services SET ${f} = $1, updated_by = $2, updated_at = now() WHERE professional_id = $3 AND service_id = $4`, [v, o.updated_by, k[0], k[1]]); break; }
        case 'create_layer': {
          const l = o.layer, k = keyOf(o.engagement);
          await tx.query('INSERT INTO provider_service_prices (professional_id, service_id, kind, model, amount, percent_low, percent_high, minimum_amount, terms_text, status, basis_missing, source_note, source_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
            [k[0], k[1], l.kind, l.model, l.amount, l.percent_low, l.percent_high, l.minimum_amount, l.terms_text, l.status, l.basis_missing, l.source_note, l.source_date, o.recorded_by]); break;
        }
        case 'update_layer': {
          const k = keyOf(o.engagement), sets = Object.keys(o.set), vals = sets.map((f) => o.set[f]);
          await tx.query(`UPDATE provider_service_prices SET ${sets.map((f, i) => f + ' = $' + (i + 1)).join(', ')}, recorded_by = $${sets.length + 1}, updated_at = now() WHERE professional_id = $${sets.length + 2} AND service_id = $${sets.length + 3} AND kind = $${sets.length + 4}`, vals.concat([o.recorded_by, k[0], k[1], o.kind])); break;
        }
        default: throw new Error('the database helper does not know ' + o.op);
      }
    }
  });
}

// The snapshot the importer is given, read back from the database (ids as text; numbers as numbers).
async function readSnapshot(pg) {
  const q = async (sql) => (await pg.query(sql)).rows;
  const services = await q('SELECT id::text AS id, name, topic, description FROM services ORDER BY id');
  const providers = await q('SELECT p.id::text AS id, p.name, pp.business_name, pp.contact_phone, pp.contact_email FROM professionals p LEFT JOIN provider_profiles pp ON pp.professional_id = p.id ORDER BY p.id');
  const engagements = await q('SELECT professional_id::text AS professional_id, service_id::text AS service_id, external_ref, activation, contact_state, agreement_state, pricing_model, pricing_id::text AS pricing_id, terms_note, updated_by FROM provider_services ORDER BY professional_id, service_id');
  const layers = await q('SELECT professional_id::text AS professional_id, service_id::text AS service_id, kind, model, amount::float8 AS amount, percent_low::float8 AS percent_low, percent_high::float8 AS percent_high, minimum_amount::float8 AS minimum_amount, terms_text, status, basis_missing, source_note, source_date::text AS source_date, recorded_by FROM provider_service_prices ORDER BY 1, 2, 3');
  engagements.forEach((e) => { e.layers = layers.filter((l) => l.professional_id === e.professional_id && l.service_id === e.service_id); });
  return { services, providers, engagements };
}

module.exports = { applyOps, runOps, readSnapshot, clone };
