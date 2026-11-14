-- Add floor opening tracking columns to buy_submissions
ALTER TABLE api.buy_submissions
  ADD COLUMN IF NOT EXISTS floor_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS floor_id BIGINT,
  ADD COLUMN IF NOT EXISTS floor_status TEXT NOT NULL DEFAULT 'none';
