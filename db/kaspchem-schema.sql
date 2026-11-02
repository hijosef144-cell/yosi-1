-- Kaspchem schema — dedicated Neon database. Idempotent: safe to run repeatedly.
-- Personal data lives only in applicants / consents / treatment_requests.
-- No prices are seeded anywhere: pricing rows are entered manually by an admin.

CREATE TABLE IF NOT EXISTS applicants (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  email       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (phone)
);

CREATE TABLE IF NOT EXISTS questionnaire_versions (
  id            BIGSERIAL PRIMARY KEY,
  topic         TEXT NOT NULL,
  version       INT  NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','published','archived')),
  content       JSONB NOT NULL,
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  UNIQUE (topic, version)
);
-- at most one published version per topic
CREATE UNIQUE INDEX IF NOT EXISTS one_published_per_topic
  ON questionnaire_versions (topic) WHERE status = 'published';

CREATE TABLE IF NOT EXISTS services (
  id          BIGSERIAL PRIMARY KEY,
  topic       TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS professionals (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  contact          TEXT,
  topics           TEXT[] NOT NULL DEFAULT '{}',
  agreement_status TEXT NOT NULL DEFAULT 'none' CHECK (agreement_status IN ('none','in_talks','signed','ended')),
  agreement_notes  TEXT,
  routing_enabled  BOOLEAN NOT NULL DEFAULT FALSE, -- future automatic routing; off by default
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Manually entered economics. Nothing here is ever shown publicly unless approved AND public.
CREATE TABLE IF NOT EXISTS pricing (
  id              BIGSERIAL PRIMARY KEY,
  service_id      BIGINT REFERENCES services(id) ON DELETE CASCADE,
  professional_id BIGINT REFERENCES professionals(id) ON DELETE SET NULL,
  label           TEXT NOT NULL,
  price           NUMERIC(12,2),          -- what the client pays; NULL = not set
  cost            NUMERIC(12,2),          -- our cost
  commission      NUMERIC(12,2),          -- fee/commission to/from partner
  notes           TEXT,
  approved        BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  public          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT public OR approved)           -- a price can never be public without approval
);

CREATE TABLE IF NOT EXISTS treatment_requests (
  id                 BIGSERIAL PRIMARY KEY,
  applicant_id       BIGINT NOT NULL REFERENCES applicants(id) ON DELETE RESTRICT,
  topic              TEXT NOT NULL,
  questionnaire_id   BIGINT REFERENCES questionnaire_versions(id),
  questionnaire_ver  TEXT,                 -- 'seed:1' when served from the bundled seed
  answers            JSONB NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('found','insufficient','none')),
  findings           JSONB NOT NULL DEFAULT '[]',
  service_id         BIGINT REFERENCES services(id),
  professional_id    BIGINT REFERENCES professionals(id),
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','in_progress','awaiting_client','done','closed','spam')),
  assignee           TEXT,
  consent_contact    BOOLEAN NOT NULL,
  consent_marketing  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tr_status_idx ON treatment_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS tr_applicant_idx ON treatment_requests (applicant_id);

-- Every consent grant, with wording version and timestamp (append-only).
CREATE TABLE IF NOT EXISTS consents (
  id            BIGSERIAL PRIMARY KEY,
  applicant_id  BIGINT NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  request_id    BIGINT REFERENCES treatment_requests(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('contact','marketing')),
  granted       BOOLEAN NOT NULL,
  text_version  TEXT NOT NULL,
  ip_hash       TEXT,                      -- salted hash, never the raw IP
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_notes (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES treatment_requests(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approved income only. Profit is derived from this plus manually entered costs.
CREATE TABLE IF NOT EXISTS revenues (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES treatment_requests(id) ON DELETE CASCADE,
  amount      NUMERIC(12,2) NOT NULL,
  cost        NUMERIC(12,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  note        TEXT,
  entered_by  TEXT NOT NULL,
  approved_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lightweight spam throttle keyed by salted IP hash (no raw IPs stored).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  hit_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rl_idx ON rate_limits (bucket, ip_hash, hit_at DESC);

-- Impact outcomes (stage 3). Money and families the public counter may be built from. Idempotent, additive only.
-- source 'system'  = a treatment request marked done in the dashboard (request_id required, completed_on required).
-- source 'baseline' = historical opening data entered by the owners (family_count required, no request). Not public until the owners approve it.
-- Only rows with amount_basis = 'documented', amount > 0, not voided (and a request still in status done) are ever counted; the totals are
-- computed when read, never stored. 'ongoing_saving' amounts are per year. evidence_note is internal and never leaves the dashboard.
CREATE TABLE IF NOT EXISTS outcomes (
  id                BIGSERIAL PRIMARY KEY,
  source            TEXT NOT NULL CHECK (source IN ('system','baseline')),
  kind              TEXT NOT NULL CHECK (kind IN ('ongoing_saving','one_time_refund','located_funds')),
  amount            NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  amount_basis      TEXT NOT NULL CHECK (amount_basis IN ('documented','estimate')),
  request_id        BIGINT REFERENCES treatment_requests(id) ON DELETE CASCADE,
  family_count      INT CHECK (family_count IS NULL OR family_count >= 0),
  completed_on      DATE,
  starts_on         DATE,
  ends_on           DATE,
  last_verified_at  DATE,
  evidence_note     TEXT,
  entered_by        TEXT NOT NULL,
  voided_at         TIMESTAMPTZ,
  voided_by         TEXT,
  void_reason       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (source = 'system'   AND request_id IS NOT NULL AND family_count IS NULL AND completed_on IS NOT NULL) OR
    (source = 'baseline' AND request_id IS NULL     AND family_count IS NOT NULL)
  ),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CHECK (voided_at IS NULL OR voided_by IS NOT NULL)
);
-- A treatment is never counted twice for the same kind. A voided row gives up its place, so a wrong entry can be voided and entered again.
CREATE UNIQUE INDEX IF NOT EXISTS outcomes_request_kind_uq
  ON outcomes (request_id, kind) WHERE request_id IS NOT NULL AND voided_at IS NULL;
