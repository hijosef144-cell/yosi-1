'use strict';
// P1: what the older pricing route needs to know about the provider catalog, kept in one place (a file of its own, so that the older router does not mention the catalog's states).
// A price that is linked to an ACTIVE engagement is not changed by the older PATCH /pricing/:id: that route replaces the service, the provider and the amount of a row and takes its approval away, which would leave an active
// engagement linked to a price that no longer fits (the rule of the catalog: approved, with an amount, of the engagement's service, general or the provider's own). Engagements that are pending, paused, draft or retired do not
// block: their activation and resumption look at the price again. Where the catalog tables do not exist yet (before their migration) no engagement can exist, and the older route is exactly what it was.
const db = require('./db');

// the condition, to be used inside the UPDATE of the pricing table (the table is not aliased there)
const ACTIVE_LINK = "EXISTS (SELECT 1 FROM provider_services ps WHERE ps.pricing_id = pricing.id AND ps.activation = 'active')";
const catalogTablesExist = async () => { const r = await db.query("SELECT to_regclass('public.provider_services') IS NOT NULL AS has"); return !!(r[0] && r[0].has); };
const LINKED_TO_ACTIVE = 'המחיר משויך להתקשרות פעילה בקטלוג הספקים. יש להשהות אותה בקטלוג לפני שינוי המחיר. לא נשמר דבר.';

module.exports = { ACTIVE_LINK, catalogTablesExist, LINKED_TO_ACTIVE };
