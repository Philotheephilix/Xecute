CREATE SCHEMA IF NOT EXISTS api;

CREATE TABLE IF NOT EXISTS api.accounts (
  account_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api.idempotency_keys (
  key TEXT PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS api.positions (
  floor_id BIGINT PRIMARY KEY,
  account_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  qty NUMERIC NOT NULL,
  floor_price_e6 NUMERIC NOT NULL,
  status TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS positions_account_id ON api.positions(account_id);
