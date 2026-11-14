-- Add floor opening tracking columns to swap_intents
ALTER TABLE relayer.swap_intents
  ADD COLUMN IF NOT EXISTS floor_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS floor_id BIGINT,
  ADD COLUMN IF NOT EXISTS floor_status TEXT NOT NULL DEFAULT 'none';
