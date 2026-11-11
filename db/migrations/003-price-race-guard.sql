-- 003 price race guard: the database itself refuses the two writes that, together, leave an ACTIVE engagement with a price that is no longer valid.
-- The race (shown on a real Neon branch on 2026-11-11): an activation checks the price as it was when ITS statement began, an edit of that price checks "no active engagement" as it was when ITS
-- statement began, and both commit. Two row triggers, each taking a row lock on the price, order the two writers whichever comes first: at most one succeeds. No data is read or changed here and no
-- existing row is touched (a trigger fires only on a new write). The rule is the same as PRICE_FITS in admin-catalog-writes.js: the price is approved, has an amount, belongs to the SERVICE of the
-- engagement, and is general (no provider) or the provider's own. The functions are owned by the schema owner (SECURITY DEFINER, fixed search_path) so they need no permission of the application role.
-- Reversible without any loss of data: db/rollback/003-price-race-guard.rollback.sql.
CREATE OR REPLACE FUNCTION kc_pricing_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM provider_services ps WHERE ps.pricing_id = NEW.id AND ps.activation = 'active'
             AND NOT (NEW.approved AND NEW.price IS NOT NULL AND NEW.service_id = ps.service_id AND (NEW.professional_id IS NULL OR NEW.professional_id = ps.professional_id))) THEN
    RAISE EXCEPTION 'price_linked_to_active_engagement' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$f$;

CREATE OR REPLACE TRIGGER kc_pricing_guard BEFORE UPDATE ON pricing FOR EACH ROW EXECUTE FUNCTION kc_pricing_guard();

CREATE OR REPLACE FUNCTION kc_engagement_price_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  PERFORM 1 FROM pricing pr WHERE pr.id = NEW.pricing_id AND pr.approved AND pr.price IS NOT NULL AND pr.service_id = NEW.service_id AND (pr.professional_id IS NULL OR pr.professional_id = NEW.professional_id) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'price_not_valid_for_active_engagement' USING ERRCODE = 'P0001'; END IF;
  RETURN NEW;
END
$f$;

CREATE OR REPLACE TRIGGER kc_engagement_price_guard BEFORE INSERT OR UPDATE ON provider_services FOR EACH ROW WHEN (NEW.activation = 'active') EXECUTE FUNCTION kc_engagement_price_guard();

CREATE INDEX IF NOT EXISTS provider_services_active_price_idx ON provider_services (pricing_id) WHERE activation = 'active';
