-- ROLLBACK of 003 price race guard. Run by the schema owner only, in ONE transaction, together with the removal of its line in the history (the last statement), so that the runner sees 003 as pending again.
-- It removes two triggers, two functions and one index, and nothing else: no table, no row and no permission is touched, so no data is lost.
DROP TRIGGER IF EXISTS kc_engagement_price_guard ON provider_services;
DROP TRIGGER IF EXISTS kc_pricing_guard ON pricing;
DROP FUNCTION IF EXISTS kc_engagement_price_guard();
DROP FUNCTION IF EXISTS kc_pricing_guard();
DROP INDEX IF EXISTS provider_services_active_price_idx;
DELETE FROM schema_migrations WHERE id = '003-price-race-guard';
