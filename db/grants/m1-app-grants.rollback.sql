-- Exact inverse of m1-app-grants.sql: takes back only what that file gave to kaspchem_app. Nothing else is touched.
-- PROPOSED ONLY: not applied to any database. After a rollback the effective privileges are exactly as before the grants (the tables' ACL text keeps the owner's own
-- entry, which Postgres writes at the first GRANT; it grants the owner nothing new).

REVOKE USAGE ON SEQUENCE catalog_imports_id_seq FROM kaspchem_app;

REVOKE SELECT, INSERT ON catalog_imports FROM kaspchem_app;

REVOKE SELECT, INSERT, UPDATE ON provider_profiles, provider_services, provider_service_prices, service_settings FROM kaspchem_app;
