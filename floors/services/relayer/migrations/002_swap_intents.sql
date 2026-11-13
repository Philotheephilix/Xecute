CREATE TABLE IF NOT EXISTS relayer.swap_intents (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE,
  account_id      TEXT NOT NULL,
  intent_hash     TEXT,
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  amount_usdc     TEXT NOT NULL,
  ticker          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS swap_intents_intent_hash ON relayer.swap_intents (intent_hash);
