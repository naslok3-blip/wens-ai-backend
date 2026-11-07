-- Keep privacy-minimal login history from this migration onward.
CREATE TABLE IF NOT EXISTS login_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_in_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_events_user_time ON login_events(user_id, logged_in_at);
