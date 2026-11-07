-- Persist successful signups and logins after session cleanup.
CREATE TABLE IF NOT EXISTS user_login_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('signup','login')),
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_login_events_user_time
  ON user_login_events(user_id, occurred_at DESC);
