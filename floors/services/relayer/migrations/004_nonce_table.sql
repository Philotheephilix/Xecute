-- Migration 004: persist floor-action nonces to prevent replay attacks after restart
CREATE TABLE IF NOT EXISTS relayer.floor_action_nonces (
  nonce      TEXT        PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS floor_action_nonces_expires_at
  ON relayer.floor_action_nonces(expires_at);
