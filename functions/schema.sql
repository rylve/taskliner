CREATE TABLE IF NOT EXISTS taskliner_users (
  google_sub TEXT PRIMARY KEY,
  email TEXT,
  refresh_token_ciphertext TEXT NOT NULL,
  workspace_id TEXT,
  key_id TEXT,
  e2ee_status TEXT NOT NULL DEFAULT 'legacy' CHECK (e2ee_status IN ('legacy', 'migrating', 'encrypted-active')),
  legacy_fingerprint TEXT,
  cutover_lock_token TEXT,
  cutover_lock_expires_at TEXT,
  cutover_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_taskliner_users_updated_at
  ON taskliner_users(updated_at);
