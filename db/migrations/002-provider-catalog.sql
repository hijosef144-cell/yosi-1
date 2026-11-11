-- Migration 002 (M1): service catalog, providers and engagements.
-- Six NEW tables and their indexes. Nothing existing is altered: the 13 tables of the base schema keep their exact structure (the tests compare it line by line).
-- The bookkeeping table schema_migrations is created and owned by scripts/kaspchem-migrate.js, not by this file.
-- Every statement is CREATE ... IF NOT EXISTS, so the file can safely be run again. Grants for kaspchem_app are a separate, separately approved step.
-- Nothing here is read by any public endpoint, questionnaire or page.

-- How a provider receives inquiries and when it is available (one row per professional).
CREATE TABLE IF NOT EXISTS provider_profiles (
  professional_id BIGINT PRIMARY KEY REFERENCES professionals(id) ON DELETE CASCADE,
  delivery_method TEXT NOT NULL DEFAULT 'portal' CHECK (delivery_method IN ('portal','manual')),  -- manual = staff enter the provider's updates
  paused_until    TIMESTAMPTZ,                          -- no new inquiries until then
  archived_at     TIMESTAMPTZ,                          -- retired provider: hidden everywhere, never deleted
  capacity_open   INT CHECK (capacity_open IS NULL OR capacity_open >= 0),
  business_name   TEXT CHECK (business_name IS NULL OR char_length(business_name) <= 200),   -- "business / organisation" in the owners' sheet
  contact_phone   TEXT CHECK (contact_phone IS NULL OR char_length(contact_phone) <= 40),   -- business contact of the provider; visible to owners only, never public
  contact_email   TEXT CHECK (contact_email IS NULL OR (char_length(contact_email) <= 200 AND contact_email ~ '^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$')),
  internal_notes  TEXT CHECK (internal_notes IS NULL OR char_length(internal_notes) <= 1000),
  availability    JSONB NOT NULL DEFAULT '{}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An OFFERING: one provider offering one service. This is what one row of the owners' catalog sheet describes (provider, exact service, price, contact state,
-- agreement state, readiness). Several providers may offer the same service; a provider may offer several services. Pausing, activating and replacing happen here.
-- Commercial terms: a fixed price lives in the existing `pricing` row (pricing_id) and keeps its approval/public rules. No commission NUMBER is stored or used here.
CREATE TABLE IF NOT EXISTS provider_services (
  professional_id   BIGINT NOT NULL REFERENCES professionals(id) ON DELETE CASCADE,
  service_id        BIGINT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  activation        TEXT NOT NULL DEFAULT 'draft' CHECK (activation IN ('draft','pending','active','paused','retired')),
  contact_state     TEXT NOT NULL DEFAULT 'none' CHECK (contact_state IN ('none','contacted','negotiating','active','stopped')),
  agreement_state   TEXT NOT NULL DEFAULT 'not_discussed' CHECK (agreement_state IN ('not_discussed','draft','signed','ended')),
  pricing_model     TEXT NOT NULL DEFAULT 'tbd' CHECK (pricing_model IN ('fixed','percent_of_result','percent_with_minimum','variable','quote','tbd')),
  pricing_id        BIGINT REFERENCES pricing(id) ON DELETE SET NULL,   -- the fixed price shown to the public, through the existing approval flow
  external_ref      TEXT,                                               -- the id used in the owners' sheet (provider-prefixed there); the service code itself stays provider-independent
  priority          INT NOT NULL DEFAULT 100,                           -- display order only; never derived from compensation
  terms_note        TEXT,                                               -- internal, never shown to the public
  paused_reason     TEXT,
  retired_reason    TEXT,
  retired_at        TIMESTAMPTZ,
  updated_by        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (professional_id, service_id),
  -- MVP safety rule in the database itself: an offering can be ACTIVE (available for referral) only with a signed agreement, an active collaboration and a fixed price row.
  CHECK (activation <> 'active' OR (agreement_state = 'signed' AND contact_state = 'active' AND pricing_model = 'fixed' AND pricing_id IS NOT NULL)),
  CHECK (activation <> 'retired' OR retired_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS provider_services_service_idx ON provider_services (service_id, activation);
CREATE UNIQUE INDEX IF NOT EXISTS provider_services_external_ref_uq ON provider_services (external_ref) WHERE external_ref IS NOT NULL;

-- Commission data as RECORDED by the owners (what the sheet says). Private and inert: never shown to providers or the public, never used in any calculation, ordering or payment.
-- Kept in its own table so that no generic query on offerings can return it by accident. The server still refuses any commission above zero in `pricing` (owners' legal block).
CREATE TABLE IF NOT EXISTS provider_service_compensation (
  professional_id  BIGINT NOT NULL,
  service_id       BIGINT NOT NULL,
  model            TEXT NOT NULL DEFAULT 'tbd' CHECK (model IN ('none','percent','fixed','tbd')),
  percent_recorded NUMERIC(5,2) CHECK (percent_recorded IS NULL OR (percent_recorded >= 0 AND percent_recorded <= 100)),
  fixed_recorded   NUMERIC(12,2) CHECK (fixed_recorded IS NULL OR fixed_recorded >= 0),
  payer_note       TEXT,                                -- who pays whom and on what basis, as written by the owners
  status           TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','negotiating','agreed')),   -- 'agreed' = agreed in writing; the record stays inert either way
  recorded_by      TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (professional_id, service_id),
  FOREIGN KEY (professional_id, service_id) REFERENCES provider_services (professional_id, service_id) ON DELETE CASCADE,
  CHECK ((model = 'percent') = (percent_recorded IS NOT NULL)),
  CHECK ((model = 'fixed') = (fixed_recorded IS NOT NULL))
);

-- The price LAYERS of one engagement, kept apart so that nothing is mistaken for something else:
--   market         = what the provider charges in the market (reference only, never shown without approval)
--   provider_offer = the special price the provider offers Kaspchem's clients; it may still be waiting for the provider's answer
--   unclassified   = a price copied from the owners' sheet whose meaning is not yet confirmed; it feeds nothing until someone classifies it
-- The price APPROVED for clients is not here: it is a `pricing` row (pricing_id on the engagement) with its existing approval and public flags.
-- The AGREED commission is not here either: see provider_service_compensation. Models cover fixed, percent of the result (single or a range), a percent with a
-- minimum amount, variable (e.g. by complexity), per-case quote and not set. Prices and wording are stored exactly as given; nothing is rounded or invented.
CREATE TABLE IF NOT EXISTS provider_service_prices (
  professional_id BIGINT NOT NULL,
  service_id      BIGINT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('market','provider_offer','unclassified')),
  model           TEXT NOT NULL DEFAULT 'tbd' CHECK (model IN ('fixed','percent_of_result','percent_with_minimum','variable','quote','tbd')),
  amount          NUMERIC(12,2) CHECK (amount IS NULL OR amount >= 0),
  percent_low     NUMERIC(5,2) CHECK (percent_low IS NULL OR (percent_low > 0 AND percent_low <= 100)),
  percent_high    NUMERIC(5,2) CHECK (percent_high IS NULL OR (percent_high > 0 AND percent_high <= 100)),
  minimum_amount  NUMERIC(12,2) CHECK (minimum_amount IS NULL OR minimum_amount >= 0),
  terms_text      TEXT CHECK (terms_text IS NULL OR char_length(terms_text) <= 600),            -- the provider's wording, verbatim
  status          TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','awaiting_response','received','declined')),
  basis_missing   BOOLEAN NOT NULL DEFAULT FALSE,                                                -- a percentage was given without saying what it is a percentage of
  source_note     TEXT CHECK (source_note IS NULL OR char_length(source_note) <= 600),          -- where the price comes from (correspondence, link)
  source_date     DATE,
  recorded_by     TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (professional_id, service_id, kind),
  FOREIGN KEY (professional_id, service_id) REFERENCES provider_services (professional_id, service_id) ON DELETE CASCADE,
  CHECK (model <> 'fixed' OR (amount IS NOT NULL AND percent_low IS NULL AND percent_high IS NULL AND minimum_amount IS NULL)),
  CHECK (model NOT IN ('percent_of_result','percent_with_minimum') OR (percent_low IS NOT NULL AND amount IS NULL)),
  CHECK (model <> 'percent_with_minimum' OR minimum_amount IS NOT NULL),
  CHECK (model NOT IN ('variable','quote','tbd') OR (amount IS NULL AND percent_low IS NULL AND percent_high IS NULL AND minimum_amount IS NULL)),
  CHECK (percent_high IS NULL OR percent_low IS NULL OR percent_high >= percent_low),
  CHECK (kind = 'provider_offer' OR status = 'recorded')
);

-- Extra settings of a service, separate from the questionnaire. Matching to findings happens here, so providers change without touching a questionnaire.
CREATE TABLE IF NOT EXISTS service_settings (
  service_id       BIGINT PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]{2,40}$'),
  finding_tags     TEXT[] NOT NULL DEFAULT '{}',        -- matched against rule.serviceTag of the findings
  topics           TEXT[] NOT NULL DEFAULT '{}',        -- fallback: offered when a check of one of these topics found something
  share_questions  TEXT[] NOT NULL DEFAULT '{}',        -- question ids whose answers this service's provider may see
  legal_cleared    BOOLEAN NOT NULL DEFAULT FALSE,      -- written clearance for referring to this kind of provider (owners' decision, recorded)
  legal_cleared_by TEXT,
  legal_cleared_at TIMESTAMPTZ,
  legal_note       TEXT,
  offered          BOOLEAN NOT NULL DEFAULT FALSE,      -- shown to the public as a route
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT offered OR (legal_cleared AND legal_cleared_by IS NOT NULL))   -- never offered without recorded clearance, like pricing.public needs approval
);

-- Catalog loads from a spreadsheet (traceability only: counts and row numbers, never the contents)
CREATE TABLE IF NOT EXISTS catalog_imports (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL CHECK (source IN ('xlsx','csv')),
  file_sha256   TEXT NOT NULL,
  rows_total    INT NOT NULL CHECK (rows_total >= 0),
  rows_created  INT NOT NULL CHECK (rows_created >= 0),
  rows_updated  INT NOT NULL CHECK (rows_updated >= 0),
  rows_skipped  INT NOT NULL CHECK (rows_skipped >= 0),
  problems      JSONB NOT NULL DEFAULT '[]',            -- [{"row":7,"code":"unknown_domain"}], no cell contents
  imported_by   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
