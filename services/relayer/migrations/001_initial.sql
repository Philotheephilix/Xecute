CREATE SCHEMA IF NOT EXISTS relayer;

CREATE TABLE IF NOT EXISTS relayer.transactions (
  idempotency_key TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_tx_hash ON relayer.transactions(tx_hash);
