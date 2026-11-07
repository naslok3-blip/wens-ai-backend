-- Add heartbeat timestamps for authenticated user presence.
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);
