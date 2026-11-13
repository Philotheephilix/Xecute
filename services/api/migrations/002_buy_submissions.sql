CREATE TABLE IF NOT EXISTS api.buy_submissions (
  status_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key UUID NOT NULL UNIQUE,
  quote_id        TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  amount_usdc     TEXT NOT NULL,
  intent_hash     TEXT,
  tx_hash         TEXT,
  deposit_address TEXT,
  status          TEXT NOT NULL DEFAULT 'submitted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS buy_submissions_status ON api.buy_submissions(status)
  WHERE status NOT IN ('done', 'failed');
