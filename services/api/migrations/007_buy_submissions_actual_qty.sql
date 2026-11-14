-- Add actual_qty column to track the real swap output amount
ALTER TABLE api.buy_submissions
  ADD COLUMN IF NOT EXISTS actual_qty TEXT;
