ALTER TABLE taskliner_users ADD COLUMN workspace_id TEXT;
ALTER TABLE taskliner_users ADD COLUMN key_id TEXT;
ALTER TABLE taskliner_users ADD COLUMN e2ee_status TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE taskliner_users ADD COLUMN legacy_fingerprint TEXT;
ALTER TABLE taskliner_users ADD COLUMN cutover_lock_token TEXT;
ALTER TABLE taskliner_users ADD COLUMN cutover_lock_expires_at TEXT;
ALTER TABLE taskliner_users ADD COLUMN cutover_verified_at TEXT;
