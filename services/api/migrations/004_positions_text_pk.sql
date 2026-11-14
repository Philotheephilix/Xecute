-- Migrate api.positions to TEXT primary key and add column defaults
-- The original schema used BIGINT; the updated spec uses TEXT floor_id.
-- We drop and recreate since IF NOT EXISTS won't alter existing tables.

DROP TABLE IF EXISTS api.positions;

CREATE TABLE IF NOT EXISTS api.positions (
  floor_id        TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES api.accounts(account_id),
  asset           TEXT NOT NULL,
  qty             TEXT NOT NULL,
  floor_price_e6  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS positions_account_id ON api.positions(account_id);
