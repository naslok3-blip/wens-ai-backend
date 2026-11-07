ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at = 0;
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);
