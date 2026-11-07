-- M1 permissions for the application role kaspchem_app (the role the admin function connects as).
-- PROPOSED ONLY: not applied to any database. Applying it needs the owner's separate approval, and it is run as the database owner, never by the application.
--
-- Principle: the least that the M1 catalog code needs (docs/research/raw/PROVIDER-PORTAL-M1-PLAN.md), in the same style as the grants kaspchem_app has today
-- (per table, data only, derived from the code).
--   * No DELETE and no TRUNCATE: rows are archived, retired, paused or marked, never deleted.
--   * No REFERENCES, no TRIGGER, no structure change, no permission management: kaspchem_app does not own these tables and gets no grant option.
--   * Nothing for PUBLIC, and no "ON ALL TABLES": a table added later gets nothing until it is granted on purpose.
--
-- Deliberately NOT granted:
--   provider_service_compensation  confidential commission records. Table privileges decide which CREDENTIAL may reach a table, not which person. Until the owner decides
--                                  how the owner-only path gets its own credential, the application role has no access at all (the records stay inert, as decision D14 says).
--   schema_migrations              belongs to the migration runner, which runs as the owner role. The application never reads or writes it.

GRANT SELECT, INSERT, UPDATE ON provider_profiles, provider_services, provider_service_prices, service_settings TO kaspchem_app;

-- the import log is append-only: it can be read and added to, never changed
GRANT SELECT, INSERT ON catalog_imports TO kaspchem_app;

-- adding a row to catalog_imports takes its id from this sequence (USAGE only: no SELECT, no UPDATE)
GRANT USAGE ON SEQUENCE catalog_imports_id_seq TO kaspchem_app;
