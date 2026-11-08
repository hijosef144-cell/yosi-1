'use strict';
// Owner decision (2026-11-08): the NAME and the TOPIC of a service that is tied to a price the public site is showing may not be changed. The reason: the public price list is grouped by the
// topic of the service, so renaming or re-topicking would silently move or relabel a price the owners approved and published. To edit such a service, first take its price off the public
// list (the pricing screen's "unpublish"), then edit.
// This is enforced in the SQL of every write that can change a service's name or topic: the existing PATCH /services, the catalog routes and the catalog import. No route, old or new,
// can bypass it, whatever the user interface does.
// "Tied to a public price" is exactly the condition the public configuration uses to show a price (kaspchem-config.js: approved AND public AND price set, grouped by the topic of
// pricing.service_id). It reads ONLY the older `pricing` table, so the existing route keeps working in a database where the catalog tables do not exist yet (production today).
//
// Both fragments use the alias `s` for the services row.
const PUBLIC_PRICE_EXISTS = '(EXISTS (SELECT 1 FROM pricing gp WHERE gp.service_id = s.id AND gp.approved AND gp.public AND gp.price IS NOT NULL))';

// For an UPDATE of services (alias s) that sets `name` to the parameter nameParam and `topic` to topicParam (either may be absent): true when neither would change, or when no public price
// is attached. Parameter casts are written by the caller.
function allowsChange(nameParam, topicParam) {
  const same = [];
  if (nameParam) same.push('s.name IS NOT DISTINCT FROM ' + nameParam);
  if (topicParam) same.push('s.topic IS NOT DISTINCT FROM ' + topicParam);
  if (!same.length) return 'TRUE';
  return '((' + same.join(' AND ') + ') OR NOT ' + PUBLIC_PRICE_EXISTS + ')';
}

// After an UPDATE that touched nothing: was it this rule that stopped it? (One extra read, only on the failure path.) A part that the edit does not set is passed as undefined.
async function isBlocked(db, id, name, topic) {
  const diff = [];
  const params = [id];
  if (name !== undefined) { params.push(name); diff.push('s.name IS DISTINCT FROM $' + params.length + '::text'); }
  if (topic !== undefined) { params.push(topic); diff.push('s.topic IS DISTINCT FROM $' + params.length + '::text'); }
  if (!diff.length) return false;
  const rows = await db.query('SELECT 1 FROM services s WHERE s.id = $1::bigint AND (' + diff.join(' OR ') + ') AND ' + PUBLIC_PRICE_EXISTS, params);
  return rows.length > 0;
}

const MESSAGE = 'לא ניתן לשנות שם או תחום של שירות שמקושר למחיר שמוצג באתר. יש להסיר קודם את המחיר מהפרסום (במסך התמחור) ורק אז לערוך.';

module.exports = { PUBLIC_PRICE_EXISTS, allowsChange, isBlocked, MESSAGE };
