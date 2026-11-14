-- Track USDC debits for user accounts.
-- On testnet protocol < 89, global contract mutable calls (w_execute_extension)
-- don't work. We record debits here so the effective balance can be computed as:
--   effective_usdc = on_chain_usdc - SUM(debits)
-- Once protocol >= 89 lands, the on-chain transfer will also execute and
-- the on-chain balance will already reflect the debit.

CREATE TABLE IF NOT EXISTS relayer.usdc_debits (
  id              BIGSERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL,
  amount          TEXT NOT NULL,             -- USDC micro-units (6 decimals) as string
  reason          TEXT NOT NULL DEFAULT 'swap',
  idempotency_key TEXT UNIQUE,               -- prevents double-counting
  on_chain        BOOLEAN NOT NULL DEFAULT FALSE,  -- true once protocol >= 89 transfer works
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usdc_debits_account_id ON relayer.usdc_debits(account_id);
