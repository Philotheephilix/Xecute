-- P1-B: Smart account lifecycle
-- Records for idempotent create-account and enable-trading requests

CREATE TABLE IF NOT EXISTS relayer.create_account_requests (
  idempotency_key UUID      PRIMARY KEY,
  account_id      TEXT      NOT NULL,
  tx_hash         TEXT,
  status          TEXT      NOT NULL,
  result          JSONB     NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS create_account_requests_account_id
  ON relayer.create_account_requests (account_id);
