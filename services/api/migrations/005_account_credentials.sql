-- Linked-device credentials table.
-- When a user creates a second passkey on a different device (link-device flow),
-- the new credential_id differs from the one stored in api.accounts at account creation.
-- This table maps those secondary credentials back to the account.

CREATE TABLE IF NOT EXISTS api.account_credentials (
  id              SERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES api.accounts(account_id),
  credential_id   TEXT NOT NULL,
  public_key      TEXT,
  source          TEXT NOT NULL DEFAULT 'extension',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(credential_id)
);

CREATE INDEX IF NOT EXISTS account_credentials_account_id ON api.account_credentials(account_id);
