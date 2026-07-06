-- Schema for the ticket assignment service (implementation.md section 1).
-- gen_random_uuid() is built into Postgres 13+ core; no extension needed.

CREATE TABLE IF NOT EXISTS agents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text        NOT NULL,
  name       text        NOT NULL,
  timezone   text        NOT NULL,               -- IANA name, validated in the app
  active     boolean     NOT NULL DEFAULT true,  -- soft delete: false stops new tickets
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_agents_company_id ON agents (company_id);

-- Recurring weekly windows in the agent's LOCAL time.
CREATE TABLE IF NOT EXISTS shifts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid    NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Mon .. 6 = Sun
  start_minute     smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439), -- inclusive
  end_minute       smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),   -- exclusive
  crosses_midnight boolean  NOT NULL DEFAULT false,
  -- Backstop for the app-level validation: a single window is always under 24h.
  CONSTRAINT shift_window_valid CHECK (
    (crosses_midnight = false AND start_minute < end_minute
                              AND end_minute - start_minute < 1440) OR
    (crosses_midnight = true  AND end_minute   < start_minute)
  )
);

CREATE INDEX IF NOT EXISTS idx_shifts_agent_id ON shifts (agent_id);

-- One row per assigned ticket; open rows drive the fairness metric.
CREATE TABLE IF NOT EXISTS assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  text        NOT NULL,
  ticket_id   text        NOT NULL,
  agent_id    uuid        NOT NULL REFERENCES agents (id),
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at   timestamptz,  -- NULL = open
  UNIQUE (company_id, ticket_id)  -- idempotency guarantee
);

CREATE INDEX IF NOT EXISTS idx_assignments_agent_id ON assignments (agent_id);
-- Speeds up the per-agent open-count subquery in the selection query (assignTicket).
CREATE INDEX IF NOT EXISTS idx_assignments_agent_open
  ON assignments (agent_id) WHERE closed_at IS NULL;

-- Company-scoped UI read paths. The UNIQUE(company_id, ticket_id) index can
-- filter by company_id (leading column) but not serve these, so add dedicated
-- indexes that match the actual predicates.
CREATE INDEX IF NOT EXISTS idx_assignments_company_open
  ON assignments (company_id, agent_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_company_assigned
  ON assignments (company_id, assigned_at DESC);
