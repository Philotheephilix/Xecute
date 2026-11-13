CREATE SCHEMA IF NOT EXISTS api;

CREATE TABLE IF NOT EXISTS api.invite_codes (
  code TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  used_by TEXT  -- account_id that redeemed it
);
